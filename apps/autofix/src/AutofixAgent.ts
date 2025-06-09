import { Agent } from 'agents'
import { datePlus } from 'itty-time'
import { WithLogTags } from 'workers-tagged-logger/ts5'
import { z as z3 } from 'zod/v3'

import { logger } from './logger'

import type { AgentContext } from 'agents'
import type { Env } from './autofix.context'
import { WorkersBuildsClient, type BuildResponse } from './workersBuilds'
import { experimental_createMCPClient, tool, generateText } from 'ai'
import { GoogleModels } from './ai-models'
import { fmt } from './format'
import { GitHubClient } from './github'
import { createDetectionSystemPrompt, createDetectionUserPrompt } from './prompts/pages.prompt'
import {
	createFixGenerationSystemPrompt,
	createFixGenerationUserPrompt,
} from './prompts/workers.prompt'

const AgentActions = {
	initialize_container: { description: 'Initialize the container for the repository.' },
	fix_issues: {
		description: 'Attempt to fix detected issues using an AI model to generate a patch.',
	},
	commit_changes: { description: 'Commit the applied fix to a new branch.' },
	push_changes: { description: 'Push the new branch with the fix to the remote repository.' },
	create_pr: { description: 'Create a pull request for the fix.' },
} as const

type AgentAction = { name: keyof typeof AgentActions; description: string }

type Config = {
	buildUuid: string
	randomTag: string
	gitConfig: {
		branch: string
		repoURL: string
		repo: string
		owner: string
		ref: string
	}
}

type AgentState =
	| {
			status: 'queued'
			config: Config
	  }
	| {
			status: 'running'
			config: Config
			currentAction: AgentAction
	  }
	| {
			status: 'stopped'
			config: Config
			finalAction: AgentAction | null
			outcome: { type: 'success' } | { type: 'error'; error: unknown }
	  }

type ToolFunction = {
	description?: string
	parameters: z3.ZodSchema
	execute?: (args: any, options?: any) => Promise<any> | any
	[key: string]: any // Allow additional properties from the AI SDK
}
type DetectionTools = Record<string, ToolFunction>

export { AutofixAgent }

class AutofixAgent extends Agent<Env, AgentState> {
	// Agents API reference:
	// https://developers.cloudflare.com/agents/api-reference/agents-api/

