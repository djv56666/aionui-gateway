/**
 * Agent Connect route — Gateway orchestration for remote ACP.
 *
 * GET /api/agent/:agentId/connect
 *   1. Verify user has access to the agent
 *   2. Ensure agent container is running (cold start if needed)
 *   3. Return direct connection info (WebSocket URL + short-lived JWT)
 *
 * The Gateway does NOT proxy ACP data — it only handles orchestration.
 * AionUI connects directly to the agent container's ACP Bridge via WebSocket.
 */

import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
const { sign } = jwt;
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { config } from '../config/index.js';
import { getBaseUrl } from '../utils/index.js';
import {
  ensureUserDirs,
  ensureSessionDir,
  copyGlobalConfig,
  agentDir as resolveAgentDir,
  sessionDir as resolveSessionDir,
} from '../services/runtime-fs.js';
import { getMountProfile, buildDockerMounts, buildDockerEnv } from '../services/runtime-mounts.js';
import { injectConfig, type RuntimeConfigOptions } from '../services/runtime-config.js';

const execAsync = promisify(exec);

// ── Types ──────────────────────────────────────────────────

interface ConnectResponse {
  url: string;
  token: string;
  protocol: 'acp' | 'loading';
  message?: string;
}

interface ConnectErrorResponse {
  error: string;
  details?: string;
}

interface AgentContainer {
  agentId: string;
  runtimeType: string;
  sessionId: string;
  containerName: string;
  port: number;
  status: 'stopped' | 'starting' | 'running' | 'error';
}

// ── Session ID Generator ──────────────────────────────────

function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `${ts}-${rand}`;
}

// ── Container Registry ────────────────────────────────────
// Phase 2 will use Docker API; for now we track active sessions in-memory.

const activeContainers = new Map<string, AgentContainer>();

function containerNameFor(agentId: string, runtimeType: string): string {
  return `aionui-agent-${agentId.substring(0, 12)}-${runtimeType}`;
}

// ── Container Lifecycle ───────────────────────────────────

/**
 * Ensure the agent container is running for the given user + agent + runtime.
 *
 * Flow:
 *  1. Resolve / create host directory structure (user dirs, session dir)
 *  2. Copy global-config → session dir
 *  3. Inject dynamic config (API keys, MCP, permissions)
 *  4. Build Docker mount flags from the runtime's MountProfile
 *  5. docker run (or docker start if container exists but stopped)
 *  6. Wait for health check to pass
 */
async function ensureAgentRunning(
  userId: string,
  agentId: string,
  runtimeType: string,
  configOptions?: RuntimeConfigOptions,
): Promise<{ container: AgentContainer; needsLoading: boolean }> {
  const cname = containerNameFor(agentId, runtimeType);
  const existing = activeContainers.get(cname);

  // Fast path: already tracked as running
  if (existing && existing.status === 'running') {
    const isRunning = await isContainerRunning(cname);
    if (isRunning) {
      return { container: existing, needsLoading: false };
    }
    // Stale — fall through to recreation
    activeContainers.delete(cname);
  }

  // Check if container exists on Docker but stopped
  try {
    const { stdout } = await execAsync(`docker inspect ${cname}`);
    const info = JSON.parse(stdout);
    if (info[0]?.State?.Running) {
      const container: AgentContainer = {
        agentId,
        runtimeType,
        sessionId: existing?.sessionId ?? generateSessionId(),
        containerName: cname,
        port: existing?.port ?? await allocatePort(),
        status: 'running',
      };
      activeContainers.set(cname, container);
      return { container, needsLoading: false };
    }
    if (info[0]?.State?.Status === 'exited') {
      // Reuse the container — just start it
      const container: AgentContainer = {
        agentId,
        runtimeType,
        sessionId: existing?.sessionId ?? generateSessionId(),
        containerName: cname,
        port: existing?.port ?? await allocatePort(),
        status: 'starting',
      };
      console.log(`[agent-connect] Starting existing container ${cname}`);
      await execAsync(`docker start ${cname}`);
      activeContainers.set(cname, { ...container, status: 'running' });
      return { container, needsLoading: true };
    }
  } catch {
    // Container doesn't exist — will create below
  }

  // ── Full creation path ──

  // 1. Ensure host directory structure
  ensureUserDirs(userId);
  const sessionId = generateSessionId();
  ensureSessionDir(userId, sessionId);

  // 2. Copy global config → session
  copyGlobalConfig(userId, runtimeType, sessionId);

  // 3. Inject dynamic config
  injectConfig(resolveSessionDir(userId, sessionId), runtimeType, configOptions ?? {});

  // 4. Create the container
  const port = await allocatePort();
  const container: AgentContainer = {
    agentId,
    runtimeType,
    sessionId,
    containerName: cname,
    port,
    status: 'starting',
  };

  await createAgentContainer(userId, container);

  // 5. Wait for readiness
  await waitForContainerReady(cname);

  activeContainers.set(cname, { ...container, status: 'running' });
  return { container: { ...container, status: 'running' }, needsLoading: true };
}

/**
 * Create a new agent container with config injection.
 */
