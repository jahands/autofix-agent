import { Command } from '@commander-js/extra-typings'
import { validateArg } from '@jahands/cli-tools'
import * as jsoncParser from 'jsonc-parser'
import { z } from 'zod/v4'

import { getRepoRoot } from '../path'

export const autofixTailCmd = new Command('tail')
	.description('Tail logs for the autofix agent')
	.option(
		'-e, --env <environment>',
		'Environment to tail logs from',
		validateArg(z.enum(['staging', 'production'])),
		'staging'
	)
	.option('--raw', 'Show raw JSON output from wrangler tail')
	.action(async ({ env, raw }) => {
		cd(`${getRepoRoot()}/apps/autofix`)

		const cmd = ['wrangler', 'tail', '-e', env, '--format', 'json']

		if (raw) {
			await $`${cmd}`.pipe(process.stdout)
			return
		}

		for await (const rawLine of $`${cmd}`.stdout) {
			const line = Buffer.isBuffer(rawLine) ? rawLine.toString('utf8') : rawLine.toString()

			// skip empty lines
			if (!line.trim()) continue

			// split concatenated JSON objects by finding }{ patterns.
			// (Sometimes multiple objects are sent to stdout at the same time.)
			const jsonStrings: string[] = []
			let current = ''
			let depth = 0

			for (let i = 0; i < line.length; i++) {
				const char = line[i]
				current += char

				if (char === '{') depth++
				else if (char === '}') {
					depth--
					if (depth === 0) {
						jsonStrings.push(current.trim())
						current = ''
					}
				}
			}

			// if no valid JSON objects found, try parsing as single line
			if (jsonStrings.length === 0) {
				jsonStrings.push(line)
			}

			// process each JSON object
			for (const jsonStr of jsonStrings) {
				if (!jsonStr) continue

				let jsonData: unknown
				try {
					jsonData = JSON.parse(jsonStr)
				} catch {
					console.log(jsonStr)
					continue
				}

				const parsed = WranglerTailOutput.safeParse(jsonData)
				if (!parsed.success) {
					continue
				}

				// handle RPC events
				if (parsed.data.event && 'rpcMethod' in parsed.data.event && parsed.data.entrypoint) {
					console.log(`[${parsed.data.entrypoint}] rpc.${parsed.data.event.rpcMethod}()`)
				}

				// handle regular logs
				for (const log of parsed.data.logs) {
					if (log.message) {
						for (const msg of log.message) {
							const method = msg.tags?.$logger?.method || 'unknown'
							console.log(`[${method}] ${msg.message}`)
						}
					}
				}
			}
		}
	})

const LogMessage = z.object({
	tags: z
		.object({
			$logger: z
				.object({
					method: z.string(),
				})
				.optional(),
		})
		.optional(),
	message: z.string(),
})

const LogEntry = z.object({
	message: z.array(LogMessage).optional(),
})

const WranglerTailOutput = z.object({
	logs: z.array(LogEntry),
	entrypoint: z.string().optional(),
	event: z
		.union([
			z.object({
				rpcMethod: z.string(),
			}),
			z.object({
				scheduledTime: z.string(),
			}),
		])
		.optional(),
})

export const autofixBuildCmd = new Command('build-container')
	.description('Build and push the autofix container, then update wrangler.jsonc')
	.option(
		'-e, --env <environment>',
		'Environment to update in wrangler.jsonc',
		validateArg(z.enum(['staging', 'production'])),
		'staging'
	)
	.action(async ({ env }) => {
		const repoRoot = getRepoRoot()

		const sandboxDir = `${repoRoot}/packages/sandbox-container`
		cd(sandboxDir)
		echo(chalk.blue(`Running esbuild`))
		await $({
			stdio: 'inherit',
		})`pnpm run esbuild`

		// get git commit hash
		const gitCommit = (await $`git rev-parse --short HEAD`.text()).trim()
		const imageName = `autofix-container:${gitCommit}`
		const registryImage = `registry.cloudchamber.cfdata.org/${imageName}`

		echo(chalk.blue(`Building container image: ${imageName}`))
		await $({
			stdio: 'inherit',
		})`docker build --platform linux/amd64 --tag ${imageName} -f ./Dockerfile ${repoRoot}`

		echo(chalk.blue(`Pushing to registry: ${registryImage}`))
		await $`wrangler containers push ${imageName}`

		// update wrangler.jsonc
		const autofixDir = `${repoRoot}/apps/autofix`
		const wranglerPath = `${autofixDir}/wrangler.jsonc`
		const wranglerContent = await fs.readFile(wranglerPath, 'utf-8')

		const errors: jsoncParser.ParseError[] = []
		const wranglerConfig = jsoncParser.parseTree(wranglerContent, errors)

		if (errors.length > 0) {
			throw new Error(`Failed to parse wrangler.jsonc: ${errors.map((e) => e.error).join(', ')}`)
		}
		if (!wranglerConfig) {
			throw new Error('Failed to parse wrangler.jsonc')
		}

		const containerPath = ['env', env, 'containers', 0, 'image']
		const imageNode = jsoncParser.findNodeAtLocation(wranglerConfig, containerPath)
		if (!imageNode) {
			throw new Error(`Could not find container image for environment: ${env}`)
		}

		const edits = jsoncParser.modify(wranglerContent, containerPath, registryImage, {
			formattingOptions: {
				insertSpaces: false,
			},
		})

		const updatedContent = jsoncParser.applyEdits(wranglerContent, edits)

		await fs.writeFile(wranglerPath, updatedContent)
		echo(chalk.green(`\nUpdated wrangler.jsonc with new image: ${registryImage}`))
	})
