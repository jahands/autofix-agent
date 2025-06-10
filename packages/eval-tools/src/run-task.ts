import { generateText } from 'ai'

import { fmt } from '@repo/format'

import type { GenerateTextResult, LanguageModelV1, ToolCallPart, ToolSet } from 'ai'

/**
 * Executes an AI model with the provided tools and captures tool calls and responses.
 *
 * @param tools - Available tools for the AI model to use
 * @param model - AI model instance (from test-models)
 * @param input - User input/prompt for the model
 * @returns Object containing formatted output, full result, and tool calls made
 *
 * @example
 * ```typescript
 * const { promptOutput, toolCalls } = await runTask(tools, model, "List files")
 * const listFilesCall = toolCalls.find(call => call.toolName === 'listContainerFiles')
 * expect(listFilesCall).toBeDefined()
 * ```
 */
export async function runTask(
	tools: ToolSet,
	model: LanguageModelV1,
	input: string
): Promise<{
	promptOutput: string
	fullResult: GenerateTextResult<ToolSet, never>
	toolCalls: ToolCallPart[]
}> {
	const res = await generateText({
		model,
		system: fmt.oneLine(`
			You are an assistant responsible for helping with code fixes
			in a containerized environment. Given the user's query, use the
			tools available to you to complete the requested task.
		`),
		tools,
		prompt: input,
		maxRetries: 1,
		maxSteps: 10,
	})

	// Convert into an LLM readable result so our factuality checker can validate tool calls
	let messagesWithTools = ''
	const toolCalls: ToolCallPart[] = []
	const response = res.response
	const messages = response.messages

	for (const message of messages) {
		for (const messagePart of message.content) {
			if (typeof messagePart === 'string') {
				messagesWithTools += `<message_content type="text">${messagePart}</message_content>`
			} else if (messagePart.type === 'tool-call') {
				messagesWithTools += fmt.trim(`
					<message_content type=${messagePart.type}>
						<tool_name>${messagePart.toolName}</tool_name>
						<tool_arguments>${JSON.stringify(messagePart.args)}</tool_arguments>
					</message_content>
				`)
				toolCalls.push(messagePart)
			} else if (messagePart.type === 'text') {
				messagesWithTools += `<message_content type=${messagePart.type}>${messagePart.text}</message_content>`
			}
		}
	}

	return { promptOutput: messagesWithTools, fullResult: res, toolCalls }
}
