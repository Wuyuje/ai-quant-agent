# ═══════════════════════════════════════════
# MasterD Quant Agent — Production Dockerfile
# Multi-stage: build contracts + install deps → slim runtime
# ═══════════════════════════════════════════

# ── Stage 1: Build ──
FROM node:20-slim AS builder

WORKDIR /app

# Install build tools for native deps (secp256k1, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

# Copy package files first (better layer caching)
COPY package.json package-lock.json* ./

# Install all deps (including devDeps for build)
RUN npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

# Copy source
COPY . .

# ── Stage 2: Runtime ──
FROM node:20-slim AS runtime

LABEL maintainer="MasterD"
LABEL description="MasterD Quant Agent — AI-driven blockchain trading system"

WORKDIR /app

# Install runtime deps for native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy from builder
COPY --from=builder /app /app

# Install only production deps
RUN npm prune --production 2>/dev/null || true

# Create data directory
RUN mkdir -p /app/data /app/logs /app/coverage

# Environment defaults
ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV PORT=10000
ENV ML_SERVICE_URL=http://localhost:8100

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "const http=require('http');const r=http.get('http://localhost:'+(process.env.PORT||10000)+'/api/health',res=>{process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(3000,()=>process.exit(1))"

# Expose ports: dashboard(10000) + ML service(8100)
EXPOSE 10000 8100

# Start command (override in docker-compose)
CMD ["node", "index.js"]
