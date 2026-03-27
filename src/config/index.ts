import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

function envOrDefault(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  /** Gateway server port */
  port: parseInt(envOrDefault('GATEWAY_PORT', '3000'), 10),

  /** Express session secret */
  sessionSecret: envOrDefault('GATEWAY_SESSION_SECRET', 'dev-secret-change-me'),

  /** Absolute path to AionUi server.mjs entry */
  aionuiServerEntry: path.resolve(
    projectRoot,
    envOrDefault('AIONUI_SERVER_ENTRY', '../AionUi/dist-server/server.mjs'),
  ),

  /** Runtime to spawn AionUi instances: 'bun' or 'node' */
  instanceRuntime: envOrDefault('INSTANCE_RUNTIME', 'bun'),

  /** Port range for user instances */
  instancePortStart: parseInt(envOrDefault('INSTANCE_PORT_START', '4001'), 10),
  instancePortEnd: parseInt(envOrDefault('INSTANCE_PORT_END', '4100'), 10),

  /** Root directory for user data */
  instanceDataRoot: path.resolve(projectRoot, envOrDefault('INSTANCE_DATA_ROOT', './data/users')),

  /** Idle timeout in ms before instance is recycled */
  instanceIdleTimeout: parseInt(envOrDefault('INSTANCE_IDLE_TIMEOUT', '1800'), 10) * 1000,

  /** OAuth2 providers */
  oauth: {
    github: {
      clientId: process.env.OAUTH_GITHUB_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_GITHUB_CLIENT_SECRET || '',
      get enabled(): boolean {
        return !!(config.oauth.github.clientId && config.oauth.github.clientSecret);
      },
    },
    google: {
      clientId: process.env.OAUTH_GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET || '',
      get enabled(): boolean {
        return !!(config.oauth.google.clientId && config.oauth.google.clientSecret);
      },
    },
    zhimi: {
      clientId: process.env.OAUTH_ZHIMI_CLIENT_ID || '',
      clientSecret: process.env.OAUTH_ZHIMI_CLIENT_SECRET || '',
      casBase: process.env.OAUTH_ZHIMI_CAS_BASE || 'https://cas.zhimi.com',
      get enabled(): boolean {
        return !!(config.oauth.zhimi.clientId && config.oauth.zhimi.clientSecret);
      },
    },
  },

  /** Gateway database path */
  dbPath: path.resolve(projectRoot, envOrDefault('GATEWAY_DB_PATH', './data/gateway.db')),

  /** Shared secret for gateway-login to AionUi instances */
  gatewaySecret: envOrDefault('GATEWAY_SECRET', 'change-me-to-a-random-string'),

  /** Project root */
  projectRoot,
} as const;
