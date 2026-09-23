# Dockerfile

# ── Stage 1: Builder ────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.js ./

# Install all dependencies including devDependencies
RUN npm ci --legacy-peer-deps

# Generate Prisma client
RUN npx prisma generate

# Copy source code
COPY . .

# Build the application
RUN npm run build

# ── Stage 2: Production ─────────────────────────────────────────────
FROM node:20-alpine AS production

WORKDIR /app

# Security: run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nestjs -u 1001 -G nodejs

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/
# Prisma's config file lives at the project root, not inside prisma/ — without
# it, `prisma migrate deploy` (run at boot when RUN_MIGRATIONS_ON_BOOT=true)
# cannot find DATABASE_URL and fails with a misleading "datasource.url is
# required" even though the env var is set correctly.
COPY prisma.config.js ./

# Install production dependencies only (--omit=dev replaces the deprecated --only=production)
RUN npm ci --omit=dev --legacy-peer-deps && \
    npx prisma generate && \
    npm cache clean --force

# Copy built application from builder stage.
# --chown here, NOT a trailing `chown -R /app`: recursive chown rewrites every
# file into a new layer, which duplicated the whole of node_modules in the image.
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/src/templates/locales ./src/templates/locales
COPY --chown=nestjs:nodejs docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

# node_modules and package files are created as root above; only the paths the
# app WRITES to need to belong to the non-root user (Prisma's generated client).
RUN chown -R nestjs:nodejs /app/node_modules/.prisma 2>/dev/null || true

USER nestjs

# Expose application port
EXPOSE 3000

# Health check. 127.0.0.1, NOT localhost: Alpine resolves localhost to ::1 first, the
# app listens on IPv4 only, and the check would fail on a perfectly healthy app.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ready || exit 1

# Start the application. entrypoint.sh conditionally runs `prisma migrate
# deploy` first (see docker/entrypoint.sh) when RUN_MIGRATIONS_ON_BOOT=true —
# for a host with no equivalent to Compose's one-shot `migrate` service.
CMD ["./docker/entrypoint.sh"]