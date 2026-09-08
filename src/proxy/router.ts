import type { AppConfig, Provider } from '../config/types.js';

export class ProviderNotFoundError extends Error {
  constructor(name: string) {
    super(`Provider not found or disabled: ${name}`);
    this.name = 'ProviderNotFoundError';
  }
}

export interface ResolvedPoolItem {
  name: string;
  provider: Provider;
}

export interface ProviderPoolResolution {
  pool: ResolvedPoolItem[];
  doCycle: boolean;
}

/**
 * Resolves the provider candidate pool for a request:
 * 1. If pinnedProviderName is specified (e.g. pinned port listener):
 *    returns exactly that provider with doCycle = false.
 * 2. Otherwise:
 *    starts with config.current and includes all enabled providers with fallback: true.
 *    Cycles in stable relative order.
 */
export function resolveProviderPool(
  config: AppConfig,
  pinnedProviderName?: string
): ProviderPoolResolution {
  if (pinnedProviderName) {
    const pinned = config.providers[pinnedProviderName];
    if (!pinned || !pinned.enabled) {
      throw new ProviderNotFoundError(pinnedProviderName);
    }
    return {
      pool: [{ name: pinnedProviderName, provider: pinned }],
      doCycle: false,
    };
  }

  const currentProvider = config.providers[config.current];
  if (!currentProvider || !currentProvider.enabled) {
    throw new ProviderNotFoundError(config.current || 'none');
  }

  const keys = Object.keys(config.providers);
  const startIdx = keys.indexOf(config.current);
  if (startIdx === -1) {
    throw new ProviderNotFoundError(config.current);
  }

  const pool: ResolvedPoolItem[] = [];
  const len = keys.length;

  for (let i = 0; i < len; i++) {
    const key = keys[(startIdx + i) % len]!;
    const provider = config.providers[key];
    if (!provider || !provider.enabled) continue;

    if (key === config.current || provider.fallback) {
      pool.push({ name: key, provider });
    }
  }

  if (pool.length === 0) {
    throw new ProviderNotFoundError(config.current);
  }

  return {
    pool,
    doCycle: true,
  };
}
