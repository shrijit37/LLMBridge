import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  GatewayDatabase,
  RingBuffer,
} from '../src/storage/index.js';
import {
  createGatewayApp,
  PinnedListenerManager,
} from '../src/server/index.js';
import {
  createDefaultConfig,
  createDefaultProvider,
  saveConfig,
} from '../src/config/index.js';
import { ConfigWatcher } from '../src/config/watcher.js';
import { CircuitBreaker } from '../src/proxy/circuit-breaker.js';

describe('Storage & Server', () => {
  let tmpDir: string;
  let dbPath: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-storage-test-'));
    dbPath = path.join(tmpDir, 'test.db');
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GatewayDatabase', () => {
    it('records and accumulates provider and model stats', () => {
      const db = new GatewayDatabase(dbPath);

      db.recordStats('p-1', 'OpenAI', 'gpt-4o', {
        requests: 1,
        failures: 0,
        input: 100,
        output: 50,
        latencyMs: 200,
      });

      db.recordStats('p-1', 'OpenAI', 'gpt-4o', {
        requests: 1,
        failures: 1,
        input: 50,
        output: 25,
        latencyMs: 150,
      });

      const stats = db.getProviderStats();
      expect(stats.length).toBe(1);
      expect(stats[0]?.provider_id).toBe('p-1');
      expect(stats[0]?.requests).toBe(2);
      expect(stats[0]?.failures).toBe(1);
      expect(stats[0]?.input).toBe(150);
      expect(stats[0]?.output).toBe(75);
      expect(stats[0]?.latency_total).toBe(350);

      const modelStats = db.getModelStats('p-1');
      expect(modelStats.length).toBe(1);
      expect(modelStats[0]?.model_name).toBe('gpt-4o');
      expect(modelStats[0]?.input).toBe(150);
      expect(modelStats[0]?.output).toBe(75);

      db.close();
    });

    it('records and prunes request logs based on limit', () => {
      const db = new GatewayDatabase(dbPath);

      for (let i = 1; i <= 5; i++) {
        db.recordRequestLog(
          {
            timestamp_ms: Date.now(),
            provider_name: 'p-1',
            model: 'gpt-4o',
            status: 200,
            latency_ms: 100,
            input_tokens: 10,
            output_tokens: 20,
            is_stream: 0,
          },
          3 // prune keep limit = 3
        );
      }

      const logs = db.getRequestLogs(10);
      expect(logs.length).toBe(3);
      db.close();
    });

    it('saves and retrieves quota output', () => {
      const db = new GatewayDatabase(dbPath);
      db.saveQuotaOutput('p-1', 'DeepSeek', 'Balance: $15.50');
      const stats = db.getProviderStats();
      expect(stats[0]?.quota_output).toBe('Balance: $15.50');
      db.close();
    });
  });

  describe('RingBuffer', () => {
    it('maintains recent items in LIFO order and respects capacity', () => {
      const ring = new RingBuffer<string>(3);
      ring.push('item 1');
      ring.push('item 2');
      ring.push('item 3');
      ring.push('item 4');

      expect(ring.size()).toBe(3);
      const recent = ring.getRecent();
      expect(recent).toEqual(['item 4', 'item 3', 'item 2']);
    });
  });

  describe('Hono HTTP App & Pinned Listener', () => {
    it('serves /health, /stats, and /v1/models endpoints', async () => {
      const config = createDefaultConfig();
      config.current = 'openai-main';
      config.providers['openai-main'] = {
        ...createDefaultProvider('p-openai'),
        baseUrl: 'https://api.openai.com',
        testModel: 'gpt-4o',
        enabled: true,
      };
      saveConfig(config, configPath);

      const configWatcher = new ConfigWatcher({ configPath });
      configWatcher.start();

      const db = new GatewayDatabase(':memory:');
      db.recordStats('p-openai', 'openai-main', 'gpt-4o', { requests: 5, input: 100, output: 200 });

      const ringBuffer = new RingBuffer<Record<string, unknown>>(10);
      const circuitBreaker = new CircuitBreaker();

      const app = createGatewayApp({
        configWatcher,
        db,
        ringBuffer,
        circuitBreaker,
      });

      // GET /health
      const healthRes = await app.request('/health');
      expect(healthRes.status).toBe(200);
      const healthJson = (await healthRes.json()) as Record<string, unknown>;
      expect(healthJson['status']).toBe('ok');
      expect(healthJson['service']).toBe('llmbridge-api');
      expect(healthJson['version']).toBeDefined();
      expect(healthJson['checks']).toEqual({ database: 'up', providers: 'up' });

      // GET /stats
      const statsRes = await app.request('/stats');
      expect(statsRes.status).toBe(200);
      const statsJson = (await statsRes.json()) as Record<string, unknown>;
      const data = statsJson['data'] as unknown[];
      expect(data.length).toBe(1);

      // GET /v1/models (Anthropic format default)
      const modelsRes = await app.request('/v1/models');
      expect(modelsRes.status).toBe(200);
      const modelsJson = (await modelsRes.json()) as Record<string, unknown>;
      expect(modelsJson['data']).toBeDefined();

      // GET /v1/models (OpenAI format with Bearer auth)
      const openAiModelsRes = await app.request('/v1/models', {
        headers: { authorization: 'Bearer test' },
      });
      expect(openAiModelsRes.status).toBe(200);
      const openAiModelsJson = (await openAiModelsRes.json()) as Record<string, unknown>;
      expect(openAiModelsJson['object']).toBe('list');

      configWatcher.stop();
      db.close();
    });

    it('/health reports ok when a provider is selected and the store is readable', async () => {
      const config = createDefaultConfig();
      config.current = 'openai-main';
      config.providers['openai-main'] = {
        ...createDefaultProvider('p-openai'),
        baseUrl: 'https://api.openai.com',
        enabled: true,
      };
      saveConfig(config, configPath);

      const configWatcher = new ConfigWatcher({ configPath });
      configWatcher.start();

      const db = new GatewayDatabase(':memory:');
      const app = createGatewayApp({
        configWatcher,
        db,
        ringBuffer: new RingBuffer<Record<string, unknown>>(10),
        circuitBreaker: new CircuitBreaker(),
      });

      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json['status']).toBe('ok');
      expect(json['service']).toBe('llmbridge-api');
      expect(json['checks']).toEqual({ database: 'up', providers: 'up' });

      configWatcher.stop();
      db.close();
    });

    it('/health returns degraded (200) when no provider is selected', async () => {
      const config = createDefaultConfig();
      // No providers and no current provider: the process is alive but cannot
      // route a single request. This is exactly the state the deploy gate
      // must refuse to promote.
      config.providers = {};
      config.current = '';
      saveConfig(config, configPath);

      const configWatcher = new ConfigWatcher({ configPath });
      configWatcher.start();

      const db = new GatewayDatabase(':memory:');
      const app = createGatewayApp({
        configWatcher,
        db,
        ringBuffer: new RingBuffer<Record<string, unknown>>(10),
        circuitBreaker: new CircuitBreaker(),
      });

      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json['status']).toBe('degraded');
      expect(json['checks']).toEqual({ database: 'up', providers: 'down' });

      configWatcher.stop();
      db.close();
    });

    it('spawns and stops pinned port listeners via PinnedListenerManager', async () => {
      const config = createDefaultConfig();
      config.providers['pinned-test'] = {
        ...createDefaultProvider('p-pinned'),
        baseUrl: 'https://api.pinned.com',
        port: 18991,
        enabled: true,
      };
      saveConfig(config, configPath);

      const configWatcher = new ConfigWatcher({ configPath });
      configWatcher.start();

      const db = new GatewayDatabase(':memory:');
      const ringBuffer = new RingBuffer<Record<string, unknown>>(10);
      const circuitBreaker = new CircuitBreaker();

      const manager = new PinnedListenerManager({
        configWatcher,
        db,
        ringBuffer,
        circuitBreaker,
      });

      manager.reconcile(config);
      const ports = manager.getActivePorts();
      expect(ports).toContain(18991);

      // Probe pinned port endpoint
      const res = await fetch('http://127.0.0.1:18991/health');
      expect(res.status).toBe(200);

      manager.stopAll();
      configWatcher.stop();
      db.close();
    });
  });
});
