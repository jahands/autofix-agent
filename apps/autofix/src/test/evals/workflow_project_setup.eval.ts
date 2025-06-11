import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { AutofixTools as t } from '../../autofix.tools'
import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval(`workflow: ${t.listContainerFiles} + ${t.installDependencies} + ${t.buildProject}`, {
		data: async () => [
			{
				input: 'List the project files, install dependencies, and then build the project',
				expected: fmt.oneLine(`
					The ${t.listContainerFiles} tool should be called first to see project structure,
					then ${t.installDependencies} should be called to install packages,
					followed by ${t.buildProject} to compile the code
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			// Verify the workflow tools were called
			const listCall = toolCalls.find((call) => call.toolName === t.listContainerFiles)
			const installCall = toolCalls.find((call) => call.toolName === t.installDependencies)
			const buildCall = toolCalls.find((call) => call.toolName === t.buildProject)

			expect(listCall, `Tool ${t.listContainerFiles} was not called`).toBeDefined()
			expect(installCall, `Tool ${t.installDependencies} was not called`).toBeDefined()
			expect(buildCall, `Tool ${t.buildProject} was not called`).toBeDefined()

			return promptOutput
		},
		scorers: [checkFactuality],
		threshold: 1,
		timeout: 90000, // Longer timeout for multi-step workflow
	})
})
