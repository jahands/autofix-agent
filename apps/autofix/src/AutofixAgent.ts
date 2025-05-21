import { Agent } from 'agents'
import { datePlus } from 'itty-time'
import { match } from 'ts-pattern'
import { WithLogTags } from 'workers-tagged-logger/ts5'
import { z } from 'zod/v4'
import { z as z3 } from 'zod/v3'

import { logger } from './logger'

import type { AgentContext } from 'agents'
import type { Env } from './autofix.context'
import { WorkersBuildsClient } from './workersBuilds'
import { tool } from 'ai'
import { generateText } from 'ai'
import { GoogleModels } from './ai-models'
import { workersPrompt } from './autofix.prompts'
import { fmt } from './format'

/**
 * The status of the agent. This allows us to easily determine the
 * state of the agent without inspecting the state of it's actions.
 */
const AgentStatuses = [
	{ name: 'queued', description: 'Agent is queued and waiting to start.' },
	{ name: 'running', description: 'Agent is running and processing actions.' },
	{ name: 'stopped', description: 'Agent has stopped running.' },
] as const satisfies Array<{
	name: string
	description: string
}>

const AgentStatus = z.enum(AgentStatuses.map((a) => a.name))
type AgentStatus = z.infer<typeof AgentStatus>

/**
 * Actions/steps that the agent will take. In theory, we could
 * support the agent taking these actions in any order, but
 * right now they are taken in the order listed here.
 */
const AgentActions = [
	{ name: 'initialize_container', description: 'Initialize the container for the repository.' },
	{
		name: 'detect_issues',
		description: 'Detect issues in the project using build logs and configuration.',
	},
	{
		name: 'fix_issues',
		description: 'Attempt to fix detected issues using an AI model to generate a patch.',
	},
	{ name: 'commit_changes', description: 'Commit the applied fix to a new branch.' },
	{
		name: 'push_changes',
		description: 'Push the new branch with the fix to the remote repository.',
	},
	{ name: 'create_pr', description: 'Create a pull request for the fix.' },
] as const satisfies Array<{
	name: string
	description: string
}>

const AgentAction = z.enum(AgentActions.map((a) => a.name))
type AgentAction = z.infer<typeof AgentAction>

/**
 * The status of an action that the agent is taking.
 */
const ActionStatuses = [
	{ name: 'queued', description: 'Action is queued and waiting to start.' },
	{ name: 'running', description: 'Action is running and processing.' },
	{ name: 'stopped', description: 'Action has stopped running.' },
] as const satisfies Array<{
	name: string
	description: string
}>
const ActionStatus = z.enum(ActionStatuses.map((a) => a.name))
type ActionStatus = z.infer<typeof ActionStatus>

type AgentState = {
	buildUuid: string
	gitConfig: {
		repo: string
		ref: string
	}
	agentStatus: AgentStatus
	/**
	 * We currently only support one action at a time, which is tracked here.
	 */
	currentAction: {
		action: AgentAction
		status: ActionStatus
		/**
		 * If the action failed, this will contain the error details.
		 */
		error?: { message: string }
	}
}

export { AutofixAgent }

