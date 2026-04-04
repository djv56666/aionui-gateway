/**
 * Runtime Config Injector
 *
 * Generates and writes runtime-specific config files into session directories
 * before container startup. Each runtime expects config at a different path
 * in a different format — this module normalises that.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeConfigOptions {
  apiKey?: string;
  model?: string;
  mcpServers?: Record<string, McpServerConfig>;
  permissions?: Record<string, string>;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  type?: string;
  url?: string;
  enabled?: boolean;
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

function injectOpenCode(configDir: string, options: RuntimeConfigOptions): void {
  const dir = path.join(configDir, 'opencode');
  fs.mkdirSync(dir, { recursive: true });

  const config: Record<string, unknown> = {};

  if (options.model) config.model = options.model;

  if (options.apiKey) {
    config.provider = {
      anthropic: { options: { apiKey: options.apiKey } },
    };
  }

  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    config.mcp = options.mcpServers;
  }

  if (options.permissions) {
    config.permission = options.permissions;
  }

  // Write if we have any config to inject, or create an empty template
  const filePath = path.join(dir, 'opencode.json');
  if (fs.existsSync(filePath)) {
    // Merge with existing
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    Object.assign(existing, config);
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
  } else if (Object.keys(config).length > 0) {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
  }
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
