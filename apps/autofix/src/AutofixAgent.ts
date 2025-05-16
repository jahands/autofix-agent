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
	{ name: 'handle_error', description: 'An error occurred and is being handled.' }, // Renamed from 'error'
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

type AgentState = {
	repo: string
	branch: string
	currentAction: AgentAction // The current lifecycle stage
	progress: ProgressStatus // The progress of that stage
	lastStatusUpdateTimestamp: number // Timestamp of the last stage/progress change
	errorDetails?: { message: string; failedAction: AgentAction } // Optional error context
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
		this.setNextAlarm() // Set next alarm early

		// grab a copy of state before we make any mutations
		const state = structuredClone(this.state)

		// Timeout check for actions that are 'running'
		if (state.progress === 'running') {
			const duration = Date.now() - state.lastStatusUpdateTimestamp
			if (duration > TIMEOUT_DURATION_MS) {
				const timeoutMessage = `Action '${state.currentAction}' timed out after ${Math.round(duration / 1000)}s.`
				console.error(`[AutofixAgent] Timeout: ${timeoutMessage}`)
				// Mark the timed-out action as failed
				this.setActionOutcome({ progress: 'failed', error: new Error(timeoutMessage) })

				// Update state to immediately run handle_error for the timeout
				// It's important to get the latest state via this.state after setActionOutcome
				this.setState({
					...this.state,
					currentAction: 'handle_error',
					progress: 'running',
					lastStatusUpdateTimestamp: Date.now(),
					// errorDetails should have been set by setActionOutcome
				})
				console.log(
					`[AutofixAgent] Transitioning to action: 'handle_error' due to timeout. Dispatching handler.`
				)
				await this.handleError() // Directly call handleError
				return // End processing for this alarm cycle
			}
		}

		const setRunning = (newAction: AgentAction): void => {
			// It's crucial to use the current `this.state` here, not a potentially stale clone from onAlarm's start,
			// especially if errorDetails were set by a timeout or a previous failing action before this transition occurs.
			const currentState = this.state
			this.setState({
				...currentState,
				currentAction: newAction,
				progress: 'running',
				lastStatusUpdateTimestamp: Date.now(),
				// errorDetails from currentState are preserved if they were set (e.g. by timeout or a failed setActionOutcome for a *previous* action)
			})
			console.log(
				`[AutofixAgent] Transitioning to action: '${newAction}', progress: 'running'. Handler will be invoked.`
			)
		}

		// Main state machine logic using ts-pattern
		await match({ currentAction: state.currentAction, progress: state.progress })
			.returnType<Promise<void>>() // All branches will execute async logic or be async
			// Initial kick-off from idle
			.with({ currentAction: 'idle', progress: 'idle' }, async () => {
				const nextAction: AgentAction = 'initialize_container'
				setRunning(nextAction)
				console.log(
					`[AutofixAgent] Transitioning from 'idle' to action: '${nextAction}'. Dispatching handler.`
				)
				await this.handleInitializeContainer()
			})
			// Successful stage transitions - each will set state and call the next handler
			.with({ currentAction: 'initialize_container', progress: 'success' }, async () => {
				setRunning('detect_issues')
				await this.handleDetectIssues()
			})
			.with({ currentAction: 'detect_issues', progress: 'success' }, async () => {
				setRunning('fix_issues')
				await this.handleFixIssues()
			})
			.with({ currentAction: 'fix_issues', progress: 'success' }, async () => {
				setRunning('commit_changes')
				await this.handleCommitChanges()
			})
			.with({ currentAction: 'commit_changes', progress: 'success' }, async () => {
				setRunning('push_changes')
				await this.handlePushChanges()
			})
			.with({ currentAction: 'push_changes', progress: 'success' }, async () => {
				setRunning('create_pr')
				await this.handleCreatePr()
			})
			.with({ currentAction: 'create_pr', progress: 'success' }, async () => {
				setRunning('finish')
				await this.handleFinish()
			})
			// Transitions to idle state (no further handler call within this cycle)
			.with({ currentAction: 'finish', progress: 'success' }, async () => {
				console.log("[AutofixAgent] 'finish' action successful. Transitioning to 'idle'.")
				this.setState({
					...this.state,
					currentAction: 'idle',
					progress: 'idle',
					errorDetails: undefined, // Clear error details on successful finish
					lastStatusUpdateTimestamp: Date.now(),
				})
			})
			// ADD BACK: Handler for successful handle_error completion
			.with({ currentAction: 'handle_error', progress: 'success' }, async () => {
				console.log("[AutofixAgent] 'handle_error' action successful. Transitioning to 'idle'.")
				this.setState({
					...this.state,
					currentAction: 'idle',
					progress: 'idle',
					errorDetails: undefined, // Clear error details after successful error handling
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
					console.log(
						`[AutofixAgent] Action '${matchedState.currentAction}' failed. Transitioning to 'handle_error'. Error details should be set.`
					)
					this.setState({
						...this.state,
						currentAction: 'handle_error',
						progress: 'running',
						lastStatusUpdateTimestamp: Date.now(),
					})
					await this.handleError()
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
				console.log(
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
		console.log('[AutofixAgent] Executing: handleFinish. Agent process cycle completed.')
		// This stage mainly signifies the end of a full pass.
		// Setting progress to 'success' will allow getNextAction to transition to 'idle'.
		this.setActionOutcome({ progress: 'success' })
	}

	private async handleError(): Promise<void> {
		console.warn(
			`[AutofixAgent] Handling error. Details: ${JSON.stringify(this.state.errorDetails)}`
		)
		// For now, handling an error means acknowledging it and setting progress to success,
		// which will transition the agent to idle via getNextAction('handle_error', 'success').
		// Future: Implement retry logic, specific error handling, or notifications here.
		this.setActionOutcome({ progress: 'success' }) // errorDetails will be cleared by processNextAction when transitioning to idle
	}
}
