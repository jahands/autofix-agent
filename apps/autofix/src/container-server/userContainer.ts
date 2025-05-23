import path from 'path'
import { Container } from 'cf-containers'
import pRetry from 'p-retry'
import { z } from 'zod'

import { OPEN_CONTAINER_PORT } from '../shared/consts'
import { proxyFetch } from './containerHelpers'
import { fileToBase64 } from './utils'

import type { Env } from '../autofix.context'
import type { FileList, FileWrite } from '../shared/schema'

type ExecResult = z.infer<typeof ExecResult>
const ExecResult = z.object({
	status: z.number(),
	stdout: z.string(),
	stderr: z.string(),
})

export class UserContainer extends Container<Env> {
	defaultPort = OPEN_CONTAINER_PORT
	sleepAfter = '5m'

	constructor(
		public ctx: DurableObjectState,
		public env: Env
	) {
		console.log('creating user container DO')
		super(ctx, env)
	}

	async container_initialize(): Promise<void> {
		// kill container
		// await this.stopContainer()

		await pRetry(async () => this.startAndWaitForPorts(OPEN_CONTAINER_PORT), {
			minTimeout: 200,
			maxTimeout: 1000,
			factor: 2,
			retries: 3,
		})
	}

	async container_ping(): Promise<string> {
		const res = await proxyFetch(
			this,
			this.env.ENVIRONMENT,
			new Request(`http://host:${OPEN_CONTAINER_PORT}/ping`)
		)
		if (!res || !res.ok) {
			throw new Error(`Request to container failed: ${await res.text()}`)
		}
		return await res.text()
	}

	async container_exec(params: { command: string; cwd: string }): Promise<ExecResult> {
		const res = await proxyFetch(
			this,
			this.env.ENVIRONMENT,
			new Request(`http://host:${OPEN_CONTAINER_PORT}/spawnSync`, {
				method: 'POST',
				body: JSON.stringify(params),
				headers: {
					'Content-Type': 'application/json',
				},
			})
		)
		if (!res || !res.ok) {
			throw new Error(`Request to container failed: ${await res.text()}`)
		}
		const body = await res.json()
		const parsed = ExecResult.parse(body)
		if (parsed.status !== 0) {
			throw new Error(`Exec failed with status ${parsed.status}: ${JSON.stringify(body)}`)
		}
		return parsed
	}

	async container_ls(dir: string): Promise<FileList> {
		const url = new URL(`http://host:${OPEN_CONTAINER_PORT}/files/ls`)
		url.searchParams.append('dir', dir)
		const res = await proxyFetch(this, this.env.ENVIRONMENT, new Request(url.toString()))
		if (!res || !res.ok) {
			throw new Error(`Request to container failed: ${await res.text()}`)
		}
		const json = (await res.json()) as FileList
		return json
	}

	async container_file_delete(params: { filePath: string; cwd: string }): Promise<boolean> {
		const { cwd, filePath } = params
		const fullPath = path.join(cwd, filePath)
		const res = await proxyFetch(
			this,
			this.env.ENVIRONMENT,
			new Request(`http://host:${OPEN_CONTAINER_PORT}/files/contents/${fullPath}`, {
				method: 'DELETE',
			})
		)
		return res.ok
	}

	async container_file_read(params: {
		filePath: string
		cwd: string
	}): Promise<
		| { type: 'text'; textOutput: string; mimeType: string | undefined }
		| { type: 'base64'; base64Output: string; mimeType: string | undefined }
	> {
		const { cwd, filePath } = params
		const fullPath = path.join(cwd, filePath)
		const res = await proxyFetch(
			this,
			this.env.ENVIRONMENT,
			new Request(`http://host:${OPEN_CONTAINER_PORT}/files/contents/${fullPath}`)
		)
		if (!res || !res.ok) {
			throw new Error(`Request to container failed: ${await res.text()}`)
		}

		const mimeType = res.headers.get('Content-Type') ?? undefined
		const blob = await res.blob()

		if (mimeType && mimeType.startsWith('text')) {
			return {
				type: 'text',
				textOutput: await blob.text(),
				mimeType,
			}
		} else {
			return {
				type: 'base64',
				base64Output: await fileToBase64(blob),
				mimeType,
			}
		}
	}

	async container_file_write(params: {
		filePath: string
		cwd: string
		text: string
	}): Promise<string> {
		const { cwd, filePath, text } = params
		const body: FileWrite = {
			path: path.join(cwd, filePath),
			text,
		}
		const res = await proxyFetch(
			this,
			this.env.ENVIRONMENT,
			new Request(`http://host:${OPEN_CONTAINER_PORT}/files/contents`, {
				method: 'POST',
				body: JSON.stringify(body),
				headers: {
					'content-type': 'application/json',
				},
			})
		)
		if (!res || !res.ok) {
			throw new Error(`Request to container failed: ${await res.text()}`)
		}
		return `Wrote file: ${body.path}`
	}
}
