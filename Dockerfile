# ── Build: compile TypeScript ──────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=optional
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Deps: clean production-only install (no devDeps, no optional) ──────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional

# ── Runtime ────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app
WORKDIR /app
ENV NODE_ENV=production PORT=4000
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=deps    --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/health || exit 1
ENTRYPOINT ["node", "dist/server.js"]