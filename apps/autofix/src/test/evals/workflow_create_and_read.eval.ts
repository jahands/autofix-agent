import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval('Create and Read File Workflow', {
		data: async () => [
			{
				input: 'Create a configuration file config.json with some settings and then read it back',
				expected: fmt.oneLine(`
					The createFile tool should be called first to create config.json,
					then the getFileContents tool should be called to read the file back
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			// Verify both tools were called
			const createCall = toolCalls.find((call) => call.toolName === 'createFile')
			const readCall = toolCalls.find((call) => call.toolName === 'getFileContents')

			expect(createCall, 'Tool createFile was not called').toBeDefined()
			expect(readCall, 'Tool getFileContents was not called').toBeDefined()

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
