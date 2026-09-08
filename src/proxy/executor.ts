import type { Provider, OpenAiApiVersion } from '../config/types.js';
import { resolveApiKey, resolveExtraHeaders } from '../config/loader.js';
import { resolveModel } from '../config/matcher.js';
import type { CanonicalRequest, CanonicalResponse } from '../transform/canonical/types.js';
import {
  canonicalToAnthropicRequest,
  anthropicToCanonicalResponse,
  canonicalToAnthropicResponse,
} from '../transform/anthropic/index.js';
import {
  canonicalToOpenAiChatRequest,
  openaiChatToCanonicalResponse,
  canonicalToOpenAiChatResponse,
} from '../transform/openai-chat/index.js';
import {
  canonicalToOpenAiResponsesRequest,
  openaiResponsesToCanonicalResponse,
  canonicalToOpenAiResponsesResponse,
} from '../transform/openai-responses/index.js';
import {
  canonicalToGeminiRequest,
  geminiToCanonicalResponse,
} from '../transform/gemini/index.js';
import {
  openAiStreamToAnthropic,
  anthropicStreamToOpenAi,
  geminiStreamToAnthropic,
  rewriteModelInStream,
  trackTokensInStream,
} from '../transform/streaming/index.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { ResolvedPoolItem } from './router.js';
import { canPassthrough, patchStreamUsage } from './passthrough.js';

export type ClientWireFormat = 'anthropic' | 'openai_chat' | 'openai_responses';

export interface ExecuteRequestOptions {
  pool: ResolvedPoolItem[];
  doCycle: boolean;
  canonicalRequest: CanonicalRequest;
  clientFormat: ClientWireFormat;
  rawClientBody: Record<string, unknown>;
  clientHeaders: Headers;
  circuitBreaker: CircuitBreaker;
  onRecordStats?: (
    providerId: string,
    providerName: string,
    delta: { requests: number; failures: number; input: number; output: number; latencyMs: number }
  ) => void;
  onLogRequest?: (entry: {
    providerName: string;
    model: string;
    status: number;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    isStream: boolean;
    error?: string;
    requestBody?: string;
    responseBody?: string;
  }) => void;
}

export function buildEndpointUrl(
  provider: Provider,
  version: OpenAiApiVersion = 'responses',
  isStream = false
): string {
  const base = provider.baseUrl.replace(/\/+$/, '');
  switch (provider.apiFormat) {
    case 'anthropic':
      return `${base}/v1/messages`;
    case 'openai':
      return version === 'chat_completions'
        ? `${base}/v1/chat/completions`
        : `${base}/v1/responses`;
    case 'gemini':
      return isStream ? `${base}/v1beta/interactions?alt=sse` : `${base}/v1beta/interactions`;
  }
}

export function prepareHeaders(
  provider: Provider,
  apiKey: string,
  clientHeaders: Headers
): Headers {
  const headers = new Headers();
  const FORBIDDEN_HEADERS: Record<string, true> = {
    host: true,
    authorization: true,
    'x-api-key': true,
    'x-goog-api-key': true,
    'content-length': true,
    'content-type': true,
    'accept-encoding': true,
    connection: true,
  };

  for (const [key, value] of clientHeaders.entries()) {
    if (!FORBIDDEN_HEADERS[key.toLowerCase()]) {
      headers.set(key, value);
    }
  }

  headers.set('content-type', 'application/json');

  // Auth Header
  switch (provider.apiFormat) {
    case 'anthropic':
      headers.set('x-api-key', apiKey);
      break;
    case 'openai':
      headers.set('authorization', `Bearer ${apiKey}`);
      break;
    case 'gemini':
      headers.set('x-goog-api-key', apiKey);
      break;
  }

  // Extra headers
  const extra = resolveExtraHeaders(provider.extraHeaders);
  for (const [k, v] of Object.entries(extra)) {
    headers.set(k, v);
  }

  return headers;
}

/**
 * Executes a request against the provider pool with fallback cycling,
 * circuit breaking, format translation, streaming interceptors, and error classification.
 */
