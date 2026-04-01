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
import { config } from '../config/index.js';
import path from 'path';
import { getBaseUrl } from '../utils/index.js';

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

// ── Agent Container Registry ───────────────────────────────
// Phase 1: static mapping via environment variables
// Phase 2: use Docker API for dynamic container management

interface AgentContainer {
  agentId: string;
  containerName: string;
  port: number;
  status: 'stopped' | 'starting' | 'running' | 'error';
}

/**
 * Get agent container info from environment.
 * AGENT_CONTAINERS=agent-id-1:container-name:port,agent-id-2:container-name:port
 */
function getAgentContainer(agentId: string): AgentContainer | null {
  const containersEnv = process.env.AGENT_CONTAINERS || '';
  const entries = containersEnv.split(',').filter(Boolean);

  for (const entry of entries) {
    const [id, name, portStr] = entry.split(':');
    if (id === agentId) {
      const port = parseInt(portStr, 10);
      if (!isNaN(port)) {
        return {
          agentId,
          containerName: name,
          port,
          status: 'running', // Assume running in static config
        };
      }
    }
  }

  return null;
}

/**
 * Ensure the agent container is running.
 * Phase 1: Use Docker CLI for cold start
 */
async function ensureAgentRunning(agentId: string, checkOnly: boolean = false): Promise<{ container: AgentContainer; needsLoading: boolean }> {
  const container = getAgentContainer(agentId);
  if (!container) {
    throw new Error(`Agent container not found: ${agentId}`);
  }

  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  // Check if container exists and is running
  try {
    const { stdout: inspectOutput } = await execAsync(`docker inspect ${container.containerName}`);
    const containerInfo = JSON.parse(inspectOutput);

    if (containerInfo[0]?.State?.Running) {
      // Container is running, check if ACP Bridge is ready
      const isHealthy = await checkAcpBridgeHealth(container.containerName, container.port);
      if (isHealthy) {
        return {
          container: {
            ...container,
            status: 'running'
          },
          needsLoading: false
        };
      } else {
        // Container is running but ACP Bridge is not ready
        return {
          container: {
            ...container,
            status: 'running'
          },
          needsLoading: true
        };
      }
    } else if (containerInfo[0]?.State?.Status === 'exited') {
      // Container exists but stopped, start it
      console.log(`[agent-connect] Starting container ${container.containerName}`);
      await execAsync(`docker start ${container.containerName}`);

      // Wait for container to be ready
      await waitForContainerReady(container.containerName, execAsync);

      return {
        container: {
          ...container,
          status: 'running'
        },
        needsLoading: true // ACP Bridge might not be ready yet
      };
    }
  } catch (err) {
    if ((err as any).code === '404') {
      // Container doesn't exist, create it
      console.log(`[agent-connect] Creating container ${container.containerName} for agent ${agentId}`);
      await createAgentContainer(agentId, container, execAsync);

      // Wait for container to be ready
      await waitForContainerReady(container.containerName, execAsync);

      return {
        container: {
          ...container,
          status: 'running'
        },
        needsLoading: true // ACP Bridge might not be ready yet
      };
    }
    throw err;
  }

  // If we get here, something is wrong
  throw new Error(`Failed to determine container status for agent ${agentId}`);
}

/**
 * Create a new agent container.
 */
async function createAgentContainer(agentId: string, container: AgentContainer, execAsync: Function): Promise<void> {
  const { config } = await import('../config/index.js');
  const userDataDir = path.resolve(config.instanceDataRoot, agentId);

  // Ensure user data directory exists
  const { mkdir } = require('fs').promises;
  await mkdir(userDataDir, { recursive: true });

  // Build Docker run command
  const dockerCmd = config.dockerCmd;
  const dockerImage = config.dockerImage;
  const containerPort = config.containerPort;
  const memory = config.containerMemory;
  const cpus = config.containerCpus;
  const pids = config.containerPidsLimit;

  const runCommand = [
    dockerCmd,
    'run',
    '-d',
    '--name', container.containerName,
    '--restart', 'unless-stopped',
    '--memory', memory,
    '--cpus', cpus,
    '--pids-limit', pids.toString(),
    '-p', `${container.port}:${containerPort}`,
    '-v', `${userDataDir}:/workspace`,
    '-v', `${path.resolve(__dirname, '../agent-runtime-opencode')}:/app/agent-runtime`,
    '-e', `AGENT_ID=${agentId}`,
    '-e', `ACP_PORT=${containerPort}`,
    '-e', `WORK_DIR=/workspace`,
    dockerImage
  ].join(' ');

  console.log(`[agent-connect] Running: ${runCommand}`);
  await execAsync(runCommand);
}

