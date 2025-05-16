import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
import type { AutofixAgent } from './AutofixAgent'
import type { UserContainer } from './container-server/userContainer'

export type Env = SharedHonoEnv & {
	// add additional Bindings here
	AutofixAgent: DurableObjectNamespace<AutofixAgent>
	USER_CONTAINER: DurableObjectNamespace<UserContainer>
	USER_BLOCKLIST: KVNamespace
	MCP_METRICS: AnalyticsEngineDataset
	AI: Ai
	MCP_SERVER_NAME: string
	MCP_SERVER_VERSION: string
	DEV_CLOUDFLARE_ACCOUNT_ID: string
	DEV_CLOUDFLARE_API_TOKEN: string
	DEV_CLOUDFLARE_EMAIL: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
