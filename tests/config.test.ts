import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  globMatch,
  resolveModel,
  createDefaultProvider,
  createDefaultConfig,
  loadConfig,
  saveConfig,
  resolveApiKey,
  resolveExtraHeaders,
  validatePorts,
  ConfigError,
  ConfigWatcher,
} from '../src/config/index.js';

describe('Configuration & Pattern Matching', () => {
  describe('globMatch', () => {
    it('matches exact strings without wildcards', () => {
      expect(globMatch('claude-3-5-sonnet', 'claude-3-5-sonnet')).toBe(true);
      expect(globMatch('claude-3-5-sonnet', 'claude-3-7-sonnet')).toBe(false);
    });

    it('matches prefix wildcards', () => {
      expect(globMatch('*sonnet', 'claude-3-5-sonnet')).toBe(true);
      expect(globMatch('*sonnet', 'claude-3-5-sonnet-20241022')).toBe(false);
    });

    it('matches suffix wildcards', () => {
      expect(globMatch('claude-3-5-*', 'claude-3-5-sonnet')).toBe(true);
      expect(globMatch('claude-3-5-*', 'gpt-4o')).toBe(false);
    });

    it('matches middle wildcards', () => {
      expect(globMatch('claude-*-sonnet', 'claude-3-5-sonnet')).toBe(true);
      expect(globMatch('claude-*-sonnet', 'claude-sonnet')).toBe(false);
      expect(globMatch('*opus*', 'anthropic/claude-opus-4')).toBe(true);
      expect(globMatch('*opus*', 'deepseek-v3')).toBe(false);
    });

    it('handles multiple wildcards', () => {
      expect(globMatch('*claude*sonnet*', 'vendor/claude-3-sonnet-latest')).toBe(true);
      expect(globMatch('**', 'anything')).toBe(true);
    });
  });

  describe('resolveModel', () => {
    it('rewrites model according to first matching route rule', () => {
      const provider = createDefaultProvider();
      provider.routes = [
        { id: '1', pattern: 'claude-3-7-*', target: 'deepseek-r1', enabled: true },
        { id: '2', pattern: '*sonnet*', target: 'claude-sonnet-4', enabled: true },
      ];

      const res1 = resolveModel(provider, 'claude-3-7-sonnet');
      expect(res1.model).toBe('deepseek-r1');
      expect(res1.matchedPattern).toBe('claude-3-7-*');

      const res2 = resolveModel(provider, 'claude-3-5-sonnet');
      expect(res2.model).toBe('claude-sonnet-4');
      expect(res2.matchedPattern).toBe('*sonnet*');
    });

    it('skips disabled route rules', () => {
      const provider = createDefaultProvider();
      provider.routes = [
        { id: '1', pattern: 'claude-3-7-*', target: 'deepseek-r1', enabled: false },
        { id: '2', pattern: '*sonnet*', target: 'claude-sonnet-fallback', enabled: true },
      ];

      const res = resolveModel(provider, 'claude-3-7-sonnet');
      expect(res.model).toBe('claude-sonnet-fallback');
    });

    it('applies modelMap after route resolution', () => {
      const provider = createDefaultProvider();
      provider.routes = [
        { id: '1', pattern: 'claude-3-7-*', target: 'r1-alias', enabled: true },
      ];
      provider.modelMap = {
        'r1-alias': 'deepseek-ai/DeepSeek-R1',
        'gpt-4o': 'openai/gpt-4o-2024-11-20',
      };

      const res = resolveModel(provider, 'claude-3-7-sonnet');
      expect(res.model).toBe('deepseek-ai/DeepSeek-R1');
      expect(res.matchedPattern).toBe('claude-3-7-*');

      const resDirect = resolveModel(provider, 'gpt-4o');
      expect(resDirect.model).toBe('openai/gpt-4o-2024-11-20');
      expect(resDirect.matchedPattern).toBeUndefined();
    });
  });

  describe('Environment Variable Resolution', () => {
    beforeEach(() => {
      process.env['TEST_CCS_API_KEY'] = 'sk-test-12345';
      process.env['TEST_HEADER_VAL'] = 'custom-auth-header-val';
    });

    afterEach(() => {
      delete process.env['TEST_CCS_API_KEY'];
      delete process.env['TEST_HEADER_VAL'];
    });

    it('resolves env var API key with leading $', () => {
      expect(resolveApiKey('$TEST_CCS_API_KEY')).toBe('sk-test-12345');
      expect(resolveApiKey('sk-literal-key')).toBe('sk-literal-key');
    });

    it('throws on missing env var API key', () => {
      expect(() => resolveApiKey('$NON_EXISTENT_VAR_XYZ')).toThrow(ConfigError);
    });

    it('resolves extra headers', () => {
      const headers = {
        'X-Literal': 'literal-val',
        'X-Dynamic': '$TEST_HEADER_VAL',
        'X-Missing': '$MISSING_VAL',
      };
      const resolved = resolveExtraHeaders(headers);
      expect(resolved).toEqual({
        'X-Literal': 'literal-val',
        'X-Dynamic': 'custom-auth-header-val',
      });
    });
  });

  describe('Port Validation & Persistence', () => {
    let tmpDir: string;
    let configFilePath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-test-'));
      configFilePath = path.join(tmpDir, 'config.json');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('detects duplicate provider ports', () => {
      const config = createDefaultConfig();
      config.providers['prov1'] = { ...createDefaultProvider(), port: 7901 };
      config.providers['prov2'] = { ...createDefaultProvider(), port: 7901 };

      expect(() => validatePorts(config)).toThrow(ConfigError);
    });

    it('detects provider port collision with global listen port', () => {
      const config = createDefaultConfig();
      config.listen = '127.0.0.1:7896';
      config.providers['prov1'] = { ...createDefaultProvider(), port: 7896 };

      expect(() => validatePorts(config)).toThrow(ConfigError);
    });

    it('atomically saves and reloads config in snake_case wire format', () => {
      const config = createDefaultConfig();
      config.current = 'openai-main';
      config.listen = '127.0.0.1:8080';
      const p1 = createDefaultProvider('prov-uuid-1');
      p1.baseUrl = 'https://api.openai.com';
      p1.apiKey = '$OPENAI_API_KEY';
      p1.apiFormat = 'openai';
      p1.apiVersion = 'chat_completions';
      p1.modelMap = { 'claude-3-5-sonnet': 'gpt-4o' };
      p1.routes = [{ id: 'r1', pattern: 'claude-*', target: 'gpt-4o', enabled: true }];
      p1.port = 7902;
      config.providers['openai-main'] = p1;

      saveConfig(config, configFilePath);
      expect(fs.existsSync(configFilePath)).toBe(true);

      // Verify raw file content uses snake_case keys (compatible with ccs Rust)
      const rawContent = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
      expect(rawContent.current).toBe('openai-main');
      expect(rawContent.providers['openai-main'].base_url).toBe('https://api.openai.com');
      expect(rawContent.providers['openai-main'].api_key).toBe('$OPENAI_API_KEY');
      expect(rawContent.providers['openai-main'].api_version).toBe('chat_completions');
      expect(rawContent.providers['openai-main'].port).toBe(7902);

      // Load back
      const loaded = loadConfig(configFilePath);
      expect(loaded.current).toBe('openai-main');
      expect(loaded.listen).toBe('127.0.0.1:8080');
      expect(loaded.providers['openai-main']?.baseUrl).toBe('https://api.openai.com');
      expect(loaded.providers['openai-main']?.apiVersion).toBe('chat_completions');
      expect(loaded.providers['openai-main']?.port).toBe(7902);
    });

    it('reloads config via ConfigWatcher when file changes', async () => {
      const config = createDefaultConfig();
      config.current = 'initial';
      saveConfig(config, configFilePath);

      const watcher = new ConfigWatcher({ configPath: configFilePath, debounceMs: 50 });
      watcher.start();

      const { promise, resolve } = Promise.withResolvers<string>();
      const unsubscribe = watcher.onChange((updated) => {
        if (updated.current === 'updated-provider') {
          resolve(updated.current);
        }
      });

      config.current = 'updated-provider';
      saveConfig(config, configFilePath);

      const current = await promise;
      expect(current).toBe('updated-provider');

      unsubscribe();
      watcher.stop();
    });
  });
});
