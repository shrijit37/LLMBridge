import { randomUUID } from 'node:crypto';

export type ApiFormat = 'anthropic' | 'openai' | 'gemini';
export type OpenAiApiVersion = 'responses' | 'chat_completions';

export interface RouteRule {
  id: string;
  pattern: string;
  target: string;
  enabled: boolean;
}

export interface Provider {
  id: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: ApiFormat;
  apiVersion?: OpenAiApiVersion;
  modelMap: Record<string, string>;
  routes: RouteRule[];
  enabled: boolean;
  fallback: boolean;
  injectThinkingHistory: boolean;
  strictThinkingHistory: boolean;
  quotaCommand?: string;
  port?: number;
  testModel?: string;
  maxTokensCap?: number;
  extraHeaders: Record<string, string>;
}
export interface LanesConfig {
  enabled: boolean;
  proxyBase: string;
  ports: number[];
  ctlUrl: string;
  token?: string;
  endpointName?: string;
  maxRotationsPerWindow?: number;
  windowSecs?: number;
}

export interface AppConfig {
  current: string;
  listen: string;
  providers: Record<string, Provider>;
  lanes?: LanesConfig;
  dbPath?: string;
  requestLogLimit: number;
}

export const DEFAULT_LISTEN = '127.0.0.1:7896';
export const DEFAULT_REQUEST_LOG_LIMIT = 100;

export function createDefaultRouteRule(pattern = ''): RouteRule {
  return {
    id: randomUUID(),
    pattern,
    target: '',
    enabled: true,
  };
}

export function createDefaultProvider(id: string = randomUUID()): Provider {
  return {
    id,
    baseUrl: '',
    apiKey: '',
    apiFormat: 'anthropic',
    apiVersion: 'responses',
    modelMap: {},
    routes: [],
    enabled: true,
    fallback: false,
    injectThinkingHistory: true,
    strictThinkingHistory: false,
    extraHeaders: {},
  };
}

export function createDefaultConfig(): AppConfig {
  return {
    current: '',
    listen: DEFAULT_LISTEN,
    providers: {},
    requestLogLimit: DEFAULT_REQUEST_LOG_LIMIT,
  };
}

/**
 * Raw wire representation in config.json matching Rust serde snake_case naming.
 */
export interface RawRouteRuleJson {
  id?: string;
  pattern?: string;
  target?: string;
  enabled?: boolean;
}

export interface RawProviderJson {
  id?: string;
  base_url?: string;
  api_key?: string;
  api_format?: ApiFormat;
  api_version?: OpenAiApiVersion;
  model_map?: Record<string, string>;
  routes?: RawRouteRuleJson[];
  enabled?: boolean;
  fallback?: boolean;
  inject_thinking_history?: boolean;
  strict_thinking_history?: boolean;
  quota_command?: string;
  quota_curl?: string;
  port?: number;
  test_model?: string;
  max_tokens_cap?: number;
  extra_headers?: Record<string, string>;
}

export interface RawLanesConfigJson {
  enabled?: boolean;
  proxy_base?: string;
  ports?: number[];
  ctl_url?: string;
  token?: string;
  endpoint_name?: string;
  max_rotations_per_window?: number;
  window_secs?: number;
}

export interface RawAppConfigJson {
  current?: string;
  listen?: string;
  providers?: Record<string, RawProviderJson>;
  lanes?: RawLanesConfigJson;
  db_path?: string;
  request_log_limit?: number;
}

