import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'
import { z } from 'zod'

import { useNotFound, useOnError } from '@repo/hono-helpers'

import type { App } from './autofix.context'
import { WorkersBuildsClient } from './workersBuilds'

export { AutofixAgent } from './AutofixAgent'
export { ContainerManager } from './container/containerManager'
export { UserContainer } from './container/userContainer'

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
			const { agentId } = c.req.valid('param')
			const id = c.env.AutofixAgent.idFromName(agentId)
			const agent = c.env.AutofixAgent.get(id)
			const ls = await agent.start({
				repo: 'https://github.com/jahands/scaffold-agent',
				branch: 'main',
			})
			return c.json({ agentId, ls })
		}
	)

	// Get the state of the agent
	.get(
		'/api/agents/:agentId',
		sValidator(
			'param',
			z.object({
				agentId: z.string(),
			})
		),
		async (c) => {
			const { agentId } = c.req.valid('param')
			const id = c.env.AutofixAgent.idFromName(agentId)
			const agent = c.env.AutofixAgent.get(id)
			await using state = await agent.state
			return c.json({ agentId, state })
		}
	)

	// Get the logs for a build
	.get(
		'/api/logs/:buildUuid',

		async (c) => {
			const workersBuilds = new WorkersBuildsClient({
				accountTag: c.env.DEMO_CLOUDFLARE_ACCOUNT_TAG,
				apiToken: c.env.DEMO_CLOUDFLARE_API_TOKEN,
			})
			const logs = await workersBuilds.getBuildLogs(c.req.param('buildUuid'))
			return c.text(logs)
		}
	)

export default app
