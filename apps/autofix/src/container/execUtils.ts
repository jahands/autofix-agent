import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'

import { chunksToLinesAsync, combine } from './iterable'

import type { ChildProcess } from 'node:child_process'

type WithIOType = {
	type: 'stdout' | 'stderr'
	line: string
}

function withIOType(
	type: WithIOType['type'],
	source: AsyncIterable<string>
): AsyncIterable<WithIOType> {
	return Readable.from(source).map((line): WithIOType => ({ type, line }))
}

class ExecError extends Error {}

function onChildProcessExit(childProcess: ChildProcess, context?: string): Promise<void> {
	return new Promise((resolve, reject) => {
		childProcess.once('exit', (code: number, _signal: string) => {
			if (code === 0) {
				resolve(undefined)
			} else {
				if (context) {
					reject(new ExecError(`Error while ${context}. Exited with error code: ${code}`))
				} else {
					reject(new Error(`Exit with error code: ${code}`))
				}
			}
		})
		childProcess.once('error', (err: Error) => {
			reject(err)
		})
	})
}

export interface ExecOptions {
	/**
	 * command to execute
	 */
	cmd: string

	/**
	 * where to execute the command
	 */
	cwd?: string

	/**
	 * what is being executed that should be logged for
	 * the user when it fails.eg. "running user command"
	 */
	context?: string

	/**
	 * the user that should run the command
	 */
	uid?: number

	/**
	 * environment variables
	 */
	env?: Record<string, string | undefined>
}

/**
 * Just like exec, except it is a generator which yields stdout lines
 */
export async function* execGetLinesStdoutStderr({
	cmd,
	cwd,
	context,
	uid,
	env,
}: ExecOptions): AsyncGenerator<WithIOType, void, unknown> {
	const proc = spawn(cmd, {
		cwd,
		uid,
		shell: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		env,
	})

	// Transform stdout/stderr into a stream of lines, then wrap the lines in
	// objects that say where the lines came from (either stdout | stderr)
	const stdout = withIOType('stdout', chunksToLinesAsync(proc.stdout))
	const stderr = withIOType('stderr', chunksToLinesAsync(proc.stderr))
	const exit = onChildProcessExit(proc, context)

	// Yield each line object from the combined iterable from stdout/stderr
	for await (const line of combine(stdout, stderr)) {
		yield line
	}

	await exit
}