	/**
	 * Context logger with tags added in the constructor so that we
	 * don't have to add tags in every method that's called via RPC.
	 */
	logger: typeof logger

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env)
		this.logger = logger
	}

	/**
	 * Start the agent
	 */
	@WithLogTags({ source: 'AutofixAgent', handler: 'start' })
	public async start({ buildUuid }: { buildUuid: string }) {
		this.logger = logger.withTags({
			state: {
				buildUuid,
			},
		})

		const workersBuilds = new WorkersBuildsClient({
			accountTag: this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG,
			apiToken: this.env.DEMO_CLOUDFLARE_API_TOKEN,
		})
		const buildMetadata = await workersBuilds.getBuildMetadata(buildUuid)
		const account = buildMetadata.result.build_trigger_metadata.provider_account_name
		const repo = buildMetadata.result.build_trigger_metadata.repo_name
		const commitSha = buildMetadata.result.build_trigger_metadata.commit_hash

		this.logger.info(`[AutofixAgent] Queueing agent for build ${buildUuid}`)
		this.setState({
			status: 'queued',
			config: {
				buildUuid,
				randomTag: crypto.randomUUID(),
				gitConfig: {
					branch: buildMetadata.result.build_trigger_metadata.branch,
					repoURL: `https://github.com/${account}/${repo}.git`,
					repo: repo,
					owner: account,
					ref: commitSha,
				},
			},
		})
		await this.schedule(datePlus('1 seconds'), 'autofix', 1)

		return {
			message: 'AutofixAgent queued.',
		}
	}

	@WithLogTags({ source: 'AutofixAgent', handler: 'autofix' })
	async autofix() {
		if (this.state.status !== 'queued') {
			logger.warn(`[AutofixAgent] Restarting after previous failure...`)
		}

		const actions = [
			{ name: 'initialize_container', handler: () => this.handleInitializeContainer() },
			{ name: 'fix_issues', handler: () => this.handleFixIssues() },
			{ name: 'commit_changes', handler: () => this.handleCommitChanges() },
			{ name: 'push_changes', handler: () => this.handlePushChanges() },
			{ name: 'create_pr', handler: () => this.handleCreatePr() },
		] as const

		let lastAction = null
		let lastError = null
		for (const action of actions) {
			try {
				lastAction = { name: action.name, ...AgentActions[action.name] }
				this.setState({ ...this.state, status: 'running', currentAction: lastAction })
				await action.handler()
			} catch (error) {
				console.error(`[AutofixAgent] error in ${action.name}: ${error}`)
				lastError = error
				break
			}
		}

		this.setState({
			...this.state,
			status: 'stopped',
			finalAction: lastAction,
			outcome: lastError === null ? { type: 'success' } : { type: 'error', error: lastError },
		})
	}

	// =========================== //
	// ===== Action Handlers ===== //
	// =========================== //

	async handleInitializeContainer(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleInitializeContainer')
		const { gitConfig } = this.state.config
		this.logger.info(`[AutofixAgent] Initializing container for repo: ${gitConfig.repoURL}`)

		// Start container, and destroy any active containers
		const userContainer = this.getContainer()
		await userContainer.initialize()

		// Create a fresh workdir for this build (since we are sharing container instances across builds for now)
		await userContainer.execCommand({
			command: 'rm',
			args: ['-rf', this.buildWorkDir()],
			cwd: '.',
		})
		await userContainer.execCommand({
			command: 'mkdir',
			args: ['-p', this.buildWorkDir()],
			cwd: '.',
		})

		// store the token in an in-memory git credential cache
		await userContainer.execCommand({
			command: 'git',
			args: ['config', '--global', 'credential.helper', 'cache'],
			cwd: this.buildWorkDir(),
		})
		const credentials = [
			'protocol=https',
			'host=github.com',
			'username=x-access-token',
			`password=${this.env.DEMO_GITHUB_TOKEN}`,
		].join('\n')
		await userContainer.execCommand({
			command: 'git',
			args: ['credential', 'approve'],
			cwd: this.buildWorkDir(),
			input: credentials,
		})

		// clone the repo
		await userContainer.execCommand({
			command: 'git',
			args: ['clone', gitConfig.repoURL, '.'],
			cwd: this.buildWorkDir(),
		})
		await userContainer.execCommand({
			command: 'git',
			args: ['checkout', gitConfig.ref],
			cwd: this.buildWorkDir(),
		})
		await userContainer.execCommand({
			command: 'git',
			args: ['config', '--global', 'user.name', 'cloudflare[bot]'],
			cwd: this.buildWorkDir(),
		})
		await userContainer.execCommand({
			command: 'git',
			args: ['config', '--global', 'user.email', '<>'],
			cwd: this.buildWorkDir(),
		})
		this.logger.info('[AutofixAgent] Container initialized.')
	}

	async handleFixIssues(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleFixIssues')
		this.logger.info('[AutofixAgent] Analyzing project type and fixing issues...')

		const docsTools = await experimental_createMCPClient({
			transport: {
				type: 'sse',
				url: 'https://docs.mcp.cloudflare.com/sse',
			},
		}).then((client) => client.tools())

		const tools = {
			...docsTools,
			listContainerFiles: tool({
				description: 'List files in the container. This requires no parameters',
				parameters: z3.object({}),
				execute: async () => {
					const files = await this.getContainer().execCommand({
						command: 'find',
						args: ['.'],
						cwd: this.buildWorkDir(),
					})
					return files.stdout
				},
			}),
			createFile: tool({
				description: 'Create a file in the container with the given path and contents',
				parameters: z3.object({ filePath: z3.string(), contents: z3.string() }),
				execute: async ({ filePath, contents }) => {
					await this.getContainer().writeFile({ filePath, cwd: this.buildWorkDir(), contents })
				},
			}),
			getFileContents: tool({
				description:
					'Get the contents of a file in the container. Can read any file given the path.',
				parameters: z3.object({ filePath: z3.string() }),
				execute: async ({ filePath }) => {
					return this.getContainer().readFile({
						cwd: this.buildWorkDir(),
						filePath,
					})
				},
			}),
			deleteFile: tool({
				description: 'Delete a file in the container with the given path',
				parameters: z3.object({ filePath: z3.string() }),
				execute: async ({ filePath }) => {
					await this.getContainer().execCommand({
						command: 'rm',
						args: ['-f', filePath],
						cwd: this.buildWorkDir(),
					})
					return { success: true, message: `File ${filePath} deleted successfully` }
				},
			}),
			installDependencies: tool({
				description: fmt.trim(`
					Install project dependencies using the appropriate package manager.
					Use the correct package manager based on lock files (npm, yarn, pnpm, or bun).

					Returns success status and any error details if the command fails.
				`),
				parameters: z3.object({ installCommand: z3.string() }),
				execute: async ({ installCommand }) => {
					try {
						await this.getContainer().execCommand({
							command: 'bash',
							args: ['-c', installCommand],
							cwd: this.buildWorkDir(),
						})
						return JSON.stringify({ success: true, message: 'Dependencies installed successfully' })
					} catch (error) {
						return JSON.stringify({
							success: false,
							error: error instanceof Error ? error.message : String(error),
							command: installCommand,
						})
					}
				},
			}),
			buildProject: tool({
				description: fmt.trim(`
					Builds the project using the specified command.
					Dependencies should be installed first using the installDependencies tool.

					Returns success status and any error details if the build fails.
				`),
				parameters: z3.object({ buildCommand: z3.string() }),
				execute: async ({ buildCommand }) => {
					try {
						await this.getContainer().execCommand({
							command: 'bash',
							args: ['-c', buildCommand],
							cwd: this.buildWorkDir(),
						})
						return JSON.stringify({ success: true, message: 'Project built successfully' })
					} catch (error) {
						return JSON.stringify({
							success: false,
							error: error instanceof Error ? error.message : String(error),
							command: buildCommand,
						})
					}
				},
			}),
		}

		const workersBuilds = new WorkersBuildsClient({
			accountTag: this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG,
			apiToken: this.env.DEMO_CLOUDFLARE_API_TOKEN,
		})
		const [metadata, logs] = await Promise.all([
			workersBuilds.getBuildMetadata(this.state.config.buildUuid),
			workersBuilds.getBuildLogs(this.state.config.buildUuid),
		])

		// Step 1: Detect if this has Pages-specific configurations that need migration
		const isPages = await this.detectIsPages(tools, metadata, logs)
		this.logger.info(`[AutofixAgent] Pages migration needed: ${isPages}`)

		// Step 2: Apply Workers-focused fix with optional Pages migration guidance
		const res = await this.generateWorkersFix(tools, metadata, logs, isPages)

		logger.info(`[AutofixAgent] generateText response`)
		console.log(res.text) // easier to read this way

		this.logger.info('[AutofixAgent] Issue fixing complete.')
	}

	private async detectIsPages(
		tools: DetectionTools,
		metadata: BuildResponse,
		logs: string
	): Promise<boolean> {
		const systemPrompt = createDetectionSystemPrompt()
		const userPrompt = createDetectionUserPrompt({ metadata, logs })

		const res = await generateText({
			model: GoogleModels.GeminiPro(),
			maxTokens: 20_000,
			maxSteps: 10,
			system: systemPrompt,
			prompt: userPrompt,
			tools,
		})

		try {
			const DetectionResult = z3.object({
				needsMigration: z3.boolean(),
				reasoning: z3.string(),
			})

			// sometimes the LLM adds backticks around the JSON and I can't get it to stop :shrug:
			const resText = res.text.replace(/^```json\n|```$/g, '')
			const parsed = DetectionResult.parse(JSON.parse(resText))
			this.logger.info(`[AutofixAgent] Migration analysis: ${parsed.reasoning}`)
			return parsed.needsMigration
		} catch (e) {
			this.logger.warn(
				`[AutofixAgent] Failed to parse migration detection response, defaulting to false: ${e}`
			)
			return false
		}
	}

	private async generateWorkersFix(
		tools: DetectionTools,
		metadata: BuildResponse,
		logs: string,
		isPages: boolean
	) {
		// Extract repo name from metadata for the prompt
		const repoName = metadata.result.build_trigger_metadata.repo_name

		const systemPrompt = createFixGenerationSystemPrompt(isPages)
		const userPrompt = createFixGenerationUserPrompt({
			metadata,
			logs,
			isPages,
			repoName,
		})

		return generateText({
			model: GoogleModels.GeminiPro(),
			maxTokens: 50_000,
			maxSteps: 20,
			system: systemPrompt,
			prompt: userPrompt,
			onStepFinish: async ({ toolCalls }) => {
				this.logger.log(
					`[AutofixAgent] step finished. tools: ${JSON.stringify(toolCalls.map((call) => call.toolName))}`
				)
			},
			tools,
		})
	}

	async handleCommitChanges(): Promise<void> {
		const userContainer = this.getContainer()
		await userContainer.execCommand({
			command: 'git',
			args: ['checkout', '-b', this.getAutofixBranch()],
			cwd: this.buildWorkDir(),
		})
		await userContainer.execCommand({
			command: 'git',
			args: ['add', '.'],
			cwd: this.buildWorkDir(),
		})
		await userContainer.execCommand({
			command: 'git',
			args: ['commit', '-m', 'Autofix Agent fixes'],
			cwd: this.buildWorkDir(),
		})
		this.logger.info('[AutofixAgent] Changes committed.')
	}

	async handlePushChanges(): Promise<void> {
		const userContainer = this.getContainer()
		await userContainer.execCommand({
			command: 'git',
			args: ['push', '-u', 'origin', this.getAutofixBranch()],
			cwd: this.buildWorkDir(),
		})
		this.logger.info('[AutofixAgent] Changes pushed.')
	}

	async handleCreatePr(): Promise<void> {
		const res = await new GitHubClient(this.env.DEMO_GITHUB_TOKEN).createPullRequest({
			base: this.state.config.gitConfig.branch,
			title: '[Autofix] Your fixed changes!',
			owner: this.state.config.gitConfig.owner,
			repo: this.state.config.gitConfig.repo,
			head: this.getAutofixBranch(),
		})
		this.logger.info('[AutofixAgent] PR created.')
		this.logger.info(`[AutofixAgent] PR URL -> ${res.url}`)
	}

	private getContainer() {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG)
		return this.env.USER_CONTAINER.get(userContainerId)
	}

	private buildWorkDir() {
		return `build-${this.state.config.buildUuid}`
	}

	private getAutofixBranch() {
		return `autofix-${this.state.config.buildUuid}-${this.state.config.randomTag}`
	}
}
