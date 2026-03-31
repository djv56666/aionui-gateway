# agent-runtime/Dockerfile
FROM node:20-slim

# Install opencode CLI + curl for healthcheck (single layer)
RUN npm install -g opencode-ai \
    && apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user with home dir + workspace directory
RUN groupadd -r appuser && useradd -r -m -g appuser appuser \
    && mkdir -p /workspace && chown appuser:appuser /workspace

# Copy sidecar application, install deps, copy entrypoint — single layer
WORKDIR /opt/sidecar
COPY package.json index.js ./
COPY sidecar/ ./sidecar/
COPY entrypoint.sh /entrypoint.sh
RUN npm install --omit=dev \
    && chmod +x /entrypoint.sh \
    && chown -R appuser:appuser /opt/sidecar /entrypoint.sh

USER appuser

# Expose ports
# 3001: ACP Bridge (WebSocket, internal Docker network)
# 3000: Sidecar HTTP (health check, internal management)
EXPOSE 3001 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
