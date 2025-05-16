import { Agent } from 'agents'

import type { Env } from './autofix.context'

type State = {
	repo: string
	branch: string
	currentStep: AgentStatus
}

const AgentStatuses = [
	{
		name: 'idle',
		description: 'The agent is idle',
	},
	{
		name: 'container_initialize',
		description: 'Initialize the container',
	},
	{
		name: 'container_check',
		description: 'Check the container',
	},
	{
		name: 'detect_issues',
		description: 'Detect issues in the project',
	},
	{
		name: 'fix_issues',
		description: 'Fix the issues in the project',
	},
	{
		name: 'commit_changes',
		description: 'Commit the changes to the project',
	},
	{
		name: 'push_changes',
		description: 'Push the changes to the project',
	},
	{
		name: 'done',
		description: 'The agent is done',
	},
] as const satisfies Array<{
	name: string
	description: string
}>

type AgentStatus = (typeof AgentStatuses)[number]['name']

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
		this.setState({ repo, branch, currentStep: 'idle' })
		// TODO: Trigger logic to start the fixing process for the repo
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)

		await userContainer.container_initialize(repo)
		const ls = await userContainer.container_ls()
		const res = await userContainer.container_ping()
		return JSON.stringify({ ...ls, res })
	}
}
