# ViaRoute API — build from the repo root:
#   docker build -f apps/api/Dockerfile -t viaroute-api .

FROM node:22-alpine AS base
RUN corepack enable && apk add --no-cache openssl
WORKDIR /repo

# --- Install dependencies (cached unless lockfile/manifests change) ---
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile --filter @viaroute/api... --filter @viaroute/db

# --- Build ---
FROM deps AS build
COPY packages/db packages/db
COPY apps/api apps/api
RUN pnpm --filter @viaroute/db build && pnpm --filter @viaroute/api build
# Production-only node_modules for the runtime image
RUN pnpm deploy --filter @viaroute/api --prod --legacy /out && \
    cp -r apps/api/dist /out/dist && \
    cp -r packages/db/prisma /out/prisma && \
    cd /out && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma

# --- Runtime ---
FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl tini && addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=app:app /out ./
RUN mkdir -p /app/storage /app/secrets && chown app:app /app/storage /app/secrets
ENV STORAGE_DIR=/app/storage
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:4000/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# Apply pending database migrations, then start.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma && node dist/main.js"]
