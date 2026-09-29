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
USER node
WORKDIR /app
COPY --from=builder --chown=node:node /out ./
EXPOSE 8080
CMD ["node", "dist/server.js"]
