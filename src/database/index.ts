import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import type { GatewayUser, OAuthProvider, UserInstance } from '../types/index.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initSchema(db);
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      oauth_provider TEXT NOT NULL,
      oauth_id TEXT NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      email TEXT,
      created_at INTEGER NOT NULL,
      last_login INTEGER NOT NULL
    )
  `);
  database.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_id)',
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      port INTEGER NOT NULL UNIQUE,
      pid INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'stopped',
      last_active INTEGER NOT NULL,
      started_at INTEGER NOT NULL
    )
  `);

  console.log('[db] Schema initialized');
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── User operations ──────────────────────────────────

export function findUserByOAuth(provider: OAuthProvider, oauthId: string): GatewayUser | null {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?')
    .get(provider, oauthId) as Record<string, unknown> | undefined;

  return row ? mapUser(row) : null;
}

export function findUserById(id: string): GatewayUser | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;

  return row ? mapUser(row) : null;
}

export function createUser(user: GatewayUser): GatewayUser {
  getDb()
    .prepare(
      `INSERT INTO users (id, oauth_provider, oauth_id, username, display_name, avatar_url, email, created_at, last_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user.id,
      user.oauthProvider,
      user.oauthId,
      user.username,
      user.displayName,
      user.avatarUrl,
      user.email,
      user.createdAt,
      user.lastLogin,
    );

  return user;
}

export function updateUserLogin(userId: string): void {
  getDb()
    .prepare('UPDATE users SET last_login = ? WHERE id = ?')
    .run(Date.now(), userId);
}

// ─── Instance operations ──────────────────────────────

export function getInstanceByUserId(userId: string): UserInstance | null {
  const row = getDb().prepare('SELECT * FROM instances WHERE user_id = ?').get(userId) as
    | Record<string, unknown>
    | undefined;

  return row ? mapInstance(row) : null;
}

export function upsertInstance(instance: UserInstance): void {
  getDb()
    .prepare(
      `INSERT INTO instances (user_id, port, pid, status, last_active, started_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         port = excluded.port,
         pid = excluded.pid,
         status = excluded.status,
         last_active = excluded.last_active,
         started_at = excluded.started_at`,
    )
    .run(
      instance.userId,
      instance.port,
      instance.pid,
      instance.status,
      instance.lastActive,
      instance.startedAt,
    );
}

export function updateInstanceStatus(userId: string, status: UserInstance['status']): void {
  getDb()
    .prepare('UPDATE instances SET status = ?, last_active = ? WHERE user_id = ?')
    .run(status, Date.now(), userId);
}

export function updateInstanceActivity(userId: string): void {
  getDb()
    .prepare('UPDATE instances SET last_active = ? WHERE user_id = ?')
    .run(Date.now(), userId);
}

export function deleteInstance(userId: string): void {
  getDb().prepare('DELETE FROM instances WHERE user_id = ?').run(userId);
}

export function getRunningInstances(): UserInstance[] {
  const rows = getDb()
    .prepare("SELECT * FROM instances WHERE status IN ('starting', 'running')")
    .all() as Record<string, unknown>[];

  return rows.map(mapInstance);
}

export function getAllocatedPorts(): Set<number> {
  const rows = getDb()
    .prepare("SELECT port FROM instances WHERE status IN ('starting', 'running')")
    .all() as Array<{ port: number }>;

  return new Set(rows.map((r) => r.port));
}

// ─── Mappers ──────────────────────────────────────────

function mapUser(row: Record<string, unknown>): GatewayUser {
  return {
    id: row.id as string,
    oauthProvider: row.oauth_provider as OAuthProvider,
    oauthId: row.oauth_id as string,
    username: row.username as string,
    displayName: (row.display_name as string) || '',
    avatarUrl: (row.avatar_url as string) || '',
    email: (row.email as string) || null,
    createdAt: row.created_at as number,
    lastLogin: row.last_login as number,
  };
}

function mapInstance(row: Record<string, unknown>): UserInstance {
  return {
    userId: row.user_id as string,
    port: row.port as number,
    pid: row.pid as number,
    status: row.status as UserInstance['status'],
    lastActive: row.last_active as number,
    startedAt: row.started_at as number,
  };
}
