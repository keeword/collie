# The public-host lead: a collie with no multiplexer, and the uplink door.
# Build context is the repo root (deploy/uplink/compose.yml sets it).
FROM oven/bun:1.4.3
WORKDIR /opt/collie

COPY . .
RUN bun install --frozen-lockfile \
 && cd web && bun install --frozen-lockfile && bun run build \
 && mkdir -p /var/lib/collie

ENV COLLIE_STATE_DIR=/var/lib/collie \
    COLLIE_MUX=none \
    COLLIE_HOST=0.0.0.0 \
    COLLIE_PORT=8787 \
    COLLIE_ALLOW_NON_LOOPBACK_BIND=1 \
    COLLIE_SKIP_SERVE=1 \
    COLLIE_CREW_UPLINK_HOST=0.0.0.0 \
    COLLIE_CREW_UPLINK_PORT=8791

VOLUME /var/lib/collie
EXPOSE 8787 8791
CMD ["bun", "bridge/index.ts"]
