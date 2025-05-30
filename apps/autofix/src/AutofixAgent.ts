import { Agent } from 'agents'
import { datePlus } from 'itty-time'
import { WithLogTags } from 'workers-tagged-logger/ts5'
import { z as z3 } from 'zod/v3'

import { logger } from './logger'

import type { AgentContext } from 'agents'
import type { Env } from './autofix.context'
import { WorkersBuildsClient } from './workersBuilds'
import { experimental_createMCPClient, tool, generateText } from 'ai'
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

type BuildMetadata = Awaited<ReturnType<WorkersBuildsClient['getBuildMetadata']>>
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
			deleteFile: tool({
				description: 'Delete a file in the container with the given path',
				parameters: z3.object({ filePath: z3.string() }),
				execute: async ({ filePath }) => {
					await this.deleteFile(filePath)
					return { success: true, message: `File ${filePath} deleted successfully` }
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
		metadata: BuildMetadata,
		logs: string
	): Promise<boolean> {
		const detectionPrompt = fmt.trim(`
			You are analyzing a project to determine if it has Cloudflare Pages-specific configurations that need to be migrated to Cloudflare Workers equivalents.

			Since Cloudflare Workers now supports static assets hosting, all projects will be deployed as Workers, but projects originally designed for Pages may need configuration migration.

			**Analysis Strategy:**
			1. **First, analyze the provided build logs and metadata** for specific Cloudflare Pages indicators:
				- Error messages like "It looks like you've run a Workers-specific command in a Pages project"
				- References to "wrangler pages deploy" or "pages deploy"
				- Mentions of "pages_build_output_dir" in configuration or errors
				- Specific Pages error messages about "functions/" deployment or Pages Functions
				- Build configuration explicitly showing Pages-specific settings

			2. **Only use file analysis tools if the logs/metadata are inconclusive** and you need to examine:
				- Wrangler configuration files (wrangler.toml, wrangler.json, wrangler.jsonc) for "pages_build_output_dir"
				- Project root for functions/ directory (Pages Functions)
				- Package.json and build scripts for Pages-specific patterns

			**Specific Cloudflare Pages Indicators to Look For:**
			- Wrangler config with "pages_build_output_dir" (should migrate to Workers Assets format)
			- Error: "It looks like you've run a Workers-specific command in a Pages project"
			- References to "wrangler pages deploy" instead of "wrangler deploy"
			- functions/ directory (Pages Functions - need migration to Worker patterns)
			- Build errors specifically mentioning Pages deployment patterns
			- Configuration showing Pages-specific build outputs

			**Note: _headers and _redirects files are supported in Workers Assets and do NOT require migration**

			**Instructions:**
			- Start by carefully analyzing the build logs and metadata below
			- Look for SPECIFIC Cloudflare Pages-related errors and configuration, not just the word "Pages"
			- If you find clear evidence of Cloudflare Pages usage, you can conclude without file analysis
			- Only use tools like listContainerFiles() and getFileContents() if you need additional information
			- Be efficient - don't list files unnecessarily

			After your analysis, respond with ONLY a valid JSON object in this exact format:
			{
				"needsMigration": boolean,
				"reasoning": "Brief explanation of why migration is or is not needed based on specific evidence found"
			}

			Build configuration:
			${JSON.stringify(metadata, null, 2)}

			Build logs:
			${logs}
		`)

		const res = await generateText({
			model: GoogleModels.GeminiPro(),
			maxTokens: 20_000,
			maxSteps: 10,
			system:
				'You are an expert at identifying Cloudflare Pages configurations that need migration to Workers. Respond only with valid JSON.',
			prompt: detectionPrompt,
			tools,
		})

		try {
			const IsPagesResult = z3.object({
				needsMigration: z3.boolean(),
				reasoning: z3.string(),
			})

			// sometimes the LLM adds backticks around the JSON and I can't get it to stop :shrug:
			const resText = res.text.replace(/^```json\n|```$/g, '')
			const parsed = IsPagesResult.parse(JSON.parse(resText))
			this.logger.info(`[AutofixAgent] Migration analysis: ${parsed.reasoning}`)
			return parsed.needsMigration
		} catch (error) {
			this.logger.warn(
				`[AutofixAgent] Failed to parse migration detection response, defaulting to false: ${error}`
			)
			return false
		}
	}

	private async generateWorkersFix(
		tools: DetectionTools,
		metadata: BuildMetadata,
		logs: string,
		isPages: boolean
	) {
		const baseGuidelines = fmt.trim(`
			- This project will be deployed as a Cloudflare Worker (with static assets support if needed)
			- You have tools available to you, call them as many times as you need
			- You MUST update the files to fix the issue
			- IMPORTANT: Always install dependencies first using the installDependencies tool before attempting to build
			- Detect the correct package manager by checking for lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lockb)
			- After making changes and installing dependencies, run buildProject to verify the project can be built successfully
			- The command must always include 'npx wrangler build' to ensure proper Workers deployment
			- DO NOT modify existing build scripts in package.json unless absolutely necessary
			- DO NOT add "engines" fields to package.json unless the build explicitly fails due to Node.js version incompatibility
			- Focus on the actual build failure, not on potential improvements or optimizations
			- Only make changes that are directly required to fix the specific build error
			- CRITICAL: For static assets, use Workers Assets format: [assets] directory = "path" or "assets": {"directory": "path"}
			- NEVER use the deprecated Workers Sites format: [site] bucket = "path" (this is outdated and unsupported)
			- IMPORTANT: If a wrangler.toml file exists, migrate it to wrangler.jsonc format for better maintainability
		`)

		const migrationGuidelines = isPages
			? fmt.trim(`
			- IMPORTANT: This project appears to have Cloudflare Pages-specific configurations that need migration
			- Migrate functions/ directory (Pages Functions) to standard Worker script patterns
			- Update any Pages-specific build configurations to Workers equivalents
			- CRITICAL: Migrate Pages wrangler configuration to Workers Assets format (NOT Workers Sites):
				* Replace "pages_build_output_dir" with "assets": {"directory": "path"}
				* Example: pages_build_output_dir = "./build/client" → "assets": {"directory": "./build/client"}
				* NEVER use the old Workers Sites format: [site] bucket = "path" (this is deprecated)
				* ALWAYS use the new Workers Assets format: [assets] directory = "path" or "assets": {"directory": "path"}
				* If using wrangler.toml, convert the entire configuration to wrangler.jsonc format
				* Delete the old wrangler.toml file after creating the new wrangler.jsonc
			- Ensure static assets are properly configured for Workers static assets hosting
			- NOTE: _headers and _redirects files are supported in Workers Assets and can remain as-is
			- Remove Pages-specific configurations that don't apply to Workers
			- Reference both Pages migration docs and Workers static assets docs
		`)
			: ''

		const workersPrompt = fmt.trim(`
			Goal:
				- Fix the build failure for this Cloudflare Workers project

			Guidelines:
				${baseGuidelines}
				${migrationGuidelines}

			Note:
				- The target deployment platform is Cloudflare Workers (with static assets support)
				- Use the search_cloudflare_documentation tool to find docs for Workers deployment${isPages ? ' and Pages-to-Workers migration' : ''} when proposing changes
				- Prefer json over toml for configuration files
				- Workers projects should have a wrangler.toml or wrangler.json configuration file
				${isPages ? '- If migrating from Pages, explain the equivalent Workers patterns for any Pages-specific features' : ''}

			Final output should contain these 3 sections. Formatted nicely for a Pull Request:
				- describe the project and why it failed to deploy${isPages ? ' (mention if Pages migration was needed)' : ''}
				- describe the relevant Cloudflare Workers docs for deploying this type of project${isPages ? ' and any Pages migration steps' : ''}
				- summarize the fix${isPages ? ' and migration changes' : ''}

			Assume the worker shares the same name as the git repo.

			Here is the build configuration:
			${JSON.stringify(metadata, null, 2)}

			Here are the full build logs:
			${logs}
		`)

		return generateText({
			model: GoogleModels.GeminiPro(),
			maxTokens: 50_000,
			maxSteps: 20,
			system: `You are an expert at debugging Cloudflare Workers deployment failures${isPages ? ' and migrating Pages projects to Workers' : ''}`,
			prompt: workersPrompt,
			onStepFinish: async ({ toolCalls }) => {
				this.logger.log(
					`[AutofixAgent] step finished. tools: ${JSON.stringify(toolCalls.map((call) => call.toolName))}`
				)
			},
			tools,
		})
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

	async deleteFile(filePath: string) {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEMO_CLOUDFLARE_ACCOUNT_TAG)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		await userContainer.container_exec({
			command: `rm -f "${filePath}"`,
			cwd: this.buildWorkDir(),
		})
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
