#!/bin/bash

docker build --build-arg='NODE_EXTRA_CA_CERTS='/etc/ssl/certs/Cloudflare_CA.pem'' --tag autofix-container:dev -f ./src/container-server/Dockerfile ../../ && docker run --rm -p 8080:8080 -it autofix-container:dev
