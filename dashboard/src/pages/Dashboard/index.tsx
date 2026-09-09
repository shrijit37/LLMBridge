import { useMemo } from "react";
import { ActivityIcon, AlertTriangleIcon, CoinsIcon } from "lucide-react";
import { StatCard, TokenHint, RequestMonitor } from "@/components/business";
import { useStats } from "@/hooks/useStats";
import { PageHeader } from "@/components/common/PageHeader";
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
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="Gateway status, provider queues, and live request feed."
      />

      <ServiceCard />

      {/* Today's requests / failures / tokens, update in real-time with SSE */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Requests"
          value={totals.requests.toLocaleString()}
          icon={ActivityIcon}
          color="primary"
        />
        <StatCard
          label="Failures"
          value={totals.failures.toLocaleString()}
          icon={AlertTriangleIcon}
          color="destructive"
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
          icon={CoinsIcon}
          color="info"
          hint={<TokenHint value={tokens} />}
          hintBelow
        />
      </div>

      <RequestMonitor pageSize={12} />
    </div>
  );
}