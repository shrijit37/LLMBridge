import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

const req = createRequire(import.meta.url);
const { DatabaseSync } = req('node:sqlite');

export interface StatsDelta {
  requests?: number;
  failures?: number;
  input?: number;
  output?: number;
  latencyMs?: number;
}

export interface ProviderStatsRecord {
  provider_id: string;
  provider_name: string;
  input: number;
  output: number;
  requests: number;
  failures: number;
  latency_total: number;
  quota_output: string | null;
}

export interface ModelStatsRecord {
  provider_id: string;
  provider_name: string;
  model_name: string;
  input: number;
  output: number;
}

export interface RequestLogRecord {
  id?: number;
  timestamp_ms: number;
  provider_name: string;
  model: string;
  status: number;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  is_stream: number;
  error?: string | null;
  request_body?: string | null;
  response_body?: string | null;
}

export class GatewayDatabase {
  private db: DatabaseSyncType;

  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    try {
      this.db = new DatabaseSync(dbPath);
    } catch {
      // In-memory fallback
      this.db = new DatabaseSync(':memory:');
    }

    if (dbPath !== ':memory:') {
      try {
        this.db.exec('PRAGMA journal_mode = WAL;');
      } catch {
        // Ignore WAL pragma failure on memory or restricted filesystems
      }
    }

    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_stats (
        provider_id   TEXT PRIMARY KEY,
        provider_name TEXT NOT NULL,
        input         INTEGER NOT NULL DEFAULT 0,
        output        INTEGER NOT NULL DEFAULT 0,
        requests      INTEGER NOT NULL DEFAULT 0,
        failures      INTEGER NOT NULL DEFAULT 0,
        latency_total INTEGER NOT NULL DEFAULT 0,
        quota_output  TEXT
      );

      CREATE TABLE IF NOT EXISTS model_stats (
        provider_id   TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        model_name    TEXT NOT NULL,
        input         INTEGER NOT NULL DEFAULT 0,
        output        INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (provider_id, model_name)
      );

      CREATE TABLE IF NOT EXISTS provider_models (
        provider_id   TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        model_name    TEXT NOT NULL,
        PRIMARY KEY (provider_id, model_name)
      );

      CREATE TABLE IF NOT EXISTS request_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms  INTEGER NOT NULL,
        provider_name TEXT NOT NULL,
        model         TEXT NOT NULL DEFAULT '',
        status        INTEGER NOT NULL,
        latency_ms    INTEGER NOT NULL DEFAULT 0,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        is_stream     INTEGER NOT NULL DEFAULT 0,
        error         TEXT,
        request_body  TEXT,
        response_body TEXT
      );
    `);
  }

  public recordStats(
    providerId: string,
    providerName: string,
    modelName: string | undefined,
    delta: StatsDelta
  ): void {
    const input = delta.input ?? 0;
    const output = delta.output ?? 0;
    const requests = delta.requests ?? 0;
    const failures = delta.failures ?? 0;
    const latencyTotal = delta.latencyMs ?? 0;

    const stmt = this.db.prepare(`
      INSERT INTO provider_stats (provider_id, provider_name, input, output, requests, failures, latency_total)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        provider_name = excluded.provider_name,
        input = input + excluded.input,
        output = output + excluded.output,
        requests = requests + excluded.requests,
        failures = failures + excluded.failures,
        latency_total = latency_total + excluded.latency_total
    `);
    stmt.run(providerId, providerName, input, output, requests, failures, latencyTotal);

    if (modelName && modelName.trim().length > 0) {
      const modelStmt = this.db.prepare(`
        INSERT INTO model_stats (provider_id, provider_name, model_name, input, output)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider_id, model_name) DO UPDATE SET
          provider_name = excluded.provider_name,
          input = input + excluded.input,
          output = output + excluded.output
      `);
      modelStmt.run(providerId, providerName, modelName, input, output);
    }
  }

  public saveQuotaOutput(providerId: string, providerName: string, quotaOutput: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO provider_stats (provider_id, provider_name, quota_output)
      VALUES (?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        provider_name = excluded.provider_name,
        quota_output = excluded.quota_output
    `);
    stmt.run(providerId, providerName, quotaOutput);
  }

  public recordRequestLog(entry: RequestLogRecord, pruneLimit = 100): number {
    const stmt = this.db.prepare(`
      INSERT INTO request_log (
        timestamp_ms, provider_name, model, status, latency_ms,
        input_tokens, output_tokens, is_stream, error, request_body, response_body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const res = stmt.run(
      entry.timestamp_ms,
      entry.provider_name,
      entry.model,
      entry.status,
      entry.latency_ms,
      entry.input_tokens,
      entry.output_tokens,
      entry.is_stream,
      entry.error ?? null,
      entry.request_body ?? null,
      entry.response_body ?? null
    );

    const insertedId = Number(res.lastInsertRowid);
    if (pruneLimit > 0) {
      this.pruneRequestLogs(pruneLimit);
    }
    return insertedId;
  }

  public pruneRequestLogs(keepCount = 100): void {
    const stmt = this.db.prepare(`
      DELETE FROM request_log
      WHERE id NOT IN (
        SELECT id FROM request_log
        ORDER BY id DESC
        LIMIT ?
      )
    `);
    stmt.run(keepCount);
  }

  public clearRequestLogs(): void {
    this.db.exec('DELETE FROM request_log;');
  }

  public getProviderStats(): ProviderStatsRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM provider_stats
      ORDER BY requests DESC
    `);
    return stmt.all() as unknown as ProviderStatsRecord[];
  }

  public getModelStats(providerId?: string): ModelStatsRecord[] {
    if (providerId) {
      const stmt = this.db.prepare(`
        SELECT * FROM model_stats
        WHERE provider_id = ?
        ORDER BY input + output DESC
      `);
      return stmt.all(providerId) as unknown as ModelStatsRecord[];
    }
    const stmt = this.db.prepare(`
      SELECT * FROM model_stats
      ORDER BY input + output DESC
    `);
    return stmt.all() as unknown as ModelStatsRecord[];
  }

  public getRequestLogs(limit = 100): RequestLogRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM request_log
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(limit) as unknown as RequestLogRecord[];
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      // Ignore already closed
    }
  }
}
