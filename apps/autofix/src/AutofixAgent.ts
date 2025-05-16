import { Agent } from 'agents'
import { match, P } from 'ts-pattern'
import { z } from 'zod'

import type { Env } from './autofix.context'

type State = {
	repo: string
	branch: string
	action: AgentAction
	currentStatus: AgentStatus
}

const AgentActions = [
	{ name: 'idle', description: 'No current action.' },
	{ name: 'initialize_container', description: 'Start the process of initializing the container.' },
	{ name: 'check_container', description: 'Start the process of checking the container.' },
	{ name: 'detect_issues', description: 'Start the process of detecting issues.' },
	{ name: 'fix_issues', description: 'Start the process of fixing issues.' },
	{ name: 'commit_changes', description: 'Start the process of committing changes.' },
	{ name: 'push_changes', description: 'Start the process of pushing changes.' },
	{ name: 'create_pr', description: 'Start the process of creating a pull request.' },
	{ name: 'finish', description: 'Agent has completed its task.' },
] as const satisfies Array<{
	name: string
	description: string
}>

// Create a Zod schema from the names of the agent actions
const AgentActionSchema = z.enum(AgentActions.map((a) => a.name))
// Infer the AgentAction type from the Zod schema
type AgentAction = z.infer<typeof AgentActionSchema>

const AgentStatuses = [
	{ name: 'idle', description: 'The agent is idle, awaiting an action.' },
	{ name: 'container_initializing', description: 'Container is currently being initialized.' },
	{ name: 'container_ready', description: 'Container is initialized and ready.' },
	{ name: 'container_check_running', description: 'Running checks on the container.' },
	{ name: 'container_check_complete', description: 'Container checks are complete.' },
	{ name: 'issue_detection_running', description: 'Detecting issues in the project.' },
	{ name: 'issue_detection_complete', description: 'Issue detection is complete.' },
	{ name: 'issue_fixing_running', description: 'Fixing issues in the project.' },
	{ name: 'issue_fixing_complete', description: 'Issue fixing is complete.' },
	{ name: 'changes_committing', description: 'Committing changes.' },
	{ name: 'changes_committed', description: 'Changes have been committed.' },
	{ name: 'changes_pushing', description: 'Pushing changes to the remote repository.' },
	{ name: 'changes_pushed', description: 'Changes have been pushed.' },
	{ name: 'pr_creating', description: 'Creating pull request.' },
	{ name: 'pr_created', description: 'Pull request has been created.' },
	{ name: 'done', description: 'The agent has completed all actions.' },
	{ name: 'error', description: 'An error occurred in the agent.' },
] as const satisfies Array<{
	name: string
	description: string
}>

// Create a Zod schema from the names of the agent statuses
const AgentStatusSchema = z.enum(AgentStatuses.map((s) => s.name))
// Infer the AgentStatus type from the Zod schema
type AgentStatus = z.infer<typeof AgentStatusSchema>

const nextActionMap: Record<AgentStatus, AgentAction> = {
	// for idle/complete statuses, the agent is ready to start the next action
	idle: 'initialize_container',
	container_ready: 'check_container',
	container_check_complete: 'detect_issues',
	issue_detection_complete: 'fix_issues',
	issue_fixing_complete: 'commit_changes',
	changes_committed: 'push_changes',
	changes_pushed: 'create_pr',
	pr_created: 'finish',
	done: 'idle',
	error: 'idle',
	// for in-progress statuses, the agent is busy. The next action to initiate is idle.
	container_initializing: 'idle',
	container_check_running: 'idle',
	issue_detection_running: 'idle',
	issue_fixing_running: 'idle',
	changes_committing: 'idle',
	changes_pushing: 'idle',
	pr_creating: 'idle',
}

function getNextAction(currentStatus: AgentStatus): AgentAction {
	return nextActionMap[currentStatus]
}

const actionToInProgressStatusMap: Record<Exclude<AgentAction, 'idle'>, AgentStatus> = {
	initialize_container: 'container_initializing',
	check_container: 'container_check_running',
	detect_issues: 'issue_detection_running',
	fix_issues: 'issue_fixing_running',
	commit_changes: 'changes_committing',
	push_changes: 'changes_pushing',
	create_pr: 'pr_creating',
	finish: 'done', // 'finish' action leads to 'done' status directly
}

function getActionInProgressStatus(action: Exclude<AgentAction, 'idle'>): AgentStatus {
	return actionToInProgressStatusMap[action]
}

export class AutofixAgent extends Agent<Env, State> {
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
		// Initialize state. The state is persisted via this.setState().
		// The durable object itself has this.id for its own ID.
		this.setState({ repo, branch, action: 'idle', currentStatus: 'idle' })

		// Asynchronously kick off the first action processing.
		// The client that called start() gets an immediate response from the return value below.
		this.ctx.waitUntil(this.processNextAction())

