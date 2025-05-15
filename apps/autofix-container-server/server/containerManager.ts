import { DurableObject } from 'cloudflare:workers'

import type { Env } from './autofix-container-server.context'

export class ContainerManager extends DurableObject<Env> {
	constructor(
		public ctx: DurableObjectState,
		public env: Env
	) {
		super(ctx, env)
	}

	async trackContainer(id: string) {
		await this.ctx.storage.put(id, new Date())
	}

	async killContainer(id: string) {
		await this.ctx.storage.delete(id)
	}

	async tryKillOldContainers() {
		const activeContainers = await this.ctx.storage.list<Date>()
		for (const c of activeContainers) {
			const id = c[0]
			const now = new Date()
			const time = c[1]

			console.log(id, time, now, now.valueOf() - time.valueOf())

			// 15m timeout for container lifetime
			if (now.valueOf() - time.valueOf() > 15 * 60 * 1000) {
				const doId = this.env.USER_CONTAINER.idFromString(id)
				const stub = this.env.USER_CONTAINER.get(doId)
				await stub.destroyContainer()
				await this.killContainer(id)
			}
		}
	}

	async listActive(): Promise<string[]> {
		const activeContainers = await this.ctx.storage.list()
		const activeIds: string[] = []
		for (const c of activeContainers.keys()) {
			activeIds.push(c)
		}

		return activeIds
	}
}

export function getContainerManager(env: Env): DurableObjectStub<ContainerManager> {
	const id = env.CONTAINER_MANAGER.idFromName('manager')
	return env.CONTAINER_MANAGER.get(id)
}
