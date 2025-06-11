import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { AutofixTools as t } from '../../autofix.tools'
import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval(`workflow: ${t.createFile} + ${t.getFileContents}`, {
		data: async () => [
			{
				input: 'Create a configuration file config.json with some settings and then read it back',
				expected: fmt.oneLine(`
					The ${t.createFile} tool should be called first to create config.json,
					then the ${t.getFileContents} tool should be called to read the file back
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			// Verify both tools were called
			const createCall = toolCalls.find((call) => call.toolName === t.createFile)
			const readCall = toolCalls.find((call) => call.toolName === t.getFileContents)

			expect(createCall, `Tool ${t.createFile} was not called`).toBeDefined()
			expect(readCall, `Tool ${t.getFileContents} was not called`).toBeDefined()

			// Verify they're working on the same file
			expect((createCall?.args as { filePath: string })?.filePath).toBe(
				(readCall?.args as { filePath: string })?.filePath
			)

			return promptOutput
		},
		scorers: [checkFactuality],
		threshold: 1,
		timeout: 60000,
	})
})
