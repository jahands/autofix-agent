import { Agent } from 'agents'
import { match } from 'ts-pattern'

import type { Env } from './autofix.context'

type AutofixStep =
	| 'idle'
	| 'fetching_build_info'
	| 'starting_container'
	| 'listing_files'
	| 'generating_fix'
	| 'applying_patch'
	| 'creating_branch'
	| 'creating_pr'
	| 'completed'
	| 'error'

type State = {
	repo: string
	branch: string
	currentStep: AutofixStep
	buildLogs?: string
	buildConfig?: unknown
	fileList?: string[]
	fixPatch?: string
	newBranchName?: string
	pullRequestUrl?: string
	errorMessage?: string
}

export class AutofixAgent extends Agent<Env, State> {
	// Define methods on the Agent:
	// https://developers.cloudflare.com/agents/api-reference/agents-api/
	//
	// Every Agent has built in state via this.setState and this.sql
	// Built-in scheduling via this.schedule
	// Agents support WebSockets, HTTP requests, state synchronization and
	// can run for seconds, minutes or hours: as long as the tasks need.

	// Initial state is a property as per the Agent SDK
	initialState: State = {
		repo: '',
		branch: '',
		currentStep: 'idle',
	}

	// Called when a new Agent instance starts or wakes from hibernation
	async onStart() {
		console.log(`[AutofixAgent] onStart invoked. Current state:`, this.state)

		// If the agent is already completed or in an error state, or hasn't been properly started,
		// don't automatically resume a workflow.
		if (
			this.state.currentStep === 'completed' ||
			this.state.currentStep === 'error' ||
			this.state.currentStep === 'idle' ||
			!this.state.repo // Check if it was ever truly started with a repo
		) {
			console.log(
				`[AutofixAgent] onStart: No automatic resumption for step: ${this.state.currentStep}. Waiting for explicit start or in a terminal state.`
			)
			return
		}

		// Resume the state machine by calling the method for the current step.
		// Each method is responsible for proceeding to the next step or handling errors.
		console.log(`[AutofixAgent] onStart: Resuming from step: ${this.state.currentStep}`)
		try {
			await match(this.state.currentStep)
				.with('fetching_build_info', () => this.fetchBuildInfo())
				.with('starting_container', () => this.startContainer())
				.with('listing_files', () => this.listFiles())
				.with('generating_fix', () => this.generateFix())
				.with('applying_patch', () => this.applyPatch())
				.with('creating_branch', () => this.createAndPushBranch())
				.with('creating_pr', () => this.createPullRequest())
				.otherwise(() => {
					console.log(
						`[AutofixAgent] onStart: No specific action defined for resuming step: ${this.state.currentStep}`
					)
				})
		} catch (error) {
			// This catch is a safety net for the resumption logic itself.
			// Individual steps have their own error handling that calls this.handleError.
			const stepForError = this.state.currentStep || 'onStart_resume_unknown'
			console.error(
				`[AutofixAgent] onStart: Critical error during resumption at step ${stepForError}:`,
				error
			)
			if (error instanceof Error) {
				await this.handleError(error, stepForError)
			} else {
				await this.handleError(
					new Error(`Unknown critical error during onStart resumption at step ${stepForError}`),
					stepForError
				)
			}
		}
	}

	/**
	 * Start the agent
	 */
	async start(repo: string, branch: string) {
		this.setState({
			...this.initialState,
			repo,
			branch,
			currentStep: 'fetching_build_info',
		})
		console.log(`[AutofixAgent] Starting for repo: ${repo}, branch: ${branch}`)
		try {
			await this.fetchBuildInfo()
		} catch (error) {
			if (error instanceof Error) {
				await this.handleError(error, 'fetching_build_info')
			} else {
				await this.handleError(
					new Error('Unknown error during fetchBuildInfo'),
					'fetching_build_info'
				)
			}
		}
	}

