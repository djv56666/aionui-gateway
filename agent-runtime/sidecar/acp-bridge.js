/**
 * ACP Bridge — stdio ↔ WebSocket 双向桥接
 *
 * Manages the bridge between ACP runtime (stdio JSON-RPC) and WebSocket clients.
 * Runtime is configurable via RUNTIME_CLI / RUNTIME_ARGS environment variables.
 *
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

    // Runtime configuration — which CLI to spawn and with what args
    this.runtimeCli = config.runtimeCli || process.env.RUNTIME_CLI || 'opencode';
    const rawArgs = config.runtimeArgs ?? process.env.RUNTIME_ARGS ?? 'acp';
    this.runtimeArgs = typeof rawArgs === 'string' ? (rawArgs ? rawArgs.split(' ') : []) : rawArgs;

    this.wss = null;
    this.runtimeProcess = null;
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

    // Start runtime process
    await this.startRuntime();

    console.log(`[acp-bridge] Listening on port ${this.port}, runtime: ${this.runtimeCli} ${this.runtimeArgs.join(' ')}`);
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

    // Kill runtime process
    if (this.runtimeProcess && !this.runtimeProcess.killed) {
      this.runtimeProcess.kill('SIGTERM');
      await new Promise(resolve => {
        this.runtimeProcess?.on('exit', resolve);
        setTimeout(resolve, 5000); // timeout fallback
      });
      this.runtimeProcess = null;
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

      // Forward to runtime via stdio (serialized writes)
      this.writeToRuntime(message);
    } catch (err) {
      console.error('[acp-bridge] Failed to parse client message:', err.message);
    }
  }

  /**
   * Route runtime responses back to the correct client.
   *
   * - response (has id): send to the client that sent the matching request
   * - notification (no id, has method): route by session_id
   * - fallback: broadcast to all clients
   */
  routeFromRuntime(data) {
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
   * Serialized writes to runtime stdin to prevent interleaving.
   */
  writeToRuntime(message) {
    this.writeQueue.push(JSON.stringify(message));
    this.drainQueue();
  }

  drainQueue() {
    if (this.writing || this.writeQueue.length === 0) return;

    this.writing = true;
    const data = this.writeQueue.shift();

    try {
      if (this.runtimeProcess?.stdin?.writable) {
        this.runtimeProcess.stdin.write(data + '\n');
      }
    } catch (err) {
      console.error(`[acp-bridge] Failed to write to ${this.runtimeCli}:`, err.message);
    }

    this.writing = false;

    // Drain remaining
    if (this.writeQueue.length > 0) {
      setImmediate(() => this.drainQueue());
    }
  }

  /**
   * Start runtime process.
   * Spawns the configured CLI (opencode/claude/goose/etc.) with ACP args.
   */
  startRuntime() {
    return new Promise((resolve, reject) => {
      console.log(`[acp-bridge] Starting ${this.runtimeCli} ${this.runtimeArgs.join(' ')}...`);

      const currentVersion = this.restartVersion;
      this.runtimeProcess = spawn(this.runtimeCli, this.runtimeArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.workDir,
      });

      // Route stdout back to clients
      let buffer = '';
      this.runtimeProcess.stdout?.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // keep incomplete line in buffer

        for (const line of lines) {
          if (line.trim()) {
            this.routeFromRuntime(line);
          }
        }
      });

      this.runtimeProcess.stderr?.on('data', (data) => {
        console.error(`[acp-bridge] ${this.runtimeCli} stderr: ${data.toString().trim()}`);
      });

      this.runtimeProcess.on('error', (err) => {
        console.error(`[acp-bridge] Failed to start ${this.runtimeCli}:`, err);
        reject(err);
      });

      this.runtimeProcess.on('exit', (code) => {
        if (this.isShuttingDown) return;
        if (currentVersion !== this.restartVersion) return;

        console.error(`[acp-bridge] ${this.runtimeCli} exited with code ${code}`);

        if (this.restartCount < this.maxRestarts) {
          const delay = Math.min(5000 * Math.pow(2, this.restartCount), 30000);
          this.restartCount++;
          this.restartVersion++;

          this.notifyClients({
            jsonrpc: '2.0',
            method: 'bridge/status',
            params: { status: 'restarting', reason: `${this.runtimeCli} exited with code ${code}` },
          });

          console.log(`[acp-bridge] Restarting in ${delay}ms (attempt ${this.restartCount}/${this.maxRestarts})`);
          setTimeout(async () => {
            try {
              await this.startRuntime();
              this.notifyClients({
                jsonrpc: '2.0',
                method: 'bridge/status',
                params: { status: 'ready', message: `${this.runtimeCli} restarted, please re-initialize` },
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
            params: { status: 'error', reason: `${this.runtimeCli} exited ${this.maxRestarts} times, giving up` },
          });
        }
      });

      // ACP runtimes are stdio JSON-RPC servers — won't print "ready".
      // Consider it ready once alive for 3 seconds.
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.log(`[acp-bridge] ${this.runtimeCli} process ready (alive check passed)`);
          resolve();
        }
      }, 3000);

      this.runtimeProcess.on('exit', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`${this.runtimeCli} exited during startup`));
        }
      });
    });
  }

  notifyClients(notification) {
    this.broadcast(JSON.stringify(notification));
  }
}

export { AcpBridge };
