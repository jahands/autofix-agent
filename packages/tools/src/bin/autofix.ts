import 'zx/globals'

import { program } from '@commander-js/extra-typings'
import { catchProcessError } from '@jahands/cli-tools/proc'

import { autofixBuildCmd, autofixFixBuildCmd, autofixTailCmd } from '../cmd/autofix.cmd'

program
	.name('autofix')
	.description('Manage the autofix agent')

	.addCommand(autofixTailCmd)
	.addCommand(autofixBuildCmd)
	.addCommand(autofixFixBuildCmd)

	// Don't hang for unresolved promises
	.hook('postAction', () => process.exit(0))
	.parseAsync()
	.catch(catchProcessError())
