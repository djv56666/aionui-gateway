/**
 * Runtime Filesystem Manager
 *
 * Manages the 3-layer host directory structure for agent runtime config injection:
 *
 *   ${dataRoot}/users/${userId}/
 *   ├── global-config/    ← Layer 1: persistent user configs (templates)
 *   ├── agents/           ← Layer 2: agent project workspaces
 *   └── sessions/         ← Layer 3: per-session runtime copies
 *
 * On session start, global-config is copied into the session directory
 * so multiple concurrent sessions don't interfere with each other.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

// ── Path helpers ──────────────────────────────────────────

function userDir(userId: string): string {
  return path.join(config.dataRoot, 'users', userId);
}

export function globalConfigDir(userId: string): string {
  return path.join(userDir(userId), 'global-config');
}

export function agentDir(userId: string, agentId: string): string {
  return path.join(userDir(userId), 'agents', agentId);
}

export function sessionDir(userId: string, sessionId: string): string {
  return path.join(userDir(userId), 'sessions', sessionId);
}

// ── Directory management ──────────────────────────────────

/**
 * Ensure the user's top-level directory structure exists.
 * Creates global-config/, agents/, sessions/ if missing.
 */
export function ensureUserDirs(userId: string): string {
  const base = userDir(userId);
  fs.mkdirSync(path.join(base, 'global-config'), { recursive: true });
  fs.mkdirSync(path.join(base, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(base, 'sessions'), { recursive: true });
  return base;
}

/**
 * Create a session directory with the standard sub-structure:
 *
 *   sessions/${sessionId}/
 *   ├── config/    ← will receive copies from global-config
 *   ├── data/      ← runtime data
 *   └── runtime-data/
 */
export function ensureSessionDir(userId: string, sessionId: string): string {
  const dir = sessionDir(userId, sessionId);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'runtime-data'), { recursive: true });
  return dir;
}

/**
 * Copy global config for a specific runtime into the session directory.
 *
 * Copies global-config/${runtimeType}/ → sessions/${sid}/config/${runtimeType}/
 * Also copies standalone files like claude.json if they exist.
 */
export function copyGlobalConfig(
  userId: string,
  runtimeType: string,
  sessionId: string,
): void {
  const src = globalConfigDir(userId);
  const dest = path.join(sessionDir(userId, sessionId), 'config');

  // Copy the runtime-specific directory
  copyDirIfExists(path.join(src, runtimeType), path.join(dest, runtimeType));

  // Copy standalone config files that some runtimes need
  const standaloneFiles: Record<string, string[]> = {
    claude: ['claude.json'],
  };
  const files = standaloneFiles[runtimeType] ?? [];
  for (const file of files) {
    const srcFile = path.join(src, file);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, path.join(dest, file));
    }
  }
}

/**
 * Remove a session directory and all its contents.
 * Called when a session is fully terminated.
 */
export function cleanupSession(userId: string, sessionId: string): void {
  const dir = sessionDir(userId, sessionId);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Internals ─────────────────────────────────────────────

/**
 * Recursively copy a directory. No-op if source doesn't exist.
 */
function copyDirIfExists(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true, force: true });
}
