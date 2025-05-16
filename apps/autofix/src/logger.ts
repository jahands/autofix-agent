import { WorkersLogger } from 'workers-tagged-logger'

type LogTagHints = {
	handler: string
}
export const logger = new WorkersLogger<LogTagHints>()