@EnsureAgentActions(AgentActions.map((a) => a.name))
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
			buildUuid,
			gitConfig: {
				repo: `https://github.com/${account}/${repo}.git`,
				ref: commitSha,
			},
			agentStatus: 'queued',
			currentAction: { action: 'initialize_container', status: 'queued' },
		})

		// All further logic is handled in onAgentAlarm
		await this.setNextAlarm()

		return {
			buildUuid: this.state.buildUuid,
			gitConfig: this.state.gitConfig,
			agentStatus: this.state.agentStatus,
			currentAction: this.state.currentAction,
			message: 'AutofixAgent queued.',
		}
	}

	@WithLogTags({ source: 'AutofixAgent', handler: 'onAgentAlarm' })
	async onAgentAlarm(): Promise<void> {
		this.logger
			.withFields({
				agentState: this.state,
			})
			.info('[AutofixAgent] Alarm triggered.')

		// handle Agent statuses
		const isStopped = await match(this.state.agentStatus)
			.returnType<Promise<boolean>>()
			.with('queued', async () => {
				this.logger.info('[AutofixAgent] Agent is queued. Transitioning to running.')
				this.setState({
					...this.state,
					agentStatus: 'running',
				})
				await this.setNextAlarm()
				return false
			})
			.with('running', async () => {
				this.logger.info('[AutofixAgent] Agent is running. Setting next alarm.')
				await this.setNextAlarm()
				return false
			})
			.with('stopped', async () => {
				this.logger.info('[AutofixAgent] Agent is stopped. Not setting next alarm.')
				return true
			})
			.exhaustive()

		if (isStopped) {
			return
		}

		// agent actions
		await match(this.state.currentAction)
			// handle queued actions
			.with({ action: 'initialize_container', status: 'queued' }, async () => {
				await this.runActionHandler('initialize_container', () => this.handleInitializeContainer())
				this.setQueued('detect_issues')
			})
			.with({ action: 'detect_issues', status: 'queued' }, async () => {
				await this.runActionHandler('detect_issues', () => this.handleDetectIssues())
				this.setQueued('fix_issues')
			})
			.with({ action: 'fix_issues', status: 'queued' }, async () => {
				await this.runActionHandler('fix_issues', () => this.handleFixIssues())
				this.setQueued('commit_changes')
			})
			.with({ action: 'commit_changes', status: 'queued' }, async () => {
				await this.runActionHandler('commit_changes', () => this.handleCommitChanges())
				this.setQueued('push_changes')
			})
			.with({ action: 'push_changes', status: 'queued' }, async () => {
				await this.runActionHandler('push_changes', () => this.handlePushChanges())
				this.setQueued('create_pr')
			})
			.with({ action: 'create_pr', status: 'queued' }, async () => {
				await this.runActionHandler('create_pr', () => this.handleCreatePr())

				this.logger.info('[AutofixAgent] Agent is done! Stopping.')
				this.setState({
					...this.state,
					agentStatus: 'stopped',
				})
			})

			// Only one alarm runs at a time, so if we got here, it means
			// the agent failed to complete the previous action (or failed
			// to mark it as stopped). In the future, we'll retry a few times.
			// But for now, stopping the agent should be fine.
			.with({ status: 'running' }, ({ action }) => {
				this.logger.error(`[AutofixAgent] Action '${action}' is stuck in a loop. Stopping agent.`)
				this.setState({
					...this.state,
					agentStatus: 'stopped',
					currentAction: {
						action,
						status: 'stopped',
						error: {
							message: `Agent is stuck in a loop.`,
						},
					},
				})
			})

			// If we get here, it means there are no further
			// actions to run, so we can stop the agent.
			.with({ status: 'stopped' }, ({ action }) => {
				this.logger.info(
					`[AutofixAgent] No action queued after ${action} was stopped. Stopping agent.`
				)
				this.setState({
					...this.state,
					agentStatus: 'stopped',
				})
			})
			.exhaustive()
	}

	// ========================== //
	// ======== Helpers ========= //
	// ========================== //

	/**
	 * Schedules the next alarm for the agent.
	 * @param nextAlarm Optional specific date for the next alarm. Default: 1 seconds from now.
	 */
	private async setNextAlarm(nextAlarm?: Date) {
		const nextAlarmDate = nextAlarm ?? datePlus('1 seconds')
		const task = await this.schedule(nextAlarmDate, 'onAgentAlarm', undefined)
		this.logger
			.withTags({
				scheduledTaskId: task.id,
			})
			.info(
				`[AutofixAgent] Next alarm set for ${nextAlarmDate.toISOString()} with taskId: "${task.id}"`
			)
	}

	/**
	 * Set the provided action to queued.
	 */
	private setQueued(actionName: AgentAction): void {
		this.setState({
			...this.state,
			currentAction: { action: actionName, status: 'queued' },
		})
		this.logger.info(`[AutofixAgent] Action '${actionName}' queued.`)
	}

	/**
	 * Set the provided action to running.
	 */
	private setRunning(actionName: AgentAction): void {
		this.setState({
			...this.state,
			currentAction: { action: actionName, status: 'running' },
		})
		this.logger.info(`[AutofixAgent] Action '${actionName}' started.`)
	}

	/**
	 * Set the provided action to stopped.
	 *
	 * @param error Optional error that occurred during the action.
	 * Note: passing an error will cause the agent to stop.
	 */
	private setStopped(actionName: AgentAction, error?: Error | unknown): void {
		if (error === undefined) {
			this.setState({
				...this.state,
				currentAction: { action: actionName, status: 'stopped' },
			})
			this.logger.info(`[AutofixAgent] Action '${actionName}' stopped.`)
		} else {
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error during action execution'
			this.logger.error(
				`[AutofixAgent] Action '${actionName}' FAILED. Error: ${errorMessage}. Agent stopping.`,
				error instanceof Error ? error.stack : undefined
			)
			this.setState({
				...this.state,
				agentStatus: 'stopped', // Stop the agent if an action fails
				currentAction: {
					action: actionName,
					status: 'stopped',
					error: { message: errorMessage },
				},
			})
		}
	}

	/**
	 * Run a queued action. Automatically updates running/stopped statuses.
	 */
	private async runActionHandler(actionName: AgentAction, handlerFn: () => Promise<void>) {
		this.setRunning(actionName)
		try {
			await handlerFn()
			this.setStopped(actionName)
		} catch (e) {
			this.setStopped(actionName, e)
		}
	}

	// =========================== //
	// ===== Action Handlers ===== //
	// =========================== //

	async handleInitializeContainer(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleInitializeContainer')
		const { gitConfig } = this.state
		this.logger.info(`[AutofixAgent] Initializing container for repo: ${gitConfig.repo}`)

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
			command: `git clone ${gitConfig.repo} .`,
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

	async handleDetectIssues(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleDetectIssues')
		this.logger.info('[AutofixAgent] Detecting issues...')

		const tools = {
			listContainerFiles: tool({
				description: 'List files in container',
				parameters: z3.object({}),
				execute: async () => {
					const files = await this.listContainerFiles()
					console.log('files', files)
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
			workersBuilds.getBuildMetadata(this.state.buildUuid),
			workersBuilds.getBuildLogs(this.state.buildUuid),
		])

		const fixItPrompt = fmt.trim(`
			Identify the root cause of the failure from the build logs and configuration.
			Infer what the user intends to deploy based on the provided repository structure.
			If you can't find any code, then assume the repo is a static website that should be deployed directly.
			Next, fix the issue so that the project can be deployed successfully.
			Note: The target deployment platform is Cloudflare Workers.

			Explain your reasoning for each step you take.

			You have tools to explore the repo (which is in a container) and create files.

			Here is the build configuration:
			${JSON.stringify(metadata, null, 2)}

			Here are the full build logs:
			${logs}
		`)

		const res = await generateText({
			model: GoogleModels.GeminiPro(),
			maxSteps: 10,
			messages: [
				{ role: 'system', content: workersPrompt },
				{ role: 'user', content: fixItPrompt },
			],
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
		this.logger.info('[AutofixAgent] Executing: handleCommitChanges')
		this.logger.info('[AutofixAgent] Mock: Committing changes...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.logger.info('[AutofixAgent] Changes committed.')
	}

	async handlePushChanges(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handlePushChanges')
		this.logger.info('[AutofixAgent] Mock: Pushing changes...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.logger.info('[AutofixAgent] Changes pushed.')
	}

	async handleCreatePr(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleCreatePr')
		this.logger.info('[AutofixAgent] Mock: Creating PR...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.logger.info('[AutofixAgent] PR created.')
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
		return `build-${this.state.buildUuid}`
	}
}

// ========================== //
// ======= Decorators ======= //
// ========================== //

/**
 * Utility type to convert a string like "detect_issues" to "DetectIssues"
 */
type PascalCase<S extends string> = S extends `${infer P1}_${infer P2}`
	? `${Capitalize<Lowercase<P1>>}${PascalCase<Capitalize<Lowercase<P2>>>}`
	: Capitalize<S>

/**
 * Utility type to convert a string like "detect_issues" to "handleDetectIssues"
 */
type ActionToHandlerName<A extends string> = `handle${PascalCase<A>}`

/**
 * Decorator function to ensure the decorated class has handler methods for the given action
 */
export function EnsureAgentActions<const TActionStrings extends readonly string[]>(
	_actionsToHandle: TActionStrings
) {
	return function <
		Ctor extends new (...args: any[]) => {
			[K in TActionStrings[number] as ActionToHandlerName<K>]: () => Promise<void>
		} & { [key: string]: any },
	>(value: Ctor, context: ClassDecoratorContext): Ctor | void {
		if (context.kind !== 'class') {
			throw new Error('EnsureAgentActions must be used as a class decorator.')
		}
		// We don't modify the class at all - only used for type checks.
		return value
	}
}
