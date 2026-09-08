import { describe, it, expect, vi } from 'vitest';
import {
  CircuitBreaker,
  resolveProviderPool,
  ProviderNotFoundError,
  canPassthrough,
  patchStreamUsage,
  prepareHeaders,
  runQuotaCommand,
} from '../src/proxy/index.js';
import { createDefaultConfig, createDefaultProvider } from '../src/config/index.js';

describe('Proxy Engine', () => {
  describe('CircuitBreaker', () => {
    it('trips open after reaching failure threshold and allows probe after cooldown', () => {
      vi.useFakeTimers();
      try {
        const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
        expect(breaker.canAttempt('prov-1')).toBe(true);

        breaker.recordFailure('prov-1');
        breaker.recordFailure('prov-1');
        expect(breaker.canAttempt('prov-1')).toBe(true);

        // 3rd failure trips the breaker
        breaker.recordFailure('prov-1');
        expect(breaker.canAttempt('prov-1')).toBe(false);
        expect(breaker.getState('prov-1')).toBe('open');

        // Advance past cooldown
        vi.advanceTimersByTime(1100);
        expect(breaker.canAttempt('prov-1')).toBe(true);
        expect(breaker.getState('prov-1')).toBe('half_open');

        // Success resets breaker
        breaker.recordSuccess('prov-1');
        expect(breaker.getState('prov-1')).toBe('closed');
        expect(breaker.canAttempt('prov-1')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Router & Pool Resolution', () => {
    it('resolves pinned provider exclusively with doCycle false', () => {
      const config = createDefaultConfig();
      config.providers['pinned-p'] = { ...createDefaultProvider('p1'), port: 7901, enabled: true };
      config.providers['other-p'] = { ...createDefaultProvider('p2'), fallback: true, enabled: true };

      const { pool, doCycle } = resolveProviderPool(config, 'pinned-p');
      expect(doCycle).toBe(false);
      expect(pool.length).toBe(1);
      expect(pool[0]?.name).toBe('pinned-p');
    });

    it('throws when pinned provider is missing or disabled', () => {
      const config = createDefaultConfig();
      expect(() => resolveProviderPool(config, 'non-existent')).toThrow(ProviderNotFoundError);
    });

    it('resolves cyclic pool starting with current provider followed by fallback providers', () => {
      const config = createDefaultConfig();
      config.current = 'prov-b';
      config.providers['prov-a'] = { ...createDefaultProvider('pa'), fallback: true, enabled: true };
      config.providers['prov-b'] = { ...createDefaultProvider('pb'), fallback: false, enabled: true };
      config.providers['prov-c'] = { ...createDefaultProvider('pc'), fallback: true, enabled: true };
      config.providers['prov-disabled'] = { ...createDefaultProvider('pd'), fallback: true, enabled: false };

      const { pool, doCycle } = resolveProviderPool(config);
      expect(doCycle).toBe(true);
      const names = pool.map((p) => p.name);
      expect(names).toEqual(['prov-b', 'prov-c', 'prov-a']);
    });
  });

  describe('Passthrough Evaluator', () => {
    it('allows passthrough for transparent OpenAI Chat provider', () => {
      const provider = {
        ...createDefaultProvider(),
        apiFormat: 'openai' as const,
        apiVersion: 'chat_completions' as const,
      };
      expect(canPassthrough('openai_chat', provider, { model: 'gpt-4o' })).toBe(true);
    });

    it('disallows passthrough if provider has routes, modelMap, or maxTokensCap', () => {
      const pWithRoute = {
        ...createDefaultProvider(),
        apiFormat: 'openai' as const,
        apiVersion: 'chat_completions' as const,
        routes: [{ id: 'r1', pattern: '*', target: 'gpt-4o', enabled: true }],
      };
      expect(canPassthrough('openai_chat', pWithRoute, { model: 'gpt-4o' })).toBe(false);

      const pWithCap = {
        ...createDefaultProvider(),
        apiFormat: 'openai' as const,
        apiVersion: 'chat_completions' as const,
        maxTokensCap: 1000,
      };
      expect(canPassthrough('openai_chat', pWithCap, { model: 'gpt-4o' })).toBe(false);
    });

    it('injects stream_options.include_usage for streaming requests', () => {
      const body = { model: 'gpt-4o', stream: true };
      const patched = patchStreamUsage(body);
      expect(patched['stream_options']).toEqual({ include_usage: true });
    });
  });

  describe('Quota Command Runner', () => {
    it('executes command and receives stdout with env variables', async () => {
      const provider = { ...createDefaultProvider('prov-test'), baseUrl: 'https://api.test.com' };
      const out = await runQuotaCommand('echo "QUOTA: $_PROVIDER $_BASE_URL"', provider, 'sk-secret');
      expect(out).toBe('QUOTA: prov-test https://api.test.com');
    });
  });

  describe('Headers Preparation', () => {
    it('strips forbidden headers and attaches format-specific auth header', () => {
      const provider = { ...createDefaultProvider(), apiFormat: 'anthropic' as const };
      const clientHeaders = new Headers({
        Host: 'ccs.local',
        Authorization: 'Bearer client-token',
        'Content-Type': 'application/json',
        'X-Custom-Client': 'my-client',
      });

      const prepared = prepareHeaders(provider, 'sk-ant-test', clientHeaders);
      expect(prepared.get('x-api-key')).toBe('sk-ant-test');
      expect(prepared.get('authorization')).toBeNull();
      expect(prepared.get('host')).toBeNull();
      expect(prepared.get('x-custom-client')).toBe('my-client');
      expect(prepared.get('content-type')).toBe('application/json');
    });
  });
});
