/* eslint-disable @typescript-eslint/no-unused-vars */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createAiGateway } from 'ai-gateway-provider'
import { env } from 'cloudflare:test'
import { describe } from 'vitest'
import { createWorkersAI } from 'workers-ai-provider'

import type { AnthropicMessagesModelId } from '@ai-sdk/anthropic/internal'
import type { GoogleGenerativeAILanguageModel } from '@ai-sdk/google/internal'
import type { OpenAIChatModelId } from '@ai-sdk/openai/internal'

export const factualityModel = getOpenAiModel('gpt-4o')

type value2key<T, V> = {
	[K in keyof T]: T[K] extends V ? K : never
}[keyof T]
type AiTextGenerationModels = Exclude<
	value2key<AiModels, BaseAiTextGeneration>,
	value2key<AiModels, BaseAiTextToImage>
>

function getOpenAiModel(modelName: OpenAIChatModelId) {
	if (!env.AI_GATEWAY_ACCOUNT_ID || !env.AI_GATEWAY_NAME || !env.AI_GATEWAY_API_KEY) {
		throw new Error('No AI gateway credentials set!')
	}

	const aigateway = createAiGateway({
		accountId: env.AI_GATEWAY_ACCOUNT_ID,
		gateway: env.AI_GATEWAY_NAME,
		apiKey: env.AI_GATEWAY_API_KEY,
	})

	const ai = createOpenAI({
		apiKey: '',
	})

	const model = aigateway([ai(modelName)])

	return { modelName, model, ai }
}

function getAnthropicModel(modelName: AnthropicMessagesModelId) {
	if (!env.AI_GATEWAY_ACCOUNT_ID || !env.AI_GATEWAY_NAME || !env.AI_GATEWAY_API_KEY) {
		throw new Error('No AI gateway credentials set!')
	}

	const aigateway = createAiGateway({
		accountId: env.AI_GATEWAY_ACCOUNT_ID,
		gateway: env.AI_GATEWAY_NAME,
		apiKey: env.AI_GATEWAY_API_KEY,
	})

	const ai = createAnthropic({
		apiKey: '',
	})

	const model = aigateway([ai(modelName)])

	return { modelName, model, ai }
}

function getGeminiModel(modelName: GoogleGenerativeAILanguageModel['modelId']) {
	if (!env.AI_GATEWAY_ACCOUNT_ID || !env.AI_GATEWAY_NAME || !env.AI_GATEWAY_API_KEY) {
		throw new Error('No AI gateway credentials set!')
	}

	const aigateway = createAiGateway({
		accountId: env.AI_GATEWAY_ACCOUNT_ID,
		gateway: env.AI_GATEWAY_NAME,
		apiKey: env.AI_GATEWAY_API_KEY,
	})

	const ai = createGoogleGenerativeAI({ apiKey: '' })

	const model = aigateway([ai(modelName)])

	return { modelName, model, ai }
}

function getWorkersAiModel(modelName: AiTextGenerationModels) {
	if (!env.AI) {
		throw new Error('No AI binding provided!')
	}

	const ai = createWorkersAI({ binding: env.AI })

	const model = ai(modelName)
	return { modelName, model, ai }
}

function getFireworksModel(modelName: string) {
	const fireworksApiKey = (env as any).FIREWORKS_AI_API_KEY
	if (!fireworksApiKey) {
		throw new Error('No Fireworks AI API key provided!')
	}

	const ai = createOpenAI({
		apiKey: fireworksApiKey,
		baseURL: 'https://api.fireworks.ai/inference/v1',
	})

	const model = ai(modelName)
	return { modelName, model, ai }
}

export const eachModel = describe.each([
	getFireworksModel('accounts/fireworks/models/qwen3-30b-a3b'), // Using Fireworks AI Qwen 3 for consistency with production
	// getOpenAiModel('gpt-4o'), // Switched to Fireworks AI now that billing is fixed
	// getOpenAiModel('gpt-4o-mini'), // TODO: enable later
	// getAnthropicModel('claude-3-5-sonnet-20241022'), TODO: The evals pass with anthropic, but our rate limit is so low with AI wholesaling that we can't use it in CI because it's impossible to get a complete run with the current limits
	// getGeminiModel('gemini-2.0-flash'), // TODO: Enable later
	// llama 3 is somewhat inconsistent
	//getWorkersAiModel("@cf/meta/llama-3.3-70b-instruct-fp8-fast")
	// llama 4 has issues with tool calling in evals, but works in production autofix agent
	//getWorkersAiModel('@cf/meta/llama-4-scout-17b-16e-instruct' as AiTextGenerationModels)
])
