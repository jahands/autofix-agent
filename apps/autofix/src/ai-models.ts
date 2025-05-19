import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createAiGateway } from 'ai-gateway-provider'
import { env } from 'cloudflare:workers'
import { createWorkersAI } from 'workers-ai-provider'

const workersAi = createWorkersAI({ binding: env.AI })
export const WorkersAIModels = {
	llama4: () => workersAi('@cf/meta/llama-4-scout-17b-16e-instruct' as any, {}),
}

const aiGateway = createAiGateway({
	accountId: env.AI_GATEWAY_ACCOUNT_ID,
	gateway: env.AI_GATEWAY_NAME,
	apiKey: env.AI_GATEWAY_API_KEY,
})

const anthropic = createAnthropic({ apiKey: '' })
export const AnthropicModels = {
	claude: () => aiGateway([anthropic('claude-3-7-sonnet-20250219')]),
}

const openAi = createOpenAI({ apiKey: '' })
export const OpenAIModels = {
	GPT4o: () => aiGateway([openAi('gpt-4o')]),
}
