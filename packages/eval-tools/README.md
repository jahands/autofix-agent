# @repo/eval-tools

AI-powered evaluation utilities for testing tools with multiple models via Cloudflare AI Gateway.

## Usage

```typescript
import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'

eachModel('$modelName', ({ model }) => {
	describeEval('Tool Test', {
		data: async () => [
			{
				input: 'Test input',
				expected: 'Tool should be called',
			},
		],
		task: async (input: string) => {
			const { promptOutput, toolCalls } = await runTask(tools, model, input)
			expect(toolCalls.find((call) => call.toolName === 'myTool')).toBeDefined()
			return promptOutput
		},
		scorers: [checkFactuality],
		threshold: 0.4,
	})
})
```

## Setup

Add to `.dev.vars`:

```bash
AI_GATEWAY_ACCOUNT_ID="your-account-id"
AI_GATEWAY_NAME="your-gateway-name"
AI_GATEWAY_API_KEY="your-api-key"
```

## Exports

- `runTask(tools, model, input)` - Execute AI model with tools
- `checkFactuality` - AI scorer for response quality
- `eachModel` - Test across OpenAI, Anthropic, Google models
