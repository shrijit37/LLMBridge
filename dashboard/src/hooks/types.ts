/** Mirror of GatewayDatabase.ProviderStatsRecord */
export interface ProviderStat {
  provider_id: string;
  provider_name: string;
  input: number;
  output: number;
  requests: number;
  failures: number;
  latency_total: number;
  quota_output: string | null;
}

/** Mirror of storage.RequestLogRecord */
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

export interface HealthSnapshot {
  status: string;
  active_provider: string;
  providers_count: number;
  version: string;
  uptime: number;
}

export interface LanesSnapshot {
  enabled: boolean;
  message?: string;
  status: Record<string, unknown> | null;
}

export interface StatusSnapshot {
  health: HealthSnapshot;
  stats: ProviderStat[];
  logs: RequestLogRecord[];
  lanes: LanesSnapshot;
  config: {
    listen: string;
    current: string;
    requestLogLimit: number;
    providers: string[];
  };
}

/** Model usage row (GatewayDatabase.ModelStatsRecord). */
export interface ModelStat {
  provider_id: string;
  provider_name: string;
  model_name: string;
  input: number;
  output: number;
}

/** Sanitized provider config row from /api/providers. */
export interface ProviderInfo {
  name: string;
  id: string;
  enabled: boolean;
  base_url: string;
  api_format: string;
  api_version?: string;
  port: number | null;
  fallback: boolean;
  test_model: string | null;
  max_tokens_cap: number | null;
  inject_thinking_history: boolean;
  routes: { pattern: string; target: string }[];
  model_map_keys: string[];
}

/** Circuit breaker row from /api/breakers. */
export interface BreakerInfo {
  provider_name: string;
  provider_id: string;
  state: "closed" | "open" | "half_open";
}
