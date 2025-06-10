import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval('Build Project Tool', {
		data: async () => [
			{
				input: 'Build the project using npm run build',
				expected: fmt.oneLine(`
					The buildProject tool should be called with buildCommand="npm run build"
					to compile the project
				`),
			},
			{
				input: 'Run the build script with pnpm',
				expected: fmt.oneLine(`
					The buildProject tool should be called with buildCommand="pnpm build"
					or "pnpm run build" to build the project
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			const toolCall = toolCalls.find((call) => call.toolName === 'buildProject')
			expect(toolCall, 'Tool buildProject was not called').toBeDefined()
			expect(toolCall?.args).toHaveProperty('buildCommand')

			// Verify the command contains a build instruction
			const command = (toolCall?.args as { buildCommand: string })?.buildCommand
			expect(command).toMatch(/pnpm build|npm run build/)

			return promptOutput
		},
		scorers: [checkFactuality],
		threshold: 1,
		timeout: 60000,
	})
})
