import { tool } from 'ai'
import z from 'zod'

const listFiles = tool({
	description: 'List all files in the current directory',
	parameters: z.object({ path: z.string() }),
	execute: async ({ path }) => {
		console.log('listFiles', path)
		return { files: ['file1.txt', 'file2.txt'] }
	},
})

export const tools = { listFiles } as const