		// Return value for the Hono app's POST /api/agents/:agentId endpoint
		return {
			repo: this.state.repo,
			branch: this.state.branch,
			currentStatus: this.state.currentStatus, // will be 'idle'
			action: this.state.action, // will be 'idle'
			message: 'AutofixAgent process initiated. Current state polling recommended.',
		}
	}

	public async processNextAction(): Promise<void> {
		const state = this.state // Access in-memory state, kept in sync by Agent SDK
		if (!state) {
			console.error('[AutofixAgent] Agent state is not available in processNextAction.')
			// Consider setting an error state or re-initializing if appropriate
			return
		}

		const actionToExecute = getNextAction(state.currentStatus)

		if (actionToExecute === 'idle') {
			console.log(
				`[AutofixAgent] Current status '${state.currentStatus}' results in 'idle' next action. No new action taken.`
			)
			return
		}

		const newStatusWhileExecuting = getActionInProgressStatus(actionToExecute)

		this.setState({
			...state,
			action: actionToExecute,
			currentStatus: newStatusWhileExecuting,
		})

		console.log(
			`[AutofixAgent] Set state to action: '${actionToExecute}', status: '${newStatusWhileExecuting}'. Dispatching handler.`
		)
		this.ctx.waitUntil(this.dispatchActionHandler(actionToExecute))
	}

	private async dispatchActionHandler(action: AgentAction): Promise<void> {
		console.log(`[AutofixAgent] Dispatching handler for action: ${action}`)
		try {
			await match(action)
				.with('initialize_container', async () => this.handleInitializeContainer())
				.with('check_container', async () => this.handleCheckContainer())
				.with('detect_issues', async () => this.handleDetectIssues())
				.with('fix_issues', async () => this.handleFixIssues())
				.with('commit_changes', async () => this.handleCommitChanges())
				.with('push_changes', async () => this.handlePushChanges())
				.with('create_pr', async () => this.handleCreatePr())
				.with('finish', async () => this.handleFinish())
				.with('idle', () => {
					console.warn(
						"[AutofixAgent] dispatchActionHandler called with 'idle'. This should not happen."
					)
					return Promise.resolve() // ts-pattern match needs all handlers to return same type (Promise<void>)
				})
				.exhaustive() // Ensures all actions are handled
		} catch (error) {
			console.error(`[AutofixAgent] Error executing action ${action}:`, error)
			// Ensure state is available before trying to spread it
			const currentState = this.state || { repo: '', branch: '' }
			this.setState({ ...currentState, currentStatus: 'error', action: 'idle' })
			// Call processNextAction to allow the system to potentially recover or go to idle based on 'error' status.
			this.ctx.waitUntil(this.processNextAction())
		}
	}

	// --- Placeholder Action Handlers ---
	// Each handler simulates work, updates status, and triggers the next processing step.

	private async handleInitializeContainer(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleInitializeContainer')
		const { repo } = this.state
		try {
			// Mock: Simulate container initialization
			console.log(`[AutofixAgent] Mock: Initializing container for repo: ${repo}`)
			// const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID);
			// const userContainer = this.env.USER_CONTAINER.get(userContainerId);
			// await userContainer.container_initialize(repo); // Actual logic
			await new Promise((resolve) => setTimeout(resolve, 500)) // Simulate async work

			this.setState({ ...this.state, currentStatus: 'container_ready' })
			console.log('[AutofixAgent] Container initialized, status set to container_ready.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to initialize container:', e)
			this.setState({ ...this.state, currentStatus: 'error', action: 'idle' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handleCheckContainer(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleCheckContainer')
		try {
			console.log('[AutofixAgent] Mock: Checking container...')
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, currentStatus: 'container_check_complete' })
			console.log('[AutofixAgent] Container check complete.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to check container:', e)
			this.setState({ ...this.state, currentStatus: 'error', action: 'idle' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handleDetectIssues(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleDetectIssues')
		try {
			console.log('[AutofixAgent] Mock: Detecting issues...')
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, currentStatus: 'issue_detection_complete' })
			console.log('[AutofixAgent] Issue detection complete.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to detect issues:', e)
			this.setState({ ...this.state, currentStatus: 'error', action: 'idle' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handleFixIssues(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleFixIssues')
		try {
			console.log('[AutofixAgent] Mock: Fixing issues...')
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, currentStatus: 'issue_fixing_complete' })
			console.log('[AutofixAgent] Issue fixing complete.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to fix issues:', e)
			this.setState({ ...this.state, currentStatus: 'error', action: 'idle' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handleCommitChanges(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleCommitChanges')
		try {
			console.log('[AutofixAgent] Mock: Committing changes...')
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, currentStatus: 'changes_committed' })
			console.log('[AutofixAgent] Changes committed.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to commit changes:', e)
			this.setState({ ...this.state, currentStatus: 'error', action: 'idle' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handlePushChanges(): Promise<void> {
		console.log('[AutofixAgent] Executing: handlePushChanges')
		try {
			console.log('[AutofixAgent] Mock: Pushing changes...')
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, currentStatus: 'changes_pushed' })
			console.log('[AutofixAgent] Changes pushed.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to push changes:', e)
			this.setState({ ...this.state, currentStatus: 'error', action: 'idle' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handleCreatePr(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleCreatePr')
		try {
			console.log('[AutofixAgent] Mock: Creating PR...')
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, currentStatus: 'pr_created' })
			console.log('[AutofixAgent] PR created.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to create PR:', e)
			this.setState({ ...this.state, currentStatus: 'error', action: 'idle' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handleFinish(): Promise<void> {
		// The status is already set to 'done' by processNextAction when 'finish' action is determined.
		// This handler is mostly for any cleanup or final logging.
		console.log('[AutofixAgent] Executing: handleFinish. Agent process completed.')
		// No need to call processNextAction() here as 'done' status will lead to 'idle' action, ending the loop.
		// However, if there was a theoretical next step after 'done', it would be called.
		// For safety, and consistency, let's call it. getNextAction('done') returns 'idle', so it's safe.
		this.ctx.waitUntil(this.processNextAction())
	}
}
