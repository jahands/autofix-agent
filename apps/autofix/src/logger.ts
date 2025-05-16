import { WorkersLogger } from 'workers-tagged-logger'

type LogTagHints = {
	repo: string
}
export const logger = new WorkersLogger<LogTagHints>()
