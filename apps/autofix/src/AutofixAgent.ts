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
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)

		// Start container, and destroy any active containers
		await userContainer.container_initialize(repo)
	}

	async pingContainer() {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		const pong = await userContainer.container_ping()
		return { res: pong }
	}

	async listContainerFiles() {
		const userContainerId = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		const userContainer = this.env.USER_CONTAINER.get(userContainerId)
		const { resources } = await userContainer.container_ls()
		return { resources }
	}
}
