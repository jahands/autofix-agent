import { expect } from 'vitest'
import { describeEval } from 'vitest-evals'

import { checkFactuality, eachModel, runTask } from '@repo/eval-tools/src'
import { fmt } from '@repo/format'

import { AutofixTools as t } from '../../autofix.tools'
import { initializeClient } from './client'

eachModel('$modelName', ({ model }) => {
	describeEval('Create File Tool', {
		data: async () => [
			{
				input: 'Create a file called hello.txt with the content "Hello World"',
				expected: fmt.oneLine(`
					The ${t.createFile} tool should be called with filePath="hello.txt"
					and contents="Hello World"
				`),
			},
			{
				input: 'Write a new JavaScript file named test.js with a simple console.log',
				expected: fmt.oneLine(`
					The ${t.createFile} tool should be called with filePath="test.js"
					and contents containing console.log
				`),
			},
		],
		task: async (input: string) => {
			const tools = await initializeClient()
			const { promptOutput, toolCalls } = await runTask(tools, model, input)

			const toolCall = toolCalls.find((call) => call.toolName === t.createFile)
			expect(toolCall, `Tool ${t.createFile} was not called`).toBeDefined()
			expect(toolCall?.args).toHaveProperty('filePath')
			expect(toolCall?.args).toHaveProperty('contents')

			return promptOutput
		},
		scorers: [checkFactuality],
		threshold: 1,
		timeout: 60000,
	})
})
