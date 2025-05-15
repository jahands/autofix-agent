import { generateText } from 'ai'
import { env } from 'cloudflare:workers'

import { WorkersAiLlama4 } from './ai-models'
import { WorkersBuildsClient } from './builds-client'

export async function autofix(buildUuid: string) {
	const workersBuilds = new WorkersBuildsClient({
		accountTag: env.CLOUDFLARE_ACCOUNT_TAG,
		apiToken: env.CLOUDFLARE_API_TOKEN,
	})
	const logs = await workersBuilds.getBuildLogs(buildUuid)

	const resp = await generateText({
		model: WorkersAiLlama4,
		system: 'You are an expert at investigating Build failures in CI systems',
		prompt: `
           You'll find the logs for a Build below. Provide a summary of the root cause of the failure.
           
           <logs>
           ${logs}
           </logs>
        `,
	})

	return resp.text
}
