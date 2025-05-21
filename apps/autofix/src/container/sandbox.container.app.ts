import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import mime from 'mime'
import { z } from 'zod'

import { FileWrite } from '../shared/schema.js'
import {
	DIRECTORY_CONTENT_TYPE,
	get_file_name_from_path,
	get_mime_type,
	list_files_in_directory,
} from './fileUtils.js'

import type { FileList } from '../shared/schema.js'

process.chdir('workdir')

const app = new Hono()

app.use(logger())

app.get('/ping', (c) => c.text('pong!'))

/**
 * GET /files/ls
 *
 * Gets all files in a directory
 */
app.get('/files/ls', zValidator('query', z.object({ dir: z.string() })), async (c) => {
	try {
		const directoriesToRead = [c.req.valid('query').dir]
		const files: FileList = { resources: [] }
		const baseCwd = process.cwd()

		while (directoriesToRead.length > 0) {
			const currentRelativeDir = directoriesToRead.pop()
			if (!currentRelativeDir) {
				throw new Error('Popped empty stack, error while listing directories')
			}

			const absoluteDirToRead = path.join(baseCwd, currentRelativeDir)
			let dirEntries
			try {
				dirEntries = await fs.readdir(absoluteDirToRead, { withFileTypes: true })
			} catch (e: unknown) {
				if (e instanceof Error) {
					console.error(`Error reading directory ${absoluteDirToRead}: ${e.message}`)
					files.resources.push({
						uri: `file:///${currentRelativeDir}`, // list the problematic directory entry
						name: path.basename(currentRelativeDir),
						mimeType: 'inode/directory-error',
					})
				}
				continue // If a directory is not readable, skip it
			}

			for (const dirent of dirEntries) {
				// Path of the current entry relative to baseCwd
				const entryRelativePath = path.join(currentRelativeDir, dirent.name)

				if (dirent.isDirectory()) {
					directoriesToRead.push(entryRelativePath)
					files.resources.push({
						uri: `file:///${entryRelativePath.replace(/\\/g, '/')}`, // normalize for URI
						name: dirent.name,
						mimeType: 'inode/directory',
					})
					// skip symlinks and other file types
				} else if (dirent.isFile()) {
					const mimeType = mime.getType(dirent.name)
					files.resources.push({
						uri: `file:///${entryRelativePath.replace(/\\/g, '/')}`, // normalize for URI
						name: dirent.name,
						mimeType: mimeType ?? undefined,
					})
				}
			}
		}
		return c.json(files)
	} catch (e) {
		return c.json({ error: e }, 500)
	}
})

/**
 * GET /files/contents/{filepath}
 *
 * Get the contents of a file or directory
 */
app.get('/files/contents/*', async (c) => {
	const reqPath = await get_file_name_from_path(c.req.path)
	try {
		const mimeType = await get_mime_type(reqPath)
		const headers = mimeType ? { 'Content-Type': mimeType } : undefined
		const contents = await fs.readFile(path.join(process.cwd(), reqPath))
		return c.newResponse(contents, 200, headers)
	} catch (e: any) {
		if (e.code) {
			if (e.code === 'EISDIR') {
				const files = await list_files_in_directory(reqPath)
				return c.newResponse(files.join('\n'), 200, {
					'Content-Type': DIRECTORY_CONTENT_TYPE,
				})
			}
			if (e.code === 'ENOENT') {
				return c.notFound()
			}
		}

		throw e
	}
})

/**
 * POST /files/contents
 *
 * Create or update file contents
 */
app.post('/files/contents', zValidator('json', FileWrite), async (c) => {
	const file = c.req.valid('json')
	const reqPath = await get_file_name_from_path(file.path)

	try {
		await fs.writeFile(reqPath, file.text)
		return c.newResponse(null, 200)
	} catch (e) {
		return c.newResponse(`Error: ${e}`, 400)
	}
})

/**
 * DELETE /files/contents/{filepath}
 *
 * Delete a file or directory
 */
app.delete('/files/contents/*', async (c) => {
	const reqPath = await get_file_name_from_path(c.req.path)

	try {
		await fs.rm(path.join(process.cwd(), reqPath), { recursive: true })
		return c.newResponse('ok', 200)
	} catch (e: any) {
		if (e.code) {
			if (e.code === 'ENOENT') {
				return c.notFound()
			}
		}

		throw e
	}
})

app.post(
	'/spawnSync',
	zValidator('json', z.object({ command: z.string(), cwd: z.string() })),
	async (c) => {
		const { command, cwd } = c.req.valid('json')
		const result = spawnSync(command, { shell: true, cwd })
		if (result.error) {
			return c.json({ error: result.error }, 500)
		}
		return c.json({
			status: result.status,
			stdout: result.stdout.toString().trim(),
			stderr: result.stderr.toString().trim(),
		})
	}
)

serve({
	fetch: app.fetch,
	port: 8080,
})
