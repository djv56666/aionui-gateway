/**
 * Runtime Mount Profile Registry
 *
 * Maps each runtime type to its Docker mount configuration.
 * Gateway uses this to dynamically assemble `-v` and `-e` flags
 * when creating agent containers.
 */

export interface MountEntry {
  /** Sub-path relative to sessions/${sessionId}/ */
  hostSubDir: string;
  /** Absolute path inside the container */
  containerPath: string;
  /** Whether this is a single file (not a directory) */
  file?: boolean;
}

export interface MountProfile {
  mounts: MountEntry[];
  env: Record<string, string>;
  transportMode: 'stdio' | 'gateway';
}

/**
 * Per-runtime mount profiles.
 *
 * Each profile tells the Gateway how to mount config/data directories
 * from the host into the container at the paths the runtime expects.
 */
const RUNTIME_MOUNT_PROFILES: Record<string, MountProfile> = {
  opencode: {
    mounts: [
      { hostSubDir: 'config/opencode', containerPath: '/home/appuser/.config/opencode' },
      { hostSubDir: 'data/opencode',   containerPath: '/home/appuser/.local/share/opencode' },
    ],
    env: {
      OPENCODE_CONFIG_DIR: '/home/appuser/.config/opencode',
    },
    transportMode: 'stdio',
  },

  claude: {
    mounts: [
      { hostSubDir: 'config/claude',      containerPath: '/home/appuser/.claude' },
      { hostSubDir: 'config/claude.json', containerPath: '/home/appuser/.claude.json', file: true },
    ],
    env: {},
    transportMode: 'stdio',
  },

  codex: {
    mounts: [
      { hostSubDir: 'config/codex', containerPath: '/home/appuser/.codex' },
    ],
    env: {},
    transportMode: 'stdio',
  },

  goose: {
    mounts: [
      { hostSubDir: 'config/goose', containerPath: '/home/appuser/.config/goose' },
      { hostSubDir: 'data/goose',   containerPath: '/home/appuser/.local/share/goose/sessions' },
    ],
    env: {},
    transportMode: 'stdio',
  },

  openclaw: {
    mounts: [],
    env: {},
    transportMode: 'gateway',
  },
};

/**
 * Get the mount profile for a runtime type.
 * Falls back to a generic profile with workspace-only mount.
 */
export function getMountProfile(runtimeType: string): MountProfile {
  return RUNTIME_MOUNT_PROFILES[runtimeType] ?? {
    mounts: [],
    env: {},
    transportMode: 'stdio',
  };
}

/**
 * Build Docker `-v` flags for a given session + agent.
 *
 * @param sessionDir  Absolute path to sessions/${sessionId}/
 * @param agentDir    Absolute path to agents/${agentId}/
 * @param profile     Mount profile for the runtime type
 * @returns Array of `-v` flag strings, e.g. ['-v /host/path:/container/path']
 */
export function buildDockerMounts(
  sessionDir: string,
  agentDir: string,
  profile: MountProfile,
): string[] {
  const volumes: string[] = [];

  // Common: agent workspace
  volumes.push(`-v ${agentDir}:/workspace`);

  // Runtime-specific mounts
  for (const entry of profile.mounts) {
    const hostPath = pathJoin(sessionDir, entry.hostSubDir);
    volumes.push(`-v ${hostPath}:${entry.containerPath}`);
  }

  return volumes;
}

/**
 * Build Docker `-e` flags for a given runtime.
 */
export function buildDockerEnv(
  agentId: string,
  profile: MountProfile,
): string[] {
  const envs: string[] = [
    `-e AGENT_ID=${agentId}`,
    `-e WORK_DIR=/workspace`,
  ];

  for (const [key, value] of Object.entries(profile.env)) {
    envs.push(`-e ${key}=${value}`);
  }

  return envs;
}

/** Simple path join that avoids importing 'path' for a trivial operation */
function pathJoin(base: string, ...segments: string[]): string {
  let result = base.replace(/\/+$/, '');
  for (const seg of segments) {
    result += '/' + seg.replace(/^\/+/, '');
  }
  return result;
}
