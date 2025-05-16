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
const ProgressStatus = z.enum(['idle', 'pending', 'in-progress', 'success', 'failed'])
type ProgressStatus = z.infer<typeof ProgressStatus>

const TIMEOUT_DURATION_MS = ms('10 minutes')

type AgentState = {
	repo: string
	branch: string
	currentActionStage: AgentAction // The current lifecycle stage
	progress: ProgressStatus // The progress of that stage
	lastStatusUpdateTimestamp: number // Timestamp of the last stage/progress change
	errorDetails?: { message: string; failedStage: AgentAction } // Optional error context
}

function getNextAction(currentStage: AgentAction, progress: ProgressStatus): AgentAction {
	return (
		match({ currentStage, progress })
			.returnType<AgentAction>()
			// Initial kick-off
			.with({ currentStage: 'idle', progress: 'idle' }, () => 'initialize_container')

			// Successful stage transitions
			.with({ currentStage: 'initialize_container', progress: 'success' }, () => 'detect_issues')
			.with({ currentStage: 'detect_issues', progress: 'success' }, () => 'fix_issues')
			.with({ currentStage: 'fix_issues', progress: 'success' }, () => 'commit_changes')
			.with({ currentStage: 'commit_changes', progress: 'success' }, () => 'push_changes')
			.with({ currentStage: 'push_changes', progress: 'success' }, () => 'create_pr')
			.with({ currentStage: 'create_pr', progress: 'success' }, () => 'finish')
			.with({ currentStage: 'finish', progress: 'success' }, () => 'idle')
			.with({ currentStage: 'handle_error', progress: 'success' }, () => 'idle')

			// If any stage fails, transition to handle_error
			.when(
				(state) => state.progress === 'failed',
				() => 'handle_error'
			)

			// Default case for any other combination (e.g., in-progress, pending,
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
		console.log(`Agent starting for repo: ${repo}, branch: ${branch}`)
		this.setState({
			repo,
			branch,
			currentActionStage: 'idle',
			progress: 'idle',
			errorDetails: undefined,
			lastStatusUpdateTimestamp: Date.now(),
		})

		// Start the agent via alarms.
		this.setNextAlarm(datePlus('1 second'))
		// Return value for the Hono app's POST /api/agents/:agentId endpoint
		return {
			repo: this.state.repo,
			branch: this.state.branch,
			currentActionStage: this.state.currentActionStage,
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
		const state = this.state // Access in-memory state, kept in sync by Agent SDK
		if (!state) {
			console.error('[AutofixAgent] Agent state is not available in processNextAction.')
			return
		}

		// Timeout check
		if (state.progress === 'in-progress') {
			const duration = Date.now() - state.lastStatusUpdateTimestamp
			if (duration > TIMEOUT_DURATION_MS) {
				const timeoutMessage = `Action '${state.currentActionStage}' timed out after ${Math.round(duration / 1000)}s.`
				console.error(`[AutofixAgent] Timeout: ${timeoutMessage}`)
				this.setState({
					...state,
					currentActionStage: 'handle_error',
					progress: 'in-progress', // The handle_error action is now in-progress
					errorDetails: { message: timeoutMessage, failedStage: state.currentActionStage },
					lastStatusUpdateTimestamp: Date.now(),
				})
				await this.dispatchActionHandler('handle_error')
				return // Stop further processing in this cycle
			}
		}

		const actionToExecute = getNextAction(state.currentActionStage, state.progress)

		if (actionToExecute === 'idle') {
			console.log(
				`[AutofixAgent] Current stage '${state.currentActionStage}' with progress '${state.progress}' results in 'idle' next action. No new stage initiated.`
			)
			// Ensure timestamp is updated if we are settling into idle from a completed stage
			if (
				(state.currentActionStage === 'finish' || state.currentActionStage === 'handle_error') &&
				state.progress === 'success'
			) {
				this.setState({
					...state,
					currentActionStage: 'idle',
					progress: 'idle',
					errorDetails: undefined,
					lastStatusUpdateTimestamp: Date.now(),
				})
				console.log(
					'[AutofixAgent] Process cycle ended (finish/error handled). Agent is now truly idle.'
				)
			}
			return
		}

		// If there's a new action/stage to execute:
		this.setState({
			...state,
			currentActionStage: actionToExecute,
			progress: 'in-progress',
			lastStatusUpdateTimestamp: Date.now(), // Update timestamp when a new action starts
		})

		console.log(
			`[AutofixAgent] Transitioning to stage: '${actionToExecute}', progress: 'in-progress'. Dispatching handler.`
		)
		await this.dispatchActionHandler(actionToExecute)
	}

	private async dispatchActionHandler(action: AgentAction): Promise<void> {
		console.log(`[AutofixAgent] Dispatching handler for action/stage: ${action}`)
		try {
			// Note: lastStatusUpdateTimestamp is set before dispatching, so handlers don't need to set it at their start.
			await match(action)
				.with('initialize_container', async () => this.handleInitializeContainer())
				.with('detect_issues', async () => this.handleDetectIssues())
				.with('fix_issues', async () => this.handleFixIssues())
				.with('commit_changes', async () => this.handleCommitChanges())
				.with('push_changes', async () => this.handlePushChanges())
				.with('create_pr', async () => this.handleCreatePr())
				.with('finish', async () => this.handleFinish())
				.with('handle_error', async () => this.handleError()) // Renamed from 'error'
				.with('idle', async () => {
					// Should ideally not be dispatched, but handle defensively
					console.warn(
						"[AutofixAgent] dispatchActionHandler called with 'idle'. Setting to idle progress."
					)
					if (this.state.currentActionStage === 'idle' && this.state.progress !== 'idle') {
						this.setState({
							...this.state,
							progress: 'idle',
							errorDetails: undefined,
							lastStatusUpdateTimestamp: Date.now(),
						})
					}
				})
				.exhaustive() // Ensures all actions are handled
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : 'Unknown error'
			console.error(`[AutofixAgent] Error executing action/stage ${action}:`, err)
			const currentState = this.state || {
				repo: '',
				branch: '',
				currentActionStage: action,
				progress: 'idle',
				lastStatusUpdateTimestamp: Date.now(),
			}
			this.setState({
				...currentState,
				progress: 'failed',
				errorDetails: { message: errorMessage, failedStage: currentState.currentActionStage },
				lastStatusUpdateTimestamp: Date.now(),
			})
		}
	}

	// --- Action Handlers ---
	// Each handler now sets progress to 'success' or 'failed'.
	// 'currentActionStage' is already set by processNextAction before these are called.

	private async handleInitializeContainer(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleInitializeContainer')
		const { repo } = this.state
		try {
			console.log(`[AutofixAgent] Mock: Initializing container for repo: ${repo}`)
			await new Promise((resolve) => setTimeout(resolve, 100))
			this.setState({
				...this.state,
				progress: 'success',
				errorDetails: undefined,
				lastStatusUpdateTimestamp: Date.now(),
			})
			console.log('[AutofixAgent] Container initialized, progress set to success.')
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : 'Unknown initialization error'
			console.error('[AutofixAgent] Failed to initialize container:', e)
			this.setState({
				...this.state,
				progress: 'failed',
				errorDetails: { message: errorMessage, failedStage: 'initialize_container' },
				lastStatusUpdateTimestamp: Date.now(),
			})
		}
	}

	private async handleDetectIssues(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleDetectIssues')
		try {
			console.log('[AutofixAgent] Mock: Detecting issues...')
			await new Promise((resolve) => setTimeout(resolve, 100))
			this.setState({
				...this.state,
				progress: 'success',
				errorDetails: undefined,
				lastStatusUpdateTimestamp: Date.now(),
			})
			console.log('[AutofixAgent] Issue detection complete, progress set to success.')
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : 'Unknown issue detection error'
			console.error('[AutofixAgent] Failed to detect issues:', e)
			this.setState({
				...this.state,
				progress: 'failed',
				errorDetails: { message: errorMessage, failedStage: 'detect_issues' },
				lastStatusUpdateTimestamp: Date.now(),
			})
		}
	}

	private async handleFixIssues(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleFixIssues')
		try {
			console.log('[AutofixAgent] Mock: Fixing issues...')
			await new Promise((resolve) => setTimeout(resolve, 100))
			this.setState({
				...this.state,
				progress: 'success',
				errorDetails: undefined,
				lastStatusUpdateTimestamp: Date.now(),
			})
			console.log('[AutofixAgent] Issue fixing complete, progress set to success.')
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : 'Unknown issue fixing error'
			console.error('[AutofixAgent] Failed to fix issues:', e)
			this.setState({
				...this.state,
				progress: 'failed',
				errorDetails: { message: errorMessage, failedStage: 'fix_issues' },
				lastStatusUpdateTimestamp: Date.now(),
			})
		}
	}

	private async handleCommitChanges(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleCommitChanges')
		try {
			console.log('[AutofixAgent] Mock: Committing changes...')
			await new Promise((resolve) => setTimeout(resolve, 100))
			this.setState({
				...this.state,
				progress: 'success',
				errorDetails: undefined,
				lastStatusUpdateTimestamp: Date.now(),
			})
			console.log('[AutofixAgent] Changes committed, progress set to success.')
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : 'Unknown commit error'
			console.error('[AutofixAgent] Failed to commit changes:', e)
			this.setState({
				...this.state,
				progress: 'failed',
				errorDetails: { message: errorMessage, failedStage: 'commit_changes' },
				lastStatusUpdateTimestamp: Date.now(),
			})
		}
	}

	private async handlePushChanges(): Promise<void> {
		console.log('[AutofixAgent] Executing: handlePushChanges')
		try {
			console.log('[AutofixAgent] Mock: Pushing changes...')
			await new Promise((resolve) => setTimeout(resolve, 100))
			this.setState({
				...this.state,
				progress: 'success',
				errorDetails: undefined,
				lastStatusUpdateTimestamp: Date.now(),
			})
			console.log('[AutofixAgent] Changes pushed, progress set to success.')
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : 'Unknown push error'
			console.error('[AutofixAgent] Failed to push changes:', e)
			this.setState({
				...this.state,
				progress: 'failed',
				errorDetails: { message: errorMessage, failedStage: 'push_changes' },
				lastStatusUpdateTimestamp: Date.now(),
			})
		}
	}

	private async handleCreatePr(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleCreatePr')
		try {
			console.log('[AutofixAgent] Mock: Creating PR...')
			await new Promise((resolve) => setTimeout(resolve, 100))
			this.setState({
				...this.state,
				progress: 'success',
				errorDetails: undefined,
				lastStatusUpdateTimestamp: Date.now(),
			})
			console.log('[AutofixAgent] PR created, progress set to success.')
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : 'Unknown PR creation error'
			console.error('[AutofixAgent] Failed to create PR:', e)
			this.setState({
				...this.state,
				progress: 'failed',
				errorDetails: { message: errorMessage, failedStage: 'create_pr' },
				lastStatusUpdateTimestamp: Date.now(),
			})
		}
	}

	private async handleFinish(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleFinish. Agent process cycle completed.')
		// This stage mainly signifies the end of a full pass.
		// Setting progress to 'success' will allow getNextAction to transition to 'idle'.
		this.setState({
			...this.state,
			progress: 'success',
			errorDetails: undefined,
			lastStatusUpdateTimestamp: Date.now(),
		})
	}

	private async handleError(): Promise<void> {
		console.warn(
			`[AutofixAgent] Handling error. Details: ${JSON.stringify(this.state.errorDetails)}`
		)
		// For now, handling an error means acknowledging it and setting progress to success,
		// which will transition the agent to idle via getNextAction('handle_error', 'success').
		// Future: Implement retry logic, specific error handling, or notifications here.
		this.setState({ ...this.state, progress: 'success', lastStatusUpdateTimestamp: Date.now() }) // errorDetails will be cleared by processNextAction when transitioning to idle
	}
}
