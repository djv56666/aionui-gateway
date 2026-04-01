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
  incrementRestartCount,
} from '../database/index.js';
import type { UserInstance } from '../types/index.js';

const CONTAINER_PREFIX = 'aionui-gw-';
const instanceTokens = new Map<string, string>();

/**
 * Parse a Docker memory string (e.g. '3g', '512m') into bytes.
 */
function parseMemoryToBytes(mem: string): number {
  const match = mem.toLowerCase().match(/^(\d+(?:\.\d+)?)([bkmg]?)$/);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
  return Math.floor(val * (multipliers[unit] || 1));
}

/**
 * Calculate the memory limit for a restart, incrementing by step each time.
 * Clamps to [containerMemory, containerMemoryMax].
 */
function calcMemoryForRestart(restartCount: number): string {
  const base = parseMemoryToBytes(config.containerMemory);
  const step = parseMemoryToBytes(config.containerMemoryStep);
  const max = parseMemoryToBytes(config.containerMemoryMax);
  const mem = Math.min(base + step * restartCount, max);
  // Format back to human-readable
  if (mem >= 1024 ** 3) return `${Math.round(mem / (1024 ** 3))}g`;
  return `${Math.round(mem / (1024 ** 2))}m`;
}

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

/**
 * Perform gateway login to an AionUI instance and cache the token.
 */
async function gatewayLogin(userId: string, port: number, username: string): Promise<void> {
  if (!config.gatewaySecret) return;
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
    console.error(`[instance] Gateway login failed for ${userId}:`, err);
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
    // DB says running but container is dead — try to restart the existing container.
    console.log(`[instance] Stale record for ${userId} (DB=running, container=dead), restarting container`);
    try {
      const count = incrementRestartCount(userId);
      const newMem = calcMemoryForRestart(count);
      console.log(`[instance] Restart #${count} for ${userId}, increasing memory to ${newMem}`);
      docker(`update --memory ${newMem} --memory-swap ${config.containerMemoryMax} ${name}`);
      docker(`start ${name}`);
      console.log(`[instance] Restarted container ${name} for user ${userId} with memory ${newMem}`);

      await waitForReady(existing.port, 60_000);
      runningUsers.add(userId);

      // Re-auth after restart
      if (username && config.gatewaySecret) {
        await gatewayLogin(userId, existing.port, username);
      }

      return existing.port;
    } catch (err) {
      console.error(`[instance] Failed to restart container ${name}:`, err);
      // Fall through to full recreation as last resort
      updateInstanceStatus(userId, 'stopped');
    }
  }

  // If container exists (stopped/exited), try to start it first instead of recreating.
  if (existing) {
    try {
      const containerExists = docker(`inspect --format '{{.Id}}' ${name}`, { quiet: true });
      if (containerExists) {
        const count = incrementRestartCount(userId);
        const newMem = calcMemoryForRestart(count);
        console.log(`[instance] Starting existing container ${name} for user ${userId}, memory ${newMem} (restart #${count})`);
        docker(`update --memory ${newMem} --memory-swap ${config.containerMemoryMax} ${name}`);
        docker(`start ${name}`);

        const port = existing.port;
        await waitForReady(port, 60_000);
        updateInstanceStatus(userId, 'running');
        runningUsers.add(userId);

        if (username && config.gatewaySecret) {
          await gatewayLogin(userId, port, username);
        }

        return port;
      }
    } catch {
      // Container doesn't exist or start failed, will recreate below
    }
  }

  // Clean up any existing container with the same name as last resort.
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
    '--memory', config.containerMemory,
    '--memory-reservation', config.containerMemory,
    '--memory-swap', config.containerMemoryMax,
    '--cpus', config.containerCpus,
    '--pids-limit', String(config.containerPidsLimit),
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
    restartCount: 0,
  };
  upsertInstance(instance);

  try {
    await waitForReady(port, 60_000);
    updateInstanceStatus(userId, 'running');
    runningUsers.add(userId);
    console.log(`[instance] Container ${name} ready on port ${port}`);

    if (username) {
      await gatewayLogin(userId, port, username);
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

  // Start Docker event listener for OOM/crash detection
  startDockerEventListener();

  reaperTimer = setInterval(() => {
    const now = Date.now();
    const running = getRunningInstances();
    for (const instance of running) {
      const name = containerName(instance.userId);

      // Health probe: verify container is actually running
      if (runningUsers.has(instance.userId) && !isContainerRunning(name)) {
        console.log(`[reaper] Container ${name} died (DB=running), clearing cache for user ${instance.userId}`);
        runningUsers.delete(instance.userId);
        instanceTokens.delete(instance.userId);
        updateInstanceStatus(instance.userId, 'stopped');
        continue;
      }

      const idle = now - instance.lastActive;
      if (idle > config.instanceIdleTimeout) {
        console.log(
          `[reaper] Recycling idle container for user ${instance.userId} (idle ${Math.round(idle / 1000)}s)`,
        );
        killInstance(instance.userId);
      }
    }
  }, 30_000);

  reaperTimer.unref();
  console.log(`[reaper] Idle reaper started (timeout: ${config.instanceIdleTimeout / 1000}s)`);
}

export function stopIdleReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
  stopDockerEventListener();
}

