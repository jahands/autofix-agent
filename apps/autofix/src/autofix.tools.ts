import { tool } from 'ai'
import { z as z3 } from 'zod/v3'

import { fmt } from '@repo/format'

import type { UserContainerTools } from './container-server/userContainer'

export function createAutofixAgentTools(container: UserContainerTools, buildWorkDir: string) {
	return {
		listContainerFiles: tool({
			description: 'List files in the container. This requires no parameters',
			parameters: z3.object({}),
			execute: async () => {
				const files = await container.execCommand({
					command: 'find',
					args: ['.'],
					cwd: buildWorkDir,
				})
				return files.stdout
			},
		}),

		createFile: tool({
			description: 'Create a file in the container with the given path and contents',
			parameters: z3.object({ filePath: z3.string(), contents: z3.string() }),
			execute: async ({ filePath, contents }) => {
				await container.writeFile({ filePath, cwd: buildWorkDir, contents })
				return { success: true, message: `File ${filePath} created successfully` }
			},
		}),

		getFileContents: tool({
			description: 'Get the contents of a file in the container. Can read any file given the path.',
			parameters: z3.object({ filePath: z3.string() }),
			execute: async ({ filePath }) => {
				return container.readFile({
					cwd: buildWorkDir,
					filePath,
				})
			},
		}),

		deleteFile: tool({
			description: 'Delete a file in the container with the given path',
			parameters: z3.object({ filePath: z3.string() }),
			execute: async ({ filePath }) => {
				await container.execCommand({
					command: 'rm',
					args: ['-f', filePath],
					cwd: buildWorkDir,
				})
				return { success: true, message: `File ${filePath} deleted successfully` }
			},
		}),

		installDependencies: tool({
			description: fmt.trim(`
				Install project dependencies using the appropriate package manager.
				Use the correct package manager based on lock files (npm, yarn, pnpm, or bun).

				Returns success status and any error details if the command fails.
			`),
			parameters: z3.object({ installCommand: z3.string() }),
			execute: async ({ installCommand }) => {
				try {
					await container.execCommand({
						command: 'bash',
						args: ['-c', installCommand],
						cwd: buildWorkDir,
					})
					return JSON.stringify({ success: true, message: 'Dependencies installed successfully' })
				} catch (error) {
					return JSON.stringify({
						success: false,
						error: error instanceof Error ? error.message : String(error),
						command: installCommand,
					})
				}
			},
		}),

		buildProject: tool({
			description: fmt.trim(`
				Builds the project using the specified command.
				Dependencies should be installed first using the installDependencies tool.

				Returns success status and any error details if the build fails.
			`),
			parameters: z3.object({ buildCommand: z3.string() }),
			execute: async ({ buildCommand }) => {
				try {
					await container.execCommand({
						command: 'bash',
						args: ['-c', buildCommand],
						cwd: buildWorkDir,
					})
					return JSON.stringify({ success: true, message: 'Project built successfully' })
				} catch (error) {
					return JSON.stringify({
						success: false,
						error: error instanceof Error ? error.message : String(error),
						command: buildCommand,
					})
				}
			},
		}),
	}
}
