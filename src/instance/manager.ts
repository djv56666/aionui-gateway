import { execSync, exec } from 'node:child_process';
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

const CONTAINER_PREFIX = 'aionui-gw-';
const instanceTokens = new Map<string, string>();

function containerName(userId: string): string {
  return `${CONTAINER_PREFIX}${userId.substring(0, 12)}`;
}

function docker(cmd: string): string {
  return execSync(`${config.dockerCmd} ${cmd}`, { encoding: 'utf8', timeout: 30_000 }).trim();
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

function waitForReady(port: number, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Container on port ${port} did not become ready within ${timeoutMs}ms`));
        return;
      }
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        setTimeout(check, 1000);
      });
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
  const existing = getInstanceByUserId(userId);
  const name = containerName(userId);

  if (existing && existing.status === 'running' && isContainerRunning(name)) {
    updateInstanceActivity(userId);
    return existing.port;
  }

  if (existing) {
    try {
      if (isContainerRunning(name)) {
        docker(`stop ${name}`);
      }
      docker(`rm ${name}`);
    } catch {
      // Container may not exist
    }
  }

  const port = existing?.port || allocatePort();
  const dataDir = path.join(config.instanceDataRoot, userId);

  console.log(`[instance] Starting container ${name} for user ${userId} on port ${port}`);

  const containerInternalPort = config.containerPort;
  const runArgs = [
    'run', '-d',
    '--name', name,
    '-p', `${port}:${containerInternalPort}`,
    '-v', `${dataDir}:/data`,
    '-e', `PORT=${containerInternalPort}`,
    '-e', 'NODE_ENV=production',
    '-e', 'ALLOW_REMOTE=false',
    '-e', `GATEWAY_SECRET=${config.gatewaySecret}`,
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
    console.log(`[instance] Container ${name} ready on port ${port}`);

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
    console.error(`[instance] Container ${name} failed to start:`, err);
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
}
