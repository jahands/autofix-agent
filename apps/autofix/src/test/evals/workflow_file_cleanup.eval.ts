import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval('File Cleanup Workflow', {
		data: async () => [
			{
				input: 'Create a temporary file temp.log, write some content to it, then delete it',
				expected: fmt.oneLine(`
					The createFile tool should be called to create temp.log,
					then the deleteFile tool should be called to remove it
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			// Verify create and delete workflow
			const createCall = toolCalls.find((call) => call.toolName === 'createFile')
			const deleteCall = toolCalls.find((call) => call.toolName === 'deleteFile')

			expect(createCall, 'Tool createFile was not called').toBeDefined()
			expect(deleteCall, 'Tool deleteFile was not called').toBeDefined()

			// Verify they're working on the same file
			expect((createCall?.args as { filePath: string })?.filePath).toBe(
				(deleteCall?.args as { filePath: string })?.filePath
			)

			return promptOutput
		},
		scorers: [checkFactuality],
		threshold: 1,
		timeout: 60000,
	})
})
