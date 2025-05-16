import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'
import { z } from 'zod'

import { useNotFound, useOnError } from '@repo/hono-helpers'

import type { App } from './autofix.context'
import { WorkersBuildsClient } from './workersBuilds'
import { generateObject, generateText, tool } from 'ai'
import { WorkersAiModels } from './ai-models'
import { GitHubClient } from './github'
import { Octokit } from '@octokit/rest'

export { AutofixAgent } from './AutofixAgent'
export { ContainerManager } from './container-server/containerManager'
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
				repo: 'https://github.com/jahands/scaffold-agent',
				branch: 'main',
			})
			return c.json({ agentId, ls })
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
			const buildUuid = c.req.valid('param').buildUuid
			const workersBuilds = new WorkersBuildsClient({
				accountTag: c.env.DEMO_CLOUDFLARE_ACCOUNT_TAG,
				apiToken: c.env.DEMO_CLOUDFLARE_API_TOKEN,
			})

			console.log(`Grabbing metadata and logs for Build "${buildUuid}"`)
			const [metadata, logs] = await Promise.all([
				workersBuilds.getBuildMetadata(buildUuid),
				workersBuilds.getBuildLogs(buildUuid),
			])

			console.log(`Build metadata: ${JSON.stringify(metadata, undefined, 2)}`)
			console.log(`Build has ${logs.length} log lines`)

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
			console.log(`Got tree: ${JSON.stringify(tree, undefined, 2)}`)

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

				Here is the full list of files available in the repo. No other files exist outside of this list:
				${JSON.stringify(tree, undefined, 2)}

				Here are the full build logs:
				${logs}
			`
			console.log(prompt)

			const analysis = await generateText({
				maxTokens: 100_000,
				model: WorkersAiModels.Llama4,
				system: 'You are an expert at investigating Build failures in CI systems',
				prompt,
			})

			console.log(`Analysis: ${analysis.text}`)

			const patch = await generateObject({
				maxTokens: 100_000,
				model: WorkersAiModels.Llama4,
				prompt: `
					Generate the set of new files to create given the previous analysis below:
					${analysis.text}
				`,
				schema: z.object({ files: z.array(z.object({ path: z.string(), contents: z.string() })) }),
			})
			console.log(`Patch: ${JSON.stringify(patch.object, undefined, 2)}`)

			return c.text('ok')
		}
	)

export default app
