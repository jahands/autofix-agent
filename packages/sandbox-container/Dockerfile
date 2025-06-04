FROM ubuntu:24.04 AS base

RUN apt-get update && apt-get install -y \
	git \
	curl \
	ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Add Cloudflare WARP certs when USE_WARP_CERTS == 'true' (local development only)
ARG USE_WARP_CERTS
COPY packages/sandbox-container/src/install-scripts/install-cloudflare-warp-certs.sh /tmp/
RUN /tmp/install-cloudflare-warp-certs.sh && rm /tmp/install-cloudflare-warp-certs.sh

RUN useradd --system --create-home --uid 1001 sandbox
USER sandbox
WORKDIR /home/sandbox
ENV HOME=/home/sandbox

RUN bash -c "set -euo pipefail; curl -fsSL https://sh.uuid.rocks/install/mise | MISE_VERSION=v2025.5.15 bash"
ENV PATH=$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH
RUN mise use -g node@22 pnpm@10 bun@1 yarn@4

COPY ./packages/sandbox-container/dist/sandbox-server.cjs .
EXPOSE 8080
CMD ["node", "sandbox-server.cjs"]
