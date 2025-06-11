import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { AutofixTools as t } from '../../autofix.tools'
import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval(`workflow: ${t.createFile} + ${t.deleteFile}`, {
		data: async () => [
			{
				input: 'Create a temporary file temp.log, write some content to it, then delete it',
				expected: fmt.oneLine(`
					The ${t.createFile} tool should be called to create temp.log,
					then the ${t.deleteFile} tool should be called to remove it
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			// Verify create and delete workflow
			const createCall = toolCalls.find((call) => call.toolName === t.createFile)
			const deleteCall = toolCalls.find((call) => call.toolName === t.deleteFile)

			expect(createCall, `Tool ${t.createFile} was not called`).toBeDefined()
			expect(deleteCall, `Tool ${t.deleteFile} was not called`).toBeDefined()

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
