import type { Provider, RouteRule } from './types.js';

/**
 * Glob pattern matching where `*` matches any sequence of characters.
 * `**` is treated identically to `*` (no directory-separator semantics).
 *
 * Matches the canonical Rust implementation in ccs::config::glob_match:
 * - "claude-sonnet*" matches "claude-sonnet-4-20250514"
 * - "*opus*" matches "anthropic/claude-opus-4"
 * - "claude-opus-4" only matches exactly "claude-opus-4"
 */
export function globMatch(pattern: string, text: string): boolean {
  if (!pattern.includes('*')) {
    return pattern === text;
  }

  const parts = pattern.split('*');
  let remaining = text;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part.length === 0) {
      continue;
    }

    if (i === 0) {
      // First segment must be a strict prefix.
      if (!remaining.startsWith(part)) {
        return false;
      }
      remaining = remaining.slice(part.length);
    } else if (i === parts.length - 1) {
      // Last segment must be a strict suffix.
      return remaining.endsWith(part);
    } else {
      // Middle segments must appear sequentially in the remainder.
      const pos = remaining.indexOf(part);
      if (pos === -1) {
        return false;
      }
      remaining = remaining.slice(pos + part.length);
    }
  }

  return true;
}

/**
 * Check whether a route rule has a non-empty pattern and target,
 * and if knownModels is non-empty, checks that target contains at least one known model.
 */
export function isRuleValid(rule: RouteRule, knownModels: string[] = []): boolean {
  const patternValid = rule.pattern.trim().length > 0;
  const targetValid = rule.target.trim().length > 0;
  if (!patternValid || !targetValid) {
    return false;
  }
  if (knownModels.length === 0) {
    return true;
  }
  return knownModels.some((m) => rule.target.includes(m));
}

export interface ModelResolution {
  model: string;
  matchedPattern?: string;
}

/**
 * Resolve an incoming model name for a provider:
 * 1. Find the first enabled route rule matching the incoming model with a non-empty target.
 * 2. If matched, rewrite the model to target and record the matched pattern.
 * 3. Apply provider's modelMap to the rewritten (or original) model name.
 */
export function resolveModel(provider: Provider, incomingModel: string): ModelResolution {
  let targetModel = incomingModel;
  let matchedPattern: string | undefined;

  for (const rule of provider.routes) {
    if (rule.enabled && rule.target.trim().length > 0 && globMatch(rule.pattern, incomingModel)) {
      targetModel = rule.target;
      matchedPattern = rule.pattern;
      break;
    }
  }

  const mappedModel = provider.modelMap[targetModel] || targetModel;
  return {
    model: mappedModel,
    matchedPattern,
  };
}
