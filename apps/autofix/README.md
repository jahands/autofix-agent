# autofix

A Cloudflare Workers application using Hono and Vite

## Development

### Run in dev mode

```sh
# run Worker in dev mode
just dev

# run the development container (Ctrl+C to stop)
just dev:container

# build, push, and update wrangler.jsonc with new container image
just build-container
```

### Run tests

```sh
just test
```

### Deploy

```sh
just deploy -- -e staging
```
