---
'@repo/autofix': minor
---

feat: install dependencies and build application to improve debugging

This helps fix minor wrangler.jsonc issues by trying to build the application.

- switched from apt to mise for easier tool management
- disable container-server alarm in dev mode (fixes local dev issues)
- adds additional tools to install dependencies and build the application
