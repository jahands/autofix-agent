import { Agent } from 'agents'
import { datePlus, ms } from 'itty-time'
import { match, P } from 'ts-pattern'
import { z } from 'zod'

import type { Env } from './autofix.context'

// Define the main actions/stages of the agent
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
	{ name: 'handle_error', description: 'An error occurred and is being handled.' },
	{ name: 'handle_timeout', description: 'The action timed out.' },
] as const satisfies Array<{
	name: string
	description: string
}>

const AgentAction = z.enum(AgentActions.map((a) => a.name))
type AgentAction = z.infer<typeof AgentAction>

// progress status for an action/stage
const ProgressStatus = z.enum(['idle', 'pending', 'running', 'success', 'failed'])
type ProgressStatus = z.infer<typeof ProgressStatus>

const TIMEOUT_DURATION_MS = ms('10 minutes')

type AgentState = {
	repo: string
	branch: string
	currentAction: AgentAction // The current lifecycle stage
	progress: ProgressStatus // The progress of that stage
	lastStatusUpdateTimestamp: number // Timestamp of the last stage/progress change
	errorDetails?: { message: string; failedAction: AgentAction } // Optional error context
}

function getNextAction({
	currentAction,
	progress,
	lastStatusUpdateTimestamp,
}: {
	currentAction: AgentAction
	progress: ProgressStatus
	lastStatusUpdateTimestamp: number
}): AgentAction {
	return (
		match({ currentAction, progress, lastStatusUpdateTimestamp })
			.returnType<AgentAction>()
			// Timeout check
			.with(
				{
					progress: 'running',
					// Check if currentAction is NOT handle_error or handle_timeout itself to prevent infinite loops
					// if these actions were to somehow get stuck.
					currentAction: P.not(P.union('handle_error', 'handle_timeout')),
					lastStatusUpdateTimestamp: P.when((ts) => Date.now() - ts > TIMEOUT_DURATION_MS),
				},
				(state) => {
					// When a timeout is detected, the 'handle_timeout' action is returned.
					// The errorDetails about the action that timed out will be set
					// when 'handle_timeout' is processed by processNextAction before dispatch.
					// Or, more accurately, 'handle_timeout' handler will set its own error details if it wants to.
					// The current structure of setActionOutcome for failure already captures currentAction.
					// So, if 'foo' times out, getNextAction returns 'handle_timeout'.
					// processNextAction sets currentAction to 'handle_timeout', progress to 'running'.
					// handleTimeoutAction will then be called. It should probably record that 'foo' timed out.
					// For now, let's assume errorDetails are NOT set here but by the handler of handle_timeout.
					console.warn(
						`[AutofixAgent:getNextAction] Timeout detected for action '${state.currentAction}'. Transitioning to 'handle_timeout'.`
					)
					return 'handle_timeout'
				}
			)

			// Initial kick-off
			.with({ currentAction: 'idle', progress: 'idle' }, () => 'initialize_container')

			// Successful stage transitions
			.with({ currentAction: 'initialize_container', progress: 'success' }, () => 'detect_issues')
			.with({ currentAction: 'detect_issues', progress: 'success' }, () => 'fix_issues')
			.with({ currentAction: 'fix_issues', progress: 'success' }, () => 'commit_changes')
			.with({ currentAction: 'commit_changes', progress: 'success' }, () => 'push_changes')
			.with({ currentAction: 'push_changes', progress: 'success' }, () => 'create_pr')
			.with({ currentAction: 'create_pr', progress: 'success' }, () => 'finish')
			.with({ currentAction: 'finish', progress: 'success' }, () => 'idle')
			.with({ currentAction: 'handle_error', progress: 'success' }, () => 'idle')
			// After successfully handling a timeout, we should then formally handle it as an error.
			.with({ currentAction: 'handle_timeout', progress: 'success' }, () => 'handle_error')

			// If any stage fails (and it's not a timeout, which is handled above), transition to handle_error
			.when(
				(state) => state.progress === 'failed',
				() => 'handle_error'
			)

			// Default case for any other combination (e.g., running, pending,
			// or 'idle' stage with 'success'/'failed' progress if not caught above, though 'failed' is).
			// These should result in an 'idle' action, meaning the agent waits.
			.otherwise(() => 'idle')
	)
}

export class AutofixAgent extends Agent<Env, AgentState> {
	// Define methods on the Agent:
	// https://developers.cloudflare.com/agents/api-reference/agents-api/
	//
	// Every Agent has built in state via this.setState and this.sql
	// Built-in scheduling via this.schedule
	// Agents support WebSockets, HTTP requests, state synchronization and
	// can run for seconds, minutes or hours: as long as the tasks need.

