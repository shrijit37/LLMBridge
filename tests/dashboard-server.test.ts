import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { startGateway, type GatewayInstance } from '../src/index.js';
import { saveConfig } from '../src/config/index.js';

/**
 * Dashboard integration: SSE /events feed + static bundle serving.
 * The gateway serves the built dashboard (when dashboard/dist exists) at
 * /dashboard, and streams log/stats events to /events.
 */
describe('Dashboard server integration', () => {
  let tmpDir: string;
  let configPath: string;
  let dbPath: string;
  let gateway: GatewayInstance;
  let mockServer: http.Server;
  const PORT = 19870;
  const MOCK_PORT = 19871;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-dash-'));
    configPath = path.join(tmpDir, 'config.json');
    dbPath = path.join(tmpDir, 'gateway.db');

    // Mock Anthropic upstream.
    mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-20250514',
            content: [{ type: 'text', text: 'hi from mock' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 11, output_tokens: 5 },
          })
        );
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(MOCK_PORT, resolve));

    // Config with one Anthropic provider.
    saveConfig(
      {
        current: 'mock',
        listen: `127.0.0.1:${PORT}`,
        requestLogLimit: 100,
        dbPath,
        providers: {
          mock: {
            id: 'mock-prov',
            baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
            apiKey: 'sk-test',
            apiFormat: 'anthropic',
            modelMap: {},
            routes: [],
            enabled: true,
            fallback: false,
            injectThinkingHistory: false,
            strictThinkingHistory: false,
            extraHeaders: {},
          },
        },
        lanes: { enabled: false, proxyBase: 'http://lane-egress', ports: [8001], ctlUrl: 'http://lane-egress:9100' },
      },
      configPath
    );

    gateway = await startGateway({ configPath, port: PORT, dbPath });
  });

  afterAll(async () => {
    gateway?.close();
    mockServer?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves /api/status snapshot', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      health: { status: string; active_provider: string };
      config: { providers: string[] };
    };
    expect(body.health.status).toBe('ok');
    expect(body.health.active_provider).toBe('mock');
    expect(body.config.providers).toContain('mock');
  });

  it('exposes models / providers / breakers endpoints', async () => {
    const [models, providers, breakers] = await Promise.all([
      fetch(`http://127.0.0.1:${PORT}/api/models`).then((r) => r.json()),
      fetch(`http://127.0.0.1:${PORT}/api/providers`).then((r) => r.json()),
      fetch(`http://127.0.0.1:${PORT}/api/breakers`).then((r) => r.json()),
    ]);
    const modelRows = models as { data: { model_name: string }[] };
    const providerRows = providers as { data: { name: string; base_url: string }[] };
    const breakerRows = breakers as { data: { provider_name: string; state: string }[] };

    expect(Array.isArray(modelRows.data)).toBe(true);
    expect(providerRows.data.some((p) => p.name === 'mock')).toBe(true);
    // Sanitized: no sensitive credential fields exposed.
    expect(providerRows.data[0]).not.toHaveProperty('api_key');
    expect(providerRows.data[0]).not.toHaveProperty('apiKey');
    expect(providerRows.data[0]).not.toHaveProperty('password');
    expect(providerRows.data[0]).not.toHaveProperty('token');
    expect(breakerRows.data.some((b) => b.provider_name === 'mock')).toBe(true);
    expect(breakerRows.data.find((b) => b.provider_name === 'mock')?.state).toBe('closed');
  });

  it('rejects cross-origin mutations (CSRF guard)', async () => {
    const base = `http://127.0.0.1:${PORT}`;
    const res = await fetch(`${base}/api/logs/clear`, {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Cross-origin');
  });

  it('control plane: toggle provider, reset breaker, clear logs', async () => {
    const base = `http://127.0.0.1:${PORT}`;

    // Toggle the mock provider off then back on.
    const off = await fetch(`${base}/api/providers/mock/toggle`, { method: 'POST' });
    expect(off.status).toBe(200);
    const offBody = (await off.json()) as { ok: boolean; enabled: boolean };
    expect(offBody.ok).toBe(true);
    expect(offBody.enabled).toBe(false);

    const on = await fetch(`${base}/api/providers/mock/toggle`, { method: 'POST' });
    const onBody = (await on.json()) as { ok: boolean; enabled: boolean };
    expect(onBody.ok).toBe(true);
    expect(onBody.enabled).toBe(true);

    // Reset a breaker (state should still be closed for an idle provider).
    const reset = await fetch(`${base}/api/breakers/mock-prov/reset`, { method: 'POST' });
    expect(reset.status).toBe(200);
    const resetBody = (await reset.json()) as { ok: boolean; state: string };
    expect(resetBody.ok).toBe(true);

    // Clear request logs (no traffic yet → still ok).
    const clear = await fetch(`${base}/api/logs/clear`, { method: 'POST' });
    expect(clear.status).toBe(200);
    const clearBody = (await clear.json()) as { ok: boolean };
    expect(clearBody.ok).toBe(true);

    // Toggle lanes on → off (config mutation round-trips through the watcher).
    const lanesOn = await fetch(`${base}/api/lanes/toggle`, { method: 'POST' });
    expect(lanesOn.status).toBe(200);
    const lanesOnBody = (await lanesOn.json()) as { enabled: boolean };
    expect(lanesOnBody.enabled).toBe(true);

    const lanesOff = await fetch(`${base}/api/lanes/toggle`, { method: 'POST' });
    const lanesOffBody = (await lanesOff.json()) as { enabled: boolean };
    expect(lanesOffBody.enabled).toBe(false);
  });

  it('control plane: config patch write round-trips', async () => {
    const base = `http://127.0.0.1:${PORT}`;
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_log_limit: 250, listen: `127.0.0.1:${PORT}` }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // The patch lands on the SAME file the watcher watches (tmpDir/config.json).
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      request_log_limit: number;
      listen: string;
    };
    expect(onDisk.request_log_limit).toBe(250);
    expect(onDisk.listen).toBe(`127.0.0.1:${PORT}`);
  });

  it('streams log events on /events after traffic', async () => {
    const controller = new AbortController();
    const streamPromise = fetch(`http://127.0.0.1:${PORT}/events`, {
      signal: controller.signal,
    });

    // Send a request through the gateway so it logs + records stats.
    const ingress = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-test',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(ingress.status).toBe(200);

    const res = await streamPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let sawLog = false;
    let sawStats = false;
    let logPayload: unknown;
    let buf = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = frame.split('\n');
        const eventLine = lines.find((l) => l.startsWith('event: '));
        const dataLine = lines.find((l) => l.startsWith('data: '));
        const eventName = eventLine ? eventLine.slice('event: '.length) : '';
        if (eventName === 'log') {
          sawLog = true;
          if (dataLine) {
            try {
              logPayload = JSON.parse(dataLine.slice('data: '.length));
            } catch {
              logPayload = undefined;
            }
          }
        }
        if (eventName === 'stats') sawStats = true;
        idx = buf.indexOf('\n\n');
      }
      if (sawLog && sawStats) break;
    }
    controller.abort();

    // Both named events should have arrived (log from the ingress, stats from recordStats).
    expect(sawLog).toBe(true);
    expect(sawStats).toBe(true);
    // The log frame must carry the emitted record, not an empty payload.
    expect(logPayload).toMatchObject({
      provider_name: expect.any(String),
      model: expect.any(String),
    });
  });

  it('serves the dashboard bundle at /dashboard when built', async () => {
    const distDir = path.resolve(process.cwd(), 'dashboard', 'dist');
    if (!fs.existsSync(distDir)) {
      return; // dashboard not built in this checkout — skip gracefully
    }
    const res = await fetch(`http://127.0.0.1:${PORT}/dashboard`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
  });
});