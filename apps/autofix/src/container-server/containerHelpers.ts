import type { Container as CfContainer } from 'cf-containers'
import type { Env } from '../autofix.context'

export async function proxyFetch(
	container: CfContainer<Env>,
	environment: 'development' | 'staging' | 'production' | 'VITEST',
	request: Request
): Promise<Response> {
	if (environment === 'development' || environment === 'VITEST') {
		const url = request.url
			.replace('https://', 'http://')
			.replace('http://host', 'http://localhost')
		return fetch(url, request.clone() as Request)
	}

	return await container.containerFetch(request)
}
