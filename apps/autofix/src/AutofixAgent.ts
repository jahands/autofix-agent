import { Agent } from 'agents'
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
] as const satisfies Array<{
	name: string
	description: string
}>

const AgentAction = z.enum(AgentActions.map((a) => a.name))
type AgentAction = z.infer<typeof AgentAction>

// progress status for an action/stage
const ProgressStatus = z.enum(['idle', 'pending', 'in-progress', 'success', 'failed'])
type ProgressStatus = z.infer<typeof ProgressStatus>

type AgentState = {
	repo: string
	branch: string
	currentActionStage: AgentAction // The current lifecycle stage
	progress: ProgressStatus // The progress of that stage
}

// Map for determining the next action when the current action/stage is successfully completed
const nextStageOnSuccessMap: Partial<Record<AgentAction, AgentAction>> = {
	initialize_container: 'detect_issues',
	detect_issues: 'fix_issues',
	fix_issues: 'commit_changes',
	commit_changes: 'push_changes',
	push_changes: 'create_pr',
	create_pr: 'finish',
	finish: 'idle', // After 'finish' successfully completes, the agent becomes 'idle'
}

function getNextAction(currentStage: AgentAction, progress: ProgressStatus): AgentAction {
	if (currentStage === 'idle' && progress === 'idle') {
		return 'initialize_container' // Start the process
	}

	if (progress === 'success') {
		return nextStageOnSuccessMap[currentStage] || 'idle' // Go to next defined stage, or idle if at the end or undefined
	}

	// If in-progress, pending, or failed, the agent should not start a new action automatically.
	// It should wait for the current action to complete or for manual intervention/retry logic for 'failed'.
	return 'idle'
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
		this.setState({ repo, branch, currentActionStage: 'idle', progress: 'idle' })

		// Asynchronously kick off the first action processing.
		// The client that called start() gets an immediate response from the return value below.
		this.ctx.waitUntil(this.processNextAction())

		// Return value for the Hono app's POST /api/agents/:agentId endpoint
		return {
			repo: this.state.repo,
			branch: this.state.branch,
			currentActionStage: this.state.currentActionStage,
			progress: this.state.progress,
			message: 'AutofixAgent process initiated. Current state polling recommended.',
		}
	}

	public async processNextAction(): Promise<void> {
		const state = this.state // Access in-memory state, kept in sync by Agent SDK
		if (!state) {
			console.error('[AutofixAgent] Agent state is not available in processNextAction.')
			return
		}

		const actionToExecute = getNextAction(state.currentActionStage, state.progress)

		if (actionToExecute === 'idle') {
			console.log(
				`[AutofixAgent] Current stage '${state.currentActionStage}' with progress '${state.progress}' results in 'idle' next action. No new stage initiated.`
			)
			// If we just successfully completed the 'finish' stage, transition the overall agent state to idle.
			if (state.currentActionStage === 'finish' && state.progress === 'success') {
				this.setState({ ...state, currentActionStage: 'idle', progress: 'idle' })
				console.log('[AutofixAgent] Process finished. Agent is now truly idle.')
			}
			return
		}

		// If there's a new action/stage to execute:
		this.setState({
			...state,
			currentActionStage: actionToExecute,
			progress: 'in-progress',
		})

		console.log(
			`[AutofixAgent] Transitioning to stage: '${actionToExecute}', progress: 'in-progress'. Dispatching handler.`
		)
		this.ctx.waitUntil(this.dispatchActionHandler(actionToExecute))
	}

	private async dispatchActionHandler(action: AgentAction): Promise<void> {
		console.log(`[AutofixAgent] Dispatching handler for action/stage: ${action}`)
		try {
			await match(action)
				.with('initialize_container', async () => this.handleInitializeContainer())
				.with('detect_issues', async () => this.handleDetectIssues())
				.with('fix_issues', async () => this.handleFixIssues())
				.with('commit_changes', async () => this.handleCommitChanges())
				.with('push_changes', async () => this.handlePushChanges())
				.with('create_pr', async () => this.handleCreatePr())
				.with('finish', async () => this.handleFinish())
				.with('idle', async () => {
					// Should ideally not be dispatched, but handle defensively
					console.warn(
						"[AutofixAgent] dispatchActionHandler called with 'idle'. Setting to idle progress."
					)
					if (this.state.currentActionStage === 'idle' && this.state.progress !== 'idle') {
						this.setState({ ...this.state, progress: 'idle' })
					}
				})
				.exhaustive() // Ensures all actions are handled
		} catch (err) {
			console.error(`[AutofixAgent] Error executing action/stage ${action}:`, err)
			const currentState = this.state || {
				repo: '',
				branch: '',
				currentActionStage: action,
				progress: 'idle',
			}
			this.setState({ ...currentState, progress: 'failed' }) // currentActionStage remains the one that failed
			this.ctx.waitUntil(this.processNextAction()) // See if 'failed' state leads to 'idle' next action
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
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, progress: 'success' })
			console.log('[AutofixAgent] Container initialized, progress set to success.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to initialize container:', e)
			this.setState({ ...this.state, progress: 'failed' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handleDetectIssues(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleDetectIssues')
		try {
			console.log('[AutofixAgent] Mock: Detecting issues...')
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, progress: 'success' })
			console.log('[AutofixAgent] Issue detection complete, progress set to success.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to detect issues:', e)
			this.setState({ ...this.state, progress: 'failed' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handleFixIssues(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleFixIssues')
		try {
			console.log('[AutofixAgent] Mock: Fixing issues...')
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, progress: 'success' })
			console.log('[AutofixAgent] Issue fixing complete, progress set to success.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to fix issues:', e)
			this.setState({ ...this.state, progress: 'failed' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handleCommitChanges(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleCommitChanges')
		try {
			console.log('[AutofixAgent] Mock: Committing changes...')
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, progress: 'success' })
			console.log('[AutofixAgent] Changes committed, progress set to success.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to commit changes:', e)
			this.setState({ ...this.state, progress: 'failed' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handlePushChanges(): Promise<void> {
		console.log('[AutofixAgent] Executing: handlePushChanges')
		try {
			console.log('[AutofixAgent] Mock: Pushing changes...')
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, progress: 'success' })
			console.log('[AutofixAgent] Changes pushed, progress set to success.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to push changes:', e)
			this.setState({ ...this.state, progress: 'failed' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handleCreatePr(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleCreatePr')
		try {
			console.log('[AutofixAgent] Mock: Creating PR...')
			await new Promise((resolve) => setTimeout(resolve, 500))
			this.setState({ ...this.state, progress: 'success' })
			console.log('[AutofixAgent] PR created, progress set to success.')
		} catch (e) {
			console.error('[AutofixAgent] Failed to create PR:', e)
			this.setState({ ...this.state, progress: 'failed' })
		}
		this.ctx.waitUntil(this.processNextAction())
	}

	private async handleFinish(): Promise<void> {
		console.log('[AutofixAgent] Executing: handleFinish. Agent process cycle completed.')
		// This stage mainly signifies the end of a full pass.
		// Setting progress to 'success' will allow getNextAction to transition to 'idle'.
		this.setState({ ...this.state, progress: 'success' })
		this.ctx.waitUntil(this.processNextAction())
	}
}
