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
	{ name: 'queued', description: 'Agent is queued and waiting to start.' },
	{ name: 'running', description: 'Agent is running and processing actions.' },
	{ name: 'stopped', description: 'Agent has stopped running.' },
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
export type AgentAction = z.infer<typeof AgentAction>

const ActionStatus = z.enum(['queued', 'running', 'stopped'])
type ActionStatus = z.infer<typeof ActionStatus>

export type AgentState = {
	repo: string
	branch: string
	agentStatus: AgentStatus
	currentAction: {
		action: AgentAction
		status: ActionStatus
	}
	errorDetails?: { message: string; failedAction: AgentAction }
}

@EnsureAgentActions(AgentActions.map((a) => a.name))
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
		this.logger = logger
	}

	/**
	 * Start the agent
	 */
	@WithLogTags({ source: 'AutofixAgent', handler: 'start' })
	public async start({ repo, branch }: { repo: string; branch: string }) {
		this.logger = logger.withTags({
			state: {
				repo,
				branch,
				agentStatus: 'queued',
				currentAction: { action: 'initialize_container', status: 'queued' },
			},
		})

		this.logger.info(`[AutofixAgent] Queueing agent for repo: ${repo}, branch: ${branch}.`)
		this.setState({
			repo,
			branch,
			agentStatus: 'queued',
			currentAction: { action: 'initialize_container', status: 'queued' },
			errorDetails: undefined,
		})

		// All further logic is handled in onAlarm
		this.setNextAlarm(datePlus('1 second'))

		return {
			repo: this.state.repo,
			branch: this.state.branch,
			currentAction: this.state.currentAction.action,
			progress: this.state.currentAction.status,
			agentStatus: this.state.agentStatus,
			errorDetails: this.state.errorDetails,
			message: 'AutofixAgent started and queued.',
		}
	}

	/**
	 * Schedules the next alarm for the agent.
	 * @param nextAlarm Optional specific date for the next alarm. Default:  5 seconds from now.
	 */
	private setNextAlarm(nextAlarm?: Date) {
		const nextAlarmDate = nextAlarm ?? datePlus('5 seconds')
		void this.ctx.storage.setAlarm(nextAlarmDate)
		this.logger.info(`[AutofixAgent] Next alarm set for ${nextAlarmDate.toISOString()}`)
	}

	@WithLogTags({ source: 'AutofixAgent', handler: 'onAlarm' })
	override async onAlarm(): Promise<void> {
		this.logger.info('[AutofixAgent] Alarm triggered.')

		// handle Agent statuses
		const isStopped = match(this.state.agentStatus)
			.returnType<boolean>()
			.with('queued', () => {
				this.logger.info('[AutofixAgent] Agent is queued. Transitioning to running.')
				this.setState({
					...this.state,
					agentStatus: 'running',
				})
				return false
			})
			.with('running', () => {
				this.setNextAlarm()
				return false
			})
			.with('stopped', () => {
				this.logger.info('[AutofixAgent] Agent is stopped. No new alarm will be set.')
				return true
			})
			.exhaustive()
		if (isStopped) {
			return
		}

		// Handle the case where the agent was interrupted by a DO restart.
		// TODO: Add retries when this happens.
		if (this.state.currentAction.status === 'running' && this.currentActionPromise === undefined) {
			const interruptedActionName = this.state.currentAction.action
			const interruptionMessage = `Action '${interruptedActionName}' was interrupted (possibly by a DO restart). Stopping agent.`
			this.logger.warn(`[AutofixAgent] Interruption: ${interruptionMessage}`)
			this.setState({
				...this.state,
				agentStatus: 'stopped',
				currentAction: { action: interruptedActionName, status: 'stopped' },
				errorDetails: {
					message: interruptionMessage,
					failedAction: interruptedActionName,
				},
			})
			this.setNextAlarm()
			return
		}

		const setRunning = (newActionName: AgentAction): void => {
			this.setState({
				...this.state,
				currentAction: { action: newActionName, status: 'running' },
				errorDetails: this.state.errorDetails,
			})
			this.logger.info(`[AutofixAgent] Starting action: '${newActionName}'.`)
		}

		const setQueued = (newActionName: AgentAction): void => {
			this.setState({
				...this.state,
				currentAction: { action: newActionName, status: 'queued' },
				errorDetails: this.state.errorDetails,
			})
			this.logger.info(`[AutofixAgent] Action '${newActionName}' queued.`)
		}

		const runActionHandler = async (actionToRun: AgentAction, callback: () => Promise<void>) => {
			setRunning(actionToRun)
			// track the current action's promise so that we can detect when
			// the DO got inturrupted while it was running.
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

		// handle agent actions
		await match(this.state.currentAction)
			.with({ action: 'initialize_container', status: 'queued' }, async () => {
				await runActionHandler('initialize_container', this.handleInitializeContainer)
				setQueued('detect_issues')
			})
			.with({ action: 'detect_issues', status: 'queued' }, async () => {
				await runActionHandler('detect_issues', this.handleDetectIssues)
				setQueued('fix_issues')
			})
			.with({ action: 'fix_issues', status: 'queued' }, async () => {
				await runActionHandler('fix_issues', this.handleFixIssues)
				setQueued('commit_changes')
			})
			.with({ action: 'commit_changes', status: 'queued' }, async () => {
				await runActionHandler('commit_changes', this.handleCommitChanges)
				setQueued('push_changes')
			})
			.with({ action: 'push_changes', status: 'queued' }, async () => {
				await runActionHandler('push_changes', this.handlePushChanges)
				setQueued('create_pr')
			})
			.with({ action: 'create_pr', status: 'queued' }, async () => {
				await runActionHandler('create_pr', this.handleCreatePr)

				this.logger.info('[AutofixAgent] Agent is done! Stopping.')
				this.setState({
					...this.state,
					agentStatus: 'stopped',
				})
			})
			.with({ status: 'running' }, ({ action }) => {
				this.logger.error(
					`[AutofixAgent] Action '${action}' is running. Agent waits for completion.`
				)
				this.setState({
					...this.state,
					agentStatus: 'stopped',
					currentAction: { action, status: 'stopped' },
					errorDetails: {
						message: `Agent is stuck in a loop.`,
						failedAction: action,
					},
				})
			})
			.with({ status: 'stopped' }, ({ action }) => {
				this.logger.info(
					`[AutofixAgent] No action queued after ${action} was stopped. Stopping agent.`
				)
				this.setState({
					...this.state,
					agentStatus: 'stopped',
					currentAction: { action, status: 'stopped' },
				})
				return
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
	): void {
		const currentActionName = this.state.currentAction.action
		if (options.progress === 'success') {
			this.setState({
				...this.state,
				currentAction: { ...this.state.currentAction, status: 'stopped' },
				errorDetails: undefined,
			})
			this.logger.info(
				`[AutofixAgent] Action '${currentActionName}' Succeeded (progress set to stopped).`
			)
		} else {
			const e = options.error
			const errorMessage = e instanceof Error ? e.message : 'Unknown error during action execution'
			this.logger.error(
				`[AutofixAgent] Action '${currentActionName}' FAILED. Error: ${errorMessage}. Agent stopping.`,
				e instanceof Error ? e.stack : undefined
			)
			this.setState({
				...this.state,
				agentStatus: 'stopped',
				currentAction: { ...this.state.currentAction, status: 'stopped' },
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
	}
}
