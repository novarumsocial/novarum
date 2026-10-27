# build
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* tsconfig.json ./
# manifests first so the install layer is cached
COPY apps/anchor/package.json apps/anchor/package.json
COPY apps/electron/package.json apps/electron/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/landing/package.json apps/landing/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/native/package.json apps/native/package.json
RUN bun install --frozen-lockfile --filter frontend
# frontend imports the anchor App type
COPY apps/anchor/src apps/anchor/src
COPY apps/anchor/modules apps/anchor/modules
COPY apps/anchor/utils apps/anchor/utils
COPY apps/frontend apps/frontend
RUN bun run --filter frontend prepare
RUN bun run --filter frontend build

# serve
FROM caddy:2-alpine
WORKDIR /srv
COPY --from=build /app/apps/frontend/build ./build
COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
