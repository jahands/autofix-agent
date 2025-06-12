# AI-Powered Evaluation System (Evals)

This repository uses an evals to test whether AI models can correctly use tools to complete tasks. The evals verify tool calling accuracy, argument passing, and response quality using multiple AI models.

## Overview

The evaluation system tests three key aspects:

1. **Tool Calling** - Models correctly identify and call the right tools
2. **Argument Passing** - Models provide appropriate arguments to tools
3. **Response Quality** - Model responses are factually correct and helpful

## Architecture

### Core Components

- **[`@repo/eval-tools`](https://github.com/jahands/autofix-agent/tree/main/packages/eval-tools)** - Shared evaluation utilities package
- **[`vitest-evals`](https://www.npmjs.com/package/vitest-evals)** - Evals framework for Vitest (built by Sentry)
- **[`@cloudflare/vitest-pool-workers`](https://www.npmjs.com/package/@cloudflare/vitest-pool-workers)** - Runs tests in Cloudflare Workers runtime
- **[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/)** - Proxies all requests to AI providers like Gemini

### Key Files

- [`packages/eval-tools/src/test-models.ts`](https://github.com/jahands/autofix-agent/blob/main/packages/eval-tools/src/test-models.ts) - AI model configuration via AI Gateway
- [`packages/eval-tools/src/run-task.ts`](https://github.com/jahands/autofix-agent/blob/main/packages/eval-tools/src/run-task.ts) - Executes AI models with tools and captures responses
- [`packages/eval-tools/src/scorers.ts`](https://github.com/jahands/autofix-agent/blob/main/packages/eval-tools/src/scorers.ts) - AI-powered scoring functions
- [`apps/autofix/src/test/evals/client.ts`](https://github.com/jahands/autofix-agent/blob/main/apps/autofix/src/test/evals/client.ts) - Mock container implementation for testing
- [`vitest.workspace.evals.ts`](https://github.com/jahands/autofix-agent/blob/main/vitest.workspace.evals.ts) - Workspace configuration for eval projects

## Setup

### Environment Variables

Create a `.dev.vars` file in your app directory (e.g., `apps/autofix/.dev.vars`):

```bash
# Required for AI Gateway access
AI_GATEWAY_ACCOUNT_ID="your-cloudflare-account-id"
AI_GATEWAY_NAME="your-ai-gateway-name"
AI_GATEWAY_API_KEY="your-ai-gateway-api-key"
```

### CI/CD Configuration

In GitHub Actions, the `.dev.vars` file is automatically created using:

- `AI_GATEWAY_ACCOUNT_ID` and `AI_GATEWAY_NAME` from GitHub Actions variables
- `AI_GATEWAY_API_KEY` from GitHub Actions secrets

See [`.github/workflows/evals.yml`](https://github.com/jahands/autofix-agent/blob/main/.github/workflows/evals.yml) for the complete CI setup.

## Running Evals

```bash
# Run all evals locally
just test-evals

# Run with specific flags
just test-evals --reporter=verbose

# Run via npm/pnpm
pnpm test:evals

# Run in CI mode
pnpm test:ci:evals
```

## Writing Evals

### File Structure

Each eval test should be in its own `.eval.ts` file for optimal parallelization:

```
apps/autofix/src/test/evals/
├── file_create.eval.ts          # File creation tool tests
├── file_read.eval.ts            # File reading tool tests
├── build_project.eval.ts        # Build tool tests
├── workflow_create_and_read.eval.ts  # Multi-tool workflow tests
└── client.ts                    # Mock container implementation
```

### Basic Eval Pattern

```typescript
import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { AutofixTools as t } from '../../autofix.tools'
import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
  describeEval(`tool: ${t.yourToolName}`, {
    data: async () => [
      {
        input: 'User request description',
        expected: fmt.oneLine(`
          The ${t.yourToolName} tool should be called with specific arguments
          and produce expected behavior
        `),
      },
    ],
    task: async (input: string) => {
      const tools = await initializeClient()
      const { promptOutput, toolCalls } = await runTask(tools, model, input)

      // Verify correct tool was called
      const toolCall = toolCalls.find((call) => call.toolName === t.yourToolName)
      expect(toolCall).toBeDefined()
      expect(toolCall?.args).toHaveProperty('expectedArgument')

      return promptOutput
    },
    scorers: [checkFactuality],
    threshold: 1,
    timeout: 60000,
  })
})
```

### Multi-Tool Workflow Example

```typescript
// Test workflows that require multiple tool calls
describeEval(`workflow: ${t.createFile} + ${t.getFileContents}`, {
  data: async () => [
    {
      input: 'Create a config file and then read it back',
      expected: fmt.oneLine(`
        The ${t.createFile} tool should be called first,
        then ${t.getFileContents} should be called to read the file
      `),
    },
  ],
  task: async (input: string) => {
    const tools = await initializeClient()
    const { promptOutput, toolCalls } = await runTask(tools, model, input)

    // Verify both tools were called
    const createCall = toolCalls.find((call) => call.toolName === t.createFile)
    const readCall = toolCalls.find((call) => call.toolName === t.getFileContents)

    expect(createCall).toBeDefined()
    expect(readCall).toBeDefined()

    // Verify they work on the same file
    expect(createCall?.args.filePath).toBe(readCall?.args.filePath)

    return promptOutput
  },
  scorers: [checkFactuality],
  threshold: 1,
})
```

## Configuration

### Vitest Configuration

Each app needs a `vitest.config.evals.ts` file:

```typescript
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    include: ['**/*.eval.?(c|m)[jt]s?(x)'],
    poolOptions: {
      workers: {
        isolatedStorage: true,
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            ENVIRONMENT: 'test',
          },
        },
      },
    },
  },
})
```

### Model Configuration

Models are configured in [`packages/eval-tools/src/test-models.ts`](https://github.com/jahands/autofix-agent/blob/main/packages/eval-tools/src/test-models.ts). Currently using:

- **OpenAI**: `gpt-4o` (primary)
- **OpenAI**: `gpt-4o` (for factuality scoring)

Other models (Claude, Gemini, Llama 4, etc.) are available, but currently disabled at the moment to speed up tests.

## Scoring System

### Factuality Scorer

The [`checkFactuality`](https://github.com/jahands/autofix-agent/blob/main/packages/eval-tools/src/scorers.ts) scorer uses GPT-4o to evaluate response quality:

- **Score 1.0**: Response fully matches or exceeds expectations
- **Score 0.4**: Response is a subset but consistent with expectations
- **Score 0.0**: Response conflicts with expectations

### Threshold Configuration

- **threshold: 1** - Requires perfect tool calling and response quality
- **threshold: 0.4** - Allows partial but correct responses
- **timeout: 60000** - 60-second timeout for model responses

## Best Practices

### Test Organization

1. **One tool per file** - Each `.eval.ts` file tests a single tool for better parallelization
2. **Workflow tests** - Separate files for multi-tool workflows
3. **Descriptive names** - Use clear, descriptive test names that include tool names

### Mock Implementation

The [`client.ts`](https://github.com/jahands/autofix-agent/blob/main/apps/autofix/src/test/evals/client.ts) file provides mock implementations:

```typescript
const mockContainer: UserContainerTools = {
  async execCommand({ command, args }) {
    // Mock command execution with pattern matching
    return match({ command, args })
      .with({ command: 'find' }, () => ({ status: 0, stdout: '...' }))
      .otherwise(() => ({ status: 1, stderr: 'command not found' }))
  },
  async writeFile({ filePath, contents }) {
    // Mock file writing
  },
  async readFile({ filePath }) {
    // Mock file reading with realistic content
    return match(filePath)
      .with('package.json', () => JSON.stringify({ name: 'test-project' }))
      .otherwise((path) => `// Mock content for ${path}`)
  },
}
```

### Error Handling

- Use descriptive error messages in `expect()` calls
- Verify both tool calls and their arguments
- Test edge cases and error conditions

## Examples

See the [`apps/autofix/src/test/evals/`](https://github.com/jahands/autofix-agent/tree/main/apps/autofix/src/test/evals) directory for complete examples:

- [File operations](https://github.com/jahands/autofix-agent/blob/main/apps/autofix/src/test/evals/file_create.eval.ts)
- [Build operations](https://github.com/jahands/autofix-agent/blob/main/apps/autofix/src/test/evals/build_project.eval.ts)
- [Multi-tool workflows](https://github.com/jahands/autofix-agent/blob/main/apps/autofix/src/test/evals/workflow_create_and_read.eval.ts)

## Extending the System

### Adding New Models

1. Update [`test-models.ts`](https://github.com/jahands/autofix-agent/blob/main/packages/eval-tools/src/test-models.ts) with new model configuration
2. Add model to the `eachModel` array

### Custom Scorers

Create custom scoring functions in [`scorers.ts`](https://github.com/jahands/autofix-agent/blob/main/packages/eval-tools/src/scorers.ts):

```typescript
export const customScorer: ScoreFn = async ({ input, expected, output }) => {
  // Custom scoring logic
  return {
    score: 0.8,
    metadata: { reason: 'Custom evaluation result' },
  }
}
```

### New Tool Categories

1. Create new `.eval.ts` files for tool categories
2. Implement mock behaviors in `client.ts`
3. Add appropriate test data and expectations
4. Configure thresholds based on tool complexity

This evaluation system provides comprehensive testing of AI tool usage, ensuring reliable performance across different models and use cases.
