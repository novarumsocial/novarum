ARG BUN_VERSION=1.3.9

FROM oven/bun:${BUN_VERSION} AS deps

WORKDIR /app

COPY apps/anchor/package.json ./package.json

RUN bun install --no-save --production

FROM gcr.io/distroless/base AS runtime

WORKDIR /app

COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY apps/anchor/package.json ./apps/anchor/package.json
COPY apps/anchor/docker-entrypoint.ts ./apps/anchor/docker-entrypoint.ts

COPY apps/anchor/src ./apps/anchor/src
COPY apps/anchor/modules ./apps/anchor/modules
COPY apps/anchor/utils ./apps/anchor/utils
COPY apps/anchor/prisma-next.config.ts ./apps/anchor/prisma-next.config.ts
COPY apps/anchor/prisma ./apps/anchor/prisma
COPY apps/anchor/migrations ./apps/anchor/migrations

ENV NODE_ENV=production \
    PRISMA_NEXT_DISABLE_TELEMETRY=1 \
    DO_NOT_TRACK=1

WORKDIR /app/apps/anchor

CMD ["/usr/local/bin/bun", "docker-entrypoint.ts"]

EXPOSE 5049
