import { ContainerManager } from './containerManager'
import { ContainerMcpAgent } from './containerMcp'
import { UserContainer } from './userContainer'

import type { Env } from './autofix-container-server.context'

export { ContainerManager, ContainerMcpAgent, UserContainer }

export type Props = Record<string, unknown>

export default {
	fetch: async (req: Request, env: Env, ctx: ExecutionContext) => {
		return await ContainerMcpAgent.mount('/sse').fetch(req, env, ctx)
	},
}
