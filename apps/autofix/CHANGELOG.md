# @repo/autofix

## 0.2.0

### Minor Changes

- b8aa7f7: feat: add watch mode to local dev docker compose
- a93a79f: chore: refactor prompts into helper functions and properly use system prompts
- 24e9e5e: feat: install dependencies and build application to improve debugging

  This helps fix minor wrangler.jsonc issues by trying to build the application.

  - switched from apt to mise for easier tool management
  - disable container-server alarm in dev mode (fixes local dev issues)
  - adds additional tools to install dependencies and build the application

- a9dc5bb: feat: add eval tests
- e6b25de: feat: migrate Pages projects with a functions/ directory
- e3348de: feat: scaffold autofix Worker
- e54cc2e: feat: add state management and run actions using alarms

### Patch Changes

- 020835f: chore: update deps
- a9d3118: BANDA-919 feat: auto fix build issues with tools
- 4d2feba: chore: don't use magic strings for tool names
- 0e220a8: chore: upgrade to eslint 9
- 1a56f0f: chore: simplify test names
- 0abb47b: chore: update workers-ai-provider and ai-gateway-provider
- Updated dependencies [020835f]
- Updated dependencies [0e220a8]
- Updated dependencies [0abb47b]
  - @repo/hono-helpers@0.1.3
  - @repo/sandbox-container@0.1.1
  - @repo/eval-tools@0.1.1
  - @repo/format@0.1.0
