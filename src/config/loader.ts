import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type AppConfig,
  createDefaultConfig,
  rawJsonToAppConfig,
  appConfigToRawJson,
} from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Returns the active configuration file path:
 * $CCS_CONFIG_DIR/config.json if set, otherwise ~/.ccs/config.json.
 */
export function configPath(): string {
  const envDir = process.env['CCS_CONFIG_DIR'];
  if (envDir && envDir.trim().length > 0) {
    return path.join(envDir.trim(), 'config.json');
  }
  return path.join(os.homedir(), '.ccs', 'config.json');
}

/**
 * Resolves the SQLite database path:
 * 1. config.dbPath if configured
 * 2. $CCS_CONFIG_DIR/ccs.db if CCS_CONFIG_DIR set
 * 3. ~/.ccs/ccs.db fallback
 */
export function resolveDbPath(config: AppConfig): string {
  if (config.dbPath && config.dbPath.trim().length > 0) {
    return config.dbPath.trim();
  }
  const envDir = process.env['CCS_CONFIG_DIR'];
  if (envDir && envDir.trim().length > 0) {
    return path.join(envDir.trim(), 'ccs.db');
  }
  return path.join(os.homedir(), '.ccs', 'ccs.db');
}

/**
 * Expands a `$ENV_VAR` string to its environment variable value.
 * If raw does not start with `$`, returns raw unchanged.
 */
export function resolveEnvStr(raw: string): string | undefined {
  if (!raw.startsWith('$')) {
    return raw;
  }
  const varName = raw.slice(1);
  return process.env[varName];
}

/**
 * Resolves a configured API key. If raw starts with `$`, reads from environment.
 * Throws ConfigError if environment variable is unset.
 */
export function resolveApiKey(raw: string): string {
  const resolved = resolveEnvStr(raw);
  if (resolved === undefined || resolved === '') {
    throw new ConfigError(`API key environment variable not found or invalid: ${raw}`);
  }
  return resolved;
}

/**
 * Resolves extra request headers, expanding `$ENV_VAR` values.
 * Unset environment variables are omitted.
 */
export function resolveExtraHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(headers)) {
    const resolved = resolveEnvStr(rawValue);
    if (resolved !== undefined) {
      result[key] = resolved;
    }
  }
  return result;
}

/**
 * Extracts port number from address string like "127.0.0.1:7896" or ":7896".
 */
export function parseListenPort(listen: string): number | undefined {
  const idx = listen.lastIndexOf(':');
  if (idx === -1) return undefined;
  const portStr = listen.slice(idx + 1);
  const parsed = parseInt(portStr, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Validates provider port assignments against conflicts and collision with global listen port.
 */
export function validatePorts(config: AppConfig): void {
  const seenPorts = new Map<number, string>();
  const listenPort = parseListenPort(config.listen);

  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.port === undefined) continue;
    const port = provider.port;

    if (listenPort !== undefined && port === listenPort) {
      throw new ConfigError(
        `Provider '${name}' port ${port} conflicts with global listen address '${config.listen}'`
      );
    }

    const other = seenPorts.get(port);
    if (other !== undefined) {
      throw new ConfigError(`Providers '${other}' and '${name}' both claim port ${port}`);
    }
    seenPorts.set(port, name);
  }
}

/**
 * Atomically writes content to a target file by writing to a temporary sibling file,
 * syncing to disk, and renaming over the destination with 0600 permissions.
 */
export function writeAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeSync(fd, content, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Ignore chmod failure on platforms that do not support POSIX file modes
  }

  fs.renameSync(tmpPath, filePath);
}

/**
 * Loads and validates configuration from disk.
 * If file does not exist, returns default configuration.
 * Generates and saves stable UUIDs for any providers missing an ID.
 */
export function loadConfig(customPath?: string): AppConfig {
  const targetPath = customPath || configPath();
  if (!fs.existsSync(targetPath)) {
    return createDefaultConfig();
  }

  const rawContent = fs.readFileSync(targetPath, 'utf8');
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(rawContent);
  } catch (err) {
    throw new ConfigError(`Failed to parse config JSON at ${targetPath}: ${String(err)}`);
  }

  const config = rawJsonToAppConfig(parsedRaw as Record<string, unknown>);

  let mutated = false;
  for (const provider of Object.values(config.providers)) {
    if (!provider.id || provider.id.trim().length === 0) {
      provider.id = randomUUID();
      mutated = true;
    }
  }

  validatePorts(config);

  if (mutated) {
    saveConfig(config, targetPath);
  }

  return config;
}

/**
 * Serializes and atomically writes configuration to disk.
 */
export function saveConfig(config: AppConfig, customPath?: string): void {
  validatePorts(config);
  const targetPath = customPath || configPath();
  const rawObj = appConfigToRawJson(config);
  const json = JSON.stringify(rawObj, null, 2);
  writeAtomic(targetPath, json);
}
