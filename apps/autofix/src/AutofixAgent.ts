import { Agent } from 'agents'
import { datePlus, ms } from 'itty-time'
import { match, P } from 'ts-pattern'
import { z } from 'zod'

import { logger } from './logger'

import type { AgentContext } from 'agents'
import type { Env } from './autofix.context'
import { WithLogTags } from 'workers-tagged-logger'

// define the main actions/stages of the agent
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
	{ name: 'handle_error', description: 'An error occurred and is being handled.' }, // renamed from 'error'
] as const satisfies Array<{
	name: string
	description: string
}>

const AgentAction = z.enum(AgentActions.map((a) => a.name))
type AgentAction = z.infer<typeof AgentAction>

// progress status for an action/stage
const ProgressStatus = z.enum(['idle', 'running', 'success', 'failed'])
type ProgressStatus = z.infer<typeof ProgressStatus>

const TIMEOUT_DURATION_MS = ms('10 minutes')
const MAX_ACTION_ATTEMPTS = 3

type AgentState = {
	repo: string
	branch: string
	currentAction: AgentAction // the current lifecycle stage
	currentActionAttempts: number // number of attempts to run the current action
	progress: ProgressStatus // the progress of that stage
	lastStatusUpdateTimestamp: number // timestamp of the last stage/progress change
	errorDetails?: { message: string; failedAction: AgentAction } // optional error context
}

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
				currentAction: this.state.currentAction,
				progress: this.state.progress,
				errorDetails: this.state.errorDetails,
				lastStatusUpdateTimestamp: this.state.lastStatusUpdateTimestamp,
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
			currentAction: 'idle',
			currentActionAttempts: 0,
			progress: 'idle',
			errorDetails: undefined,
			lastStatusUpdateTimestamp: Date.now(),
		})

		// start the agent via alarms.
		this.setNextAlarm(datePlus('1 second'))

		return {
			repo: this.state.repo,
			branch: this.state.branch,
			currentAction: this.state.currentAction,
			progress: this.state.progress,
			errorDetails: this.state.errorDetails,
			lastStatusUpdateTimestamp: this.state.lastStatusUpdateTimestamp,
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
		this.setNextAlarm() // set next alarm early

		/**
		 * Sets the agent's current action to a new action and progress to 'running'.
		 * Preserves existing errorDetails.
		 * @param newAction The action to transition to.
		 */
		const setRunning = (newAction: AgentAction): void => {
			// it's crucial to use the current `this.state` here, not a potentially stale clone from onAlarm's start,
			// especially if errorDetails were set by a timeout or a previous failing action before this transition occurs.
			const currentState = this.state
			this.setState({
				...currentState,
				currentAction: newAction,
				progress: 'running',
				lastStatusUpdateTimestamp: Date.now(),
				// errorDetails from currentState are preserved if they were set (e.g. by timeout or a failed setActionOutcome for a *previous* action)
			})
			this.logger.info(
				`[AutofixAgent] Transitioning to action: '${newAction}', progress: 'running'. Handler will be invoked.`
			)
		}

		/**
		 * Wraps an action handler callback, setting its state to running and managing its outcome (success/failure).
		 * @param actionToRun The action being executed.
		 * @param callback The async function representing the action's logic.
		 */
		const runActionHandler = async (actionToRun: AgentAction, callback: () => Promise<void>) => {
			setRunning(actionToRun) // This also logs the transition
			// The redundant log previously here has been removed.
			try {
				await callback()
				this.setActionOutcome({ progress: 'success' })
			} catch (e) {
				this.setActionOutcome({ progress: 'failed', error: e })
			}
		}

		// Timeout check for actions that are 'running' so
		// that we don't get stuck in a loop indefinitely.
		if (this.state.progress === 'running') {
			const duration = Date.now() - this.state.lastStatusUpdateTimestamp
			if (duration > TIMEOUT_DURATION_MS) {
				const currentActionThatTimedOut = this.state.currentAction
				const timeoutMessage = `Action '${currentActionThatTimedOut}' timed out after ${Math.round(duration / 1000)}s.`
				console.error(`[AutofixAgent] Timeout: ${timeoutMessage}`)
				// mark the timed-out action as failed. this.state will be updated by setActionOutcome.
				this.setActionOutcome({ progress: 'failed', error: new Error(timeoutMessage) })

				// No need to explicitly set state to run handle_error here, runActionHandler will do it.
				this.logger.info(
					`[AutofixAgent] Action '${currentActionThatTimedOut}' timed out. Transitioning to 'handle_error'.`
				)
				await runActionHandler('handle_error', () => this.handleError())
				return // end processing for this alarm cycle
			}
		}

		// The core state machine: evaluates the current action and its progress (from the live this.state)
		// to determine and execute the next step in the agent's lifecycle.
		// Active transitions typically use `runActionHandler` to execute the next action's logic,
		// while terminal states (like 'finish' succeeding or 'handle_error' succeeding) directly set the agent to idle.
		await match({ currentAction: this.state.currentAction, progress: this.state.progress })
			.returnType<Promise<void>>() // all branches will execute async logic or be async
			// initial kick-off from idle
			.with({ currentAction: 'idle', progress: 'idle' }, async () => {
				await runActionHandler('initialize_container', () => this.handleInitializeContainer())
			})
			// successful stage transitions - each will set state and call the next handler
			.with({ currentAction: 'initialize_container', progress: 'success' }, async () => {
				await runActionHandler('detect_issues', () => this.handleDetectIssues())
			})
			.with({ currentAction: 'detect_issues', progress: 'success' }, async () => {
				await runActionHandler('fix_issues', () => this.handleFixIssues())
			})
			.with({ currentAction: 'fix_issues', progress: 'success' }, async () => {
				await runActionHandler('commit_changes', () => this.handleCommitChanges())
			})
			.with({ currentAction: 'commit_changes', progress: 'success' }, async () => {
				await runActionHandler('push_changes', () => this.handlePushChanges())
			})
			.with({ currentAction: 'push_changes', progress: 'success' }, async () => {
				await runActionHandler('create_pr', () => this.handleCreatePr())
			})
			.with({ currentAction: 'create_pr', progress: 'success' }, async () => {
				await runActionHandler('finish', () => this.handleFinish())
			})
			// transitions to idle state (no further work to do)
			.with({ currentAction: 'finish', progress: 'success' }, async () => {
				this.logger.info("[AutofixAgent] 'finish' action successful. Transitioning to 'idle'.")
				this.setState({
					...this.state,
					currentAction: 'idle',
					progress: 'idle',
					errorDetails: undefined, // clear error details on successful finish
					lastStatusUpdateTimestamp: Date.now(),
				})
			})
			// set to idle after handling errors
			.with({ currentAction: 'handle_error', progress: 'success' }, async () => {
				this.logger.info(
					"[AutofixAgent] 'handle_error' action successful. Transitioning to 'idle'."
				)
				this.setState({
					...this.state,
					currentAction: 'idle',
					progress: 'idle',
					errorDetails: undefined, // clear error details after successful error handling
					lastStatusUpdateTimestamp: Date.now(),
				})
			})
			// handle failed actions
			.with(
				{
					currentAction: P.union(
						'idle',
						'initialize_container',
						'detect_issues',
						'fix_issues',
						'commit_changes',
						'push_changes',
						'create_pr',
						'finish'
					),
					progress: 'failed',
				},
				async (matchedState) => {
					this.logger.info(
						`[AutofixAgent] Action '${matchedState.currentAction}' failed. Transitioning to 'handle_error'.`
					)
					// errorDetails should have been set by the setActionOutcome call in runActionHandler for the failed action.
					await runActionHandler('handle_error', () => this.handleError())
				}
			)
			.with({ currentAction: 'handle_error', progress: 'failed' }, async () => {
				console.error(
					"[AutofixAgent] 'handle_error' action itself FAILED. Transitioning to 'idle' to prevent loop. Error details preserved."
				)
				this.setState({
					...this.state,
					currentAction: 'idle',
					progress: 'idle',
					lastStatusUpdateTimestamp: Date.now(),
				})
			})
			// handle running actions
			.with({ currentAction: P.not('idle'), progress: 'running' }, async (matchedState) => {
				this.logger.info(
					`[AutofixAgent] Action '${matchedState.currentAction}' is 'running'. Agent waits for completion or timeout.`
				)
				// No state change, just wait for the next alarm cycle.
			})
			// handle anomalous states for 'idle' action
			.with(
				{ currentAction: 'idle', progress: P.union('running', 'success') },
				async (matchedState) => {
					console.warn(
						`[AutofixAgent] Anomalous state: currentAction is 'idle' but progress is '${matchedState.progress}'. Agent waits. This may indicate an issue.`
					)
				}
			)
			// handle anomalous states where a normally active action has 'idle' progress
			.with({ currentAction: P.not('idle'), progress: 'idle' }, async (matchedState) => {
				console.warn(
					`[AutofixAgent] Anomalous state: currentAction is '${matchedState.currentAction}' but progress is 'idle'. Action might not have started correctly or was reset. Agent waits.`
				)
			})
			.exhaustive()
	}

	/**
	 * Sets the outcome (success or failure) of the current action, updating progress and error details accordingly.
	 * @param options Specifies the progress status and error object if failed.
	 */
	private setActionOutcome(
		options: { progress: 'success' } | { progress: 'failed'; error: Error | unknown }
	): void {
		const baseUpdate: Partial<AgentState> = {
			lastStatusUpdateTimestamp: Date.now(),
			progress: options.progress,
		}

		if (options.progress === 'success') {
			this.setState({
				...this.state,
				...baseUpdate,
				errorDetails: undefined,
			})
		} else {
			// 'failed'
			const error = options.error
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error during action execution'
			const failedAction = this.state?.currentAction || 'unknown' // fallback if state is somehow not set

			console.error(
				`[AutofixAgent] Action '${failedAction}' failed. Error: ${errorMessage}`,
				error instanceof Error ? error : undefined
			)
			this.setState({
				...this.state,
				...baseUpdate,
				errorDetails: { message: errorMessage, failedAction },
			})
		}
	}

	// =========================== //
	// ===== Action Handlers ===== //
	// =========================== //

	private async handleInitializeContainer(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleInitializeContainer')
		const { repo } = this.state
		this.logger.info(`[AutofixAgent] Mock: Initializing container for repo: ${repo}`)
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.logger.info('[AutofixAgent] Container initialized.')
	}

	private async handleDetectIssues(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleDetectIssues')
		this.logger.info('[AutofixAgent] Mock: Detecting issues...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.logger.info('[AutofixAgent] Issue detection complete.')
	}

	private async handleFixIssues(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleFixIssues')
		this.logger.info('[AutofixAgent] Mock: Fixing issues...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.logger.info('[AutofixAgent] Issue fixing complete.')
	}

	private async handleCommitChanges(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleCommitChanges')
		this.logger.info('[AutofixAgent] Mock: Committing changes...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.logger.info('[AutofixAgent] Changes committed.')
	}

	private async handlePushChanges(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handlePushChanges')
		this.logger.info('[AutofixAgent] Mock: Pushing changes...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.logger.info('[AutofixAgent] Changes pushed.')
	}

	private async handleCreatePr(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleCreatePr')
		this.logger.info('[AutofixAgent] Mock: Creating PR...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.logger.info('[AutofixAgent] PR created.')
	}

	private async handleFinish(): Promise<void> {
		this.logger.info('[AutofixAgent] Executing: handleFinish. Agent process cycle completed.')
		// this stage mainly signifies the end of a full pass.
		// runActionHandler will set its progress to 'success'.
	}

	private async handleError(): Promise<void> {
		console.warn(
			`[AutofixAgent] Handling error. Details: ${JSON.stringify(this.state.errorDetails)}`
		)
		// for now, handling an error means acknowledging it.
		// runActionHandler will set its progress to 'success'.
		// future: Implement retry logic, specific error handling, or notifications here.
	}
}
