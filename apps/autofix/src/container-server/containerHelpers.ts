import { connect } from 'cloudflare:sockets'
import pRetry from 'p-retry'

import type { Container as CfContainer } from 'cf-containers'
import type { WorkersEnvironment } from '@repo/hono-helpers/src/types'
import type { Env } from '../autofix.context'

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
	environment,
	container,
	port,
}: {
	container: CfContainer<Env>
	environment: WorkersEnvironment
	port: number
}): Promise<void> {
	if (environment === 'development' || environment === 'VITEST') {
		console.log('Running in dev, assuming locally running container')
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
	environment,
	request,
}: {
	container: CfContainer<Env>
	environment: WorkersEnvironment
	request: Request
}): Promise<Response> {
	if (environment === 'development' || environment === 'VITEST') {
		const url = request.url
			.replace('https://', 'http://')
			.replace('http://host', 'http://localhost')
		return fetch(url, request)
	}

	return await container.containerFetch(request)
}