async function createAgentContainer(userId: string, container: AgentContainer): Promise<void> {
  const { runtimeType, sessionId, containerName, port } = container;

  // Resolve host paths
  const sDir = resolveSessionDir(userId, sessionId);
  const aDir = resolveAgentDir(userId, container.agentId);

  // Get mount profile and build flags
  const profile = getMountProfile(runtimeType);
  const mountFlags = buildDockerMounts(sDir, aDir, profile);
  const envFlags = buildDockerEnv(container.agentId, profile);

  // Resolve Docker image
  const image = config.runtimeImages[runtimeType] ?? config.dockerImage;

  // Gateway URL that the sidecar can reach
  const gatewayUrl = process.env.GATEWAY_BASE_URL || `http://${config.gatewayHost}:${config.gatewayPort}`;

  const runCommand = [
    config.dockerCmd,
    'run', '-d',
    '--name', containerName,
    '--restart', 'unless-stopped',
    '--memory', config.containerMemory,
    '--memory-reservation', config.containerMemory,
    '--memory-swap', config.containerMemoryMax,
    '--cpus', config.containerCpus,
    '--pids-limit', String(config.containerPidsLimit),
    '-p', `${port}:${config.containerPort}`,
    ...mountFlags,
    ...envFlags,
    '-e', `ACP_PORT=${config.containerPort}`,
    '-e', `GATEWAY_URL=${gatewayUrl}`,
    '-e', `GATEWAY_SECRET=${config.gatewaySecret}`,
    '-e', `TRANSPORT_MODE=${profile.transportMode}`,
    image,
  ].join(' ');

  console.log(`[agent-connect] Creating container: ${runCommand}`);
  await execAsync(runCommand);
}

/**
 * Check if a Docker container is running.
 */
async function isContainerRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`docker inspect --format '{{.State.Running}}' ${name}`);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Allocate an available port from the configured range.
 */
async function allocatePort(): Promise<number> {
  // Get ports currently in use by running containers
  const { stdout } = await execAsync(
    `docker ps --filter name=aionui-agent- --format '{{.Ports}}'`
  );
  const usedPorts = new Set<number>();
  for (const line of stdout.split('\n')) {
    const match = line.match(/:(\d+)->/);
    if (match) usedPorts.add(parseInt(match[1], 10));
  }

  for (let p = config.instancePortStart; p <= config.instancePortEnd; p++) {
    if (!usedPorts.has(p)) return p;
  }
  throw new Error('No available ports in the configured range');
}

/**
 * Wait for container to be running and HTTP health check to pass.
 */
async function waitForContainerReady(containerName: string, maxWaitMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const running = await isContainerRunning(containerName);
    if (running) {
      // Give the sidecar a moment to initialise
      await new Promise(r => setTimeout(r, 2000));
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Container ${containerName} failed to start within ${maxWaitMs / 1000}s`);
}

/**
 * Check if the sidecar health endpoint is responsive.
 */
async function checkSidecarHealth(containerName: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check if user has access to the agent.
 * Phase 1: all authenticated users have access
 */
function hasAgentAccess(_userId: string, _agentId: string): boolean {
  return true;
}

// ── Route Handler ──────────────────────────────────────────

export function createAgentConnectRouter(): Router {
  const router = Router();

  /**
   * GET /api/agent/:agentId/connect/loading
   *
   * Returns a loading page while the container is being initialized.
   */
  router.get('/:agentId/connect/loading', (req: Request, res: Response) => {
    const { agentId } = req.params;
    const baseUrl = getBaseUrl(req);
    res.redirect(`${baseUrl}/gateway/loading/${agentId}`);
  });

  /**
   * GET /api/agent/:agentId/connect
   *
   * Query params:
   *   runtimeType  (optional) — which runtime to use, default 'opencode'
   *
   * Returns connection info for direct ACP WebSocket connection.
   * Gateway signs a short-lived JWT that the ACP Bridge validates.
   */
  router.get('/:agentId/connect', async (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
    const runtimeType = (req.query.runtimeType as string) || 'opencode';
    const session = req.session as { userId?: string } | undefined;
    const userId = session?.userId;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' } satisfies ConnectErrorResponse);
      return;
    }

    try {
      // 1. Access check
      if (!hasAgentAccess(userId, agentId)) {
        res.status(403).json({ error: 'Access denied to this agent' } satisfies ConnectErrorResponse);
        return;
      }

      // 2. Ensure container is running (cold start with config injection)
      const { container, needsLoading } = await ensureAgentRunning(userId, agentId, runtimeType);

      // 3. If not ready yet, return loading state
      if (needsLoading) {
        const healthy = await checkSidecarHealth(container.containerName, container.port);
        if (!healthy) {
          const baseUrl = getBaseUrl(req);
          return res.json({
            url: `${baseUrl}/gateway/loading/${agentId}`,
            token: '',
            protocol: 'loading' as const,
            message: 'Container is starting up, please wait...',
          });
        }
      }

      // 4. Sign short-lived JWT for ACP Bridge authentication (5 min)
      const agentToken = sign(
        {
          agentId,
          userId,
          sessionId: container.sessionId,
          runtimeType,
          iat: Math.floor(Date.now() / 1000),
        },
        config.gatewaySecret,
        { expiresIn: '5m' },
      );

      // 5. Return connection info
      const response: ConnectResponse = {
        url: `ws://${config.gatewayHost}:${config.port}/api/agent/${agentId}/acp`,
        token: agentToken,
        protocol: 'acp',
      };

      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[agent-connect] Failed for agent=${agentId} runtime=${runtimeType}:`, message);
      res.status(502).json({
        error: 'Failed to connect to agent',
        details: message,
      } satisfies ConnectErrorResponse);
    }
  });

  return router;
}
