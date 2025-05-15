import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'
import { z } from 'zod'

import { useNotFound, useOnError } from '@repo/hono-helpers'

import type { App } from './autofix.context'

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
		'/api/agents/:agentId/start',
		sValidator('query', z.object({ agentId: z.string() })),
		async (c) => {
			const { agentId } = c.req.valid('query')
			const id = c.env.AutofixAgent.idFromName(agentId)
			const agent = c.env.AutofixAgent.get(id)
			await agent.start({
				repo: 'https://github.com/jahands/scaffold-agent',
				branch: 'main',
			})
			return c.json({ agentId })
		}
	)

	// Get the state of the agent
	.get(
		'/api/agents/:agentId/state',
		sValidator(
			'query',
			z.object({
				agentId: z.string(),
			})
		),
		async (c) => {
			const { agentId } = c.req.valid('query')
			const id = c.env.AutofixAgent.idFromName(agentId)
			const agent = c.env.AutofixAgent.get(id)
			await using state = await agent.state
			return c.json({ agentId, state })
		}
	)

export default app
