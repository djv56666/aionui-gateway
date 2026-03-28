import { execSync, exec } from 'node:child_process';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
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

const CONTAINER_PREFIX = 'aionui-gw-';
const instanceTokens = new Map<string, string>();

/**
 * Per-user lock map to prevent concurrent ensureInstance() calls from racing.
 * When multiple requests arrive for the same user simultaneously, only the
 * first one actually creates/starts the container — the rest await the same
 * Promise and reuse the result.
 */
const ensureLocks = new Map<string, Promise<number>>();

/**
 * In-memory set of user IDs whose containers are confirmed running.
 * This avoids calling `docker inspect` (slow sync subprocess) on every
 * request. Populated when a container starts successfully; cleared on
 * stop/kill/reaper.
 */
const runningUsers = new Set<string>();

function containerName(userId: string): string {
  return `${CONTAINER_PREFIX}${userId.substring(0, 12)}`;
}

function docker(cmd: string, options?: { quiet?: boolean }): string {
  return execSync(`${config.dockerCmd} ${cmd}`, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', options?.quiet ? 'pipe' : 'inherit'],
  }).trim();
}

function dockerAsync(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`${config.dockerCmd} ${cmd}`, { encoding: 'utf8', timeout: 30_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

function isContainerRunning(name: string): boolean {
  try {
    const state = docker(`inspect --format '{{.State.Running}}' ${name}`);
    return state === 'true';
  } catch {
    return false;
  }
}

function allocatePort(): number {
  const allocated = getAllocatedPorts();
  for (let port = config.instancePortStart; port <= config.instancePortEnd; port++) {
    if (!allocated.has(port)) return port;
  }
  throw new Error('No available ports in the configured range');
}

/**
 * Wait until the container's HTTP service is fully ready.
 *
 * TCP port open ≠ service ready — the application may still be initializing
 * routes / DB after binding the port. So we probe an actual HTTP endpoint
 * instead of just checking TCP connectivity.
 *
 * Strategy: try multiple health-check paths that AionUI might expose,
 * and also accept any non-connection-error response (even 404) as a sign
 * the HTTP server is up and routing requests.
 */
function waitForReady(port: number, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Container on port ${port} did not become ready within ${timeoutMs}ms`));
        return;
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(3000),
        });
        // Any HTTP response (even 404) means the server is up and routing
        if (res.status < 500) {
          resolve();
          return;
        }
      } catch {
        // Connection refused / timeout — service not ready yet
      }
      setTimeout(check, 1000);
    };
    check();
  });
}

function ensureDockerAvailable(): void {
  try {
    docker('version');
  } catch {
    throw new Error(`${config.dockerCmd} is not available. Please ensure ${config.dockerCmd} is installed and running.`);
  }
}

export async function ensureInstance(userId: string, username?: string): Promise<number> {
  // If there's already a pending ensure for this user, piggyback on it.
  const pending = ensureLocks.get(userId);
  if (pending) return pending;

  const promise = ensureInstanceInner(userId, username).finally(() => {
    ensureLocks.delete(userId);
  });

  ensureLocks.set(userId, promise);
  return promise;
}

async function ensureInstanceInner(userId: string, username?: string): Promise<number> {
  const existing = getInstanceByUserId(userId);
  const name = containerName(userId);

  // Fast path: if in-memory cache says running, trust it (avoids slow docker inspect).
  // Fall back to docker inspect only when the cache entry is missing (e.g. process restarted).
  if (existing && existing.status === 'running') {
    if (runningUsers.has(userId) || isContainerRunning(name)) {
      updateInstanceActivity(userId);
      runningUsers.add(userId);

      // If gateway process restarted but container is still alive, the in-memory
      // token map is empty. Re-authenticate so the proxy can inject the token.
      if (!instanceTokens.has(userId) && username && config.gatewaySecret) {
        try {
          const loginRes = await fetch(`http://127.0.0.1:${existing.port}/api/auth/gateway-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gatewaySecret: config.gatewaySecret, username }),
          });
          if (loginRes.ok) {
            const loginData = (await loginRes.json()) as { success: boolean; token?: string };
            if (loginData.success && loginData.token) {
              instanceTokens.set(userId, loginData.token);
              console.log(`[instance] Re-authenticated gateway login for user ${userId}`);
            }
          }
        } catch (err) {
          console.error(`[instance] Re-auth gateway-login failed for ${userId}:`, err);
        }
      }

      return existing.port;
    }
    // DB says running but container is dead — stale record, will recreate below.
    console.log(`[instance] Stale record for ${userId} (DB=running, container=dead), recreating`);
  }

  // Clean up any existing container with the same name, whether tracked in DB or not.
  // Using `rm -f` ensures removal even if stop fails (e.g. container in weird state).
  try {
    docker(`rm -f ${name}`, { quiet: true });
  } catch {
    // Container does not exist — nothing to clean up
  }

  const port = existing?.port || allocatePort();
  const dataDir = path.join(config.instanceDataRoot, userId);

  // Ensure the user data directory exists before mounting it into the container.
  // Podman (unlike Docker) does not auto-create host bind-mount paths.
  mkdirSync(dataDir, { recursive: true });

  console.log(`[instance] Starting container ${name} for user ${userId} on port ${port}`);

  const containerInternalPort = config.containerPort;
  const gatewayBaseUrl = process.env.GATEWAY_BASE_URL || '';
  const runArgs = [
    'run', '-d',
    '--name', name,
    '-p', `${port}:${containerInternalPort}`,
    '-v', `${dataDir}:/data`,
    '-e', `PORT=${containerInternalPort}`,
    '-e', 'NODE_ENV=production',
    '-e', 'ALLOW_REMOTE=true',
    '-e', `GATEWAY_SECRET=${config.gatewaySecret}`,
    // Tell AionUI to accept requests originating from the Gateway's public domain.
    // Without this, CORS rejects the browser's origin and cookies (csrfToken, etc.)
    // won't be set properly, causing WebSocket auth failures.
    ...(gatewayBaseUrl ? ['-e', `SERVER_BASE_URL=${gatewayBaseUrl}`] : []),
    '--memory=512m',
    '--cpus=1',
    '--pids-limit=256',
    config.dockerImage,
  ];

  try {
    docker(runArgs.join(' '));
  } catch (err) {
    console.error(`[instance] Failed to start container:`, err);
    throw new Error(`Failed to start Docker container for user ${userId}`);
  }

  const now = Date.now();
  const instance: UserInstance = {
    userId,
    port,
    pid: 0,
    status: 'starting',
    lastActive: now,
    startedAt: now,
  };
  upsertInstance(instance);

  try {
    await waitForReady(port, 60_000);
    updateInstanceStatus(userId, 'running');
    runningUsers.add(userId);
    console.log(`[instance] Container ${name} ready on port ${port}`);

    if (username && config.gatewaySecret) {
      try {
        console.log(`[instance] Attempting gateway-login for ${userId} at http://127.0.0.1:${port}/api/auth/gateway-login`);
        const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/gateway-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gatewaySecret: config.gatewaySecret, username }),
        });
        if (loginRes.ok) {
          const loginData = (await loginRes.json()) as { success: boolean; token?: string };
          if (loginData.success && loginData.token) {
            instanceTokens.set(userId, loginData.token);
            console.log(`[instance] Gateway login succeeded for user ${userId}, token length: ${loginData.token.length}`);
          } else {
            console.warn(`[instance] Gateway login response not successful:`, loginData);
          }
        } else {
          const body = await loginRes.text();
          console.error(`[instance] Gateway login HTTP ${loginRes.status} for ${userId}: ${body}`);
        }
      } catch (err) {
        console.error(`[instance] Gateway login failed for user ${userId}:`, err);
      }
    }
  } catch (err) {
    console.error(`[instance] Container ${name} failed to start:`, err);
    runningUsers.delete(userId);
    stopContainer(name);
    updateInstanceStatus(userId, 'stopped');
    throw err;
  }

  return port;
}

