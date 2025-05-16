import { Octokit } from '@octokit/rest'

export class GitHubClient {
	private octokit: Octokit
	private authToken: string

	constructor(authToken: string) {
		this.authToken = authToken
		this.octokit = new Octokit({ auth: authToken })
	}

	async createPullRequest(
		params: Parameters<typeof this.octokit.pulls.create>
	): Promise<{ url: string }> {
		const resp = await this.octokit.pulls.create(...params)
		return { url: resp.url }
	}

	async listFiles(params: Parameters<typeof this.octokit.git.getTree>) {
		const resp = await this.octokit.git.getTree(...params)
		return resp.data.tree.map((file) => file.path).filter((path) => path !== undefined)
	}
}
