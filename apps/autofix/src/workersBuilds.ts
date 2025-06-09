import { z } from 'zod'

import { fetchJSON } from './shared/fetch'

/**
 * Configuration needed to make API calls to Workers Builds
 */
type WorkersBuildsConfig = {
	accountTag: string
	apiToken: string
}

/**
 * The wrapper/envelope type for all Cloudflare API Requests
 */
const cfApiSchema = <T extends z.ZodTypeAny>(resultSchema: T) =>
	z.object({
		result: resultSchema,
		success: z.boolean(),
		errors: z.array(z.unknown()),
		messages: z.array(z.unknown()),
	})

export type BuildResponse = z.infer<typeof BuildResponse>
export const BuildResponse = cfApiSchema(
	z.object({
		build_uuid: z.string().uuid(),
		status: z.string(),
		build_outcome: z.string(),
		initializing_on: z.string().datetime(),
		running_on: z.string().datetime(),
		stopped_on: z.string().datetime(),
		created_on: z.string().datetime(),
		modified_on: z.string().datetime(),
		trigger: z.object({
			trigger_uuid: z.string().uuid(),
			external_script_id: z.string(),
			trigger_name: z.string(),
			build_command: z.string(),
			deploy_command: z.string(),
			root_directory: z.string(),
			branch_includes: z.array(z.string()),
			branch_excludes: z.array(z.string()),
			path_includes: z.array(z.string()),
			path_excludes: z.array(z.string()),
			build_caching_enabled: z.boolean(),
			created_on: z.string().datetime(),
			modified_on: z.string().datetime(),
			deleted_on: z.nullable(z.string().datetime()),
			repo_connection: z.object({
				repo_connection_uuid: z.string().uuid(),
				repo_id: z.string(),
				repo_name: z.string(),
				provider_type: z.string(),
				provider_account_id: z.string(),
				provider_account_name: z.string(),
				created_on: z.string().datetime(),
				modified_on: z.string().datetime(),
				deleted_on: z.nullable(z.string().datetime()),
			}),
		}),
		build_trigger_metadata: z.object({
			build_trigger_source: z.string(),
			branch: z.string(),
			commit_hash: z.string(),
			commit_message: z.string(),
			author: z.string(),
			build_command: z.string(),
			deploy_command: z.string(),
			root_directory: z.string(),
			build_token_uuid: z.string().uuid(),
			environment_variables: z.record(z.any()),
			repo_name: z.string(),
			provider_account_name: z.string(),
			provider_type: z.string(),
		}),
	})
)

/**
 * API Client for Workers Builds
 */
export class WorkersBuildsClient {
	constructor(private config: WorkersBuildsConfig) {
		if (!config.accountTag) {
			throw new Error('accountTag is missing/empty')
		}
		if (!config.apiToken) {
			throw new Error('apiToken is missing/empty')
		}
	}

	getBuildMetadata(buildUuid: string) {
		return fetchJSON(
			new Request(
				`https://api.cloudflare.com/client/v4/accounts/${this.config.accountTag}/builds/builds/${buildUuid}`,
				{ headers: this.getHeaders() }
			),
			BuildResponse
		)
	}

	/**
	 * Grab all logs for the specifiecd build.
	 * Makes multiple requests until all logs are gathered.
	 */
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

		const allLines: Array<[number, string]> = []
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
