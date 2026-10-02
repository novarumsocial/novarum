# build context is the repo root: docker build -f apps/anchor/Dockerfile .
ARG BUN_VERSION=1.3.9

FROM oven/bun:${BUN_VERSION}-slim

WORKDIR /app

# the lockfile is for the whole workspace, so every workspace manifest must be present for --frozen-lockfile
COPY package.json bun.lock ./
COPY apps/anchor/package.json apps/anchor/package.json
COPY apps/electron/package.json apps/electron/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/landing/package.json apps/landing/package.json
COPY apps/mobile/package.json apps/mobile/package.json

RUN bun install --frozen-lockfile --production --filter anchor

COPY apps/anchor/src apps/anchor/src
COPY apps/anchor/modules apps/anchor/modules
COPY apps/anchor/utils apps/anchor/utils
COPY apps/anchor/drizzle apps/anchor/drizzle

# the app lives in the workspace, but config and keys stay where they were before: /app/config.toml and /app/keys
RUN mkdir -p /app/keys && ln -s /app/keys /app/apps/anchor/keys
WORKDIR /app/apps/anchor
ENV NODE_ENV=production
ENV ANCHOR_CONFIG=/app/config.toml

CMD ["bun", "run", "src/index.ts"]

EXPOSE 5049
