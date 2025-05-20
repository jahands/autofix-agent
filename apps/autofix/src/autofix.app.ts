import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'
import { z } from 'zod'

import { useNotFound, useOnError } from '@repo/hono-helpers'

import type { App } from './autofix.context'
import { WorkersBuildsClient } from './workersBuilds'
import { generateObject, generateText, tool, CoreMessage, ToolCallPart, ToolResultPart } from 'ai'
import { AnthropicModels, GoogleModels, OpenAIModels } from './ai-models'
import { Octokit } from '@octokit/rest'
import { streamText } from 'hono/streaming'

export { AutofixAgent } from './AutofixAgent'
export { UserContainer } from './container-server/userContainer'

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(useOnError())
	.notFound(useNotFound())

	// Start an agent
	.post(
		'/api/agents/:agentId',
		sValidator('param', z.object({ agentId: z.string() })),
		async (c) => {
			const { agentId } = c.req.valid('param')
			const id = c.env.AutofixAgent.idFromName(agentId)
			const agent = c.env.AutofixAgent.get(id)
			const ls = await agent.start({
				repo: 'https://github.com/jahands/autofix-agent.git',
				branch: 'main',
			})
			return c.json({ agentId, ls })
		}
	)

	// Heartbeat the agent
	.post(
		'/api/agents/:agentId/ping',
		sValidator('param', z.object({ agentId: z.string() })),
		async (c) => {
			const { agentId } = c.req.valid('param')
			const id = c.env.AutofixAgent.idFromName(agentId)
			const agent = c.env.AutofixAgent.get(id)
			const res = await agent.pingContainer()
			return c.json(res)
		}
	)

	// List files
	.get(
		'/api/agents/:agentId/files',
		sValidator('param', z.object({ agentId: z.string() })),
		async (c) => {
			const { agentId } = c.req.valid('param')
			const id = c.env.AutofixAgent.idFromName(agentId)
			const agent = c.env.AutofixAgent.get(id)
			const res = await agent.listContainerFiles()
			return c.json(res)
		}
	)

	// Get the state of the agent
	.get(
		'/api/agents/:agentId',
		sValidator(
			'param',
			z.object({
				agentId: z.string(),
			})
		),
		async (c) => {
			const { agentId } = c.req.valid('param')
			const id = c.env.AutofixAgent.idFromName(agentId)
			const agent = c.env.AutofixAgent.get(id)
			await using state = await agent.state
			return c.json({ agentId, state })
		}
	)

	// Get the logs for a build
	// this is basically only for testing that we have the demo account wired up correctly
	// and can be removed soon
	.get(
		'/api/builds/:buildUuid/logs',
		sValidator(
			'param',
			z.object({
				buildUuid: z.string(),
			})
		),
		async (c) => {
			const workersBuilds = new WorkersBuildsClient({
				accountTag: c.env.DEMO_CLOUDFLARE_ACCOUNT_TAG,
				apiToken: c.env.DEMO_CLOUDFLARE_API_TOKEN,
			})
			const logs = await workersBuilds.getBuildLogs(c.req.valid('param').buildUuid)
			return c.text(logs)
		}
	)

	// Analyze the logs for a build using an AI model.
	// this is basically only for testing that we have basic AI model functionality wired up
	// and can be removed soon
	.get(
		'/api/builds/:buildUuid/analyze',
		sValidator(
			'param',
			z.object({
				buildUuid: z.string(),
			})
		),
		async (c) => {
			return streamText(c, async (stream) => {
				const buildUuid = c.req.valid('param').buildUuid
				const workersBuilds = new WorkersBuildsClient({
					accountTag: c.env.DEMO_CLOUDFLARE_ACCOUNT_TAG,
					apiToken: c.env.DEMO_CLOUDFLARE_API_TOKEN,
				})

				await stream.writeln(`Grabbing metadata and logs for Build "${buildUuid}"`)
				const [metadata, logs] = await Promise.all([
					workersBuilds.getBuildMetadata(buildUuid),
					workersBuilds.getBuildLogs(buildUuid),
				])

				await stream.writeln(`Build metadata: ${JSON.stringify(metadata, undefined, 2)}`)
				await stream.writeln(`Build has ${logs.length} log lines`)

				// for now only ask the model to generate new files since we dont have a way to read/edit existing ones yet:
				// that's enough to suggest a "wrangler.jsonc" when it is missing in super trivial cases,
				// but it wont get us much further than that
				const prompt = `
				Identify the root cause of the failure from the build logs.
				Infer what the user intends to deploy based on the provided repository structure.
			    If you can't find any code, then assume the repo is a static website that should be deployed directly.
				Then, suggest a fix to apply by adding new files to the repo only. No other configuration changes can be made.

				Here is the build configuration:
				${JSON.stringify(metadata, undefined, 2)}

				Here are the full build logs:
				${logs}
			`

				await stream.writeln(prompt)
				await stream.writeln('Analyzing...')

				const model = OpenAIModels.GPT4o()
				const maxTokens = 10_000
				const analysis = await generateText({
					maxSteps: 5,
					maxTokens,
					model,
					system: 'You are an expert at investigating Build failures in CI systems',
					prompt,
					tools: {
						listRepoFiles: tool({
							description: 'Get the full list of files in the repository',
							parameters: z.object({ name: z.string() }),
							execute: async () => {
								await stream.writeln(`listing files!`)
								const trigger = metadata.result.build_trigger_metadata
								const repo = metadata.result.trigger.repo_connection
								const gitRef = trigger.commit_hash ? trigger.commit_hash : trigger.branch
								const tree = await new Octokit({ auth: c.env.DEMO_GITHUB_TOKEN }).git
									.getTree({
										owner: repo.provider_account_name,
										repo: repo.repo_name,
										tree_sha: gitRef,
									})
									.then((tree) =>
										tree.data.tree.map((file) => file.path).filter((path) => path !== undefined)
									)
								await stream.writeln(`Got tree: ${JSON.stringify(tree, undefined, 2)}`)
								return JSON.stringify(tree, undefined, 2)
							},
						}),
					},
				})

				await stream.writeln(`Analysis: ${analysis.text}`)

				await stream.writeln('Generating patch...')
				const patch = await generateObject({
					maxTokens,
					model,
					prompt: `
					Generate the set of new files to create given the previous analysis below:
					${analysis.text}
				`,
					schema: z.object({
						files: z.array(z.object({ path: z.string(), contents: z.string() })),
					}),
				})
				await stream.writeln(`Patch: ${JSON.stringify(patch.object, undefined, 2)}`)
			})
		}
	)

	.get('/api/test', async (c) => {
		const model = GoogleModels.GeminiFlash()
		const tools = {
			getCurrentWeather: tool({
				description: 'Get the current weather for a city',
				parameters: z.object({ city: z.string() }),
				execute: async (params: { city: string }) => {
					console.log('getCurrentWeather tool executed for:', params.city)
					// In a real scenario, you would call a weather API here
					return { weather: `The weather in ${params.city} is sunny.` }
				},
			}),
		}

		const initialPrompt =
			'Check the weather in Amarillo and then tell me a joke about the current weather.'
		const messages: CoreMessage[] = [{ role: 'user', content: initialPrompt }]

		const maxTurns = 5 // To prevent infinite loops

		for (let i = 0; i < maxTurns; i++) {
			const result = await generateText({
				model,
				messages,
				tools,
			})

			let assistantMessageContent: string | ToolCallPart[]
			if (result.toolCalls && result.toolCalls.length > 0) {
				assistantMessageContent = result.toolCalls.map((tc) => ({
					type: 'tool-call',
					toolCallId: tc.toolCallId,
					toolName: tc.toolName,
					args: tc.args,
				}))
			} else {
				assistantMessageContent = result.text
			}
			messages.push({ role: 'assistant', content: assistantMessageContent })

			if (result.finishReason === 'tool-calls' && result.toolCalls && result.toolCalls.length > 0) {
				const toolResultsContent: ToolResultPart[] = []
				for (const toolCall of result.toolCalls) {
					console.log(
						`Executing tool: ${toolCall.toolName} with args:`,
						JSON.stringify(toolCall.args)
					)
					const toolDefinition = tools[toolCall.toolName]
					let executionResult
					let isError = false
					try {
						// The 'as any' is a temporary workaround if types are still mismatched.
						// Ideally, the types from the 'ai' library should align perfectly.
						executionResult = await (toolDefinition.execute as any)(toolCall.args)
					} catch (error) {
						console.error(`Error executing tool ${toolCall.toolName}:`, error)
						executionResult = {
							error: error instanceof Error ? error.message : String(error),
						}
						isError = true
					}

					toolResultsContent.push({
						type: 'tool-result',
						toolCallId: toolCall.toolCallId,
						toolName: toolCall.toolName,
						result: executionResult,
						isError,
					})
				}
				messages.push({ role: 'tool', content: toolResultsContent })
			} else if (result.finishReason === 'stop') {
				return c.text(JSON.stringify({ res: result.text, history: messages }, null, 2))
			} else {
				console.error('Unexpected finish reason or state:', result)
				return c.text(
					JSON.stringify(
						{ error: 'Unexpected finish reason', details: result, history: messages },
						null,
						2
					),
					500
				)
			}
		}
		return c.text(
			JSON.stringify({ error: `Max turns (${maxTurns}) reached`, history: messages }, null, 2),
			500
		)
	})

export default app
