import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval('Install Dependencies Tool', {
		data: async () => [
			{
				input: 'Install the project dependencies using npm',
				expected: fmt.oneLine(`
					The installDependencies tool should be called with installCommand="npm install"
					or similar npm installation command
				`),
			},
			{
				input: 'Run pnpm install to install dependencies',
				expected: fmt.oneLine(`
					The installDependencies tool should be called with installCommand="pnpm install"
					to install project dependencies
				`),
			},
			{
				input: 'Install packages with yarn',
				expected: fmt.oneLine(`
					The installDependencies tool should be called with installCommand="yarn install"
					or "yarn" to install dependencies
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			const toolCall = toolCalls.find((call) => call.toolName === 'installDependencies')
			expect(toolCall, 'Tool installDependencies was not called').toBeDefined()
			expect(toolCall?.args).toHaveProperty('installCommand')

			// Verify the command contains an install instruction
			const command = (toolCall?.args as { installCommand: string })?.installCommand
			expect(command?.toLowerCase()).toMatch(/(^(npm|pnpm) install)|(yarn)/)

			return promptOutput
		},
		scorers: [checkFactuality],
		threshold: 1,
		timeout: 60000,
	})
})
