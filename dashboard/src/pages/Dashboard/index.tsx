import { useMemo } from "react";
import { StatCard, TokenHint, RequestMonitor } from "@/components/business";
import { useStats } from "@/hooks/useStats";
import { ServiceCard } from "./_components/ServiceCard";

export function Dashboard() {
  const { data: stats } = useStats();

  const totals = useMemo(() => {
    const t = {
      requests: 0,
      failures: 0,
      input: 0,
      output: 0,
    };
    // Raw per-provider rows; on a live gateway these are lifetime counters.
    for (const s of stats ?? []) {
      t.requests += s.requests;
      t.failures += s.failures;
      t.input += s.input;
      t.output += s.output;
    }
    return t;
  }, [stats]);

  const tokens = totals.input + totals.output;
  const successRate =
    totals.requests > 0 ? ((totals.requests - totals.failures) / totals.requests) * 100 : 100;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <span className="text-[10px] font-medium tracking-[0.06em] text-ink-secondary uppercase">
          Dashboard
        </span>
        <h1 className="text-2xl font-light tracking-tight">Dashboard</h1>
      </header>

      <ServiceCard />

      {/* Today's requests / failures / tokens, update in real-time with SSE */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Requests" value={totals.requests.toLocaleString()} />
        <StatCard
          label="Failures"
          value={totals.failures.toLocaleString()}
          hint={
            <span className="text-xs text-ink-secondary">
              {successRate.toFixed(1)}% success
            </span>
          }
          hintBelow
        />
        <StatCard
          label="Tokens"
          value={tokens.toLocaleString()}
          hint={<TokenHint value={tokens} />}
          hintBelow
        />
      </div>

      <RequestMonitor pageSize={12} />
    </div>
  );
}