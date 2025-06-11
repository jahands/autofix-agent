import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
import type { AutofixAgent } from './AutofixAgent'
import type { UserContainer } from './container-server/userContainer'

export type Env = SharedHonoEnv & {
	AUTOFIX_AGENT: DurableObjectNamespace<AutofixAgent>
	USER_CONTAINER: DurableObjectNamespace<UserContainer>
	AI: Ai

	AI_GATEWAY_ACCOUNT_ID: string
	AI_GATEWAY_NAME: string
	AI_GATEWAY_API_KEY: string

	FIREWORKS_AI_API_KEY: string

	DEMO_CLOUDFLARE_ACCOUNT_TAG: string
	DEMO_CLOUDFLARE_API_TOKEN: string

	DEMO_GITHUB_TOKEN: string
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
