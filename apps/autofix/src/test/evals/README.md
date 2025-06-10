# AutofixAgent AI-Powered Evals

This directory contains AI-powered evaluation tests for AutofixAgent tools using `vitest-evals` and `vitest-pool-workers`.

## Overview

These evals test whether AI models can correctly use AutofixAgent tools to complete tasks. The tests verify:

1. **Tool Calling** - Models correctly identify and call the right tools
2. **Argument Passing** - Models provide appropriate arguments to tools
3. **Response Quality** - Model responses are factually correct and helpful

## Setup

These evals use Cloudflare AI Gateway for model access and run in Cloudflare Workers runtime via `vitest-pool-workers`.

### Local Development

Configure the following environment variables in your `.dev.vars` file:

```bash
# Required for AI Gateway access
AI_GATEWAY_ACCOUNT_ID="your-cloudflare-account-id"
AI_GATEWAY_NAME="your-ai-gateway-name"
AI_GATEWAY_API_KEY="your-ai-gateway-api-key"
```

### CI/CD

In GitHub Actions, the `.dev.vars` file is automatically created using:

- `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_NAME` from GitHub Actions variables
- `AI_GATEWAY_API_KEY` from GitHub Actions secrets

The AI Gateway handles API key management for multiple providers (OpenAI, Anthropic, Google) centrally.

## Running Evals

```bash
# Run all evals (requires AI Gateway setup)
just test-evals
```

## Architecture

### Test Structure

Each eval test is in its own file for optimal parallelization:

- **File Operations**: `file_create.eval.ts`, `file_read.eval.ts`, `file_delete.eval.ts`, `file_list.eval.ts`
- **Build Operations**: `build_install_dependencies.eval.ts`, `build_project.eval.ts`
- **Workflows**: `workflow_create_and_read.eval.ts`, `workflow_project_setup.eval.ts`, `workflow_file_cleanup.eval.ts`

### Components

- **`@repo/eval-tools`** - Shared eval utilities package containing:
  - `test-models.ts` - Configuration for different AI models via AI Gateway (uses `env` from `cloudflare:test`)
  - `run-task.ts` - Executes AI model with tools and captures responses
  - `scorers.ts` - AI-powered scoring functions for evaluating responses
- **`client.ts`** - Mock container implementation
- **`vitest.config.evals.ts`** - Workers pool configuration for running tests in Cloudflare Workers runtime

### Adding New Evals

1. Create a new `.eval.ts` file in this directory
2. Import the required components:

   ```typescript
   import { expect } from 'vitest'
   import { describeEval } from 'vitest-evals'

   import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'

   import { initializeClient } from './client'
   ```

3. Define your eval using the pattern:

   ```typescript
   eachModel('$modelName', ({ model }) => {
   	describeEval('Your Tool Name', {
   		data: async () => [
   			{
   				input: 'User request description',
   				expected: 'Expected behavior including tool calls',
   			},
   		],
   		task: async (input: string) => {
   			const tools = await initializeClient()
   			const { promptOutput, toolCalls } = await runTask(tools, model, input)

   			// Verify correct tool was called
   			const toolCall = toolCalls.find((call) => call.toolName === 'expectedToolName')
   			expect(toolCall).toBeDefined()

   			return promptOutput
   		},
   		scorers: [checkFactuality],
   		threshold: 1,
   		timeout: 60000,
   	})
   })
   ```
