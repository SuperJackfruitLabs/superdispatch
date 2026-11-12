# SuperDispatch, built from the repository root: docker build -f apps/dispatch/Dockerfile .
FROM oven/bun:1.2.8-alpine
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/dispatch/package.json apps/dispatch/
RUN bun install --frozen-lockfile --production
COPY apps/dispatch/src apps/dispatch/src
# The store's directory (SUPERDISPATCH_DATA_DIR, /data by default), owned by the user the service
# runs as. A named volume mounted here takes this ownership when it is first created.
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV PORT=8796
EXPOSE 8796
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "apps/dispatch/src/main.ts"]
