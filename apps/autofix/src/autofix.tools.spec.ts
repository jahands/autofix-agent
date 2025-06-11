import { describe, expect, test } from 'vitest'

import { AutofixTools } from './autofix.tools'

import type { createAutofixAgentTools } from './autofix.tools'

// assert values match key names
type AssertValuesMatchKeys<T extends Record<string, string>> = {
	[K in keyof T]: T[K] extends K ? T[K] : never
}
const _assertValuesMatchKeys: AssertValuesMatchKeys<typeof AutofixTools> = AutofixTools

// assert createAutofixAgentTools returns all tools from AutofixTools
type AssertAllToolsReturned<T extends Record<keyof typeof AutofixTools, any>> = T
const _assertAllToolsReturned: AssertAllToolsReturned<ReturnType<typeof createAutofixAgentTools>> =
	{} as ReturnType<typeof createAutofixAgentTools>

describe('autofix.tools', () => {
	test('types-only test file', () => {
		expect(true).toBe(true)
	})
})
