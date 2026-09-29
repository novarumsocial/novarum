# build
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* tsconfig.json ./
COPY apps/ apps/
RUN bun install
RUN bun run --filter frontend prepare
RUN bun run --filter frontend build

# serve
FROM caddy:2-alpine
WORKDIR /srv
COPY --from=build /app/apps/frontend/build ./build
COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
