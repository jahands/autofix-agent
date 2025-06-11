import { fmt } from '@repo/format'

import { AutofixTools as t } from '../autofix.tools'

import type { BuildResponse } from '../workersBuilds'

/**
 * Data required for the Pages detection prompt
 */
export interface DetectionPromptOptions {
	metadata: BuildResponse
	logs: string
}

/**
 * Result from Pages detection analysis
 */
export interface DetectionResult {
	needsMigration: boolean
	reasoning: string
}

/**
 * Creates the system prompt for Pages detection analysis
 */
export const createDetectionSystemPrompt = () =>
	fmt.trim(`
		You are analyzing a project to determine if it has Cloudflare Pages-specific configurations that need to be migrated to Cloudflare Workers equivalents.

		Since Cloudflare Workers now supports static assets hosting, all projects will be deployed as Workers, but projects originally designed for Pages may need configuration migration.

		Analysis Strategy:
		1. First, analyze the provided build logs and metadata for specific Cloudflare Pages indicators
		2. Only use file analysis tools if the logs/metadata are inconclusive and you need to examine:
			- Wrangler configuration files (wrangler.toml, wrangler.json, wrangler.jsonc) for "pages_build_output_dir"
			- Project root for functions/ directory (Pages Functions)
			- Package.json and build scripts for Pages-specific patterns
		3. Look for SPECIFIC Cloudflare Pages-related errors and configuration, not just the word "Pages"
		4. If you find clear evidence of Cloudflare Pages usage, you can conclude without file analysis
		5. Only use tools like ${t.listContainerFiles}() and ${t.getFileContents}() if you need additional information
		6. Be efficient - don't list files unnecessarily

		Specific Cloudflare Pages Indicators to Look For:
		- Error messages like "It looks like you've run a Workers-specific command in a Pages project"
		- References to "wrangler pages deploy" or "pages deploy"
		- Mentions of "pages_build_output_dir" in configuration or errors
		- Specific Pages error messages about "functions/" deployment or Pages Functions
		- Build configuration explicitly showing Pages-specific settings
		- Wrangler config with "pages_build_output_dir" (should migrate to Workers Assets format)
		- functions/ directory (Pages Functions - requires compilation with 'wrangler pages functions build')
		- Build errors specifically mentioning Pages deployment patterns
		- Configuration showing Pages-specific build outputs
		- Error messages about functions/ folder deployment or Pages Functions routing

		Important Notes:
		- _headers and _redirects files are supported in Workers Assets and do NOT require migration
		- Since Cloudflare Workers now supports static assets hosting, all projects will be deployed as Workers
		- Projects originally designed for Pages may need configuration migration

		Response Format:
		Respond with ONLY a valid JSON object in this exact format:
		{
			"needsMigration": boolean,
			"reasoning": "Brief explanation of why migration is or is not needed based on specific evidence found"
		}
	`)

/**
 * Creates the user prompt for Pages detection analysis
 * Contains only data, no instructions (those are in the system prompt)
 */
export const createDetectionUserPrompt = (opts: DetectionPromptOptions) =>
	fmt.trim(`
		Build configuration:
		${JSON.stringify(opts.metadata, null, 2)}

		Build logs:
		${opts.logs}
	`)

/**
 * Guidelines specific to migrating Pages projects to Workers
 */
export const createMigrationGuidelines = () =>
	fmt.trim(`
		- IMPORTANT: This project appears to have Cloudflare Pages-specific configurations that need migration
		- CRITICAL MIGRATION RULE: Migrate FROM Pages TO Workers - use 'wrangler deploy', NEVER 'wrangler pages deploy'
		- This migration is FROM Pages TO Workers, not the other way around
		- Any build scripts that use 'wrangler pages deploy' must be changed to 'wrangler deploy'
		- Change 'wrangler pages dev' to 'wrangler dev' in preview/dev scripts (without adding unnecessary flags)
		- DO NOT add redundant command-line flags that duplicate wrangler.jsonc configuration
		- CRITICAL functions/ DIRECTORY MIGRATION: If the project has a functions/ directory (Pages Functions):
			* Update package.json build script to include: 'wrangler pages functions build --outdir=./dist/worker/'
			* Update wrangler.jsonc main field to point to the compiled script: "main": "./dist/worker/index.js"
			* The compiled Worker script will handle all the routing that was previously done by the functions/ folder
			* Example package.json script update:
				- Before: "build": "npm run build:client"
				- After: "build": "npm run build:client && wrangler pages functions build --outdir=./dist/worker/"
			* Example wrangler.jsonc configuration:
				{
					"name": "my-worker",
					"main": "./dist/worker/index.js",
					"assets": {"directory": "./dist/client/"}
				}
			* The functions compilation must happen BEFORE 'wrangler deploy' in the deployment process
		- Update any Pages-specific build configurations to Workers equivalents
		- CRITICAL: Migrate Pages wrangler configuration to Workers Assets format (NOT Workers Sites):
			* Replace "pages_build_output_dir" with "assets": {"directory": "path"}
			* Example: pages_build_output_dir = "./build/client" → "assets": {"directory": "./build/client"}
			* NEVER use the old Workers Sites format: [site] bucket = "path" (this is deprecated)
			* ALWAYS use the new Workers Assets format: [assets] directory = "path" or "assets": {"directory": "path"}
			* If using wrangler.toml, convert the entire configuration to wrangler.jsonc format
			* Delete the old wrangler.toml file after creating the new wrangler.jsonc
		- Ensure static assets are properly configured for Workers static assets hosting
		- NOTE: _headers and _redirects files are supported in Workers Assets and can remain as-is
		- Remove Pages-specific configurations that don't apply to Workers
		- CRITICAL: During migration, do NOT add service bindings (KV, D1, R2) unless the code explicitly requires them
		- Pages projects may have had implicit bindings - only migrate bindings that are actually used in the code
		- CRITICAL _worker.js HANDLING: Pages projects often generate _worker.js files in the build output
			* Create a .assetsignore file in the project root containing "_worker.js" to prevent uploading server-side code as static assets
			* Update build scripts to copy .assetsignore to the assets output directory before deployment
			* Example build command: "npm run build && cp .assetsignore ./dist/ && wrangler deploy"
			* This prevents the error: "Uploading a Pages _worker.js directory as an asset"
		- DEPLOYMENT: Always use 'wrangler deploy' for the final deployment, never Pages commands
		- Reference both Pages migration docs and Workers static assets docs
	`)
