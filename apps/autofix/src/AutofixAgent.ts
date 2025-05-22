import { Agent } from 'agents'
import { WithLogTags } from 'workers-tagged-logger/ts5'
import { z as z3 } from 'zod/v3'

import { logger } from './logger'

import type { AgentContext } from 'agents'
import type { Env } from './autofix.context'
import { WorkersBuildsClient } from './workersBuilds'
import { experimental_createMCPClient, tool } from 'ai'
import { generateText } from 'ai'
import { GoogleModels } from './ai-models'
import { fmt } from './format'
import { GitHubClient } from './github'

type BuildConfig = {
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

type AgentAction =
	| 'initialize_container'
	| 'fix_issues'
	| 'commit_changes'
	| 'push_changes'
	| 'create_pr'

type AgentState = {
	buildConfig: BuildConfig
	status:
		| {
				type: 'queued'
		  }
		| {
				type: 'running'
				currentAction: AgentAction
		  }
		| {
				type: 'stopped'
				finalAction: AgentAction
				outcome: { type: 'success' } | { type: 'error'; error: string }
		  }
}

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

		// TODO throw an error if the agent was already started

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
			status: { type: 'queued' },
			buildConfig: {
				randomTag: crypto.randomUUID(),
				buildUuid,
				gitConfig: {
					branch: buildMetadata.result.build_trigger_metadata.branch,
					repoURL: `https://github.com/${account}/${repo}.git`,
					repo: repo,
					owner: account,
					ref: commitSha,
				},
			},
		})

		// Schedule a task to fix the build in the background
		await this.schedule(new Date(Date.now() + 1000), 'autofixBuild')
	}
	@WithLogTags({ source: 'AutofixAgent', handler: 'autofixBuild' })
	async autofixBuild() {
		this.logger
			.withFields({
				agentState: this.state,
			})
			.info('[AutofixAgent] autofixBuild started')

		let currentAction: AgentAction = 'initialize_container'
		this.setState({
			...this.state,
			status: { type: 'running', currentAction },
		})
		try {
			await this.handleInitializeContainer()

			currentAction = 'fix_issues'
			this.setState({
				...this.state,
				status: { type: 'running', currentAction },
			})
			await this.handleDetectIssues()

			currentAction = 'commit_changes'
			this.setState({
				...this.state,
				status: { type: 'running', currentAction },
			})
			await this.handleCommitChanges()

			currentAction = 'push_changes'
			this.setState({
				...this.state,
				status: { type: 'running', currentAction },
			})
			await this.handlePushChanges()

			currentAction = 'create_pr'
			this.setState({
				...this.state,
				status: { type: 'running', currentAction },
			})
			await this.handleCreatePr()

			this.setState({
				...this.state,
				status: { type: 'stopped', finalAction: currentAction, outcome: { type: 'success' } },
			})
		} catch (error) {
			this.setState({
				...this.state,
				status: {
					type: 'stopped',
					finalAction: currentAction,
					outcome: { type: 'error', error: String(error) },
				},
			})
		}
	}

	// =========================== //
	// ===== Action Handlers ===== //
	// =========================== //

	async handleInitializeContainer(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleInitializeContainer')
		const { buildConfig } = this.state
		this.logger.info(
			`[AutofixAgent] Initializing container for repo: ${buildConfig.gitConfig.repoURL}`
		)

		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)

		// Start container, and destroy any active containers
		await userContainer.container_initialize()

		// Create a fresh workdir for this build (since we are sharing container instances across builds for now)
		await userContainer.container_exec({
			command: `rm -rf ${this.buildWorkDir()} || true`,
			cwd: '.',
		})
		await userContainer.container_exec({ command: `mkdir -p ${this.buildWorkDir()}`, cwd: '.' })

		// Clone the code
		await userContainer.container_exec({
			command: `git config --global url.https://${this.env.DEMO_GITHUB_TOKEN}@github.com.insteadOf https://github.com`,
			cwd: this.buildWorkDir(),
		})
		await userContainer.container_exec({
			command: `git clone ${buildConfig.gitConfig.repoURL} .`,
			cwd: this.buildWorkDir(),
		})
		await userContainer.container_exec({
			command: `git checkout ${buildConfig.gitConfig.ref}`,
			cwd: this.buildWorkDir(),
		})
		await userContainer.container_exec({
			command: `git config --global user.name 'cloudflare[bot]'`,
			cwd: this.buildWorkDir(),
		})
		await userContainer.container_exec({
			command: "git config --global user.email '<>'",
			cwd: this.buildWorkDir(),
		})
		this.logger.info('[AutofixAgent] Container initialized.')
	}

	async handleDetectIssues(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleDetectIssues')
		this.logger.info('[AutofixAgent] Detecting issues...')

		const docsTools = await experimental_createMCPClient({
			transport: {
				type: 'sse',
				url: 'https://docs.mcp.cloudflare.com/sse',
			},
		}).then((client) => client.tools())

		const tools = {
			...docsTools,
			listContainerFiles: tool({
				description: 'List files in container',
				parameters: z3.object({}),
				execute: async () => {
					const files = await this.listContainerFiles()
					return { files }
				},
			}),
			createFile: tool({
				description: 'Create a file in the container with the given path and text',
				parameters: z3.object({ filePath: z3.string(), text: z3.string() }),
				execute: async ({ filePath, text }) => {
					await this.createFile(filePath, text)
				},
			}),
			getFileContents: tool({
				description:
					'Get the contents of a file in the container. Can read any file given the path.',
				parameters: z3.object({ filePath: z3.string() }),
				execute: async ({ filePath }) => {
					const contents = await this.getFileContents(filePath)
					return { contents }
				},
			}),
		}

		const workersBuilds = new WorkersBuildsClient({
			accountTag: this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG,
			apiToken: this.env.DEMO_CLOUDFLARE_API_TOKEN,
		})
		const [metadata, logs] = await Promise.all([
			workersBuilds.getBuildMetadata(this.state.buildConfig.buildUuid),
			workersBuilds.getBuildLogs(this.state.buildConfig.buildUuid),
		])

		const fixItPrompt = fmt.trim(`
			Goal:
				- Fix the build failure given the logs and configuration provided below

			Guidelines:
				- You have tools available to you, call them as many times as you need
				- Infer what type of project the user intends to deploy based on the provided repository structure and contents
				- If you can't find any code, then assume the repo is a static website that should be deployed directly
				- You MUST update the files to fix the issue

			 Note:
				- The target deployment platform is Cloudflare Workers
				- Use the search_cloudflare_documentation tool to find docs for the given project type when proposing changes. Include a link when possible.
				- Prefer json over toml for configuration files

			Final output should contain these 3 sections. Formatted nicely for a Pull Request:
				- describe the project and why it failed to deploy
				- describe the relevant docs for deploying this type of project
				- summarize the fix

			Assume the worker shares the same name as the git repo.

			Here is the build configuration:
			${JSON.stringify(metadata, null, 2)}

			Here are the full build logs:
			${logs}
		`)

		const res = await generateText({
			model: GoogleModels.GeminiPro(),
			maxTokens: 50_000,
			maxSteps: 10,
			system: 'You are an expert at debugging CI failures',
			prompt: fixItPrompt,
			onStepFinish: async ({ toolCalls }) => {
				this.logger.log(
					`[AutofixAgent] step finished. tools: ${JSON.stringify(toolCalls.map((call) => call.toolName))}`
				)
			},
			tools,
		})

		logger.info(`[AutofixAgent] generateText response`)
		console.log(res.text) // easier to read this way

		this.logger.info('[AutofixAgent] Issue detection complete.')
	}

	async handleFixIssues(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleFixIssues')
		this.logger.info('[AutofixAgent] Mock: Fixing issues...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.logger.info('[AutofixAgent] Issue fixing complete.')
	}

	async handleCommitChanges(): Promise<void> {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		await userContainer.container_exec({
			command: `git checkout -b ${this.getAutofixBranch()}`,
			cwd: this.buildWorkDir(),
		})
		await userContainer.container_exec({
			command: 'git add .',
			cwd: this.buildWorkDir(),
		})
		await userContainer.container_exec({
			command: 'git commit -m "Autofix Agent fixes"',
			cwd: this.buildWorkDir(),
		})
		this.logger.info('[AutofixAgent] Changes committed.')
	}

	async handlePushChanges(): Promise<void> {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		await userContainer.container_exec({
			command: `git push -u origin ${this.getAutofixBranch()}`,
			cwd: this.buildWorkDir(),
		})
		this.logger.info('[AutofixAgent] Changes pushed.')
	}

	async handleCreatePr(): Promise<void> {
		const res = await new GitHubClient(this.env.DEMO_GITHUB_TOKEN).createPullRequest({
			base: this.state.buildConfig.gitConfig.branch,
			title: '[Autofix] Your fixed changes!',
			owner: this.state.buildConfig.gitConfig.owner,
			repo: this.state.buildConfig.gitConfig.repo,
			head: this.getAutofixBranch(),
		})
		this.logger.info('[AutofixAgent] PR created.')
		this.logger.info(`[AutofixAgent] PR URL -> ${res.url}`)
	}

	// ========================== //
	// ==== Container Helpers ==== //
	// ========================== //

	async pingContainer() {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		const pong = await userContainer.container_ping()
		return { res: pong }
	}

	async listContainerFiles() {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		const { resources } = await userContainer.container_ls(this.buildWorkDir())
		return { resources }
	}

	async createFile(filePath: string, content: string) {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		await userContainer.container_file_write({
			cwd: this.buildWorkDir(),
			filePath,
			text: content,
		})
	}

	async getFileContents(filePath: string) {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		const contents = await userContainer.container_file_read({
			cwd: this.buildWorkDir(),
			filePath,
		})
		return contents
	}

	private buildWorkDir() {
		return `build-${this.state.buildConfig.buildUuid}`
	}

	private getAutofixBranch() {
		return `autofix-${this.state.buildConfig.buildUuid}-${this.state.buildConfig.randomTag}`
	}
}