function stopContainer(name: string): void {
  try {
    docker(`stop ${name}`);
  } catch {
    // Ignore
  }
  try {
    docker(`rm ${name}`);
  } catch {
    // Ignore
  }
}

export function killInstance(userId: string): void {
  const name = containerName(userId);
  console.log(`[instance] Stopping container ${name} for user ${userId}`);
  runningUsers.delete(userId);
  stopContainer(name);
  updateInstanceStatus(userId, 'stopped');
  instanceTokens.delete(userId);
}

let reaperTimer: ReturnType<typeof setInterval> | null = null;

export function startIdleReaper(): void {
  ensureDockerAvailable();

  if (reaperTimer) return;

  reaperTimer = setInterval(() => {
    const now = Date.now();
    const running = getRunningInstances();
    for (const instance of running) {
      const idle = now - instance.lastActive;
      if (idle > config.instanceIdleTimeout) {
        console.log(
          `[reaper] Recycling idle container for user ${instance.userId} (idle ${Math.round(idle / 1000)}s)`,
        );
        killInstance(instance.userId);
      }
    }
  }, 60_000);

  reaperTimer.unref();
  console.log(`[reaper] Idle reaper started (timeout: ${config.instanceIdleTimeout / 1000}s)`);
}

export function stopIdleReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

export function touchInstance(userId: string): void {
  const name = containerName(userId);
  if (isContainerRunning(name)) {
    updateInstanceActivity(userId);
  }
}

export function getInstanceToken(userId: string): string | null {
  return instanceTokens.get(userId) || null;
}

export function shutdownAll(): void {
  stopIdleReaper();
  try {
    const output = docker(`ps --filter name=${CONTAINER_PREFIX} -q`);
    if (output) {
      const ids = output.split('\n').filter(Boolean);
      for (const id of ids) {
        try {
          docker(`stop ${id}`);
          docker(`rm ${id}`);
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore
  }
  instanceTokens.clear();
  runningUsers.clear();
}
