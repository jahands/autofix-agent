import path from 'path'
import { Container } from 'cf-containers'
import { connect } from 'cloudflare:sockets'
import { env } from 'cloudflare:workers'
import pRetry from 'p-retry'
import { z } from 'zod'

import { logger } from '../logger'

import type { Env } from '../autofix.context'

const OPEN_CONTAINER_PORT = 8080

type ExecResult = z.infer<typeof ExecResult>
const ExecResult = z.object({
	status: z.number(),
	stdout: z.string(),
	stderr: z.string(),
})

/**
 * Container operations used by AutofixAgent tools.
 */
export type UserContainerTools = Pick<UserContainer, 'execCommand' | 'writeFile' | 'readFile'>

export class UserContainer extends Container<Env> {
	defaultPort = OPEN_CONTAINER_PORT
	sleepAfter = '5m'
	manualStart = isDevEnv()

	constructor(
		public ctx: DurableObjectState,
		public env: Env
	) {
		if (isDevEnv()) {
			ctx.container = getMockContainerCtx()
		}
		super(ctx, env)

		if (isDevEnv()) {
			this.alarm = async () => {}
		}
	}

	async initialize(): Promise<void> {
		await startContainer({
			container: this,
			port: OPEN_CONTAINER_PORT,
		})
	}

	private async proxyFetch(request: Request) {
		const resp = await proxyContainerFetch({
			container: this,
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

const isDevEnv = () => env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'VITEST'

export function getMockContainerCtx() {
	// mock ctx.container methods in development
	return {
		running: true,
		monitor: (): Promise<void> => {
			// never resolves
			return new Promise(() => {})
		},
		start: () => {},
		getTcpPort(_port: number) {
			return { fetch, connect }
		},
		signal: () => {},
		destroy: () => {
			return Promise.resolve()
		},
	}
}

export async function startContainer({
	container,
	port,
}: {
	container: Container<Env>
	port: number
}): Promise<void> {
	if (isDevEnv()) {
		logger.warn('Running in dev, assuming locally running container')
		return
	}

	await pRetry(async () => container.startAndWaitForPorts(port), {
		minTimeout: 200,
		maxTimeout: 1000,
		factor: 2,
		retries: 3,
	})
}

export async function proxyContainerFetch({
	container,
	request,
}: {
	container: Container<Env>
	request: Request
}): Promise<Response> {
	if (isDevEnv()) {
		const url = request.url
			.replace('https://', 'http://')
			.replace('http://host', 'http://localhost')
		return fetch(url, request)
	}

	return await container.containerFetch(request)
}
