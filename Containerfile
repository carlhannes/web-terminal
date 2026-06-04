# Builds ONE image that serves both roles (build once, run twice):
#   - App  (default CMD): node .output/server/index.mjs   — Nitro server, honors PORT (default 3000)
#   - Gateway (override CMD): npm run gateway:start        — ssh2+tmux WS gateway, honors GATEWAY_PORT (default 8081)
# Podman: `podman build -t webterm .`  (Containerfile is Podman's native name; docker build works too)

# ---- builder ----
FROM docker.io/library/node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM docker.io/library/node:22-slim AS runtime
WORKDIR /app
# App server output is self-contained; the gateway role additionally needs node_modules
# (ssh2/ws/zod) + tsx + the server/ sources.
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/server ./server
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json

# NOTE: NODE_ENV is intentionally NOT set here. The gateway requires SSH_KNOWN_HOSTS when
# NODE_ENV=production (host-key pinning), so set NODE_ENV=production + SSH_KNOWN_HOSTS at
# run time (e.g. deploy/service.env / an EnvironmentFile) for the gateway in production.
EXPOSE 3000 8081

# Default role = app. The gateway container overrides this with: npm run gateway:start
CMD ["node", ".output/server/index.mjs"]
