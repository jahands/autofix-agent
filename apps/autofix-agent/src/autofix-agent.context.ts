import type { HonoApp } from '@repo/hono-helpers'
import type { SharedHonoEnv, SharedHonoVariables } from '@repo/hono-helpers/src/types'
import type { AutofixAgent } from './autofix-agent.app'

export type Env = SharedHonoEnv & {
	// add additional Bindings here

	AutofixAgent: DurableObjectNamespace<AutofixAgent>
}

/** Variables can be extended */
export type Variables = SharedHonoVariables

export interface App extends HonoApp {
	Bindings: Env
	Variables: Variables
}