	/**
	 * Start the agent
	 */
	async start({ repo, branch }: { repo: string; branch: string }) {
		console.log(`[AutofixAgent] Starting for repo: ${repo}, branch: ${branch}`)
		this.setState({
			repo,
			branch,
			currentAction: 'idle',
			progress: 'idle',
			errorDetails: undefined,
			lastStatusUpdateTimestamp: Date.now(),
		})

		// Start the agent via alarms.
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

	private setNextAlarm(nextAlarm?: Date) {
		const nextAlarmDate = nextAlarm ?? datePlus('5 seconds')
		void this.ctx.storage.setAlarm(nextAlarmDate)
		console.log(`[AutofixAgent] Next alarm set for ${nextAlarmDate.toISOString()}`)
	}

	override async onAlarm(): Promise<void> {
		console.log('[AutofixAgent] Alarm triggered.')
		// only one alarm can run at a time, so it's
		// fine if the next action takes > 5 seconds
		this.setNextAlarm()

		await this.processNextAction()
	}

	public async processNextAction(): Promise<void> {
		const state = this.state

		const actionToExecute = getNextAction({
			currentAction: state.currentAction,
			progress: state.progress,
			lastStatusUpdateTimestamp: state.lastStatusUpdateTimestamp,
		})

		await match(actionToExecute)
			.with('idle', async () => {
				console.log(
					`[AutofixAgent] Current action '${state.currentAction}' with progress '${state.progress}' results in 'idle' next action. No new action initiated.`
				)
				// Ensure timestamp is updated if we are settling into idle from a completed stage
				if (
					(state.currentAction === 'finish' || state.currentAction === 'handle_error') &&
					state.progress === 'success'
				) {
					this.setState({
						...state,
						currentAction: 'idle',
						progress: 'idle',
						errorDetails: undefined,
						lastStatusUpdateTimestamp: Date.now(),
					})
					console.log(
						'[AutofixAgent] Process cycle ended (finish/error handled). Agent is now truly idle.'
					)
				}
				// If actionToExecute is 'idle', we simply do nothing further in this processing cycle.
			})
			.otherwise(async (newActionToDispatch) => {
				// If we are about to dispatch 'handle_timeout', it means an action *has* timed out.
				// We need to record which action timed out.
				// The 'newActionToDispatch' is 'handle_timeout'.
				// The action that *actually* timed out is 'state.currentAction'.
				let errorDetailsToSet = state.errorDetails
				if (newActionToDispatch === 'handle_timeout' && state.progress === 'running') {
					const timedOutAction = state.currentAction
					const duration = Date.now() - state.lastStatusUpdateTimestamp
					const timeoutMessage = `Action '${timedOutAction}' timed out after ${Math.round(duration / 1000)}s.`
					console.warn(
						`[AutofixAgent:processNextAction] ${timeoutMessage} - setting up for handle_timeout action.`
					)
					errorDetailsToSet = { message: timeoutMessage, failedAction: timedOutAction }
				}

				this.setState({
					...state,
					currentAction: newActionToDispatch,
					progress: 'running',
					lastStatusUpdateTimestamp: Date.now(),
					errorDetails: errorDetailsToSet, // Set error details if it's a timeout
				})
				console.log(
					`[AutofixAgent] Transitioning to action: '${newActionToDispatch}', progress: 'running'. Dispatching handler.`
				)
				await this.dispatchActionHandler(newActionToDispatch)
			})
	}

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
			const failedAction = this.state?.currentAction || 'unknown' // Fallback if state is somehow not set

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

	private async dispatchActionHandler(action: AgentAction): Promise<void> {
		try {
			await match(action)
				.with('initialize_container', async () => this.handleInitializeContainer())
				.with('detect_issues', async () => this.handleDetectIssues())
				.with('fix_issues', async () => this.handleFixIssues())
				.with('commit_changes', async () => this.handleCommitChanges())
				.with('push_changes', async () => this.handlePushChanges())
				.with('create_pr', async () => this.handleCreatePr())
				.with('finish', async () => this.handleFinish())
				.with('handle_error', async () => this.handleError())
				.with('handle_timeout', async () => this.handleTimeoutAction())
				.with('idle', async () => {
					// This case should ideally not be reached due to logic in processNextAction
					console.error(
						"[AutofixAgent:dispatchActionHandler] 'idle' action was dispatched. This is unexpected."
					)
					// Attempt to recover by ensuring state is idle if it somehow got here.
					if (this.state.currentAction !== 'idle' || this.state.progress !== 'idle') {
						this.setState({
							...this.state,
							currentAction: 'idle',
							progress: 'idle',
							errorDetails: undefined,
							lastStatusUpdateTimestamp: Date.now(),
						})
					}
				})
				.exhaustive()
		} catch (err) {
			const errorMessage =
				err instanceof Error ? err.message : 'Unknown error during action execution'
			this.setActionOutcome({ progress: 'failed', error: new Error(errorMessage) })
		}
	}

	// --- Action Handlers ---
	// Each handler now sets progress to 'success' or 'failed'.
	// 'currentAction' is already set by processNextAction before these are called.

	private async handleInitializeContainer(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleInitializeContainer')
		const { repo } = this.state
		try {
			console.log(`[AutofixAgent] Mock: Initializing container for repo: ${repo}`)
			await new Promise((resolve) => setTimeout(resolve, 100))
			console.log('[AutofixAgent] Container initialized, progress set to success.')
			this.setActionOutcome({ progress: 'success' })
		} catch (e) {
			this.setActionOutcome({ progress: 'failed', error: e })
		}
	}

	private async handleDetectIssues(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleDetectIssues')
		try {
			console.log('[AutofixAgent] Mock: Detecting issues...')
			await new Promise((resolve) => setTimeout(resolve, 100))
			console.log('[AutofixAgent] Issue detection complete, progress set to success.')
			this.setActionOutcome({ progress: 'success' })
		} catch (e) {
			this.setActionOutcome({ progress: 'failed', error: e })
		}
	}

	private async handleFixIssues(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleFixIssues')
		try {
			console.log('[AutofixAgent] Mock: Fixing issues...')
			await new Promise((resolve) => setTimeout(resolve, 100))
			console.log('[AutofixAgent] Issue fixing complete, progress set to success.')
			this.setActionOutcome({ progress: 'success' })
		} catch (e) {
			this.setActionOutcome({ progress: 'failed', error: e })
		}
	}

	private async handleCommitChanges(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleCommitChanges')
		try {
			console.log('[AutofixAgent] Mock: Committing changes...')
			await new Promise((resolve) => setTimeout(resolve, 100))
			console.log('[AutofixAgent] Changes committed, progress set to success.')
			this.setActionOutcome({ progress: 'success' })
		} catch (e) {
			this.setActionOutcome({ progress: 'failed', error: e })
		}
	}

	private async handlePushChanges(): Promise<void> {
		console.log('[AutofixAgent] Executing: handlePushChanges')
		try {
			console.log('[AutofixAgent] Mock: Pushing changes...')
			await new Promise((resolve) => setTimeout(resolve, 100))
			console.log('[AutofixAgent] Changes pushed, progress set to success.')
			this.setActionOutcome({ progress: 'success' })
		} catch (e) {
			this.setActionOutcome({ progress: 'failed', error: e })
		}
	}

	private async handleCreatePr(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleCreatePr')
		try {
			console.log('[AutofixAgent] Mock: Creating PR...')
			await new Promise((resolve) => setTimeout(resolve, 100))
			console.log('[AutofixAgent] PR created, progress set to success.')
			this.setActionOutcome({ progress: 'success' })
		} catch (e) {
			this.setActionOutcome({ progress: 'failed', error: e })
		}
	}

	private async handleFinish(): Promise<void> {
		console.log('[AutofixAgent] handleFinish: Process completed.')
		// Potentially, notify completion, clean up resources, etc.
		this.setActionOutcome({ progress: 'success' })
	}

	private async handleError(): Promise<void> {
		const errorDetails = this.state.errorDetails || {
			message: 'Unknown error occurred',
			failedAction: this.state.currentAction, // This would be 'handle_error' itself, fallback.
		}
		console.error(
			`[AutofixAgent] handleError: Processing error for action '${errorDetails.failedAction}'. Message: ${errorDetails.message}`
		)
		// For now, simply log and mark as success to allow transition to idle.
		// In a real scenario, might involve retries, notifications, specific cleanup.
		this.setActionOutcome({ progress: 'success' })
	}

	// New handler for timeouts
	private async handleTimeoutAction(): Promise<void> {
		const { errorDetails, currentAction } = this.state

		// currentAction here is 'handle_timeout'.
		// errorDetails should contain information about the action that *actually* timed out.
		if (errorDetails && errorDetails.failedAction) {
			console.warn(
				`[AutofixAgent] handleTimeoutAction: Action '${errorDetails.failedAction}' has officially timed out. Original error: ${errorDetails.message}`
			)
		} else {
			// This case should ideally not be reached if processNextAction sets errorDetails correctly
			// when transitioning to 'handle_timeout'.
			console.warn(
				`[AutofixAgent] handleTimeoutAction: Executing due to timeout, but specific timed-out action details are missing. Current action was '${currentAction}'.`
			)
		}

		// Mark the 'handle_timeout' action itself as successfully processed.
		// getNextAction will then transition from ('handle_timeout', 'success') to 'handle_error'.
		this.setActionOutcome({ progress: 'success' })
	}
}
