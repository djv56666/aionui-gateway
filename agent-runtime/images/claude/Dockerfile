# agent-runtime: claude
# ACP-compatible runtime using Claude Code CLI
FROM node:20-slim

# Use China mirrors for faster downloads
RUN npm config set registry https://registry.npmmirror.com \
    && sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
    && (grep -q 'mirrors.aliyun.com' /etc/apt/sources.list 2>/dev/null || sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true)

# Install Claude Code CLI + ACP Bridge package + curl for healthcheck
RUN npm install -g @anthropic-ai/claude-code @zed-industries/claude-agent-acp \
    && apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user with home dir + workspace directory
RUN groupadd -r appuser && useradd -r -m -g appuser appuser \
    && mkdir -p /workspace && chown appuser:appuser /workspace

# Copy sidecar application, install deps, copy entrypoint
WORKDIR /opt/sidecar
COPY package.json index.js ./
COPY sidecar/ ./sidecar/
COPY entrypoint.sh /entrypoint.sh
RUN npm install --omit=dev \
    && sed -i 's/\r$//' /entrypoint.sh \
    && chmod +x /entrypoint.sh \
    && chown -R appuser:appuser /opt/sidecar /entrypoint.sh

USER appuser

# Runtime configuration — claude-agent-acp wraps Claude Code into ACP stdio JSON-RPC
ENV RUNTIME_CLI=claude-agent-acp
ENV RUNTIME_ARGS=

EXPOSE 3001 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
