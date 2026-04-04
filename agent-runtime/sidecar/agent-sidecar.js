/**
 * Agent Sidecar
 *
 * Main orchestrator that manages runtime process lifecycle.
 * Supports two transport modes:
 *
 * - stdio:   Spawn CLI → bridge stdin/stdout ↔ WebSocket via ACP Bridge
 *            For ACP runtimes (opencode, claude, goose, codex)
 *
 * - gateway: Spawn gateway process → expose its native WebSocket port directly
 *            For runtimes with built-in server (OpenClaw)
 *
 * Also handles: health checks, heartbeat to Gateway, crash recovery.
 */

import { AcpBridge } from './acp-bridge.js';
import { spawn } from 'child_process';
import http from 'http';

export class AgentSidecar {
  constructor(config) {
    this.config = config;
    this.transport = config.transport || process.env.TRANSPORT_MODE || 'stdio';

    // stdio mode
    this.acpBridge = null;

    // gateway mode
    this.gatewayProcess = null;
    this.restartVersion = 0;
    this.restartCount = 0;
    this.maxRestarts = 3;
    this.isShuttingDown = false;

    // common
    this.isRunning = false;
    this.heartbeatTimer = null;
    this.healthServer = null;
  }

  async start() {
    console.log(`[sidecar] Starting Agent Sidecar (transport: ${this.transport})...`);

    if (this.transport === 'gateway') {
      await this.startGatewayMode();
    } else {
      await this.startStdioMode();
    }

    // Start heartbeat to gateway
    this.startHeartbeat();

    // Start health check HTTP server
    this.startHealthServer();

    this.isRunning = true;
    console.log('[sidecar] Agent Sidecar started successfully');
  }

  async stop() {
    console.log('[sidecar] Stopping Agent Sidecar...');
    this.isShuttingDown = true;
    this.isRunning = false;

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Stop health server
    if (this.healthServer) {
      this.healthServer.close();
      this.healthServer = null;
    }

    // Stop runtime
    if (this.transport === 'gateway') {
      await this.stopGatewayMode();
    } else {
      await this.stopStdioMode();
    }

    console.log('[sidecar] Agent Sidecar stopped');
  }

  // ─── stdio mode ─────────────────────────────────────────

  async startStdioMode() {
    this.acpBridge = new AcpBridge({
      acpPort: this.config.acpPort,
      workDir: this.config.workDir,
      jwtSecret: this.config.jwtSecret,
    });
    await this.acpBridge.start();
  }

  async stopStdioMode() {
    if (this.acpBridge) {
      await this.acpBridge.stop();
      this.acpBridge = null;
    }
  }

  // ─── gateway mode ───────────────────────────────────────

  async startGatewayMode() {
    const cli = this.config.runtimeCli || process.env.RUNTIME_CLI || 'openclaw';
    const args = (this.config.runtimeArgs || process.env.RUNTIME_ARGS || 'gateway').split(' ');
    const workDir = this.config.workDir || '/workspace';

    return new Promise((resolve, reject) => {
      console.log(`[sidecar] Starting gateway: ${cli} ${args.join(' ')}`);

      const currentVersion = this.restartVersion;
      this.gatewayProcess = spawn(cli, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workDir,
      });

      this.gatewayProcess.stdout?.on('data', (data) => {
        console.log(`[gateway] ${data.toString().trim()}`);
      });

      this.gatewayProcess.stderr?.on('data', (data) => {
        console.error(`[gateway] ${data.toString().trim()}`);
      });

      this.gatewayProcess.on('error', (err) => {
        console.error(`[sidecar] Failed to start gateway:`, err);
        reject(err);
      });

      this.gatewayProcess.on('exit', (code) => {
        if (this.isShuttingDown) return;
        if (currentVersion !== this.restartVersion) return;

        console.error(`[sidecar] Gateway exited with code ${code}`);
        this.handleGatewayCrash(code, currentVersion);
      });

      // Wait for gateway to settle (3s alive check)
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.log('[sidecar] Gateway process ready');
          resolve();
        }
      }, 3000);

      this.gatewayProcess.on('exit', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Gateway exited during startup'));
        }
      });
    });
  }

  async stopGatewayMode() {
    if (this.gatewayProcess && !this.gatewayProcess.killed) {
      this.gatewayProcess.kill('SIGTERM');
      await new Promise(resolve => {
        this.gatewayProcess?.on('exit', resolve);
        setTimeout(resolve, 5000);
      });
      this.gatewayProcess = null;
    }
  }

  handleGatewayCrash(code, currentVersion) {
    if (this.restartCount < this.maxRestarts) {
      const delay = Math.min(5000 * Math.pow(2, this.restartCount), 30000);
      this.restartCount++;
      this.restartVersion++;

      console.log(`[sidecar] Restarting gateway in ${delay}ms (attempt ${this.restartCount}/${this.maxRestarts})`);
      setTimeout(async () => {
        try {
          await this.startGatewayMode();
          console.log('[sidecar] Gateway restarted successfully');
        } catch (err) {
          console.error('[sidecar] Gateway restart failed:', err);
        }
      }, delay);
    } else {
      console.error(`[sidecar] Gateway exited ${this.maxRestarts} times, giving up`);
    }
  }

  // ─── health & heartbeat ─────────────────────────────────

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
      if (this.transport === 'gateway') {
        // Check gateway process is alive
        if (!this.gatewayProcess || this.gatewayProcess.killed) {
          return 'error';
        }
      } else {
        // Check ACP Bridge
        if (!this.acpBridge) {
          return 'error';
        }
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

  // ─── health HTTP server ─────────────────────────────────

  startHealthServer() {
    const port = parseInt(process.env.HEALTH_PORT || '3000');
    this.healthServer = http.createServer(async (req, res) => {
      if (req.url === '/health') {
        const status = await this.checkHealth();
        const code = status === 'healthy' ? 200 : 503;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status, agentId: this.config.agentId, uptime: process.uptime() }));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    this.healthServer.listen(port, () => {
      console.log(`[sidecar] Health check listening on :${port}/health`);
    });
  }
}
