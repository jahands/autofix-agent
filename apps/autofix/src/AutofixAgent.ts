import { Agent } from 'agents'
import { datePlus } from 'itty-time'
import { match, P } from 'ts-pattern'
import { z } from 'zod'

import { logger } from './logger'
import { EnsureAgentActions } from './agent.decorators'

import type { AgentContext } from 'agents'
import type { Env } from './autofix.context'
import { WithLogTags } from 'workers-tagged-logger/ts5'

/**
 * The status of the agent.
 */
const AgentStatuses = [
	{
		name: 'queued',
		description: 'Agent is queued and waiting to start.',
	},
	{
		name: 'running',
		description: 'Agent is running and processing actions.',
	},
	{
		name: 'stopped',
		description: 'Agent has stopped running.',
	},
] as const satisfies Array<{
	name: string
	description: string
}>

const AgentStatus = z.enum(AgentStatuses.map((a) => a.name))
export type AgentStatus = z.infer<typeof AgentStatus>

/**
 * Actions/steps the agent may take.
 */
const AgentActions = [
	{ name: 'idle', description: 'Agent is idle, awaiting or finished.' },
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
	{ name: 'finish', description: 'Agent has completed its task cycle.' },
	{
		name: 'cycle_complete',
		description: 'Agent has completed a full operational cycle and is ready for idle.',
	},
] as const satisfies Array<{
	name: string
	description: string
}>

const AgentAction = z.enum(AgentActions.map((a) => a.name))
export type AgentAction = z.infer<typeof AgentAction>

// progress status for an action/stage
const ProgressStatus = z.enum(['idle', 'running', 'success', 'failed'])
type ProgressStatus = z.infer<typeof ProgressStatus>

// MAX_ACTION_ATTEMPTS removed
// const MAX_ACTION_ATTEMPTS = 3;

export type AgentState = {
	repo: string
	branch: string
	currentAction: {
		action: AgentAction
		progress: ProgressStatus
	}
	errorDetails?: { message: string; failedAction: AgentAction } // optional error context
}

// Define the specific list of action *string literals* from AgentAction that require handlers
const autofixAgentActionsRequiringHandlers = [
	'initialize_container',
	'detect_issues',
	'fix_issues',
	'commit_changes',
	'push_changes',
	'create_pr',
	'finish',
] as const // Use 'as const' for a tuple of string literals

// Removed autofixAgentSequence and setupAgentWorkflow call

@EnsureAgentActions(autofixAgentActionsRequiringHandlers)
export class AutofixAgent extends Agent<Env, AgentState> {
	// define methods on the Agent:
	// https://developers.cloudflare.com/agents/api-reference/agents-api/
	//
	// every Agent has built in state via this.setState and this.sql
	// built-in scheduling via this.schedule
	// agents support WebSockets, HTTP requests, state synchronization and
	// can run for seconds, minutes or hours: as long as the tasks need.

	/**
	 * Context logger with tags added in the constructor so that we
	 * don't have to add tags in every method that's called via RPC.
	 */
	logger: typeof logger

