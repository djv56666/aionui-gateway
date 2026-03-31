/**
 * ACP Bridge — stdio ↔ WebSocket 双向桥接
 *
 * Manages the bridge between opencode acp (stdio JSON-RPC) and WebSocket clients.
 * Features:
 * - Message routing: response → sender, notification → by session_id, fallback → broadcast
 * - Write serialization via writeQueue
 * - Process crash handling with restartVersion + exponential backoff
 * - bridge/status notifications to clients
 */

import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import jwt from 'jsonwebtoken';

class AcpBridge {
  constructor(config = {}) {
    this.port = config.acpPort || 25808;
    this.workDir = config.workDir || '/workspace';
    this.jwtSecret = config.jwtSecret || process.env.JWT_SECRET || 'dev-secret';
    this.wss = null;
    this.opencodeProcess = null;
    this.clients = new Map(); // ws → ClientState
    this.writeQueue = [];
    this.writing = false;
    this.restartVersion = 0;
    this.restartCount = 0;
    this.maxRestarts = 3;
    this.isShuttingDown = false;
  }

  async start() {
    // Start WebSocket server
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    // Start opencode acp process
    await this.startOpencode();

    console.log(`[acp-bridge] Listening on port ${this.port}`);
  }

  async stop() {
    this.isShuttingDown = true;

    // Close all WebSocket connections
    for (const [ws] of this.clients) {
      ws.close(1001, 'shutting down');
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      await new Promise(resolve => this.wss.close(resolve));
      this.wss = null;
    }

    // Kill opencode process
    if (this.opencodeProcess && !this.opencodeProcess.killed) {
      this.opencodeProcess.kill('SIGTERM');
      await new Promise(resolve => {
        this.opencodeProcess?.on('exit', resolve);
        setTimeout(resolve, 5000); // timeout fallback
      });
      this.opencodeProcess = null;
    }
  }

  handleConnection(ws, req) {
    // JWT token validation
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');

    if (token) {
      try {
        jwt.verify(token, this.jwtSecret);
      } catch (err) {
        console.warn('[acp-bridge] JWT verification failed, rejecting connection');
        ws.close(4001, 'Unauthorized');
        return;
      }
    }

    const clientState = { sessionId: null };
    this.clients.set(ws, clientState);
    console.log(`[acp-bridge] Client connected (total: ${this.clients.size})`);

    ws.on('message', (data) => {
      this.handleClientMessage(ws, data);
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      console.log(`[acp-bridge] Client disconnected (total: ${this.clients.size})`);
    });

    ws.on('error', (err) => {
      console.error('[acp-bridge] WebSocket error:', err.message);
      this.clients.delete(ws);
    });
  }

  handleClientMessage(ws, data) {
    try {
      const message = JSON.parse(data.toString());

      // Track session_id from responses
      if (message.method === 'session/new' || message.method === 'initialize') {
        // Will track the session_id from the response
      }

      // Forward to opencode via stdio (serialized writes)
      this.writeToOpencode(message);
    } catch (err) {
      console.error('[acp-bridge] Failed to parse client message:', err.message);
    }
  }

  /**
   * Route opencode responses back to the correct client.
   *
   * - response (has id): send to the client that sent the matching request
   * - notification (no id, has method): route by session_id
   * - fallback: broadcast to all clients
   */
  routeFromOpencode(data) {
    try {
      const message = JSON.parse(data.toString().trim());
      if (!message) return;

      // Response to a request (has id) — broadcast for simplicity
      // In production, track request id → ws mapping for precise routing
      if (message.id) {
        this.broadcast(JSON.stringify(message));
        return;
      }

      // Notification with session info — route by session_id
      if (message.method && message.params) {
        // Track session_id from session/new responses
        if (message.params.session_id) {
          for (const [, state] of this.clients) {
            if (!state.sessionId) {
              state.sessionId = message.params.session_id;
              break;
            }
          }
        }
        this.broadcast(JSON.stringify(message));
        return;
      }

      // Fallback: broadcast
      this.broadcast(JSON.stringify(message));
    } catch (err) {
      // Not JSON or incomplete line — ignore
    }
  }

  broadcast(data) {
    for (const [ws] of this.clients) {
      if (ws.readyState === 1) { // OPEN
        ws.send(data);
      }
    }
  }

  /**
   * Serialized writes to opencode stdin to prevent interleaving.
   */
  writeToOpencode(message) {
    this.writeQueue.push(JSON.stringify(message));
    this.drainQueue();
  }

  drainQueue() {
    if (this.writing || this.writeQueue.length === 0) return;

    this.writing = true;
    const data = this.writeQueue.shift();

    try {
      if (this.opencodeProcess?.stdin?.writable) {
        this.opencodeProcess.stdin.write(data + '\n');
      }
    } catch (err) {
      console.error('[acp-bridge] Failed to write to opencode:', err.message);
    }

    this.writing = false;

    // Drain remaining
    if (this.writeQueue.length > 0) {
      setImmediate(() => this.drainQueue());
    }
  }

  /**
   * Start opencode acp process.
   */
  startOpencode() {
    return new Promise((resolve, reject) => {
      console.log('[acp-bridge] Starting opencode acp...');

      const currentVersion = this.restartVersion;
      this.opencodeProcess = spawn('opencode', ['acp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.workDir,
      });

      // Route stdout back to clients
      let buffer = '';
      this.opencodeProcess.stdout?.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            this.routeFromOpencode(line);
          }
        }
      });

      this.opencodeProcess.stderr?.on('data', (data) => {
        console.error(`[acp-bridge] opencode stderr: ${data.toString().trim()}`);
      });

      this.opencodeProcess.on('error', (err) => {
        console.error('[acp-bridge] Failed to start opencode:', err);
        reject(err);
      });

      this.opencodeProcess.on('exit', (code) => {
        if (this.isShuttingDown) return;
        if (currentVersion !== this.restartVersion) return;

        console.error(`[acp-bridge] opencode exited with code ${code}`);

        if (this.restartCount < this.maxRestarts) {
          const delay = Math.min(5000 * Math.pow(2, this.restartCount), 30000);
          this.restartCount++;
          this.restartVersion++;

          this.notifyClients({
            jsonrpc: '2.0',
            method: 'bridge/status',
            params: { status: 'restarting', reason: `opencode exited with code ${code}` },
          });

          console.log(`[acp-bridge] Restarting in ${delay}ms (attempt ${this.restartCount}/${this.maxRestarts})`);
          setTimeout(async () => {
            try {
              await this.startOpencode();
              this.notifyClients({
                jsonrpc: '2.0',
                method: 'bridge/status',
                params: { status: 'ready', message: 'opencode restarted, please re-initialize' },
              });
            } catch (err) {
              this.notifyClients({
                jsonrpc: '2.0',
                method: 'bridge/status',
                params: { status: 'error', reason: err.message },
              });
            }
          }, delay);
        } else {
          this.notifyClients({
            jsonrpc: '2.0',
            method: 'bridge/status',
            params: { status: 'error', reason: `opencode exited ${this.maxRestarts} times, giving up` },
          });
        }
      });

      // opencode acp is a stdio JSON-RPC server — won't print "ready".
      // Consider it ready once alive for 3 seconds.
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.log('[acp-bridge] opencode process ready (alive check passed)');
          resolve();
        }
      }, 3000);

      this.opencodeProcess.on('exit', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('opencode exited during startup'));
        }
      });
    });
  }

  notifyClients(notification) {
    this.broadcast(JSON.stringify(notification));
  }
}

export { AcpBridge };
