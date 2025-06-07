# ESLint 9 Migration TODO

## High Priority

- [x] Update packages/eslint-config/package.json with new exports and dependencies (High)
- [x] Create packages/eslint-config/src/ directory structure (High)
- [x] Create packages/eslint-config/src/helpers.ts (High)
- [x] Create packages/eslint-config/src/default.config.ts (High)
- [x] Create packages/eslint-config/src/react.config.ts (High)
- [x] Create packages/eslint-config/eslint.config.ts (High)
- [x] Create packages/eslint-config/tsconfig.json (High)
- [x] Delete old packages/eslint-config/default.cjs (High)

## TypeScript Configuration Updates

- [ ] Update packages/typescript-config/base.json to exclude eslint.config.ts (High)
- [ ] Update packages/typescript-config/workers.json to exclude eslint.config.ts (High)
- [ ] Update packages/typescript-config/workers-lib.json to exclude eslint.config.ts (High)

## Root Configuration

- [ ] Replace .eslintrc.cjs with eslint.config.ts (High)
- [ ] Update root package.json scripts (High)

## Tools Package Updates

- [ ] Rename run-eslint-default to run-eslint and update contents (High)
- [ ] Update packages/tools/src/cmd/check.ts (High)
- [ ] Create packages/tools/eslint.config.ts (High)
- [ ] Delete packages/tools/.eslintrc.cjs (High)

## Turbo Configuration

- [ ] Rename turbo.json to turbo.jsonc (High)
- [ ] Update lint tasks in turbo.jsonc (High)

## Package Configurations

- [ ] Replace .eslintrc.cjs with eslint.config.ts in apps/autofix (Medium)
- [ ] Replace .eslintrc.cjs with eslint.config.ts in apps/example-worker-echoback (Medium)
- [ ] Replace .eslintrc.cjs with eslint.config.ts in packages/tools (Medium)
- [ ] Replace .eslintrc.cjs with eslint.config.ts in packages/hono-helpers (Medium)
- [ ] Replace .eslintrc.cjs with eslint.config.ts in packages/sandbox-container (Medium)
- [ ] Replace .eslintrc.cjs with eslint.config.ts in packages/workspace-dependencies (Medium)
- [ ] Update package.json scripts from run-eslint-default to run-eslint in all packages (Medium)

## Generator Templates

- [ ] Update turbo/generators/templates/ package.json.hbs files (Medium)

## VS Code Settings

- [ ] Update .vscode/settings.json with ESLint 9 support (Low)

## Documentation

- [ ] Update CLAUDE.md references (Low)
- [ ] Update .cursor/rules/package-management.mdc (Low)

## Testing

- [ ] Install dependencies (High)
- [ ] Verify ESLint version (High)
- [ ] Test linting with run-eslint (High)
- [ ] Run full checks with just check (High)

## Completed

- [x] Analyzed current codebase structure
- [x] Created migration plan
- [x] Set up TODO tracking