export async function executeProviderLoop(options: ExecuteRequestOptions): Promise<Response> {
  const {
    pool,
    doCycle,
    canonicalRequest,
    clientFormat,
    rawClientBody,
    clientHeaders,
    circuitBreaker,
    onRecordStats,
    onLogRequest,
  } = options;

  const roundSize = pool.length;
  const maxFailures = roundSize * 3;
  const maxAuthFailures = Math.max(roundSize, 1);

  let consecutiveFailures = 0;
  let authFailures = 0;
  let lastErrorResponse: Response | null = null;
  let poolIdx = 0;

  const originalModel = canonicalRequest.model;
  const rawBodyStr = JSON.stringify(rawClientBody);

  while (consecutiveFailures < maxFailures) {
    const candidate = pool[poolIdx % roundSize]!;
    poolIdx++;

    const { name: providerName, provider } = candidate;

    // Fast-fail if breaker is open
    if (!circuitBreaker.canAttempt(provider.id)) {
      consecutiveFailures++;
      if (!doCycle) break;
      continue;
    }

    // Resolve model and API key
    let apiKey = '';
    try {
      apiKey = resolveApiKey(provider.apiKey);
    } catch (err) {
      circuitBreaker.recordFailure(provider.id);
      onRecordStats?.(provider.id, providerName, {
        requests: 1,
        failures: 1,
        input: 0,
        output: 0,
        latencyMs: 0,
      });
      consecutiveFailures++;
      if (!doCycle) break;
      continue;
    }

    const { model: resolvedModel } = resolveModel(provider, originalModel);
    const reqForProvider: CanonicalRequest = {
      ...canonicalRequest,
      model: resolvedModel,
    };

    const isPassthrough = canPassthrough(clientFormat, provider, rawClientBody);
    const isStream = canonicalRequest.stream;

    let upstreamBodyObj: Record<string, unknown>;
    let effectiveVersion: OpenAiApiVersion = provider.apiVersion || 'responses';

    if (isPassthrough) {
      upstreamBodyObj = patchStreamUsage(rawClientBody);
      effectiveVersion = 'chat_completions';
    } else {
      switch (provider.apiFormat) {
        case 'anthropic':
          upstreamBodyObj = canonicalToAnthropicRequest(reqForProvider, provider);
          break;
        case 'openai':
          if (effectiveVersion === 'chat_completions') {
            upstreamBodyObj = canonicalToOpenAiChatRequest(reqForProvider, provider);
          } else {
            upstreamBodyObj = canonicalToOpenAiResponsesRequest(reqForProvider, provider);
          }
          break;
        case 'gemini':
          upstreamBodyObj = canonicalToGeminiRequest(reqForProvider, provider);
          break;
      }
    }

    const url = buildEndpointUrl(provider, effectiveVersion, isStream);
    const reqHeaders = prepareHeaders(provider, apiKey, clientHeaders);

    const t0 = Date.now();
    let res: Response;

    try {
      res = await fetch(url, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(upstreamBodyObj),
        signal: AbortSignal.timeout(300000),
      });
    } catch (netErr) {
      const latencyMs = Date.now() - t0;
      circuitBreaker.recordFailure(provider.id);
      consecutiveFailures++;
      onRecordStats?.(provider.id, providerName, {
        requests: 1,
        failures: 1,
        input: 0,
        output: 0,
        latencyMs,
      });
      onLogRequest?.({
        providerName,
        model: resolvedModel,
        status: 0,
        latencyMs,
        inputTokens: 0,
        outputTokens: 0,
        isStream,
        error: String(netErr),
        requestBody: rawBodyStr,
      });

      if (!doCycle || consecutiveFailures >= maxFailures) {
        throw new Error(`All providers failed. Last network error: ${String(netErr)}`);
      }
      continue;
    }

    const latencyMs = Date.now() - t0;

    // Handle 404 from /v1/responses by auto-retrying /v1/chat/completions on same provider
    if (
      res.status === 404 &&
      provider.apiFormat === 'openai' &&
      effectiveVersion === 'responses' &&
      !isPassthrough
    ) {
      const fallbackUrl = buildEndpointUrl(provider, 'chat_completions', isStream);
      const fallbackBody = canonicalToOpenAiChatRequest(reqForProvider, provider);
      try {
        const retryRes = await fetch(fallbackUrl, {
          method: 'POST',
          headers: reqHeaders,
          body: JSON.stringify(fallbackBody),
          signal: AbortSignal.timeout(300000),
        });
        if (retryRes.ok) {
          res = retryRes;
          effectiveVersion = 'chat_completions';
        }
      } catch {
        // Continue with original response
      }
    }

    // Success (2xx)
    if (res.ok) {
      circuitBreaker.recordSuccess(provider.id);

      if (isStream && res.body) {
        let stream = res.body;

        // Apply stream transformations based on upstream format vs client format
        if (isPassthrough) {
          stream = rewriteModelInStream(stream, originalModel);
        } else if (provider.apiFormat === 'openai' && clientFormat === 'anthropic') {
          stream = openAiStreamToAnthropic(stream, originalModel);
        } else if (provider.apiFormat === 'gemini' && clientFormat === 'anthropic') {
          stream = geminiStreamToAnthropic(stream);
        } else if (provider.apiFormat === 'anthropic' && clientFormat !== 'anthropic') {
          stream = anthropicStreamToOpenAi(
            stream,
            clientFormat === 'openai_chat' ? 'chat_completions' : 'responses'
          );
        } else {
          stream = rewriteModelInStream(stream, originalModel);
        }

        // Tap token usage non-intrusively
        stream = trackTokensInStream(stream, (usage) => {
          onRecordStats?.(provider.id, providerName, {
            requests: 1,
            failures: 0,
            input: usage.inputTokens,
            output: usage.outputTokens,
            latencyMs,
          });
          onLogRequest?.({
            providerName,
            model: resolvedModel,
            status: res.status,
            latencyMs,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            isStream: true,
            requestBody: rawBodyStr,
          });
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }

      // Buffered (non-streaming)
      const resJson = (await res.json()) as Record<string, unknown>;
      let canonicalResp: CanonicalResponse;

      if (provider.apiFormat === 'anthropic') {
        canonicalResp = anthropicToCanonicalResponse(resJson);
      } else if (provider.apiFormat === 'openai') {
        if (effectiveVersion === 'chat_completions') {
          canonicalResp = openaiChatToCanonicalResponse(resJson);
        } else {
          canonicalResp = openaiResponsesToCanonicalResponse(resJson);
        }
      } else {
        canonicalResp = geminiToCanonicalResponse(resJson);
      }

      // Override model to match client's requested alias
      canonicalResp.model = originalModel;

      let clientJson: Record<string, unknown>;
      if (clientFormat === 'anthropic') {
        clientJson = canonicalToAnthropicResponse(canonicalResp);
      } else if (clientFormat === 'openai_chat') {
        clientJson = canonicalToOpenAiChatResponse(canonicalResp);
      } else {
        clientJson = canonicalToOpenAiResponsesResponse(canonicalResp);
      }

      onRecordStats?.(provider.id, providerName, {
        requests: 1,
        failures: 0,
        input: canonicalResp.usage.inputTokens,
        output: canonicalResp.usage.outputTokens + canonicalResp.usage.thoughtTokens,
        latencyMs,
      });

      onLogRequest?.({
        providerName,
        model: resolvedModel,
        status: res.status,
        latencyMs,
        inputTokens: canonicalResp.usage.inputTokens,
        outputTokens: canonicalResp.usage.outputTokens + canonicalResp.usage.thoughtTokens,
        isStream: false,
        requestBody: rawBodyStr,
        responseBody: JSON.stringify(clientJson),
      });

      return new Response(JSON.stringify(clientJson), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Error classification
    const status = res.status;
    const errorText = await res.text();

    onLogRequest?.({
      providerName,
      model: resolvedModel,
      status,
      latencyMs,
      inputTokens: 0,
      outputTokens: 0,
      isStream,
      error: errorText,
      requestBody: rawBodyStr,
      responseBody: errorText,
    });

    // 4xx Client Error (not 401, 403, 404, 429) -> DO NOT CYCLE!
    if (status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 404 && status !== 429) {
      return new Response(errorText, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }

    circuitBreaker.recordFailure(provider.id);
    onRecordStats?.(provider.id, providerName, {
      requests: 1,
      failures: 1,
      input: 0,
      output: 0,
      latencyMs,
    });

    lastErrorResponse = new Response(errorText, {
      status,
      headers: { 'content-type': 'application/json' },
    });

    if (status === 401 || status === 403 || status === 404) {
      authFailures++;
      if (!doCycle || authFailures >= maxAuthFailures) {
        break;
      }
    } else {
      // 5xx or 429
      consecutiveFailures++;
      if (!doCycle || consecutiveFailures >= maxFailures) {
        break;
      }
    }
  }

  if (lastErrorResponse) {
    return lastErrorResponse;
  }

  return new Response(
    JSON.stringify({
      error: { message: 'All upstream providers failed or were exhausted.' },
    }),
    { status: 502, headers: { 'content-type': 'application/json' } }
  );
}
