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
const ProgressStatus = z.enum(['idle', 'pending', 'running', 'success', 'failed'])
type ProgressStatus = z.infer<typeof ProgressStatus>

const TIMEOUT_DURATION_MS = ms('10 minutes')
const MAX_ACTION_ATTEMPTS = 3

type AgentState = {
	repo: string
	branch: string
	currentAction: AgentAction // the current lifecycle stage
	currentActionAttempts: number // number of attempts made for the current action
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

		// Interruption Check: Detect if DO might have restarted during an action
		if (this.state.progress === 'running' && this.currentActionPromise === undefined) {
			const interruptedAction = this.state.currentAction
			const interruptionMessage = `Action '${interruptedAction}' may have been interrupted by a restart. Treating as a failed attempt.`
			this.logger.warn(`[AutofixAgent] Interruption: ${interruptionMessage}`)

			const attemptsMade = this.state.currentActionAttempts + 1

			this.setState({
				...this.state,
				currentActionAttempts: attemptsMade,
				progress: 'pending', // Set to pending for the match statement to handle retry
				lastStatusUpdateTimestamp: Date.now(),
				errorDetails: {
					message: interruptionMessage,
					failedAction: interruptedAction,
				},
			})
			// The main match statement will now see this action as 'pending' with an incremented attempt count.
		}

		this.setNextAlarm() // Set next alarm early

		/**
		 * Sets the agent's current action to a new action and progress to 'running'.
		 * Resets attempt counter if it's a new action type.
		 * @param newAction The action to transition to.
		 */
		const setRunning = (newAction: AgentAction): void => {
			const currentState = this.state
			let attemptsForNewAction = currentState.currentActionAttempts

			if (currentState.currentAction !== newAction) {
				// Transitioning to a completely new action type, reset attempts count for it.
				attemptsForNewAction = 0
			}
			// If newAction is the same as currentState.currentAction, it's a retry,
			// and attemptsForNewAction (which is currentState.currentActionAttempts)
			// already holds the count of prior failed attempts for this action.

			this.setState({
				...currentState,
				currentAction: newAction,
				progress: 'running',
				currentActionAttempts: attemptsForNewAction,
				lastStatusUpdateTimestamp: Date.now(),
				// errorDetails from currentState are preserved if transitioning from a failed state to retry
			})
			this.logger.info(
				`[AutofixAgent] Starting action: '${newAction}', progress: 'running'. Attempt ${attemptsForNewAction + 1} of ${MAX_ACTION_ATTEMPTS} (upcoming).`
			)
		}

		/**
		 * Manages currentActionPromise for interruption detection.
		 * @param actionToRun The action being executed.
		 */
		const runActionHandler = async (actionToRun: AgentAction, callback: () => Promise<void>) => {
			setRunning(actionToRun)
			this.currentActionPromise = callback()
			try {
				await this.currentActionPromise
				this.setActionOutcome({ progress: 'success' })
			} catch (e) {
				// setActionOutcome will increment attempts and determine if it's a definitive failure
				// or if retries are still possible.
				this.setActionOutcome({ progress: 'failed', error: e })
				// The main match statement will handle the 'failed' state for retry or transition to handle_error
			} finally {
				this.currentActionPromise = undefined
			}
		}

		// Timeout check for actions that are 'running'
		if (this.state.progress === 'running') {
			const duration = Date.now() - this.state.lastStatusUpdateTimestamp
			if (duration > TIMEOUT_DURATION_MS) {
				const currentActionThatTimedOut = this.state.currentAction
				const timeoutMessage = `Action '${currentActionThatTimedOut}' timed out after ${Math.round(duration / 1000)}s.`
				this.logger.error(`[AutofixAgent] Timeout: ${timeoutMessage}`)

				// Mark the timed-out action as failed. setActionOutcome handles attempt counting.
				const definitivelyFailed = this.setActionOutcome({
					progress: 'failed',
					error: new Error(timeoutMessage),
				})

				if (definitivelyFailed) {
					this.logger.info(
						`[AutofixAgent] Action '${currentActionThatTimedOut}' timed out and reached max attempts (${this.state.currentActionAttempts}). Transitioning to 'handle_error'.`
					)
					// Ensure the promise is cleared as we are aborting its logical flow.
					this.currentActionPromise = undefined
					await runActionHandler('handle_error', () => this.handleError())
				} else {
					this.logger.info(
						`[AutofixAgent] Action '${currentActionThatTimedOut}' timed out. Will retry. Attempt ${this.state.currentActionAttempts + 1} of ${MAX_ACTION_ATTEMPTS} upcoming.`
					)
					// State is now 'failed', currentActionAttempts is updated.
					// The next alarm will pick this up, and the match statement will trigger a retry.
				}
				return // Crucial: end processing for this alarm cycle after timeout.
			}
		}

		// The core state machine: evaluates the current action and its progress
		await match({
			currentAction: this.state.currentAction,
			progress: this.state.progress,
			currentActionAttempts: this.state.currentActionAttempts, // include for match
		})
			.returnType<Promise<void>>()
			// initial kick-off from idle or if initialize_container is pending
			.with(
				{ currentAction: 'idle', progress: 'idle' },
				{ currentAction: 'initialize_container', progress: 'pending' },
				async () => {
					await runActionHandler('initialize_container', () => this.handleInitializeContainer())
				}
			)
			// successful stage transitions OR current stage is pending (interrupted)
			.with(
				{ currentAction: 'initialize_container', progress: 'success' },
				{ currentAction: 'detect_issues', progress: 'pending' },
				async () => {
					await runActionHandler('detect_issues', () => this.handleDetectIssues())
				}
			)
			.with(
				{ currentAction: 'detect_issues', progress: 'success' },
				{ currentAction: 'fix_issues', progress: 'pending' },
				async () => {
					await runActionHandler('fix_issues', () => this.handleFixIssues())
				}
			)
			.with(
				{ currentAction: 'fix_issues', progress: 'success' },
				{ currentAction: 'commit_changes', progress: 'pending' },
				async () => {
					await runActionHandler('commit_changes', () => this.handleCommitChanges())
				}
			)
			.with(
				{ currentAction: 'commit_changes', progress: 'success' },
				{ currentAction: 'push_changes', progress: 'pending' },
				async () => {
					await runActionHandler('push_changes', () => this.handlePushChanges())
				}
			)
			.with(
				{ currentAction: 'push_changes', progress: 'success' },
				{ currentAction: 'create_pr', progress: 'pending' },
				async () => {
					await runActionHandler('create_pr', () => this.handleCreatePr())
				}
			)
			.with(
				{ currentAction: 'create_pr', progress: 'success' },
				{ currentAction: 'finish', progress: 'pending' },
				async () => {
					await runActionHandler('finish', () => this.handleFinish())
				}
			)
			// transitions to idle state (no further work to do)
			.with({ currentAction: 'finish', progress: 'success' }, async () => {
				this.logger.info("[AutofixAgent] 'finish' action successful. Transitioning to 'idle'.")
				this.setState({
					...this.state,
					currentAction: 'idle',
					progress: 'idle',
					currentActionAttempts: 0, // Reset attempts when going to idle
					errorDetails: undefined,
					lastStatusUpdateTimestamp: Date.now(),
				})
			})
			.with({ currentAction: 'handle_error', progress: 'success' }, async () => {
				this.logger.info(
					"[AutofixAgent] 'handle_error' action successful. Transitioning to 'idle'."
				)
				this.setState({
					...this.state,
					currentAction: 'idle',
					progress: 'idle',
					currentActionAttempts: 0, // Reset attempts when going to idle
					errorDetails: undefined, // Clear error details after successful error handling
					lastStatusUpdateTimestamp: Date.now(),
				})
			})
			.with(
				{
					currentAction: P.union(
						// 'idle' failing is an anomaly, not typically part of retry logic for specific actions
						'initialize_container',
						'detect_issues',
						'fix_issues',
						'commit_changes',
						'push_changes',
						'create_pr',
						'finish'
					),
					progress: 'failed', // Only handle 'failed' here; 'pending' is handled by specific transitions above
				},
				async ({ currentAction, currentActionAttempts, progress }) => {
					if (currentActionAttempts < MAX_ACTION_ATTEMPTS) {
						this.logger.info(
							`[AutofixAgent] Action '${currentAction}' FAILED (attempt ${currentActionAttempts} of ${MAX_ACTION_ATTEMPTS}). Transitioning to 'pending' for retry on next alarm.`
						)
						// errorDetails from the failure are preserved from setActionOutcome.
						// currentActionAttempts was already incremented by setActionOutcome.
						this.setState({
							...this.state,
							progress: 'pending', // Set to pending, the specific transition above will pick it up.
							lastStatusUpdateTimestamp: Date.now(),
						})
					} else {
						this.logger.info(
							`[AutofixAgent] Action '${currentAction}' (state: ${progress}) failed after ${currentActionAttempts} attempts. Transitioning to 'handle_error'.`
						)
						// errorDetails should have been set by the last setActionOutcome call or interruption handling.
						await runActionHandler('handle_error', () => this.handleError())
					}
				}
			)
			.with({ currentAction: 'handle_error', progress: 'pending' }, async () => {
				this.logger.info(
					"[AutofixAgent] 'handle_error' action was interrupted (pending). Retrying handle_error."
				)
				await runActionHandler('handle_error', () => this.handleError())
			})
			.with({ currentAction: 'handle_error', progress: 'failed' }, async (matchedState) => {
				// This implies handleError itself failed.
				this.logger.error(
					`[AutofixAgent] 'handle_error' action itself FAILED (attempt ${matchedState.currentActionAttempts}). Error details: ${JSON.stringify(this.state.errorDetails)}. Transitioning to 'idle' to prevent loop. Error details preserved.`
				)
				this.setState({
					...this.state,
					currentAction: 'idle',
					progress: 'idle',
					currentActionAttempts: 0, // Reset attempts
					// errorDetails are preserved from the original error + the handle_error failure
					lastStatusUpdateTimestamp: Date.now(),
				})
			})
			.with({ currentAction: P.not('idle'), progress: 'running' }, async (matchedState) => {
				this.logger.info(
					`[AutofixAgent] Action '${matchedState.currentAction}' is 'running' (attempt ${matchedState.currentActionAttempts + 1}). Agent waits for completion or timeout.`
				)
			})
			.with(
				{ currentAction: 'idle', progress: P.union('running', 'success', 'failed', 'pending') }, // Added 'pending' and 'failed'
				async (matchedState) => {
					this.logger.warn(
						`[AutofixAgent] Anomalous state: currentAction is 'idle' but progress is '${matchedState.progress}'. Resetting to idle/idle.`
					)
					this.setState({
						...this.state,
						currentAction: 'idle',
						progress: 'idle',
						currentActionAttempts: 0,
						errorDetails: undefined,
						lastStatusUpdateTimestamp: Date.now(),
					})
				}
			)
			.with({ currentAction: P.not('idle'), progress: 'idle' }, async (matchedState) => {
				this.logger.warn(
					`[AutofixAgent] Anomalous state: currentAction is '${matchedState.currentAction}' but progress is 'idle'. Action might not have started correctly or was reset. Transitioning to 'pending' to attempt restart.`
				)
				// Set to pending, the specific transition above for this action will pick it up.
				// currentActionAttempts is preserved. If it was 0, it remains 0 for the pending retry.
				// If it had prior attempts, those are respected.
				this.setState({
					...this.state,
					// currentAction is already matchedState.currentAction
					progress: 'pending',
					lastStatusUpdateTimestamp: Date.now(),
					errorDetails: {
						message: `Anomalous recovery: Action '${matchedState.currentAction}' was idle, now set to pending.`,
						failedAction: matchedState.currentAction,
					},
				})
			})
			.exhaustive()
	}

	/**
	 * Sets the outcome (success or failure) of the current action, updating progress, attempt counts, and error details.
	 * @param options Specifies the progress status and error object if failed.
	 * @returns boolean - true if the action has definitively failed (all retries exhausted or unrecoverable), false otherwise.
	 */
	private setActionOutcome(
		options: { progress: 'success' } | { progress: 'failed'; error: Error | unknown }
	): boolean {
		const baseUpdate: Partial<AgentState> = {
			lastStatusUpdateTimestamp: Date.now(),
		}
		const currentAction = this.state.currentAction // Action that just finished

		if (options.progress === 'success') {
			this.setState({
				...this.state,
				...baseUpdate,
				progress: 'success',
				// currentActionAttempts for the completed action remains; it's reset by setRunning
				// when a new distinct action type begins.
				errorDetails: undefined, // Clear error on success
			})
			this.logger.info(`[AutofixAgent] Action '${currentAction}' Succeeded.`)
			return false // Not definitively failed
		} else {
			// 'failed'
			const error = options.error
			const errorMessage =
				error instanceof Error ? error.message : 'Unknown error during action execution'

			// This is the number of attempts that will have been made *after* this one.
			const attemptsMade = this.state.currentActionAttempts + 1

			this.logger.error(
				`[AutofixAgent] Action '${currentAction}' attempt ${attemptsMade} of ${MAX_ACTION_ATTEMPTS} FAILED. Error: ${errorMessage}`,
				error instanceof Error ? error.stack : undefined // Log stack for Error instances
			)

			const isDefinitivelyFailed = attemptsMade >= MAX_ACTION_ATTEMPTS

			this.setState({
				...this.state,
				...baseUpdate,
				progress: 'failed', // Mark as 'failed' for this attempt.
				currentActionAttempts: attemptsMade, // Increment failed attempts count
				errorDetails: {
					message: `Action '${currentAction}' attempt ${attemptsMade}/${MAX_ACTION_ATTEMPTS} failed: ${errorMessage}`,
					failedAction: currentAction,
				},
			})

			if (isDefinitivelyFailed) {
				this.logger.warn(
					`[AutofixAgent] Action '${currentAction}' has definitively FAILED after ${attemptsMade} attempts.`
				)
				return true // Definitively failed
			} else {
				// For 'failed' state, log remaining retries.
				// For 'pending' state (handled by interruption logic directly), this specific log might not appear from here,
				// as 'pending' doesn't call setActionOutcome directly for the interruption event itself.
				// However, if a retried 'pending' action then fails, this log will be relevant.
				this.logger.info(
					`[AutofixAgent] Action '${currentAction}' failed on attempt ${attemptsMade}. Retries remaining: ${MAX_ACTION_ATTEMPTS - attemptsMade}.`
				)
				return false // Not definitively failed yet, retries possible
			}
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
		// If this were to fail, retries would apply as per normal action handling.
	}

	private async handleError(): Promise<void> {
		// The errorDetails in this.state should already be set by setActionOutcome
		// from the action that ultimately failed and led to handleError.
		this.logger.warn(
			`[AutofixAgent] Executing handleError. Error details: ${JSON.stringify(this.state.errorDetails)}`
		)
		// For now, handling an error means acknowledging it and allowing the agent to go idle.
		// runActionHandler (which calls this) will set handleError's progress to 'success'.
		// If handleError itself were to throw an error, it would be caught by its own runActionHandler
		// and its setActionOutcome would be called. The main match statement has a case for
		// 'handle_error'/'failed' which transitions to idle to prevent loops.

		// Future: Implement more specific error handling, notifications, or even specific cleanup actions.
		// For example, if errorDetails.failedAction was 'push_changes', try to delete remote branch.
		await new Promise((resolve) => setTimeout(resolve, ms('0.05 seconds'))) // Simulate some brief work
	}
}
