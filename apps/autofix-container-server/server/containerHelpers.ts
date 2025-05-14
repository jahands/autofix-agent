export const MAX_CONTAINERS = 3
export async function startAndWaitForPort({
	gitURL,
	environment,
	container,
	portToAwait,
	maxTries = 10,
}: {
	gitURL: string
	environment: 'development' | 'production' | 'test'
	container: Container | undefined
	portToAwait: number
	maxTries?: number
}): Promise<boolean> {
	if (environment === 'development' || environment === 'test') {
		console.log('Running in dev, assuming locally running container')
		return true
	}

	if (!container) {
		throw new Error('Error: ctx.container is undefined. Does this DO support containers?')
	}

	const port = container.getTcpPort(portToAwait)
	// promise to make sure the container does not exit
	let monitor

	for (let i = 0; i < maxTries; i++) {
		try {
			if (!container.running) {
				console.log('starting container')
				container.start({
					enableInternet: true,
					env: { GIT_CLONE_URL: gitURL },
				})

				// force DO to keep track of running state
				monitor = container.monitor()
				void monitor.then(() => console.log('Container exited'))
			}

			const conn = port.connect(`10.0.0.1:${portToAwait}`)
			await conn.close()
			console.log('Connected')
			return true
		} catch (err: any) {
			if (!(err instanceof Error)) {
				throw err
			}

			console.error('Error connecting to the container on', i, 'try', err)

			if (err.message.includes('listening')) {
				await new Promise((res) => setTimeout(res, 300))
				continue
			}

			// no container yet
			if (err.message.includes('there is no container instance that can be provided')) {
				await new Promise((res) => setTimeout(res, 300))
				continue
			}

			console.log(err)
			return false
		}
	}

	return false
}

export async function proxyFetch(
	environment: 'development' | 'production' | 'test',
	container: Container | undefined,
	request: Request,
	portNumber: number
): Promise<Response> {
	if (environment === 'development' || environment === 'test') {
		const url = request.url
			.replace('https://', 'http://')
			.replace('http://host', 'http://localhost')
		return fetch(url, request.clone() as Request)
	}

	if (!container) {
		throw new Error('Error: ctx.container is undefined. Does this DO support containers?')
	}

	return await container
		.getTcpPort(portNumber)
		.fetch(request.url.replace('https://', 'http://'), request.clone() as Request)
}
