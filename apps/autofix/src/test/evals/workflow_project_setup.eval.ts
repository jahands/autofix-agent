import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval('Project Setup Workflow', {
		data: async () => [
			{
				input: 'List the project files, install dependencies, and then build the project',
				expected: fmt.oneLine(`
					The listContainerFiles tool should be called first to see project structure,
					then installDependencies should be called to install packages,
					followed by buildProject to compile the code
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			// Verify the workflow tools were called
			const listCall = toolCalls.find((call) => call.toolName === 'listContainerFiles')
			const installCall = toolCalls.find((call) => call.toolName === 'installDependencies')
			const buildCall = toolCalls.find((call) => call.toolName === 'buildProject')

			expect(listCall, 'Tool listContainerFiles was not called').toBeDefined()
			expect(installCall, 'Tool installDependencies was not called').toBeDefined()
			expect(buildCall, 'Tool buildProject was not called').toBeDefined()

			return promptOutput
		},
		scorers: [checkFactuality],
		threshold: 1,
		timeout: 90000, // Longer timeout for multi-step workflow
	})
})
