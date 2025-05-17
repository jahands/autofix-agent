import { Agent } from 'agents'
import { datePlus, ms } from 'itty-time'
import { match, P } from 'ts-pattern'
import { z } from 'zod'

import { logger } from './logger'
import { EnsureActionHandlers, type HandledAgentActions } from './agent.decorators'

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
] as const satisfies Array<{
	name: string
	description: string
}>

const AgentAction = z.enum(AgentActions.map((a) => a.name))
export type AgentAction = z.infer<typeof AgentAction>

// progress status for an action/stage
const ProgressStatus = z.enum(['idle', 'retry', 'running', 'success', 'failed'])
type ProgressStatus = z.infer<typeof ProgressStatus>

// MAX_ACTION_ATTEMPTS is back, TIMEOUT_DURATION_MS remains removed
const MAX_ACTION_ATTEMPTS = 3

type AgentState = {
	repo: string
	branch: string
	currentAction: AgentAction // the current lifecycle stage
	currentActionAttempts: number // 1-indexed number of the current attempt for the active action; 0 if idle.
	progress: ProgressStatus // the progress of that stage
	errorDetails?: { message: string; failedAction: AgentAction } // optional error context
}

// Define the list of actions that require handlers for this specific agent
const autofixAgentHandledActions: HandledAgentActions[] = [
	'initialize_container',
	'detect_issues',
	'fix_issues',
	'commit_changes',
	'push_changes',
	'create_pr',
	// 'finish' is excluded as per previous discussion
]

