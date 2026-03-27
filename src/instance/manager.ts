/**
 * Instance Manager — spawns, tracks and recycles AionUi server instances.
 *
 * Each user gets a dedicated child process running dist-server/server.mjs
 * with its own PORT and DATA_DIR.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { config } from '../config/index.js';
import {
  getAllocatedPorts,
  getInstanceByUserId,
  getRunningInstances,
  upsertInstance,
  updateInstanceStatus,
  updateInstanceActivity,
} from '../database/index.js';
import type { UserInstance } from '../types/index.js';

// In-memory child process references (DB stores metadata, this holds the live handle)
const processes = new Map<string, ChildProcess>();

// In-memory AionUi session tokens (obtained via gateway-login)
const instanceTokens = new Map<string, string>();

// ─── Port allocation ──────────────────────────────────

function allocatePort(): number {
  const allocated = getAllocatedPorts();
  for (let port = config.instancePortStart; port <= config.instancePortEnd; port++) {
    if (!allocated.has(port)) return port;
  }
  throw new Error('No available ports in the configured range');
}

// ─── Health check ─────────────────────────────────────

function waitForReady(port: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const check = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Instance on port ${port} did not become ready within ${timeoutMs}ms`));
        return;
      }

      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve();
      });

      socket.on('error', () => {
        socket.destroy();
        setTimeout(check, 500);
      });
    };

    check();
  });
}

// ─── Spawn ────────────────────────────────────────────

export async function ensureInstance(userId: string, username?: string): Promise<number> {
  // 1. Check if already running (in-memory process still alive)
  const existing = getInstanceByUserId(userId);
  if (existing && existing.status === 'running' && processes.has(userId)) {
    updateInstanceActivity(userId);
    return existing.port;
  }

  // 2. If DB says running but process is dead, clean up
  if (existing && processes.has(userId)) {
    const proc = processes.get(userId)!;
    if (proc.exitCode !== null || proc.killed) {
      processes.delete(userId);
      updateInstanceStatus(userId, 'stopped');
    } else {
      // Process exists and didn't exit — it's alive
      updateInstanceStatus(userId, 'running');
      updateInstanceActivity(userId);
      return existing.port;
    }
  }

  // 3. Spawn new instance
  const port = existing?.port || allocatePort();
  const dataDir = path.join(config.instanceDataRoot, userId);

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  console.log(`[instance] Spawning AionUi for user ${userId} on port ${port}, data: ${dataDir}`);

  const runtime = config.instanceRuntime;
  const args = runtime.endsWith('bun') ? ['run', config.aionuiServerEntry] : [config.aionuiServerEntry];

  // cwd must be the AionUi project root so getAppPath() (= process.cwd())
  // can locate out/renderer/index.html for serving static assets.
  const aionuiRoot = path.dirname(path.dirname(config.aionuiServerEntry));

  const child = spawn(runtime, args, {
    cwd: aionuiRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ALLOW_REMOTE: 'false',
      NODE_ENV: 'production',
      GATEWAY_SECRET: config.gatewaySecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Pipe child stdout/stderr with prefix
  const prefix = `[user:${userId.substring(0, 8)}]`;
  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd().split('\n');
    for (const line of lines) {
      console.log(`${prefix} ${line}`);
    }
  });
  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trimEnd().split('\n');
    for (const line of lines) {
      console.error(`${prefix} ${line}`);
    }
  });

  const now = Date.now();
  const instance: UserInstance = {
    userId,
    port,
    pid: child.pid || 0,
    status: 'starting',
    lastActive: now,
    startedAt: now,
  };

  processes.set(userId, child);
  upsertInstance(instance);

  // Handle unexpected exit
  child.on('exit', (code, signal) => {
    console.log(`[instance] User ${userId} instance exited: code=${code}, signal=${signal}`);
    processes.delete(userId);
    updateInstanceStatus(userId, 'stopped');
  });

  // Wait for the server to accept connections
  try {
    await waitForReady(port);
    updateInstanceStatus(userId, 'running');
    console.log(`[instance] User ${userId} instance ready on port ${port}`);

    if (username && config.gatewaySecret) {
      try {
        const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/gateway-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gatewaySecret: config.gatewaySecret, username }),
        });
        if (loginRes.ok) {
          const loginData = (await loginRes.json()) as { success: boolean; token?: string };
          if (loginData.success && loginData.token) {
            instanceTokens.set(userId, loginData.token);
            console.log(`[instance] Gateway login succeeded for user ${userId}`);
          }
        }
      } catch (err) {
        console.error(`[instance] Gateway login failed for user ${userId}:`, err);
      }
    }
  } catch (err) {
    console.error(`[instance] User ${userId} instance failed to start:`, err);
    killInstance(userId);
    throw err;
  }

  return port;
}

// ─── Kill ─────────────────────────────────────────────

export function killInstance(userId: string): void {
  const proc = processes.get(userId);
  if (proc && proc.exitCode === null && !proc.killed) {
    console.log(`[instance] Killing instance for user ${userId}`);
    proc.kill('SIGTERM');

    // Force kill after 5 seconds
    setTimeout(() => {
      if (!proc.killed && proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    }, 5000).unref();
  }

  processes.delete(userId);
  updateInstanceStatus(userId, 'stopped');
}

// ─── Idle reaper ──────────────────────────────────────

let reaperTimer: ReturnType<typeof setInterval> | null = null;

export function startIdleReaper(): void {
  if (reaperTimer) return;

  reaperTimer = setInterval(() => {
    const now = Date.now();
    const running = getRunningInstances();

    for (const instance of running) {
      const idle = now - instance.lastActive;
      if (idle > config.instanceIdleTimeout) {
        console.log(
          `[reaper] Recycling idle instance for user ${instance.userId} (idle ${Math.round(idle / 1000)}s)`,
        );
        killInstance(instance.userId);
      }
    }
  }, 60_000); // Check every minute

  reaperTimer.unref();
  console.log(
    `[reaper] Idle reaper started (timeout: ${config.instanceIdleTimeout / 1000}s)`,
  );
}

export function stopIdleReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

// ─── Touch (update activity) ──────────────────────────

export function touchInstance(userId: string): void {
  if (processes.has(userId)) {
    updateInstanceActivity(userId);
  }
}

// ─── Get instance token (for cookie injection) ────────

export function getInstanceToken(userId: string): string | null {
  return instanceTokens.get(userId) || null;
}

// ─── Shutdown all ─────────────────────────────────────

export function shutdownAll(): void {
  stopIdleReaper();
  for (const userId of processes.keys()) {
    killInstance(userId);
  }
  instanceTokens.clear();
}
