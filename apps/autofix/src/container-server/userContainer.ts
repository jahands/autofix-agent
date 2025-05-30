import path from 'path'
import { Container } from 'cf-containers'
import { env } from 'cloudflare:workers'
import { z } from 'zod'

import { getMockContainerCtx, proxyContainerFetch, startContainer } from './containerHelpers'

import type { Env } from '../autofix.context'

const OPEN_CONTAINER_PORT = 8080

type ExecResult = z.infer<typeof ExecResult>
const ExecResult = z.object({
	status: z.number(),
	stdout: z.string(),
	stderr: z.string(),
})

export class UserContainer extends Container<Env> {
	defaultPort = OPEN_CONTAINER_PORT
	sleepAfter = '5m'
	// Enable manual start in development
	manualStart = env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'VITEST' ? true : false

	constructor(
		public ctx: DurableObjectState,
		public env: Env
	) {
		if (env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'VITEST') {
			ctx.container = getMockContainerCtx()
		}
		console.log('creating user container DO')
		super(ctx, env)

		if (env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'VITEST') {
			this.alarm = async () => {}
		}
	}

	async initialize(): Promise<void> {
		await startContainer({
			container: this,
			environment: this.env.ENVIRONMENT,
			port: OPEN_CONTAINER_PORT,
		})
	}

	private async proxyFetch(request: Request) {
		const resp = await proxyContainerFetch({
			container: this,
			environment: this.env.ENVIRONMENT,
			request,
		})
		if (!resp.ok) {
			throw new Error(
				`Container ${request.method} to ${request.url} failed with code ${resp.status}: ${await resp.text()}`
			)
		}
		return resp
	}

	async ping(): Promise<string> {
		const resp = await this.proxyFetch(new Request(`http://host:${OPEN_CONTAINER_PORT}/ping`))
		return resp.text()
	}

	async execCommand(params: { command: string; args: string[]; cwd: string; input?: string }) {
		const resp = await this.proxyFetch(
			new Request(`http://host:${OPEN_CONTAINER_PORT}/spawnSync`, {
				method: 'POST',
				body: JSON.stringify(params),
				headers: {
					'Content-Type': 'application/json',
				},
			})
		)
		const body = await resp.json()
		const parsed = ExecResult.parse(body)
		if (parsed.status !== 0) {
			throw new Error(`Command failed with status ${parsed.status}: ${JSON.stringify(body)}`)
		}
		return parsed
	}

	async readFile(params: { filePath: string; cwd: string }): Promise<string> {
		const { cwd, filePath } = params
		const fullPath = path.join(cwd, filePath)
		const url = new URL(`http://host:${OPEN_CONTAINER_PORT}/files`)
		url.searchParams.append('path', fullPath)
		const resp = await this.proxyFetch(new Request(url.toString()))
		return resp.text()
	}

	async writeFile(params: { filePath: string; cwd: string; contents: string }) {
		const { cwd, filePath, contents } = params
		const fullPath = path.join(cwd, filePath)
		const body = { path: fullPath, contents }
		await this.proxyFetch(
			new Request(`http://host:${OPEN_CONTAINER_PORT}/files`, {
				method: 'POST',
				body: JSON.stringify(body),
				headers: {
					'content-type': 'application/json',
				},
			})
		)
	}
}
