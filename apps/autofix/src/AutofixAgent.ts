import { Agent } from 'agents'
import { datePlus } from 'itty-time'
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

		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG)
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
			command: `git clone ${gitConfig.repoURL} .`,
			cwd: this.buildWorkDir(),
		})
		await userContainer.container_exec({
			command: `git checkout ${gitConfig.ref}`,
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

	async handleFixIssues(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleFixIssues')
		this.logger.info('[AutofixAgent] Fixing issues...')

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
			installDependencies: tool({
				description: fmt.trim(`
					Install project dependencies using the appropriate package manager.
					Detects and uses the correct package manager based on lock files:
					- npm (package-lock.json)
					- yarn (yarn.lock)
					- pnpm (pnpm-lock.yaml)
					- bun (bun.lockb)

					Example:
					installCommand: "npm install" or "yarn install" or "pnpm install" or "bun install"

					Returns success status and any error details if the command fails.
				`),
				parameters: z3.object({ installCommand: z3.string() }),
				execute: async ({ installCommand }) => {
					try {
						await this.installDependencies(installCommand)
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
					IMPORTANT: Dependencies should be installed first using the installDependencies tool.
					If a package.json exists with a build script, it will be used.
					The command must always include 'npx wrangler build' to ensure proper Workers deployment.

					Example:
					buildCommand: "npm run build && npx wrangler build"

					Returns success status and any error details if the build fails.
				`),
				parameters: z3.object({ buildCommand: z3.string() }),
				execute: async ({ buildCommand }) => {
					try {
						await this.buildProject(buildCommand)
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

		const fixItPrompt = fmt.trim(`
			Goal:
				- Fix the build failure given the logs and configuration provided below

			Guidelines:
				- You have tools available to you, call them as many times as you need
				- Infer what type of project the user intends to deploy based on the provided repository structure and contents
				- If you can't find any code, then assume the repo is a static website that should be deployed directly
				- You MUST update the files to fix the issue
				- IMPORTANT: Always install dependencies first using the installDependencies tool before attempting to build
				- Detect the correct package manager by checking for lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb)
				- After making changes and installing dependencies, run buildProject to verify the project can be built successfully
				- DO NOT modify existing build scripts in package.json unless absolutely necessary - proper dependency installation should resolve "command not found" errors
				- Avoid using "pnpm exec", "npm exec", or "yarn exec" in build scripts - these are unnecessary if dependencies are properly installed
				- DO NOT add "engines" fields to package.json unless the build explicitly fails due to Node.js version incompatibility
				- Focus on the actual build failure, not on potential improvements or optimizations
				- Only make changes that are directly required to fix the specific build error

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

		this.logger.info('[AutofixAgent] Issue fixing complete.')
	}

	async handleCommitChanges(): Promise<void> {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG)
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
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		await userContainer.container_exec({
			command: `git push -u origin ${this.getAutofixBranch()}`,
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

	// ========================== //
	// ==== Container Helpers ==== //
	// ========================== //

	async pingContainer() {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		const pong = await userContainer.container_ping()
		return { res: pong }
	}

	async listContainerFiles() {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		const { resources } = await userContainer.container_ls(this.buildWorkDir())
		return { resources }
	}

	async createFile(filePath: string, content: string) {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		await userContainer.container_file_write({
			cwd: this.buildWorkDir(),
			filePath,
			text: content,
		})
	}

	async getFileContents(filePath: string) {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		const contents = await userContainer.container_file_read({
			cwd: this.buildWorkDir(),
			filePath,
		})
		return contents
	}

	async buildProject(buildCommand: string) {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		return userContainer.container_exec({
			command: buildCommand,
			cwd: this.buildWorkDir(),
		})
	}

	async installDependencies(installCommand: string) {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		return userContainer.container_exec({
			command: installCommand,
			cwd: this.buildWorkDir(),
		})
	}

	private buildWorkDir() {
		return `build-${this.state.config.buildUuid}`
	}

	private getAutofixBranch() {
		return `autofix-${this.state.config.buildUuid}-${this.state.config.randomTag}`
	}
}
