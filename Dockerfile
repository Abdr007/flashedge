# ─── Flash Terminal Docker Image ───────────────────────────────────────────────
# Production-grade Solana perpetual futures trading CLI
#
# Build:  docker build -t bolt-terminal .
# Run:    docker run -it --env-file .env bolt-terminal
# ───────────────────────────────────────────────────────────────────────────────

FROM node:lts-slim AS builder

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/

# Generate build info (git not available in Docker — use fallback)
RUN echo '{"version":"1.0.0","gitHash":"docker","branch":"main","buildDate":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' > src/build-info.json
RUN npx tsc && chmod +x dist/index.js

# ─── Production image ─────────────────────────────────────────────────────────

FROM node:lts-slim

WORKDIR /app

# Create non-root user for security
RUN groupadd -r flash && useradd -r -g flash -m flash

# Copy built artifacts and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create config directory
RUN mkdir -p /home/flash/.flash && chown -R flash:flash /home/flash/.flash

USER flash

# Default to simulation mode for safety
ENV SIMULATION_MODE=true
ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/index.js"]
