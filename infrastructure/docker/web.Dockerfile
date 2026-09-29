FROM node:24.19.0-bookworm-slim AS builder
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/web apps/web
RUN pnpm install --frozen-lockfile --filter @dc-geomap/web...
RUN pnpm --filter @dc-geomap/web build

FROM caddy:2.11.4-alpine
COPY infrastructure/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /workspace/apps/web/dist /srv
EXPOSE 80 443