export function rawJsonToAppConfig(raw: RawAppConfigJson): AppConfig {
  const providers: Record<string, Provider> = {};
  if (raw.providers && typeof raw.providers === 'object') {
    for (const [name, p] of Object.entries(raw.providers)) {
      if (!p || typeof p !== 'object') continue;
      const routes: RouteRule[] = Array.isArray(p.routes)
        ? p.routes.map((r) => ({
            id: r.id || randomUUID(),
            pattern: r.pattern || '',
            target: r.target || '',
            enabled: r.enabled ?? true,
          }))
        : [];

      providers[name] = {
        id: p.id || randomUUID(),
        baseUrl: p.base_url || '',
        apiKey: p.api_key || '',
        apiFormat: p.api_format || 'anthropic',
        apiVersion: p.api_version,
        modelMap: p.model_map ? { ...p.model_map } : {},
        routes,
        enabled: p.enabled ?? true,
        fallback: Boolean(p.fallback),
        injectThinkingHistory: p.inject_thinking_history ?? true,
        strictThinkingHistory: Boolean(p.strict_thinking_history),
        quotaCommand: p.quota_command || p.quota_curl,
        port: typeof p.port === 'number' ? p.port : undefined,
        testModel: p.test_model,
        maxTokensCap: typeof p.max_tokens_cap === 'number' ? p.max_tokens_cap : undefined,
        extraHeaders: p.extra_headers ? { ...p.extra_headers } : {},
      };
    }
  }

  let lanes: LanesConfig | undefined;
  if (raw.lanes && typeof raw.lanes === 'object') {
    lanes = {
      enabled: raw.lanes.enabled ?? true,
      proxyBase: raw.lanes.proxy_base || 'http://lane-egress',
      ports:
        Array.isArray(raw.lanes.ports) && raw.lanes.ports.length > 0
          ? raw.lanes.ports
          : [8001, 8002, 8003, 8004],
      ctlUrl: raw.lanes.ctl_url || 'http://lane-egress:9100',
      token: raw.lanes.token,
      endpointName: raw.lanes.endpoint_name,
      maxRotationsPerWindow: raw.lanes.max_rotations_per_window,
      windowSecs: raw.lanes.window_secs,
    };
  }

  return {
    current: raw.current || '',
    listen: raw.listen || DEFAULT_LISTEN,
    providers,
    lanes,
    dbPath: raw.db_path,
    requestLogLimit: raw.request_log_limit ?? DEFAULT_REQUEST_LOG_LIMIT,
  };
}

export function appConfigToRawJson(config: AppConfig): RawAppConfigJson {
  const rawProviders: Record<string, RawProviderJson> = {};
  for (const [name, p] of Object.entries(config.providers)) {
    const rawRoutes: RawRouteRuleJson[] = p.routes.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      target: r.target,
      enabled: r.enabled,
    }));

    const rawP: RawProviderJson = {
      id: p.id,
      base_url: p.baseUrl,
      api_key: p.apiKey,
      api_format: p.apiFormat,
      model_map: Object.keys(p.modelMap).length > 0 ? p.modelMap : undefined,
      routes: rawRoutes.length > 0 ? rawRoutes : undefined,
      enabled: p.enabled,
      fallback: p.fallback ? true : undefined,
      api_version: p.apiVersion,
      inject_thinking_history: p.injectThinkingHistory ? undefined : false,
      strict_thinking_history: p.strictThinkingHistory ? true : undefined,
      quota_command: p.quotaCommand,
      port: p.port,
      test_model: p.testModel,
      max_tokens_cap: p.maxTokensCap,
      extra_headers: Object.keys(p.extraHeaders).length > 0 ? p.extraHeaders : undefined,
    };
    rawProviders[name] = rawP;
  }
  let rawLanes: RawLanesConfigJson | undefined;
  if (config.lanes) {
    rawLanes = {
      enabled: config.lanes.enabled,
      proxy_base: config.lanes.proxyBase,
      ports: config.lanes.ports,
      ctl_url: config.lanes.ctlUrl,
      token: config.lanes.token,
      endpoint_name: config.lanes.endpointName,
      max_rotations_per_window: config.lanes.maxRotationsPerWindow,
      window_secs: config.lanes.windowSecs,
    };
  }

  return {
    current: config.current,
    listen: config.listen,
    providers: rawProviders,
    lanes: rawLanes,
    db_path: config.dbPath,
    request_log_limit: config.requestLogLimit,
  };
}
