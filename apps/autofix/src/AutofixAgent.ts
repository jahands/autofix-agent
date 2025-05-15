import { Agent } from 'agents'

import type { Env } from './autofix.context'

type State = {
	repo: string
	branch: string
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
		this.setState({ repo, branch })
		// TODO: Trigger logic to start the fixing process for the repo
	}
}
