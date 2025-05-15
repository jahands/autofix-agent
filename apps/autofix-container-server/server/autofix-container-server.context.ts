import type { ContainerManager, UserContainer } from './autofix-container-server.app'

export interface Env {
	OAUTH_KV: KVNamespace
	ENVIRONMENT: 'development'
	CONTAINER_MANAGER: DurableObjectNamespace<ContainerManager>
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