// ─── Docker event listener ──────────────────────────────────

let dockerEventProcess: ReturnType<typeof exec> | null = null;

/**
 * Listen to Docker/Podman events for container die/oom events.
 * Uses JSON output format for compatibility with both Docker and Podman.
 */
export function startDockerEventListener(): void {
  if (dockerEventProcess) return;

  // Use JSON format — works with both Docker and Podman
  const child = exec(
    `${config.dockerCmd} events --filter event=die --filter event=oom --format json`,
    { encoding: 'utf8' },
  );

  let buffer = '';

  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const evt = JSON.parse(trimmed);
        // Docker: evt.Actor.Attributes.name, Podman: evt.Name or evt.actor.attributes.name
        const containerName =
          evt?.Actor?.Attributes?.name ||
          evt?.actor?.attributes?.name ||
          evt?.Name ||
          '';
        const action = evt?.Action || evt?.action || evt?.status || '';

        if (!containerName || !containerName.startsWith(CONTAINER_PREFIX)) continue;

        const userIdSuffix = containerName.slice(CONTAINER_PREFIX.length);
        const existing = getRunningInstances().find(
          (inst) => inst.userId.substring(0, 12) === userIdSuffix,
        );
        if (!existing) continue;

        console.log(`[docker-events] Container ${containerName} ${action}, marking user ${existing.userId} as stopped`);
        runningUsers.delete(existing.userId);
        instanceTokens.delete(existing.userId);
        updateInstanceStatus(existing.userId, 'stopped');
      } catch {
        // Not valid JSON — try plain text format (Podman fallback)
        const match = trimmed.match(/name=(\S+)/);
        if (match) {
          const containerName = match[1];
          if (containerName.startsWith(CONTAINER_PREFIX)) {
            const userIdSuffix = containerName.slice(CONTAINER_PREFIX.length);
            const existing = getRunningInstances().find(
              (inst) => inst.userId.substring(0, 12) === userIdSuffix,
            );
            if (existing) {
              console.log(`[docker-events] Container ${containerName} died (text), marking user ${existing.userId} as stopped`);
              runningUsers.delete(existing.userId);
              instanceTokens.delete(existing.userId);
              updateInstanceStatus(existing.userId, 'stopped');
            }
          }
        }
      }
    }
  });

  child.stderr?.on('data', (chunk: string) => {
    console.error(`[docker-events] stderr:`, chunk.trim());
  });

  child.on('error', (err) => {
    console.error(`[docker-events] Process error:`, err.message);
    dockerEventProcess = null;
  });

  child.on('close', (code) => {
    console.log(`[docker-events] Process exited with code ${code}, restarting in 5s`);
    dockerEventProcess = null;
    // Auto-restart the event listener
    setTimeout(() => {
      if (reaperTimer) startDockerEventListener();
    }, 5000);
  });

  dockerEventProcess = child;
  console.log(`[docker-events] Listening for container die/oom events`);
}

export function stopDockerEventListener(): void {
  if (dockerEventProcess) {
    dockerEventProcess.kill();
    dockerEventProcess = null;
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

/**
 * Clear the in-memory running cache for a user, forcing the next
 * ensureInstance() call to re-check actual container status.
 */
export function invalidateRunningCache(userId: string): void {
  runningUsers.delete(userId);
  instanceTokens.delete(userId);
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