	async fetchBuildInfo() {
		console.log('[AutofixAgent] Fetching build logs and configuration...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		const mockBuildLogs = 'Error: Build failed due to Xyz...'
		const mockBuildConfig = { compiler: 'tsc', version: '5.0' }

		this.setState({
			...this.state,
			buildLogs: mockBuildLogs,
			buildConfig: mockBuildConfig,
			currentStep: 'starting_container',
		})
		console.log('[AutofixAgent] Build info fetched.')
		try {
			await this.startContainer()
		} catch (error) {
			if (error instanceof Error) {
				await this.handleError(error, 'starting_container')
			} else {
				await this.handleError(
					new Error('Unknown error during startContainer'),
					'starting_container'
				)
			}
		}
	}

	async startContainer() {
		console.log('[AutofixAgent] Starting container...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.setState({ ...this.state, currentStep: 'listing_files' })
		console.log('[AutofixAgent] Container started.')
		try {
			await this.listFiles()
		} catch (error) {
			if (error instanceof Error) {
				await this.handleError(error, 'listing_files')
			} else {
				await this.handleError(new Error('Unknown error during listFiles'), 'listing_files')
			}
		}
	}

	async listFiles() {
		console.log('[AutofixAgent] Listing files in container...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		const mockFileList = ['src/index.ts', 'package.json', 'README.md']
		this.setState({
			...this.state,
			fileList: mockFileList,
			currentStep: 'generating_fix',
		})
		console.log('[AutofixAgent] Files listed.')
		try {
			await this.generateFix()
		} catch (error) {
			if (error instanceof Error) {
				await this.handleError(error, 'generating_fix')
			} else {
				await this.handleError(new Error('Unknown error during generateFix'), 'generating_fix')
			}
		}
	}

	async generateFix() {
		console.log('[AutofixAgent] Prompting AI model to generate a fix...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		const mockFixPatch =
			'--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-console.log("bug");\n+console.log("fix");'

		this.setState({
			...this.state,
			fixPatch: mockFixPatch,
			currentStep: 'applying_patch',
		})
		console.log('[AutofixAgent] Fix patch generated.')
		try {
			await this.applyPatch()
		} catch (error) {
			if (error instanceof Error) {
				await this.handleError(error, 'applying_patch')
			} else {
				await this.handleError(new Error('Unknown error during applyPatch'), 'applying_patch')
			}
		}
	}

	async applyPatch() {
		console.log('[AutofixAgent] Applying patch to container...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		this.setState({ ...this.state, currentStep: 'creating_branch' })
		console.log('[AutofixAgent] Patch applied.')
		try {
			await this.createAndPushBranch()
		} catch (error) {
			if (error instanceof Error) {
				await this.handleError(error, 'creating_branch')
			} else {
				await this.handleError(
					new Error('Unknown error during createAndPushBranch'),
					'creating_branch'
				)
			}
		}
	}

	async createAndPushBranch() {
		console.log('[AutofixAgent] Creating new branch and pushing to remote...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		const newBranchName = `autofix/${this.state.branch}-${Date.now()}`
		this.setState({
			...this.state,
			newBranchName,
			currentStep: 'creating_pr',
		})
		console.log(`[AutofixAgent] New branch ${newBranchName} created and pushed.`)
		try {
			await this.createPullRequest()
		} catch (error) {
			if (error instanceof Error) {
				await this.handleError(error, 'creating_pr')
			} else {
				await this.handleError(new Error('Unknown error during createPullRequest'), 'creating_pr')
			}
		}
	}

	async createPullRequest() {
		console.log('[AutofixAgent] Creating Pull Request on GitHub...')
		await new Promise((resolve) => setTimeout(resolve, 100))
		const mockPullRequestUrl = `https://github.com/${this.state.repo}/pull/123`
		this.setState({
			...this.state,
			pullRequestUrl: mockPullRequestUrl,
			currentStep: 'completed',
		})
		console.log(`[AutofixAgent] Pull Request created: ${mockPullRequestUrl}`)
		console.log('[AutofixAgent] Autofix process completed successfully.')
	}

	async handleError(error: Error, step: AutofixStep) {
		console.error(`[AutofixAgent] Error during step: ${step}`, error.message)
		this.setState({
			...this.state,
			currentStep: 'error',
			errorMessage: error.message,
		})
	}
}
