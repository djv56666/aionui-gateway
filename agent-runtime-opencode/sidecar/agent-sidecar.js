/**
 * Agent Sidecar
 *
 * Main orchestrator that manages:
 * - ACP Bridge (which owns opencode acp process + WebSocket server)
 * - Health checks and heartbeat
 * - Communication with Gateway
 */

import { AcpBridge } from './acp-bridge.js';

export class AgentSidecar {
  constructor(config) {
    this.config = config;
    this.acpBridge = null;
    this.isRunning = false;
    this.heartbeatTimer = null;
  }

  async start() {
    console.log('[sidecar] Starting Agent Sidecar...');

    // Start ACP Bridge (manages opencode acp + WebSocket server)
    this.acpBridge = new AcpBridge({
      acpPort: this.config.acpPort,
      workDir: this.config.workDir,
      jwtSecret: this.config.jwtSecret,
    });
    await this.acpBridge.start();

    // Start heartbeat to gateway
    this.startHeartbeat();

    this.isRunning = true;
    console.log('[sidecar] Agent Sidecar started successfully');
  }

  async stop() {
    console.log('[sidecar] Stopping Agent Sidecar...');

    this.isRunning = false;

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Stop ACP Bridge (which stops opencode)
    if (this.acpBridge) {
      await this.acpBridge.stop();
      this.acpBridge = null;
    }

    console.log('[sidecar] Agent Sidecar stopped');
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.sendHeartbeat();
      } catch (err) {
        console.error('[sidecar] Failed to send heartbeat:', err);
      }
    }, this.config.heartbeatInterval);
  }

  async sendHeartbeat() {
    const status = await this.checkHealth();
    const metrics = await this.collectMetrics();

    const payload = {
      agentId: this.config.agentId,
      timestamp: Date.now(),
      status,
      metrics,
    };

    try {
      const response = await fetch(`${this.config.gatewayUrl}/api/internal/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.gatewaySecret}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Heartbeat failed: ${response.status}`);
      }
    } catch (err) {
      console.error('[sidecar] Heartbeat error:', err);
      throw err;
    }
  }

  async checkHealth() {
    if (!this.isRunning) return 'unhealthy';

    try {
      // Check ACP Bridge (which manages opencode)
      if (!this.acpBridge) {
        return 'error';
      }

      return 'healthy';
    } catch (err) {
      console.error('[sidecar] Health check error:', err);
      return 'error';
    }
  }

  async collectMetrics() {
    return {
      cpu: 0,
      memory: 0,
      requests: 0,
      uptime: process.uptime(),
    };
  }
}