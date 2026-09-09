import fs from 'node:fs';
import path from 'node:path';
import { type AppConfig } from './types.js';
import { configPath, loadConfig } from './loader.js';

export type ConfigChangeListener = (config: AppConfig) => void;

export class ConfigWatcher {
  private targetPath: string;
  private debounceMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private listeners: Set<ConfigChangeListener> = new Set();
  private currentConfig: AppConfig | null = null;

  constructor(options?: { configPath?: string; debounceMs?: number }) {
    this.targetPath = options?.configPath || configPath();
    this.debounceMs = options?.debounceMs ?? 200;
  }

  public get config(): AppConfig {
    if (!this.currentConfig) {
      this.currentConfig = loadConfig(this.targetPath);
    }
    return this.currentConfig;
  }

  /** The config file path being watched (resolved from the constructor). */
  public get configPath(): string {
    return this.targetPath;
  }

  public onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public start(): void {
    if (this.watcher) {
      return;
    }

    // Initial load
    this.currentConfig = loadConfig(this.targetPath);

    const dir = path.dirname(this.targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Watch directory to catch rename / atomic write replacement
    this.watcher = fs.watch(dir, (_eventType, filename) => {
      const targetFilename = path.basename(this.targetPath);
      if (filename && filename !== targetFilename) {
        return;
      }
      clearTimeout(this.debounceTimer!);

      this.debounceTimer = setTimeout(() => {
        this.reload();
      }, this.debounceMs);
    });
  }

  public stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  public reload(): AppConfig | null {
    try {
      if (!fs.existsSync(this.targetPath)) {
        return null;
      }
      const newConfig = loadConfig(this.targetPath);
      this.currentConfig = newConfig;
      for (const listener of this.listeners) {
        try {
          listener(newConfig);
        } catch (err) {
          console.error('[ConfigWatcher] Listener error:', err);
        }
      }
      return newConfig;
    } catch (err) {
      console.warn(`[ConfigWatcher] Failed to reload config: ${String(err)}`);
      return null;
    }
  }
}
