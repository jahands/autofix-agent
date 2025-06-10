declare module 'cloudflare:test' {
	// Controls the type of `import("cloudflare:test").env`
	interface ProvidedEnv {
		AI: Ai

		AI_GATEWAY_ACCOUNT_ID: string
		AI_GATEWAY_NAME: string
		AI_GATEWAY_API_KEY: string
	}
}
