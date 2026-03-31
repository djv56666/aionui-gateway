/**
 * Agent Sidecar Main Entry Point
 *
 * Responsibilities:
 * - Start opencode acp process
 * - Run ACP Bridge (stdio ↔ WebSocket)
 * - Handle health checks
 * - Report status to Gateway
 */

import { AgentSidecar } from './sidecar/agent-sidecar.js';

const config = {
  agentId: process.env.AGENT_ID || 'default',
  acpPort: parseInt(process.env.ACP_PORT || '25808'),
  workDir: process.env.WORK_DIR || '/workspace',
  logLevel: process.env.LOG_LEVEL || 'info',
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30000'),
  gatewayUrl: process.env.GATEWAY_URL || 'http://gateway:3000',
  gatewaySecret: process.env.GATEWAY_SECRET || '',
};

const sidecar = new AgentSidecar(config);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[sidecar] Received SIGTERM, shutting down gracefully...');
  await sidecar.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[sidecar] Received SIGINT, shutting down gracefully...');
  await sidecar.stop();
  process.exit(0);
});

// Start the sidecar
console.log('[sidecar] Starting Agent Sidecar...');
sidecar.start().catch(err => {
  console.error('[sidecar] Failed to start:', err);
  process.exit(1);
});