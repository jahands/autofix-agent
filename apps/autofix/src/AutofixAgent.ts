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
			- functions/ directory (Pages Functions - requires compilation with 'wrangler pages functions build')
			- Build errors specifically mentioning Pages deployment patterns
			- Configuration showing Pages-specific build outputs
			- Error messages about functions/ folder deployment or Pages Functions routing

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
			- CRITICAL DEPLOYMENT RULE: Use 'wrangler deploy' for deployment, NEVER 'wrangler pages deploy'
			- NEVER suggest or use any Pages-specific deployment commands (wrangler pages deploy, etc.)
			- This is a Workers project, not a Pages project - all deployment must use Workers commands
			- DO NOT modify existing build scripts in package.json unless absolutely necessary
			- DO NOT add "engines" fields to package.json unless the build explicitly fails due to Node.js version incompatibility
			- DO NOT add unnecessary flags to wrangler commands in package.json scripts - configuration should be in wrangler.jsonc
			- When updating scripts from 'wrangler pages dev' to 'wrangler dev', use simple commands without redundant flags
			- Example: "wrangler pages dev" → "wrangler dev" (NOT "wrangler dev ./dist/_worker.js --local --assets ./dist")
			- Focus on the actual build failure, not on potential improvements or optimizations
			- Only make changes that are directly required to fix the specific build error
			- CRITICAL: For static assets, use Workers Assets format: [assets] directory = "path" or "assets": {"directory": "path"}
			- NEVER use the deprecated Workers Sites format: [site] bucket = "path" (this is outdated and unsupported)
			- IMPORTANT: If a wrangler.toml file exists, migrate it to wrangler.jsonc format for better maintainability
			- CRITICAL ASSETS HANDLING: If the build output contains a _worker.js file (common in Pages projects), create a .assetsignore file containing "_worker.js" to prevent uploading server-side code as a static asset
			- The .assetsignore file should be created in the project root and copied to the assets output directory during the build process
			- Update build commands to include copying .assetsignore to the output directory before running 'wrangler deploy'
			- CRITICAL functions/ DIRECTORY: If a functions/ directory exists, integrate 'wrangler pages functions build --outdir=./dist/worker/' into package.json build scripts
			- Functions compilation must happen after static asset building but before deployment

			CRITICAL BINDING MANAGEMENT RULES:
			- DO NOT add KV namespace, D1 database, R2 bucket, or other service bindings to wrangler.jsonc unless the build explicitly fails due to missing bindings
			- NEVER add placeholder binding IDs (like "preview_id": "placeholder" or "id": "your-kv-namespace-id") as these create invalid configurations
			- Astro projects may log session-related messages mentioning KV stores - these are informational and do NOT require adding KV bindings
			- Only add bindings when there are explicit import/usage errors in the code that reference undefined binding variables
			- If you must add a binding, use proper resource names and leave ID fields empty with comments explaining they need to be configured
			- Remember: wrangler.jsonc files support JavaScript-style comments (// and /* */) for documentation
			- Bindings should only be added if the code explicitly imports or uses them (e.g., env.MY_KV_NAMESPACE, platform.env.DATABASE)
			- Log messages about sessions, caching, or storage are usually framework-level and don't require binding configuration
		`)

		const migrationGuidelines = isPages
			? fmt.trim(`
			- IMPORTANT: This project appears to have Cloudflare Pages-specific configurations that need migration
			- CRITICAL MIGRATION RULE: Migrate FROM Pages TO Workers - use 'wrangler deploy', NEVER 'wrangler pages deploy'
			- This migration is FROM Pages TO Workers, not the other way around
			- Any build scripts that use 'wrangler pages deploy' must be changed to 'wrangler deploy'
			- Change 'wrangler pages dev' to 'wrangler dev' in preview/dev scripts (without adding unnecessary flags)
			- DO NOT add redundant command-line flags that duplicate wrangler.jsonc configuration
			- CRITICAL functions/ DIRECTORY MIGRATION: If the project has a functions/ directory (Pages Functions):
				* Update package.json build script to include: 'wrangler pages functions build --outdir=./dist/worker/'
				* Update wrangler.jsonc main field to point to the compiled script: "main": "./dist/worker/index.js"
				* The compiled Worker script will handle all the routing that was previously done by the functions/ folder
				* Example package.json script update:
					- Before: "build": "npm run build:client"
					- After: "build": "npm run build:client && wrangler pages functions build --outdir=./dist/worker/"
				* Example wrangler.jsonc configuration:
					{
						"name": "my-worker",
						"main": "./dist/worker/index.js",
						"assets": {"directory": "./dist/client/"}
					}
				* The functions compilation must happen BEFORE 'wrangler deploy' in the deployment process
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
			- CRITICAL: During migration, do NOT add service bindings (KV, D1, R2) unless the code explicitly requires them
			- Pages projects may have had implicit bindings - only migrate bindings that are actually used in the code
			- CRITICAL _worker.js HANDLING: Pages projects often generate _worker.js files in the build output
				* Create a .assetsignore file in the project root containing "_worker.js" to prevent uploading server-side code as static assets
				* Update build scripts to copy .assetsignore to the assets output directory before deployment
				* Example build command: "npm run build && cp .assetsignore ./dist/ && wrangler deploy"
				* This prevents the error: "Uploading a Pages _worker.js directory as an asset"
			- DEPLOYMENT: Always use 'wrangler deploy' for the final deployment, never Pages commands
			- Reference both Pages migration docs and Workers static assets docs
		`)
			: ''

		const workersPrompt = fmt.trim(`
			Goal:
				- Fix the build failure for this Cloudflare Workers project

			Guidelines:
				${baseGuidelines}
				${migrationGuidelines}

			CRITICAL DEPLOYMENT INSTRUCTIONS:
				- This project will be deployed using 'wrangler deploy' command
				- NEVER use 'wrangler pages deploy' or any Pages-specific deployment commands
				- If you find any build scripts using 'wrangler pages deploy', change them to 'wrangler deploy'
				- This is a Workers project, not a Pages project - all deployment must use Workers commands

			Notes:
				- The target deployment platform is Cloudflare Workers (with static assets support)
				- Use the search_cloudflare_documentation tool to find docs for Workers deployment${isPages ? ' and Pages-to-Workers migration' : ''} when proposing changes
				- Prefer wrangler.jsonc over wrangler.toml for configuration files (jsonc supports comments for better documentation)
				- Workers projects should have a wrangler.toml, wrangler.json, or wrangler.jsonc configuration file
				- JSONC files (.jsonc) support JavaScript-style comments (// single-line and /* multi-line */) for documentation
				- When working with wrangler.jsonc, you can add explanatory comments to help developers understand configuration
				- CRITICAL: Only add service bindings (KV, D1, R2, etc.) when the code explicitly uses them and build fails due to missing bindings
				- DO NOT add redundant command-line flags to wrangler commands in package.json - configuration belongs in wrangler.jsonc
				- Keep package.json scripts simple: use "wrangler dev" and "wrangler deploy" without unnecessary flags
				- Framework log messages (especially from Astro) about sessions or storage are informational - they don't require adding bindings
				- CRITICAL _worker.js HANDLING: If you encounter the error "Uploading a Pages _worker.js directory as an asset", create a .assetsignore file containing "_worker.js" and copy it to the assets output directory during build
				- Always check for _worker.js files in build outputs and handle them appropriately to prevent security issues
				- CRITICAL functions/ DIRECTORY HANDLING: If you detect a functions/ directory, update package.json build scripts to include 'wrangler pages functions build --outdir=./dist/worker/' and update wrangler.jsonc main field to point to the compiled script
				- Functions compilation must be integrated into the build process, not run as a separate step
				${isPages ? '- If migrating from Pages, explain the equivalent Workers patterns for any Pages-specific features' : ''}
				${isPages ? '- Remember: this is a migration FROM Pages TO Workers, so use Workers deployment commands' : ''}

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
			system: `You are an expert at debugging Cloudflare Workers deployment failures${isPages ? ' and migrating Pages projects to Workers' : ''}.`,
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
