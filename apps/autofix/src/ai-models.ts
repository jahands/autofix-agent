import { openai } from '@ai-sdk/openai'
import { env } from 'cloudflare:workers'
import { createWorkersAI } from 'workers-ai-provider'

// OpenAI
export const OpenAIGPT4o = openai('gpt-4o-2024-11-20')

// Workers AI
const workersai = createWorkersAI({ binding: env.AI })
export const WorkersAiLlama4 = workersai('@cf/meta/llama-4-scout-17b-16e-instruct' as any, {})
