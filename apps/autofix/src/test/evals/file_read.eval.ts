import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { AutofixTools as t } from '../../autofix.tools'
import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval('Get File Contents Tool', {
		data: async () => [
			{
				input: 'Read the contents of package.json',
				expected: fmt.oneLine(`
					The ${t.getFileContents} tool should be called with filePath="package.json"
					and return the file contents
				`),
			},
			{
				input: 'Show me what is in the README.md file',
				expected: fmt.oneLine(`
					The ${t.getFileContents} tool should be called with filePath="README.md"
					to retrieve the file contents
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			const toolCall = toolCalls.find((call) => call.toolName === t.getFileContents)
			expect(toolCall, `Tool ${t.getFileContents} was not called`).toBeDefined()
			expect(toolCall?.args).toHaveProperty('filePath')

			return promptOutput
		},
		scorers: [checkFactuality],
		threshold: 1,
		timeout: 60000,
	})
})
