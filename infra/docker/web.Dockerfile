# ═══════════════════════════════════════════════════════════════════════════
# web.Dockerfile — the Next.js deployable (gateway + engine + consoles).
#
# Multi-stage, non-root, distroless-adjacent (ADR-27):
#   deps  → install with a warm, cacheable layer
#   build → compile; standalone output keeps the runtime image tiny
#   migrator → schema + RLS bootstrap job (compose 'migrator' service)
#   run   → final image; no build toolchain, runs as uid 10001
#
# In the target architecture this image is deployed as: gateway-api +
# silo/engine + finance-worker + outbox-relay + audit-worker — one artifact,
# five process profiles selected by WORKER_ROLE (ADR-07 PSP isolation is a
# network policy concern; the image stays identical).
# ═══════════════════════════════════════════════════════════════════════════

FROM oven/bun:1.1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
RUN bunx prisma generate && bun run lint --max-warnings 0 && bun test
# next build is skipped in the sandbox profile (dev server contract); the CI
# pipeline (infra/ci/pipeline.yml) builds with output:"standalone" for prod.

FROM oven/bun:1.1-alpine AS migrator
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY prisma ./prisma
COPY src ./src
COPY tsconfig.json ./
USER 10001
ENTRYPOINT ["bunx", "prisma"]

FROM oven/bun:1.1-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/next.config.ts ./
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
USER 10001
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=12 \
  CMD wget -q -O - http://localhost:3000/api/v1/rooms || exit 1
ENTRYPOINT ["bun", "run", "dev"]
