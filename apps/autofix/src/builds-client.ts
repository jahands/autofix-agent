import { z } from 'zod'

import { fetchJSON } from './fetch-utils'

type WorkersBuildsConfig = {
	accountTag: string
	apiToken: string
}

export class WorkersBuildsClient {
	constructor(private config: WorkersBuildsConfig) {}

	async getBuildLogs(buildUuid: string) {
		const logsSchema = cfApiSchema(
			z.object({
				cursor: z.string(),
				truncated: z.boolean(),
				lines: z.array(
					z.tuple([
						z.number(), // timestamp
						z.string(), // message
					])
				),
			})
		)

		// Pull all pages of build logs
		let allLines: [number, string][] = []
		let cursor: string | undefined = undefined
		let truncated = true
		while (truncated) {
			const url = new URL(
				`https://api.cloudflare.com/client/v4/accounts/${this.config.accountTag}/builds/builds/${buildUuid}/logs`
			)
			if (cursor) url.searchParams.set('cursor', cursor)

			const resp = await fetchJSON(
				new Request(url.toString(), {
					headers: this.getHeaders(),
				}),
				logsSchema
			)

			allLines.push(...resp.result.lines)
			cursor = resp.result.cursor
			truncated = resp.result.truncated
		}

		const combinedLogs = allLines.map(([timestamp, line]) => `${timestamp}: ${line}`).join('\n')
		return combinedLogs
	}

	private getHeaders() {
		return { Authorization: `Bearer ${this.config.apiToken}` }
	}
}

const cfApiSchema = <T extends z.ZodTypeAny>(resultSchema: T) =>
	z.object({
		result: resultSchema,
		success: z.boolean(),
		errors: z.array(z.unknown()),
		messages: z.array(z.unknown()),
	})
