import { sValidator } from '@hono/standard-validator'
import { Hono } from 'hono'
import { useWorkersLogger } from 'workers-tagged-logger'
import { z } from 'zod'

import { useNotFound, useOnError } from '@repo/hono-helpers'

import type { App } from './autofix.context'
import { WorkersBuildsClient } from './workersBuilds'
import { generateText } from 'ai'
import { WorkersAiModels } from './ai-models'

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
	// this is basically only for testing that we have the demo account wired up correctly
	// and can be removed soon
	.get(
		'/api/builds/:buildUuid/logs',
		sValidator(
			'param',
			z.object({
				buildUuid: z.string(),
			})
		),
		async (c) => {
			const workersBuilds = new WorkersBuildsClient({
				accountTag: c.env.DEMO_CLOUDFLARE_ACCOUNT_TAG,
				apiToken: c.env.DEMO_CLOUDFLARE_API_TOKEN,
			})
			const logs = await workersBuilds.getBuildLogs(c.req.valid('param').buildUuid)
			return c.text(logs)
		}
	)

	// Analyze the logs for a build using an AI model.
	// this is basically only for testing that we have basic AI model functionality wired up
	// and can be removed soon
	.get(
		'/api/builds/:buildUuid/analyze',
		sValidator(
			'param',
			z.object({
				buildUuid: z.string(),
			})
		),
		async (c) => {
			const workersBuilds = new WorkersBuildsClient({
				accountTag: c.env.DEMO_CLOUDFLARE_ACCOUNT_TAG,
				apiToken: c.env.DEMO_CLOUDFLARE_API_TOKEN,
			})
			const logs = await workersBuilds.getBuildLogs(c.req.valid('param').buildUuid)

			const modelResult = await generateText({
				model: WorkersAiModels.Llama4,
				system: 'You are an expert at investigating Build failures in CI systems',
				prompt: `
				Summarize the failure from the build logs:
			   	${logs}
			`,
			})

			return c.text(modelResult.text)
		}
	)

export default app
