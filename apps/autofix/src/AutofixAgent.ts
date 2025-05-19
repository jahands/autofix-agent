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
	repo: string
	branch: string
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
		})

		// All further logic is handled in onAlarm
		this.setNextAlarm(datePlus('1 second'))

		return {
			repo: this.state.repo,
			branch: this.state.branch,
			currentAction: this.state.currentAction.action,
			progress: this.state.currentAction.status,
			agentStatus: this.state.agentStatus,
			message: 'AutofixAgent queued.',
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
				currentAction: {
					action: interruptedActionName,
					status: 'stopped',
					error: { message: interruptionMessage },
				},
			})
			this.setNextAlarm()
			return
		}

		const setQueued = (newActionName: AgentAction): void => {
			this.setState({
				...this.state,
				currentAction: { action: newActionName, status: 'queued' },
			})
			this.logger.info(`[AutofixAgent] Action '${newActionName}' queued.`)
		}

		const setRunning = (newActionName: AgentAction): void => {
			this.setState({
				...this.state,
				currentAction: { action: newActionName, status: 'running' },
			})
			this.logger.info(`[AutofixAgent] Starting action: '${newActionName}'.`)
		}

		const setStopped = (actionName: AgentAction, error?: Error | unknown): void => {
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
		const runActionHandler = async (actionName: AgentAction, handlerFn: () => Promise<void>) => {
			setRunning(actionName)
			// Track the current action's promise so that we can detect when
			// the DO got inturrupted while it was running.
			this.currentActionPromise = handlerFn()
			try {
				await this.currentActionPromise
				setStopped(actionName)
			} catch (e) {
				setStopped(actionName, e)
			} finally {
				this.currentActionPromise = undefined
			}
		}

		// agent actions
		await match(this.state.currentAction)
			// handle queued actions
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
}
