FROM node:24.19.0-bookworm-slim AS builder
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /workspace
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/api apps/api
RUN pnpm install --frozen-lockfile --filter @dc-geomap/api...
RUN pnpm --filter @dc-geomap/api build && pnpm --filter @dc-geomap/api deploy --prod --legacy /out

FROM node:24.19.0-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder --chown=node:node /out ./
COPY --chmod=0755 infrastructure/docker/api-entrypoint.sh /usr/local/bin/dcgeomap-api-entrypoint
EXPOSE 8080
ENTRYPOINT ["dcgeomap-api-entrypoint"]
CMD ["node", "dist/server.js"]
