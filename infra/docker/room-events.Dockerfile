# ═══════════════════════════════════════════════════════════════════════════
# room-events.Dockerfile — the real-time fan-out hub (SignalR-gateway role).
#
# Pure broadcast layer: owns sockets, owns nothing else. Round state lives in
# the system of record; clients recover via REST snapshots (UC-05), never from
# this process. Horizontally scalable behind the blue-green rotation.
# ═══════════════════════════════════════════════════════════════════════════

FROM oven/bun:1.1-alpine AS deps
WORKDIR /svc
COPY mini-services/room-events/package.json mini-services/room-events/bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.1-alpine AS run
WORKDIR /svc
ENV NODE_ENV=production
COPY --from=deps /svc/node_modules ./node_modules
COPY mini-services/room-events/index.ts ./
USER 10001
EXPOSE 3003
HEALTHCHECK --interval=10s --timeout=5s --retries=12 \
  CMD wget -q -O - http://localhost:3003/healthz || exit 1
ENTRYPOINT ["bun", "index.ts"]
