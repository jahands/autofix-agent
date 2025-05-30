import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { serve } from '@hono/node-server'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { z } from 'zod'

const app = new Hono().use(logger())

app.get('/ping', (c) => c.text('pong!'))

app
	.get('/files', zValidator('query', z.object({ path: z.string() })), async (c) => {
		const { path } = c.req.valid('query')
		console.log(`reading file: ${path}`)
		const contents = await fs.readFile(path)
		return c.newResponse(contents, 200)
	})
	.post(zValidator('json', z.object({ path: z.string(), contents: z.string() })), async (c) => {
		const { path, contents } = c.req.valid('json')
		console.log(`writing file: ${path}`)
		await fs.mkdir(dirname(path), { recursive: true })
		await fs.writeFile(path, contents)
		return c.text('OK', 200)
	})

app.post(
	'/spawnSync',
	zValidator(
		'json',
		z.object({
			command: z.string(),
			args: z.array(z.string()),
			cwd: z.string(),
			input: z.string().optional(),
		})
	),
	async (c) => {
		const { command, args, cwd, input } = c.req.valid('json')
		console.log(`executing command ${command}`)
		const result = spawnSync(command, args, { cwd, input })
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
