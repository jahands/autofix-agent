import { McpAgent } from 'agents/mcp'

import { ExecParams, FilePathParam, FileWrite, InitalizeParams } from '../shared/schema'
import { CloudflareMCPServer } from '../shared/server'
import { BASE_INSTRUCTIONS } from './prompts'
import { stripProtocolFromFilePath } from './utils'

import type { Props, UserContainer } from './autofix-container-server.app'
import type { Env } from './autofix-container-server.context'

export class ContainerMcpAgent extends McpAgent<Env, never, Props> {
	_server: CloudflareMCPServer | undefined
	set server(server: CloudflareMCPServer) {
		this._server = server
	}

	get server(): CloudflareMCPServer {
		if (!this._server) {
			throw new Error('Tried to access server before it was initialized')
		}

		return this._server
	}

	get userContainer(): DurableObjectStub<UserContainer> {
		const userContainer = this.env.USER_CONTAINER.idFromName(this.env.DEV_CLOUDFLARE_ACCOUNT_ID)
		return this.env.USER_CONTAINER.get(userContainer)
	}

	constructor(
		public ctx: DurableObjectState,
		public env: Env
	) {
		console.log('creating container DO')
		super(ctx, env)
	}

	async init() {
		this.server = new CloudflareMCPServer({
			wae: this.env.MCP_METRICS,
			serverInfo: {
				name: this.env.MCP_SERVER_NAME,
				version: this.env.MCP_SERVER_VERSION,
			},
			options: { instructions: BASE_INSTRUCTIONS },
		})

		this.server.tool(
			'container_initialize',
			`Start or restart the container.
			Use this tool to initialize a container before running any python or node.js code that the user requests to run. Takes in a required gitURL as a parameter for what git repository to clone for the container's working directory`,
			{ args: InitalizeParams },
			async ({ args }) => {
				const userInBlocklist = await this.env.USER_BLOCKLIST.get(
					this.env.DEV_CLOUDFLARE_ACCOUNT_ID
				)
				if (userInBlocklist) {
					return {
						content: [{ type: 'text', text: 'Blocked from intializing container.' }],
					}
				}
				return {
					content: [
						{ type: 'text', text: await this.userContainer.container_initialize(args.gitURL) },
					],
				}
			}
		)

		this.server.tool(
			'container_ping',
			`Ping the container for liveliness. Use this tool to check if the container is running.`,
			async () => {
				return {
					content: [{ type: 'text', text: await this.userContainer.container_ping() }],
				}
			}
		)
		this.server.tool(
			'container_exec',
			`Run a command in a container and return the results from stdout.
			If necessary, set a timeout. To debug, stream back standard error.
			If you're using python, ALWAYS use python3 alongside pip3`,
			{ args: ExecParams },
			async ({ args }) => {
				return {
					content: [{ type: 'text', text: await this.userContainer.container_exec(args) }],
				}
			}
		)
		this.server.tool(
			'container_file_delete',
			'Delete file in the working directory',
			{ args: FilePathParam },
			async ({ args }) => {
				const path = await stripProtocolFromFilePath(args.path)
				const deleted = await this.userContainer.container_file_delete(path)
				return {
					content: [{ type: 'text', text: `File deleted: ${deleted}.` }],
				}
			}
		)
		this.server.tool(
			'container_file_write',
			'Create a new file with the provided contents in the working direcotry, overwriting the file if it already exists',
			{ args: FileWrite },
			async ({ args }) => {
				args.path = await stripProtocolFromFilePath(args.path)
				return {
					content: [{ type: 'text', text: await this.userContainer.container_file_write(args) }],
				}
			}
		)
		this.server.tool(
			'container_files_list',
			'List working directory file tree. This just reads the contents of the current working directory',
			async () => {
				// Begin workaround using container read rather than ls:
				const readFile = await this.userContainer.container_file_read('.')
				return {
					content: [
						{
							type: 'resource',
							resource: {
								text: readFile.type === 'text' ? readFile.textOutput : readFile.base64Output,
								uri: `file://`,
								mimeType: readFile.mimeType,
							},
						},
					],
				}
			}
		)
		this.server.tool(
			'container_file_read',
			'Read a specific file or directory. Use this tool if you would like to read files or display them to the user. This allow you to get a displayable image for the user if there is an image file.',
			{ args: FilePathParam },
			async ({ args }) => {
				const path = await stripProtocolFromFilePath(args.path)
				const readFile = await this.userContainer.container_file_read(path)

				return {
					content: [
						{
							type: 'resource',
							resource: {
								text: readFile.type === 'text' ? readFile.textOutput : readFile.base64Output,
								uri: `file://${path}`,
								mimeType: readFile.mimeType,
							},
						},
					],
				}
			}
		)
	}
}
