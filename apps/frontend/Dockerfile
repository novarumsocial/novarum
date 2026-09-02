# build
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
COPY apps/ apps/
RUN bun install
RUN bun run --filter frontend build

# serve
FROM caddy:2-alpine
WORKDIR /srv
COPY --from=build /app/apps/frontend/build ./build
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
