# Build deps for node-pty native fallback (prebuilds usually suffice)
FROM node:24-slim

# Pin the Kilo CLI version so container image builds don't drift from the
# host CLI (override with --build-arg KILO_VERSION=x.y.z if needed).
ARG KILO_VERSION=7.4.3

WORKDIR /app

# System deps: node-pty may need to compile; git helps kilo in some setups
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install app dependencies first (better layer caching)
COPY package.json ./
RUN npm install

# Install the Kilo CLI globally so `kilo` is available to spawn inside the
# container. Pinned to avoid version drift between rebuilds.
RUN npm install -g @kilocode/cli@${KILO_VERSION}

# Copy the app source
COPY . .

# Config + data live here (mount a volume so layout survives restarts)
ENV KILOTON_PORT=7655
ENV KILOTON_CONFIG=/data/config.json
VOLUME ["/data", "/workspace"]

EXPOSE 7655

CMD ["node", "server.js"]
