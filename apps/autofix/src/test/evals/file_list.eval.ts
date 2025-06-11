import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { AutofixTools as t } from '../../autofix.tools'
import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval('List Container Files Tool', {
		data: async () => [
			{
				input: 'List all files in the project directory',
				expected: fmt.oneLine(`
					The ${t.listContainerFiles} tool should be called to retrieve the project files,
					and it should return a list of files including package.json and TypeScript files.
				`),
			},
			{
				input: 'Show me what files are in the container',
				expected: fmt.oneLine(`
					The ${t.listContainerFiles} tool should be called to show container contents,
					returning file paths like ./package.json, ./src/index.ts, etc.
				`),
			},
			{
				input: 'What files exist in this project?',
				expected: fmt.oneLine(`
					The ${t.listContainerFiles} tool should be called to list existing files,
					showing the project structure.
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			// Verify the AI model called the correct tool
			const toolCall = toolCalls.find((call) => call.toolName === t.listContainerFiles)
			expect(toolCall, `Tool ${t.listContainerFiles} was not called`).toBeDefined()

			return promptOutput
		},
		scorers: [checkFactuality],
		threshold: 1,
		timeout: 60000, // 60 seconds
	})
})