@EnsureActionHandlers(autofixAgentHandledActions)
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
				currentActionAttempts: this.state.currentActionAttempts, // Restored
				progress: this.state.progress,
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
			currentAction: 'idle',
			currentActionAttempts: 0, // Restored
			progress: 'idle',
			errorDetails: undefined,
		})

		// start the agent via alarms.
		this.setNextAlarm(datePlus('1 second'))

		return {
			repo: this.state.repo,
			branch: this.state.branch,
			currentAction: this.state.currentAction,
			progress: this.state.progress,
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

		// Interruption Check: Detect if DO might have restarted during an action
		if (this.state.progress === 'running' && this.currentActionPromise === undefined) {
			const interruptedAction = this.state.currentAction
			const attemptOfInterruptedAction = this.state.currentActionAttempts
			const interruptionMessage = `Action '${interruptedAction}' attempt ${attemptOfInterruptedAction} may have been interrupted by a restart.`
			this.logger.warn(`[AutofixAgent] Interruption: ${interruptionMessage}`)

			if (attemptOfInterruptedAction < MAX_ACTION_ATTEMPTS) {
				this.logger.info(
					`Transitioning interrupted action '${interruptedAction}' (attempt ${attemptOfInterruptedAction}) to 'retry' state for upcoming attempt ${attemptOfInterruptedAction + 1}.`
				)
				// Setting to retry allows the main match statement to handle it.
				// currentActionAttempts (the one that was interrupted) is preserved for setRunning to increment.
				this.setState({
					...this.state,
					progress: 'retry',
					errorDetails: {
						message: interruptionMessage,
						failedAction: interruptedAction,
					},
				})
			} else {
				this.logger.error(
					`Action '${interruptedAction}' attempt ${attemptOfInterruptedAction} was interrupted and has reached MAX attempts. Transitioning to idle with error.`
				)
				// Directly set state to idle, preserving interruption error details
				this.setState({
					...this.state,
					currentAction: 'idle', // Go to idle
					progress: 'idle',
					currentActionAttempts: 0, // Reset attempts
					errorDetails: {
						message: `${interruptionMessage} Max attempts reached. Agent idle.`,
						failedAction: interruptedAction,
					},
				})
				// No further processing for this alarm if error is terminal for the action
				return
			}
		}

		this.setNextAlarm() // Set next alarm early

		/**
		 * Sets the agent's current action to a new action and progress to 'running'.
		 * Manages the 1-indexed attempt counter for the action about to run.
		 * @param newAction The action to transition to.
		 */
		const setRunning = (newAction: AgentAction): void => {
			let attemptNumberOfUpcomingRun: number

			// If it's a new type of action OR the agent is starting its first action from an overall idle state,
			// this is Attempt 1 for the newAction.
			if (
				this.state.currentAction !== newAction ||
				(this.state.currentAction === 'idle' && this.state.progress === 'idle')
			) {
				attemptNumberOfUpcomingRun = 1
			} else {
				// It's a retry of the same action (which was retry or failed and then became retry).
				// this.state.currentActionAttempts holds the number of the *previous* attempt for this action.
				attemptNumberOfUpcomingRun = this.state.currentActionAttempts + 1
			}

			this.setState({
				...this.state,
				currentAction: newAction,
				progress: 'running',
				currentActionAttempts: attemptNumberOfUpcomingRun,
				// errorDetails from this.state are preserved if transitioning from a failed/retry state to retry
			})
			this.logger.info(
				`[AutofixAgent] Starting action: '${newAction}'. Attempt ${attemptNumberOfUpcomingRun} of ${MAX_ACTION_ATTEMPTS}.`
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
				// The main match statement will handle the 'failed' state for retry or transition to idle
			} finally {
				this.currentActionPromise = undefined
			}
		}

		// The core state machine: evaluates the current action and its progress
		await match({
			currentAction: this.state.currentAction,
			progress: this.state.progress,
			currentActionAttempts: this.state.currentActionAttempts, // Restored in match context
		})
			.returnType<Promise<void>>()
			// initial kick-off from idle or if initialize_container is to be retried
			.with(
				{ currentAction: 'idle', progress: 'idle' },
				{ currentAction: 'initialize_container', progress: 'retry' },
				() => runActionHandler('initialize_container', () => this.handleInitializeContainer())
			)
			// successful stage transitions OR current stage is marked for retry (interrupted/failed previously)
			.with(
				{ currentAction: 'initialize_container', progress: 'success' },
				{ currentAction: 'detect_issues', progress: 'retry' },
				() => runActionHandler('detect_issues', () => this.handleDetectIssues())
			)
			.with(
				{ currentAction: 'detect_issues', progress: 'success' },
				{ currentAction: 'fix_issues', progress: 'retry' },
				() => runActionHandler('fix_issues', () => this.handleFixIssues())
			)
			.with(
				{ currentAction: 'fix_issues', progress: 'success' },
				{ currentAction: 'commit_changes', progress: 'retry' },
				() => runActionHandler('commit_changes', () => this.handleCommitChanges())
			)
			.with(
				{ currentAction: 'commit_changes', progress: 'success' },
				{ currentAction: 'push_changes', progress: 'retry' },
				() => runActionHandler('push_changes', () => this.handlePushChanges())
			)
			.with(
				{ currentAction: 'push_changes', progress: 'success' },
				{ currentAction: 'create_pr', progress: 'retry' },
				() => runActionHandler('create_pr', () => this.handleCreatePr())
			)
			.with(
				{ currentAction: 'create_pr', progress: 'success' },
				{ currentAction: 'finish', progress: 'retry' },
				() => runActionHandler('finish', () => this.handleFinish())
			)
			// transitions to idle state (no further work to do)
			.with({ currentAction: 'finish', progress: 'success' }, async () => {
				this.logger.info("[AutofixAgent] 'finish' action successful. Transitioning to 'idle'.")
				this.setState({
					...this.state,
					currentAction: 'idle',
					progress: 'idle',
					currentActionAttempts: 0, // Restored
					errorDetails: undefined,
				})
			})
			// Handle failed actions (that are not 'idle')
			// These will transition to 'retry', or to 'idle' if max attempts are reached.
			.with(
				{
					currentAction: P.not('idle'), // Any action except idle
					progress: 'failed',
				},
				async ({ currentAction, currentActionAttempts, progress }) => {
					if (currentActionAttempts < MAX_ACTION_ATTEMPTS) {
						this.logger.info(
							`[AutofixAgent] Action '${currentAction}' FAILED (attempt ${currentActionAttempts} of ${MAX_ACTION_ATTEMPTS}). Transitioning to 'retry' state for next alarm (upcoming attempt ${currentActionAttempts + 1}).`
						)
						this.setState({
							...this.state,
							progress: 'retry',
							errorDetails: this.state.errorDetails,
						})
					} else {
						this.logger.error(
							`[AutofixAgent] Action '${currentAction}' (state: ${progress}) failed after ${currentActionAttempts} attempts (MAX attempts reached). Transitioning to idle with error.`
						)
						// errorDetails should have been set by the last setActionOutcome call.
						this.setState({
							...this.state,
							currentAction: 'idle',
							progress: 'idle',
							currentActionAttempts: 0,
							// errorDetails are preserved from the failed action
						})
					}
				}
			)
			.with({ currentAction: P.not('idle'), progress: 'running' }, async (matchedState) => {
				this.logger.info(
					// Restored attempt count log
					`[AutofixAgent] Action '${matchedState.currentAction}' is 'running' (attempt ${matchedState.currentActionAttempts}). Agent waits for completion.`
				)
			})
			.with(
				{ currentAction: 'idle', progress: P.union('running', 'success', 'failed', 'retry') }, // Added 'retry'
				async (matchedState) => {
					this.logger.warn(
						`[AutofixAgent] Anomalous state: currentAction is 'idle' but progress is '${matchedState.progress}'. Resetting to idle/idle.`
					)
					this.setState({
						...this.state,
						currentAction: 'idle',
						progress: 'idle',
						currentActionAttempts: 0, // Restored
						errorDetails: undefined,
					})
				}
			)
			.with({ currentAction: P.not('idle'), progress: 'idle' }, async (matchedState) => {
				this.logger.warn(
					`[AutofixAgent] Anomalous state: currentAction is '${matchedState.currentAction}' but progress is 'idle'. Action might not have started correctly or was reset. Transitioning to 'retry' state to attempt restart.`
				)
				// Set to retry, the specific transition above for this action will pick it up.
				// currentActionAttempts is preserved. If it was 0, it remains 0 for the pending retry.
				// If it had prior attempts, those are respected.
				this.setState({
					...this.state,
					// currentAction is already matchedState.currentAction
					progress: 'retry',
					errorDetails: {
						message: `Anomalous recovery: Action '${matchedState.currentAction}' was idle, now set to retry.`,
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
		// Return type is boolean again
		const currentAction = this.state.currentAction // Action that just finished
		if (options.progress === 'success') {
			this.setState({
				...this.state,
				progress: options.progress,
				// currentActionAttempts for the completed action already holds the 1-indexed attempt number it succeeded on.
				errorDetails: undefined, // Clear error on success
			})
			this.logger.info(
				`[AutofixAgent] Action '${currentAction}' attempt ${this.state.currentActionAttempts} Succeeded.`
			)
			return false // Not definitively failed
		} else {
			// 'failed'
			const e = options.error // Using 'e' as per preference
			const errorMessage = e instanceof Error ? e.message : 'Unknown error during action execution'

			// currentActionAttempts in this.state already holds the number of the attempt that just failed.
			const attemptThatFailed = this.state.currentActionAttempts

			this.logger.error(
				`[AutofixAgent] Action '${currentAction}' attempt ${attemptThatFailed} of ${MAX_ACTION_ATTEMPTS} FAILED. Error: ${errorMessage}`,
				e instanceof Error ? e.stack : undefined // Log stack for Error instances
			)

			const isDefinitivelyFailed = attemptThatFailed >= MAX_ACTION_ATTEMPTS

			this.setState({
				...this.state,
				progress: options.progress,
				// currentActionAttempts remains as attemptThatFailed. It's not incremented here.
				errorDetails: {
					message: `Action '${currentAction}' attempt ${attemptThatFailed}/${MAX_ACTION_ATTEMPTS} failed: ${errorMessage}`,
					failedAction: currentAction,
				},
			})

			if (isDefinitivelyFailed) {
				this.logger.warn(
					`[AutofixAgent] Action '${currentAction}' has definitively FAILED after ${attemptThatFailed} attempts.`
				)
				return true // Definitively failed
			} else {
				this.logger.info(
					`[AutofixAgent] Action '${currentAction}' failed on attempt ${attemptThatFailed}. Retries remaining: ${MAX_ACTION_ATTEMPTS - attemptThatFailed}. Will transition to retry state for next alarm.`
				)
				return false // Not definitively failed yet, retries possible
			}
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
