import { match, P } from 'ts-pattern'

import { fmt } from '@repo/format'

import { createAutofixAgentTools } from '../../autofix.tools'

import type { UserContainerTools } from '../../container-server/userContainer'

export async function initializeClient() {
	// Mock container implementation for testing
	const mockContainer: UserContainerTools = {
		async execCommand({ command, args }) {
			return match({ command, args })
				.with({ command: 'find', args: P.when((args) => args.includes('.')) }, () => ({
					status: 0,
					stdout: fmt.trim(`
						./package.json
						./src/index.ts
						./src/utils.ts
						./README.md
						./wrangler.jsonc
						./temp.txt
						./old-config.json
					`),
					stderr: '',
				}))
				.with({ command: 'rm' }, () => ({
					status: 0,
					stdout: '',
					stderr: '',
				}))
				.with({ command: 'bash' }, () => ({
					status: 0,
					stdout: 'Command executed successfully',
					stderr: '',
				}))
				.otherwise(() => ({
					status: 1,
					stdout: '',
					stderr: 'error: command not found',
				}))
		},

		async writeFile({ filePath, contents }) {
			// Mock file writing - in a real test this might use a memory fs
			console.log(`Writing file ${filePath} with ${contents.length} characters`)
		},

		async readFile({ filePath }) {
			return match(filePath)
				.with('package.json', () => JSON.stringify({ name: 'test-project', version: '1.0.0' }))
				.otherwise((path) => `// Mock content for ${path}`)
		},
	}

	const buildWorkDir = '/mock/build/dir'
	return createAutofixAgentTools(mockContainer, buildWorkDir)
}
