import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval('Delete File Tool', {
		data: async () => [
			{
				input: 'Delete the temporary file temp.txt',
				expected: fmt.oneLine(`
					The deleteFile tool should be called with filePath="temp.txt"
					to remove the file
				`),
			},
			{
				input: 'Remove the old config file old-config.json',
				expected: fmt.oneLine(`
					The deleteFile tool should be called with filePath="old-config.json"
					to delete the specified file
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			const toolCall = toolCalls.find((call) => call.toolName === 'deleteFile')
			expect(toolCall, 'Tool deleteFile was not called').toBeDefined()
			expect(toolCall?.args).toHaveProperty('filePath')

			return promptOutput
		},
		scorers: [checkFactuality],
		threshold: 1,
		timeout: 60000,
	})
})
