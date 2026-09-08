#!/usr/bin/env node
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { Hono } from 'hono';
import { ConfigWatcher } from './config/watcher.js';
import { parseListenPort, resolveDbPath } from './config/loader.js';
import { GatewayDatabase } from './storage/db.js';
import { RingBuffer } from './storage/ring-buffer.js';
import { CircuitBreaker } from './proxy/circuit-breaker.js';
import { LaneManager } from './proxy/lane-manager.js';
import { createGatewayApp } from './server/app.js';
import { PinnedListenerManager } from './server/listener.js';

export interface GatewayInstance {
  app: Hono;
  server: ServerType;
  db: GatewayDatabase;
  configWatcher: ConfigWatcher;
  pinnedManager: PinnedListenerManager;
  laneManager: LaneManager;
  port: number;
  close: () => void;
}

export async function startGateway(options?: {
  configPath?: string;
  port?: number;
  dbPath?: string;
}): Promise<GatewayInstance> {
  const configWatcher = new ConfigWatcher({ configPath: options?.configPath });
  configWatcher.start();

  const initialConfig = configWatcher.config;
  const dbFile = options?.dbPath || resolveDbPath(initialConfig);
  const db = new GatewayDatabase(dbFile);

  const ringBuffer = new RingBuffer<Record<string, unknown>>(initialConfig.requestLogLimit);
  const circuitBreaker = new CircuitBreaker();
  const laneManager = new LaneManager(initialConfig.lanes);

  const appContext = {
    configWatcher,
    db,
    ringBuffer,
    circuitBreaker,
    laneManager,
  };

  const app = createGatewayApp(appContext);

  const listenPort = options?.port || parseListenPort(initialConfig.listen) || 7896;
  const listenHost = initialConfig.listen.split(':')[0] || '127.0.0.1';

  const mainServer = serve({
    fetch: app.fetch,
    port: listenPort,
    hostname: listenHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
  });

  console.log(`[ccMesh Gateway] Listening on http://${listenHost}:${listenPort}`);

  const pinnedManager = new PinnedListenerManager(appContext);
  pinnedManager.reconcile(initialConfig);

  configWatcher.onChange((newConfig) => {
    console.log('[ccMesh Gateway] Configuration reloaded');
    pinnedManager.reconcile(newConfig);
    ringBuffer.resize(newConfig.requestLogLimit);
    laneManager.updateConfig(newConfig.lanes);
  });

  const cleanup = () => {
    console.log('[ccMesh Gateway] Shutting down...');
    pinnedManager.stopAll();
    laneManager.close();
    mainServer.close();
    configWatcher.stop();
    db.close();
    process.exit(0);
  };

  if (!process.env['VITEST']) {
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  return {
    app,
    server: mainServer,
    db,
    configWatcher,
    pinnedManager,
    laneManager,
    port: listenPort,
    close: () => {
      pinnedManager.stopAll();
      laneManager.close();
      mainServer.close();
      configWatcher.stop();
      db.close();
    },
  };
}

// Auto-start when executed directly
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  startGateway().catch((err) => {
    console.error('[ccMesh Gateway] Fatal startup error:', err);
    process.exit(1);
  });
}
