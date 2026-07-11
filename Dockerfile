# syntax=docker/dockerfile:1

# Pin the Kilo CLI version so container image builds don't drift from the
# host CLI (override with --build-arg KILO_VERSION=x.y.z if needed).
ARG KILO_VERSION=7.4.5

# ---- Build stage: compile native modules (node-pty) ----
# node-pty ships prebuilds that usually suffice, but this stage carries the
# python3/make/g++ toolchain so a native compile always succeeds. The toolchain
# is dropped in the runtime stage so it never ships in the final image.
FROM node:22-slim AS build
ARG KILO_VERSION
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
# Drop dev-only packages (e.g. eslint) from the image; node-pty's prebuilt
# native binary and its optional deps are preserved.
RUN npm prune --omit=dev

# ---- Runtime stage: minimal, no build toolchain ----
FROM node:22-slim AS runtime
ARG KILO_VERSION
WORKDIR /app
# The Kilo CLI is pure JS, so installing it globally needs no native build here.
RUN npm install -g @kilocode/cli@${KILO_VERSION}
# Bring in the already-built node_modules (incl. the compiled node-pty binary,
# ABI-compatible with this same Node major) from the build stage.
COPY --from=build /app/node_modules ./node_modules
COPY . .

# Config + data live here (mount a volume so layout survives restarts)
ENV KILOTON_PORT=7655
ENV KILOTON_CONFIG=/data/config.json
VOLUME ["/data", "/workspace"]

EXPOSE 7655

CMD ["node", "server.js"]
