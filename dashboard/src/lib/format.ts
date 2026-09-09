/** Token-count auxiliary units: nearest magnitude, approx sign + 2 decimals + unit. */
export function formatTokenCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${sign}≈${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}≈${(abs / 1e3).toFixed(2)}K`;
  return n.toLocaleString();
}

/** Token compact display (K unit): |n| ≥ 1000 rounds to thousands → `1k`, `102k`. */
export function formatTokenK(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}${Math.round(abs / 1000)}k`;
  return String(Math.round(n));
}

/** Duration in seconds (2 decimals): `6458ms → 6.46s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "0.00s";
  return `${(ms / 1000).toFixed(2)}s`;
}
