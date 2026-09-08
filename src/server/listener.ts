import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { AppConfig } from '../config/types.js';
import type { ConfigWatcher } from '../config/watcher.js';
import type { GatewayDatabase } from '../storage/db.js';
import type { RingBuffer } from '../storage/ring-buffer.js';
import type { CircuitBreaker } from '../proxy/circuit-breaker.js';
import type { LaneManager } from '../proxy/lane-manager.js';
import { createGatewayApp } from './app.js';

export interface PinnedListenerOptions {
  configWatcher: ConfigWatcher;
  db: GatewayDatabase;
  ringBuffer: RingBuffer<Record<string, unknown>>;
  circuitBreaker: CircuitBreaker;
  laneManager?: LaneManager;
}

interface ActiveListener {
  port: number;
  providerName: string;
  server: ServerType;
}

/**
 * Manages dedicated HTTP listeners bound to provider-specific pinned ports.
 * Requests arriving at a pinned port route exclusively to that provider.
 */
export class PinnedListenerManager {
  private options: PinnedListenerOptions;
  private listeners = new Map<number, ActiveListener>();

  constructor(options: PinnedListenerOptions) {
    this.options = options;
  }

  public reconcile(config: AppConfig): void {
    const desiredPorts = new Map<number, string>();

    for (const [name, provider] of Object.entries(config.providers)) {
      if (provider.port !== undefined && provider.enabled) {
        desiredPorts.set(provider.port, name);
      }
    }

    // Stop removed or changed ports
    for (const [port, active] of this.listeners.entries()) {
      const desiredProvider = desiredPorts.get(port);
      if (!desiredProvider || desiredProvider !== active.providerName) {
        active.server.close();
        this.listeners.delete(port);
      }
    }

    // Start newly desired ports
    for (const [port, providerName] of desiredPorts.entries()) {
      if (!this.listeners.has(port)) {
        try {
          const app = createGatewayApp({
            ...this.options,
            pinnedProviderName: providerName,
          });

          const server = serve({
            fetch: app.fetch,
            port,
            hostname: '0.0.0.0',
          });

          this.listeners.set(port, {
            port,
            providerName,
            server,
          });
        } catch (err) {
          console.error(
            `[PinnedListenerManager] Failed to bind pinned port ${port} for provider ${providerName}:`,
            err
          );
        }
      }
    }
  }

  public getActivePorts(): number[] {
    return Array.from(this.listeners.keys());
  }

  public stopAll(): void {
    for (const active of this.listeners.values()) {
      try {
        active.server.close();
      } catch {
        // Ignore close errors on teardown
      }
    }
    this.listeners.clear();
  }
}