	/**
	 * Promise for the current running action. This is used
	 * to help us detect when a running action has timed out.
	 */
	private currentActionPromise: Promise<void> | undefined

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env)
		this.logger = logger.withTags({
			state: {
				repo: this.state.repo,
				branch: this.state.branch,
				currentAction: this.state.currentAction.action,
				progress: this.state.currentAction.progress,
				errorDetails: this.state.errorDetails,
			},
		})
	}

	/**
	 * Start the agent
	 */
	@WithLogTags({ source: 'AutofixAgent', handler: 'start' })
	public async start({ repo, branch }: { repo: string; branch: string }) {
		this.logger.info(`[AutofixAgent] Starting for repo: ${repo}, branch: ${branch}`)
		this.setState({
			repo,
			branch,
			currentAction: { action: 'idle', progress: 'idle' },
			errorDetails: undefined,
		})

		// start the agent via alarms.
		this.setNextAlarm(datePlus('1 second'))

		return {
			repo: this.state.repo,
			branch: this.state.branch,
			currentAction: this.state.currentAction.action,
			progress: this.state.currentAction.progress,
			errorDetails: this.state.errorDetails,
			message: 'AutofixAgent started.',
		}
	}

	/**
	 * Schedules the next alarm for the agent.
	 * @param nextAlarm Optional specific date for the next alarm. Defaults to 5 seconds from now.
	 */
	private setNextAlarm(nextAlarm?: Date) {
		const nextAlarmDate = nextAlarm ?? datePlus('5 seconds')
		void this.ctx.storage.setAlarm(nextAlarmDate)
		this.logger.info(`[AutofixAgent] Next alarm set for ${nextAlarmDate.toISOString()}`)
	}

	@WithLogTags({ source: 'AutofixAgent', handler: 'onAlarm' })
	override async onAlarm(): Promise<void> {
		this.logger.info('[AutofixAgent] Alarm triggered.')

		if (
			this.state.currentAction.progress === 'running' &&
			this.currentActionPromise === undefined
		) {
			const interruptedActionName = this.state.currentAction.action
			const interruptionMessage = `Action '${interruptedActionName}' may have been interrupted by a restart. Transitioning to idle with error.`
			this.logger.warn(`[AutofixAgent] Interruption: ${interruptionMessage}`)
			this.setState({
				...this.state,
				currentAction: { action: 'idle', progress: 'idle' },
				errorDetails: {
					message: interruptionMessage,
					failedAction: interruptedActionName,
				},
			})
			return // End processing for this alarm cycle
		}

		this.setNextAlarm()

		const setRunning = (newActionName: AgentAction): void => {
			this.setState({
				...this.state,
				currentAction: { action: newActionName, progress: 'running' },
				errorDetails: this.state.errorDetails,
			})
			this.logger.info(`[AutofixAgent] Starting action: '${newActionName}'.`)
		}

		const runActionHandler = async (actionToRun: AgentAction, callback: () => Promise<void>) => {
			setRunning(actionToRun)
			this.currentActionPromise = callback()
			try {
				await this.currentActionPromise
				this.setActionOutcome({ progress: 'success' })
			} catch (e) {
				this.setActionOutcome({ progress: 'failed', error: e })
			} finally {
				this.currentActionPromise = undefined
			}
		}

		await match(this.state.currentAction)
			.returnType<Promise<void>>()
			.with({ action: 'idle', progress: 'idle' }, () =>
				runActionHandler('initialize_container', () => this.handleInitializeContainer())
			)
			.with({ action: 'initialize_container', progress: 'success' }, () =>
				runActionHandler('detect_issues', () => this.handleDetectIssues())
			)
			.with({ action: 'detect_issues', progress: 'success' }, () =>
				runActionHandler('fix_issues', () => this.handleFixIssues())
			)
			.with({ action: 'fix_issues', progress: 'success' }, () =>
				runActionHandler('commit_changes', () => this.handleCommitChanges())
			)
			.with({ action: 'commit_changes', progress: 'success' }, () =>
				runActionHandler('push_changes', () => this.handlePushChanges())
			)
			.with({ action: 'push_changes', progress: 'success' }, () =>
				runActionHandler('create_pr', () => this.handleCreatePr())
			)
			.with({ action: 'create_pr', progress: 'success' }, () =>
				runActionHandler('finish', () => this.handleFinish())
			)
			.with({ action: 'finish', progress: 'success' }, async () => {
				this.logger.info(
					"[AutofixAgent] 'finish' action successful. Transitioning to 'cycle_complete' action."
				)
				this.setState({
					...this.state,
					currentAction: { action: 'cycle_complete', progress: 'success' },
					errorDetails: undefined,
				})
			})
			.with({ action: 'cycle_complete', progress: 'success' }, async () => {
				this.logger.info(
					`[AutofixAgent] Action 'cycle_complete' acknowledged. Transitioning to idle/idle.`
				)
				this.setState({
					...this.state,
					currentAction: { action: 'idle', progress: 'idle' },
					errorDetails: undefined,
				})
			})
			.with(
				{ action: P.not(P.union('idle', 'cycle_complete')), progress: 'failed' },
				async ({ action, progress }) => {
					this.logger.error(
						`[AutofixAgent] Action '${action}' FAILED. Transitioning to idle with error.`
					)
					this.setState({
						...this.state,
						currentAction: { action: 'idle', progress: 'idle' },
					})
				}
			)
			.with({ action: 'cycle_complete', progress: P.not('success') }, async (matchedState) => {
				this.logger.warn(
					`[AutofixAgent] Anomalous state: 'cycle_complete' action found with progress '${matchedState.progress}'. Transitioning to idle/idle.`
				)
				this.setState({
					...this.state,
					currentAction: { action: 'idle', progress: 'idle' },
					errorDetails: undefined,
				})
			})
			.with(
				{ action: P.not(P.union('idle', 'cycle_complete')), progress: 'running' },
				async (matchedState) => {
					this.logger.info(
						`[AutofixAgent] Action '${matchedState.action}' is 'running'. Agent waits for completion.`
					)
				}
			)
			.with({ action: 'idle', progress: P.not('idle') }, async (matchedState) => {
				this.logger.warn(
					`[AutofixAgent] Anomalous state: currentAction is 'idle' but progress is '${matchedState.progress}'. Resetting to idle/idle.`
				)
				this.setState({
					...this.state,
					currentAction: { action: 'idle', progress: 'idle' },
					errorDetails: undefined,
				})
			})
			.with(
				{ action: P.not(P.union('idle', 'cycle_complete')), progress: 'idle' },
				async (matchedState) => {
					this.logger.warn(
						`[AutofixAgent] Anomalous state: Action '${matchedState.action}' has progress 'idle'. This is unexpected. Transitioning to idle with error.`
					)
					this.setState({
						...this.state,
						currentAction: { action: 'idle', progress: 'idle' },
						errorDetails: {
							message: `Anomalous state: Action '${matchedState.action}' found with progress 'idle'.`,
							failedAction: matchedState.action,
						},
					})
				}
			)
			.exhaustive()
	}

	/**
	 * Sets the outcome (success or failure) of the current action, updating progress, attempt counts, and error details.
	 * @param options Specifies the progress status and error object if failed.
	 * @returns boolean - true if the action has definitively failed (all retries exhausted or unrecoverable), false otherwise.
	 */
	private setActionOutcome(
		options: { progress: 'success' } | { progress: 'failed'; error: Error | unknown }
	): void {
		const currentActionName = this.state.currentAction.action
		if (options.progress === 'success') {
			this.setState({
				...this.state,
				currentAction: { ...this.state.currentAction, progress: 'success' },
				errorDetails: undefined,
			})
			this.logger.info(`[AutofixAgent] Action '${currentActionName}' Succeeded.`)
		} else {
			const e = options.error
			const errorMessage = e instanceof Error ? e.message : 'Unknown error during action execution'
			this.logger.error(
				`[AutofixAgent] Action '${currentActionName}' FAILED. Error: ${errorMessage}`,
				e instanceof Error ? e.stack : undefined
			)
			this.setState({
				...this.state,
				currentAction: { ...this.state.currentAction, progress: 'failed' },
				errorDetails: {
					message: `Action '${currentActionName}' failed: ${errorMessage}`,
					failedAction: currentActionName,
				},
			})
		}
	}

	// =========================== //
	// ===== Action Handlers ===== //
	// =========================== //

	async handleInitializeContainer(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleInitializeContainer')
		const { repo } = this.state
		this.logger.info(`[AutofixAgent] Mock: Initializing container for repo: ${repo}`)
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.logger.info('[AutofixAgent] Container initialized.')
	}

	async handleDetectIssues(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleDetectIssues')
		this.logger.info('[AutofixAgent] Mock: Detecting issues...')
		await new Promise((resolve) => setTimeout(resolve, 100))
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

	async handleFinish(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleFinish. Agent process cycle completed.')
		// this stage mainly signifies the end of a full pass.
		// runActionHandler will set its progress to 'success'.
		// If this were to fail, retries would apply as per normal action handling.
	}
}