/**
 * Wait for container to be ready.
 */
async function waitForContainerReady(containerName: string, execAsync: Function): Promise<void> {
  let attempts = 0;
  const maxAttempts = 30; // 30 seconds max

  while (attempts < maxAttempts) {
    try {
      // Check if container is running
      const { stdout: inspectOutput } = await execAsync(`docker inspect ${containerName}`);
      const containerInfo = JSON.parse(inspectOutput);

      if (containerInfo[0]?.State?.Running) {
        // Wait a bit more for services to start
        await new Promise(resolve => setTimeout(resolve, 3000));
        return;
      }
    } catch (err) {
      // Container might not be ready yet
    }

    attempts++;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`Container ${containerName} failed to start within ${maxAttempts} seconds`);
}

/**
 * Check if ACP Bridge is healthy.
 */
async function checkAcpBridgeHealth(containerName: string, port: number): Promise<boolean> {
  try {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    // Check if the container is running first
    const { stdout: inspectOutput } = await execAsync(`docker inspect ${containerName}`);
    const containerInfo = JSON.parse(inspectOutput);
    if (!containerInfo[0]?.State?.Running) {
      return false;
    }

    // Check if ACP bridge process is running inside container
    const { stdout: psOutput } = await execAsync(`docker exec ${containerName} ps aux`);
    if (!psOutput.includes('acp-bridge')) {
      return false;
    }

    // Check if the port is accessible (try curl to health endpoint)
    try {
      await execAsync(`docker exec ${containerName} curl -s http://localhost:${port}/ --connect-timeout 5`);
      return true;
    } catch {
      return false;
    }
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
   * This is useful for showing a loading state during cold start.
   */
  router.get('/:agentId/connect/loading', (req: Request, res: Response) => {
    const { agentId } = req.params;
    const baseUrl = getBaseUrl(req);
    res.redirect(`${baseUrl}/gateway/loading/${agentId}`);
  });

  /**
   * GET /api/agent/:agentId/connect
   *
   * Returns connection info for direct ACP WebSocket connection.
   * Gateway signs a short-lived JWT that the ACP Bridge validates.
   */
  router.get('/:agentId/connect', async (req: Request, res: Response) => {
    const agentId = req.params.agentId as string;
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

      // 2. Ensure container is running (cold start)
      const { container: container, needsLoading } = await ensureAgentRunning(agentId);

      // 3. If ACP Bridge is not ready, return loading URL
      if (needsLoading) {
        const baseUrl = getBaseUrl(req);
        return res.json({
          url: `${baseUrl}/gateway/loading/${agentId}`,
          token: '',
          protocol: 'loading',
          message: 'Container is starting up, please wait...'
        });
      }

      // 4. Wait for ACP Bridge to be ready (double check)
      const isHealthy = await checkAcpBridgeHealth(container.containerName, container.port);
      if (!isHealthy) {
        throw new Error('ACP Bridge is not ready');
      }

      // 4. Sign short-lived JWT for ACP Bridge authentication (5 min)
      const agentToken = sign(
        {
          agentId,
          userId,
          sessionId: `session-${Date.now()}`,
          iat: Math.floor(Date.now() / 1000),
        },
        config.gatewaySecret,
        { expiresIn: '5m' },
      );

      // 5. Return connection through gateway proxy (not direct to container)
      const response: ConnectResponse = {
        // WebSocket URL goes through gateway to handle routing
        url: `ws://${config.gatewayHost}:${config.port}/api/agent/${agentId}/acp`,
        token: agentToken,
        protocol: 'acp',
      };

      res.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[agent-connect] Failed for agent=${agentId}:`, message);
      res.status(502).json({
        error: 'Failed to connect to agent',
        details: message,
      } satisfies ConnectErrorResponse);
    }
  });

  return router;
}