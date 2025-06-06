import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'
import { z } from 'zod'

import { useNotFound, useOnError } from '@repo/hono-helpers'

import type { App, Env } from './autofix.context'

export { AutofixAgent } from './AutofixAgent'
export { UserContainer } from './container-server/userContainer'

function getAgent(env: Env, param: { agentId: string }) {
	const id = env.AUTOFIX_AGENT.idFromName(param.agentId)
	const agent = env.AUTOFIX_AGENT.get(id)
	return { agentId: param.agentId, agent }
}

const app = new Hono<App>()
	.use(
		'*',
		// middleware
		(c, next) =>
			useWorkersLogger(c.env.NAME, {
				environment: c.env.ENVIRONMENT,
				release: c.env.SENTRY_RELEASE,
			})(c, next)
	)

	.onError(useOnError())
	.notFound(useNotFound())

	// Start an agent
	.post(
		'/api/agents/:agentId',
		sValidator('param', z.object({ agentId: z.string() })),
		async (c) => {
			const { agentId, agent } = getAgent(c.env, c.req.valid('param'))
			const ls = await agent.start({
				buildUuid: agentId,
			})
			return c.json({ agentId, ls })
		}
	)

	// Get the state of the agent
	.get(
		'/api/agents/:agentId',
		sValidator('param', z.object({ agentId: z.string() })),
		async (c) => {
			const { agentId, agent } = getAgent(c.env, c.req.valid('param'))
			await using state = await agent.state
			return c.json({ agentId, state })
		}
	)

export default app
