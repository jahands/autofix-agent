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

	.get(
		'/api/agents/:agentId',
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
			const res = await agent.fetch(c.req.raw)
			return c.newResponse(res.body, res)
		}
	)

export default app
