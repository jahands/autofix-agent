import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createAiGateway } from 'ai-gateway-provider'
import { env } from 'cloudflare:workers'
import { createWorkersAI } from 'workers-ai-provider'

// AI Gateway configuration
const aiGateway = createAiGateway({
	accountId: env.AI_GATEWAY_ACCOUNT_ID,
	gateway: env.AI_GATEWAY_NAME,
	apiKey: env.AI_GATEWAY_API_KEY,
})

// Workers AI Models
const workersAi = createWorkersAI({ binding: env.AI })
export const WorkersAIModels = {
	llama4: () => workersAi('@cf/meta/llama-4-scout-17b-16e-instruct' as any, {}),
}

// Anthropic Models
const anthropic = createAnthropic({ apiKey: '' })
export const AnthropicModels = {
	claude: () => aiGateway([anthropic('claude-3-7-sonnet-20250219')]),
}

// OpenAI Models
const openAi = createOpenAI({ apiKey: '' })
export const OpenAIModels = {
	GPT4o: () => aiGateway([openAi('gpt-4o')]),
}

// Google AI Models
const google = createGoogleGenerativeAI({ apiKey: '' })
export const GoogleModels = {
	GeminiPro: () => aiGateway([google('gemini-2.5-pro-preview-03-25')]),
	GeminiFlash: () => aiGateway([google('gemini-2.0-flash')]),
}

// Fireworks AI Models (using OpenAI-compatible endpoint)
const fireworks = createOpenAI({
	apiKey: env.FIREWORKS_AI_API_KEY,
	baseURL: 'https://api.fireworks.ai/inference/v1',
})
export const FireworksModels = {
	qwen3: () => fireworks('accounts/fireworks/models/qwen3-30b-a3b'),
}
