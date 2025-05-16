import { env } from 'cloudflare:workers'
import { createWorkersAI } from 'workers-ai-provider'

// We can add other models or providers (openAI) here

const workersAiInstance = createWorkersAI({ binding: env.AI })

export const WorkersAiModels = {
	Llama4: workersAiInstance('@cf/meta/llama-4-scout-17b-16e-instruct' as any, {}),
}
