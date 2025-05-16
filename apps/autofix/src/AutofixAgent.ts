import { Agent } from 'agents'
import { match, P } from 'ts-pattern'

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

type AgentAction = (typeof AgentActions)[number]['name']

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

type AgentStatus = (typeof AgentStatuses)[number]['name']

function getNextAction(currentStatus: AgentStatus): AgentAction {
	return (
		match(currentStatus)
			.returnType<AgentAction>()
			.with('idle', () => 'initialize_container')
			.with('container_ready', () => 'check_container')
			.with('container_check_complete', () => 'detect_issues')
			.with('issue_detection_complete', () => 'fix_issues')
			.with('issue_fixing_complete', () => 'commit_changes')
			.with('changes_committed', () => 'push_changes')
			.with('changes_pushed', () => 'create_pr')
			.with('pr_created', () => 'finish')
			.with('done', () => 'idle')
			.with('error', () => 'idle')
			// For "in-progress" statuses, the agent is busy. The "next action" to initiate is 'idle'.
			.with('container_initializing', () => 'idle')
			.with('container_check_running', () => 'idle')
			.with('issue_detection_running', () => 'idle')
			.with('issue_fixing_running', () => 'idle')
			.with('changes_committing', () => 'idle')
			.with('changes_pushing', () => 'idle')
			.with('pr_creating', () => 'idle')
			.exhaustive()
	)
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
		this.setState({ repo, branch, action: 'idle', currentStatus: 'idle' })
		// TODO: Trigger logic to start the fixing process for the repo
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)

		await userContainer.container_initialize(repo)
		const ls = await userContainer.container_ls()
		const res = await userContainer.container_ping()
		return JSON.stringify({ ...ls, res })
	}
}
