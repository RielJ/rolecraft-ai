# syntax=docker/dockerfile:1

# Hanapbuhay: one Bun process serving the API and the built SPA, with Debian's Chromium for PDF
# export (decision 47). Postgres runs as its own Compose service.

ARG BUN_IMAGE=oven/bun:1.4.3-debian

# ---- All dependencies, for the Vite build ----
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---- Build the SPA into dist/ ----
FROM deps AS build
COPY . .
RUN bun run build

# ---- Runtime dependencies only ----
FROM ${BUN_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- Runtime ----
FROM ${BUN_IMAGE} AS runtime
# Chromium renders PDFs. The fonts cover text the bundled Literata face does not (symbols, other scripts).
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-dejavu-core fonts-liberation fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*

# HB_HOST: inside the container the server must listen on all interfaces, or Docker's port
# publishing cannot reach it. Compose publishes the port on the host's loopback only.
ENV NODE_ENV=production \
    PORT=3000 \
    HB_HOST=0.0.0.0 \
    HB_CHROMIUM_PATH=/usr/bin/chromium \
    HB_STATIC_DIR=/app/dist \
    HB_DATA_DIR=/data

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
# The server runs from TypeScript source; tsconfig.json carries the @/ path alias Bun resolves.
COPY package.json tsconfig.json ./
COPY drizzle ./drizzle
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY src/domain ./src/domain
COPY --from=build /app/dist ./dist

# The AI key file lives in /data (mode 0600). The image's `bun` user owns it, never root.
RUN mkdir -p /data && chown bun:bun /data
USER bun

EXPOSE 3000
# main.ts runs the migrations, then listens.
CMD ["bun", "src/server/main.ts"]
