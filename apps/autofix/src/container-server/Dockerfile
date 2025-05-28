# Use Alpine as base for minimal size
FROM ubuntu:24.04 AS base
ARG NODE_EXTRA_CA_CERTS=""

# Install necessary packages while minimizing layers
# We combine commands with && and clean cache in the same layer
# to reduce the image size

# Install warp certs as root if NODE_EXTRA_CA_CERTS is provided
COPY apps/autofix/src/container/install-scripts/install-cloudflare-warp-certs.sh /installation/
RUN /installation/install-cloudflare-warp-certs.sh
# Cleanup warp certs script after execution
RUN rm /installation/install-cloudflare-warp-certs.sh

RUN apt-get -y update && \
	apt-get install -y \
	# Core utilities
	git \
	curl \
	wget \
	# Build essentials
	build-essential \
	# Python and pip
	python3 && \
	# Create symlink for python
	ln -sf /usr/bin/python3 /usr/bin/python

ENV HOME=/root

# todo: add this script to the repo instead of piping curl to bash
RUN curl -fsSL https://sh.uuid.rocks/install/mise | MISE_VERSION=v2025.5.15 bash
ENV PATH=$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH

# Install common tools
RUN mise use -g node@22 pnpm@10 bun@1 yarn@4


# Set up pnpm environment
ENV PNPM_HOME=/usr/local/bin
ENV PATH=$PNPM_HOME:$PATH

# Set working directory
WORKDIR /app

# Set environment variables
ENV PATH="/app/node_modules/.bin:${PATH}"

###
# STAGE: PRUNE -  Generate a partial monorepo for the sandbox-container app. The output will be placed into a directory named "out"
###
FROM base AS prune
WORKDIR /app
RUN pnpm install turbo --global
COPY . .
RUN turbo prune @repo/autofix

###
# STAGE: INSTALL & RUN
###
FROM base AS installer
WORKDIR /app

COPY --from=prune /app/out/ .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
	pnpm install --frozen-lockfile --only=production --child-concurrency=10

WORKDIR /app/apps/autofix

RUN mkdir -p /work

# Ensure tools like pnpm are not interactive
ENV CI=1

# Expose the port your Node.js server will run on
EXPOSE 8080

CMD ["pnpm", "run", "start:container"]
