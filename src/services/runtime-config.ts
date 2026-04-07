/**
 * Runtime Config Injector
 *
 * Generates and writes runtime-specific config files into session directories
 * before container startup. Each runtime expects config at a different path
 * in a different format — this module normalises that.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Deep merge utility ───────────────────────────────────

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Recursively merge `source` into `target`.
 * - Both plain objects → recurse
 * - Arrays / primitives → source wins
 * - Returns a new object (inputs are not mutated)
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (isPlainObject(result[key]) && isPlainObject(source[key])) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// ── Type definitions ─────────────────────────────────────

export interface RuntimeConfigOptions {
  apiKey?: string;
  model?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: Record<string, string>;

  /** OpenCode-specific configuration fields */
  opencode?: OpenCodeConfigOptions;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  enabled?: boolean;
}

export interface OpenCodeConfigOptions {
  smallModel?: string;
  defaultAgent?: string;
  instructions?: string[];
  agent?: Record<string, OpenCodeAgentDefinition>;
  provider?: Record<string, OpenCodeProviderConfig>;
  plugin?: Record<string, unknown>;
  disabledProviders?: string[];
  compaction?: Record<string, unknown>;
  snapshot?: boolean;
  formatter?: Record<string, unknown>;
  autoupdate?: boolean | 'notify';
  share?: 'manual' | 'auto' | 'disabled';
  tools?: Record<string, boolean>;
  watcher?: Record<string, unknown>;
}

export interface OpenCodeAgentDefinition {
  description?: string;
  instructions?: string;
  model?: string;
  tools?: string[];
  mcp?: Record<string, McpServerConfig>;
  permission?: Record<string, string>;
}

export interface OpenCodeProviderConfig {
  options?: {
    apiKey?: string;
    timeout?: number;
    cache?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Inject runtime config into the session's config directory.
 *
 * For runtimes with no global-config template on disk, this generates
 * a fresh config from the provided options. If a template exists
 * (copied by copyGlobalConfig), this merges/overrides key fields.
 */
export function injectConfig(
  sessionDir: string,
  runtimeType: string,
  options: RuntimeConfigOptions,
): void {
  const configDir = path.join(sessionDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const injector = INJECTORS[runtimeType];
  if (injector) {
    injector(configDir, options);
  }
}

// ── Per-runtime injectors ─────────────────────────────────

type InjectorFn = (configDir: string, options: RuntimeConfigOptions) => void;

const INJECTORS: Record<string, InjectorFn> = {
  opencode: injectOpenCode,
  claude: injectClaude,
  goose: injectGoose,
};

/** Safe defaults for ephemeral container environments */
const OPENCODE_CONTAINER_DEFAULTS: Record<string, unknown> = {
  autoupdate: false,
  share: 'disabled',
  snapshot: false,
};

function injectOpenCode(configDir: string, options: RuntimeConfigOptions): void {
  const dir = path.join(configDir, 'opencode');
  fs.mkdirSync(dir, { recursive: true });

  const config: Record<string, unknown> = {};
  const oc = options.opencode;

  // ── Shared fields ──

  if (options.model) config.model = options.model;

  // Provider: build from apiKey + opencode-specific provider config
  const providerFromKey: Record<string, unknown> = {};
  if (options.apiKey) {
    providerFromKey.anthropic = { options: { apiKey: options.apiKey } };
  }
  const providerFromOc = oc?.provider ?? {};
  if (Object.keys(providerFromKey).length > 0 || Object.keys(providerFromOc).length > 0) {
    config.provider = deepMerge(
      providerFromKey,
      providerFromOc as Record<string, unknown>,
    );
  }

  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    config.mcp = options.mcpServers;
  }

  if (options.permissions) {
    config.permission = options.permissions;
  }

  // ── OpenCode-specific fields ──

  if (oc) {
    if (oc.smallModel)                config.small_model = oc.smallModel;
    if (oc.defaultAgent)              config.default_agent = oc.defaultAgent;
    if (oc.instructions)              config.instructions = oc.instructions;
    if (oc.agent)                     config.agent = oc.agent;
    if (oc.plugin)                    config.plugin = oc.plugin;
    if (oc.disabledProviders)         config.disabled_providers = oc.disabledProviders;
    if (oc.compaction)                config.compaction = oc.compaction;
    if (oc.snapshot !== undefined)    config.snapshot = oc.snapshot;
    if (oc.formatter)                 config.formatter = oc.formatter;
    if (oc.autoupdate !== undefined)  config.autoupdate = oc.autoupdate;
    if (oc.share)                     config.share = oc.share;
    if (oc.tools)                     config.tools = oc.tools;
    if (oc.watcher)                   config.watcher = oc.watcher;
  }

  // ── 3-way deep merge: defaults ← existing template ← dynamic config ──

  const filePath = path.join(dir, 'opencode.json');
  let merged: Record<string, unknown>;

  if (fs.existsSync(filePath)) {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    merged = deepMerge(deepMerge(OPENCODE_CONTAINER_DEFAULTS, existing), config);
  } else {
    merged = deepMerge(OPENCODE_CONTAINER_DEFAULTS, config);
  }

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
}

function injectClaude(configDir: string, options: RuntimeConfigOptions): void {
  // settings.json → config/claude/settings.json (mounted as ~/.claude/)
  const claudeDir = path.join(configDir, 'claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const settings: Record<string, unknown> = {};

  if (options.apiKey) {
    settings.env = { ANTHROPIC_API_KEY: options.apiKey };
  }

  if (options.permissions) {
    settings.permissions = options.permissions;
  }

  const settingsPath = path.join(claudeDir, 'settings.json');
  if (Object.keys(settings).length > 0) {
    if (fs.existsSync(settingsPath)) {
      const existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      Object.assign(existing, settings);
      fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
    } else {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  }

  // claude.json → config/claude.json (mounted as ~/.claude.json)
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    const claudeJsonPath = path.join(configDir, 'claude.json');
    let claudeJson: Record<string, unknown> = {};
    if (fs.existsSync(claudeJsonPath)) {
      claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    }
    claudeJson.mcpServers = options.mcpServers;
    fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
  }
}

function injectGoose(configDir: string, options: RuntimeConfigOptions): void {
  const dir = path.join(configDir, 'goose');
  fs.mkdirSync(dir, { recursive: true });

  const configPath = path.join(dir, 'config.yaml');

  // Build YAML-like config (simple structure, no need for a YAML library)
  let yaml = '';
  if (options.apiKey) {
    yaml += `provider: anthropic\n`;
  }
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    yaml += `extensions:\n`;
    for (const [name, server] of Object.entries(options.mcpServers)) {
      yaml += `  - name: ${name}\n`;
      if (server.command) {
        yaml += `    command: ${server.command}\n`;
      }
      if (server.args?.length) {
        yaml += `    args:\n`;
        for (const arg of server.args) {
          yaml += `      - ${arg}\n`;
        }
      }
    }
  }

  if (yaml) {
    if (fs.existsSync(configPath)) {
      const existing = fs.readFileSync(configPath, 'utf8');
      fs.writeFileSync(configPath, yaml + '\n' + existing);
    } else {
      fs.writeFileSync(configPath, yaml);
    }
  }
}
