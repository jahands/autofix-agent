import { DurableObject } from 'cloudflare:workers'

import { OPEN_CONTAINER_PORT } from '../shared/consts'
import { proxyFetch, startAndWaitForPort } from './containerHelpers'
import { fileToBase64 } from './utils'

import type { Env } from '../autofix.context'
import type { ExecParams, FileList, FileWrite } from '../shared/schema'

export class UserContainer extends DurableObject<Env> {
	constructor(
		public ctx: DurableObjectState,
		public env: Env
	) {
		console.log('creating user container DO')
		super(ctx, env)
	}

	async destroyContainer(): Promise<void> {
		await this.ctx.container?.destroy()
	}

	async container_initialize(gitURL: string): Promise<string> {
		// kill container
		await this.destroyContainer()

		// start container
		let startedContainer = false
		await this.ctx.blockConcurrencyWhile(async () => {
			startedContainer = await startAndWaitForPort({
				gitURL,
				environment: this.env.ENVIRONMENT,
				container: this.ctx.container,
				portToAwait: OPEN_CONTAINER_PORT,
			})
		})
		if (!startedContainer) {
			throw new Error('Failed to start container')
		}

		return `Created new container`
	}

	async container_ping(): Promise<string> {
		const res = await proxyFetch(
			this.env.ENVIRONMENT,
			this.ctx.container,
			new Request(`http://host:${OPEN_CONTAINER_PORT}/ping`),
			OPEN_CONTAINER_PORT
		)
		if (!res || !res.ok) {
			throw new Error(`Request to container failed: ${await res.text()}`)
		}
		return await res.text()
	}

	async container_exec(params: ExecParams): Promise<string> {
		const res = await proxyFetch(
			this.env.ENVIRONMENT,
			this.ctx.container,
			new Request(`http://host:${OPEN_CONTAINER_PORT}/exec`, {
				method: 'POST',
				body: JSON.stringify(params),
				headers: {
					'content-type': 'application/json',
				},
			}),
			OPEN_CONTAINER_PORT
		)
		if (!res || !res.ok) {
			throw new Error(`Request to container failed: ${await res.text()}`)
		}
		const txt = await res.text()
		return txt
	}

	async container_ls(): Promise<FileList> {
		const res = await proxyFetch(
			this.env.ENVIRONMENT,
			this.ctx.container,
			new Request(`http://host:${OPEN_CONTAINER_PORT}/files/ls`),
			OPEN_CONTAINER_PORT
		)
		if (!res || !res.ok) {
			throw new Error(`Request to container failed: ${await res.text()}`)
		}
		const json = (await res.json()) as FileList
		return json
	}

	async container_file_delete(filePath: string): Promise<boolean> {
		const res = await proxyFetch(
			this.env.ENVIRONMENT,
			this.ctx.container,
			new Request(`http://host:${OPEN_CONTAINER_PORT}/files/contents/${filePath}`, {
				method: 'DELETE',
			}),
			OPEN_CONTAINER_PORT
		)
		return res.ok
	}
	async container_file_read(
		filePath: string
	): Promise<
		| { type: 'text'; textOutput: string; mimeType: string | undefined }
		| { type: 'base64'; base64Output: string; mimeType: string | undefined }
	> {
		const res = await proxyFetch(
			this.env.ENVIRONMENT,
			this.ctx.container,
			new Request(`http://host:${OPEN_CONTAINER_PORT}/files/contents/${filePath}`),
			OPEN_CONTAINER_PORT
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

	async container_file_write(file: FileWrite): Promise<string> {
		const res = await proxyFetch(
			this.env.ENVIRONMENT,
			this.ctx.container,
			new Request(`http://host:${OPEN_CONTAINER_PORT}/files/contents`, {
				method: 'POST',
				body: JSON.stringify(file),
				headers: {
					'content-type': 'application/json',
				},
			}),
			OPEN_CONTAINER_PORT
		)
		if (!res || !res.ok) {
			throw new Error(`Request to container failed: ${await res.text()}`)
		}
		return `Wrote file: ${file.path}`
	}
}
