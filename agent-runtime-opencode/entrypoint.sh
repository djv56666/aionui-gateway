#!/bin/bash
# entrypoint.sh

set -e

# Log function
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Default configuration
export AGENT_ID=${AGENT_ID:-"default"}
export ACP_PORT=${ACP_PORT:-"25808"}
export WORK_DIR=${WORK_DIR:-"/workspace"}
export LOG_LEVEL=${LOG_LEVEL:-"info"}

# Ensure workspace directory exists
mkdir -p "$WORK_DIR"
log "Workspace: $WORK_DIR"
log "Agent ID: $AGENT_ID"
log "ACP Port: $ACP_PORT"

# Change to workspace directory
cd "$WORK_DIR"

# Start Sidecar (foreground, as PID 1)
# Sidecar will internally start opencode acp and ACP Bridge
log "Starting Agent Sidecar..."
exec node /opt/sidecar/index.js