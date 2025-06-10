import { defineWorkspace } from 'vitest/config'

import { glob } from '@repo/workspace-dependencies/zx'

const projects = await glob([
	// All eval projects
	'{apps,packages}/*/vitest.config.evals.ts',
])

export default defineWorkspace(projects)
