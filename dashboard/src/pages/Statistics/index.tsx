import { useMemo } from "react";
import { BarChart3Icon } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { StatCard } from "@/components/business";
import { Badge, Card, CardContent, TabularText } from "@/components/ui";
import { DataTable, TableHead } from "@/components/ui/data-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useModels } from "@/hooks/useModels";
import { useStats } from "@/hooks/useStats";
import { formatDuration } from "@/lib/format";

export function Statistics() {
  const { data: stats } = useStats();
  const { data: models } = useModels();

  const totals = useMemo(() => {
    const t = { requests: 0, failures: 0, input: 0, output: 0 };
    for (const s of stats ?? []) {
      t.requests += s.requests;
      t.failures += s.failures;
      t.input += s.input;
      t.output += s.output;
    }
    return t;
  }, [stats]);

  const quotaProviders = useMemo(
    () => (stats ?? []).filter((s) => s.quota_output != null),
    [stats],
  );

  const sortedModels = useMemo(
    () =>
      [...(models ?? [])].sort(
        (a, b) => b.input + b.output - (a.input + a.output),
      ),
    [models],
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <PageHeader
        eyebrow="Analytics"
        title="Statistics"
        description="Provider and model usage across the gateway."
      />

      <Tabs defaultValue="providers">
        <TabsList>
          <TabsTrigger value="providers">By Provider</TabsTrigger>
          <TabsTrigger value="models">By Model</TabsTrigger>
          <TabsTrigger value="summary">Summary</TabsTrigger>
        </TabsList>

        <TabsContent value="providers">
          <Card>
            <CardContent className="px-5 py-4">
              {!stats?.length ? (
                <EmptyState
                  icon={BarChart3Icon}
                  heading="No provider stats yet"
                  description="Stats accumulate as requests flow through the gateway."
                />
              ) : (
                <DataTable>
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-edge text-left">
                        <TableHead>Provider</TableHead>
                        <TableHead>Requests</TableHead>
                        <TableHead>Failures</TableHead>
                        <TableHead>Input tokens</TableHead>
                        <TableHead>Output tokens</TableHead>
                        <TableHead>Avg latency</TableHead>
                        <TableHead>Success rate</TableHead>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.map((s) => {
                        const avg =
                          s.requests > 0 ? s.latency_total / s.requests : 0;
                        const rate =
                          s.requests > 0
                            ? ((s.requests - s.failures) / s.requests) * 100
                            : 100;
                        return (
                          <tr
                            key={s.provider_id}
                            className="border-b border-edge-subtle last:border-0 transition-colors hover:bg-surface-hover"
                          >
                            <td className="px-3 py-2.5">{s.provider_name}</td>
                            <td className="px-3 py-2.5">
                              <TabularText className="text-xs">
                                {s.requests.toLocaleString()}
                              </TabularText>
                            </td>
                            <td className="px-3 py-2.5">
                              {s.failures > 0 ? (
                                <Badge variant="warning">
                                  <TabularText>{s.failures.toLocaleString()}</TabularText>
                                </Badge>
                              ) : (
                                <TabularText className="text-xs">
                                  {s.failures.toLocaleString()}
                                </TabularText>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              <TabularText className="text-xs">
                                {s.input.toLocaleString()}
                              </TabularText>
                            </td>
                            <td className="px-3 py-2.5">
                              <TabularText className="text-xs">
                                {s.output.toLocaleString()}
                              </TabularText>
                            </td>
                            <td className="px-3 py-2.5">
                              <TabularText className="text-xs">
                                {formatDuration(avg)}
                              </TabularText>
                            </td>
                            <td className="px-3 py-2.5">
                              <TabularText className="text-xs">
                                {rate.toFixed(1)}%
                              </TabularText>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </DataTable>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="models">
          <Card>
            <CardContent className="px-5 py-4">
              {!sortedModels.length ? (
                <EmptyState
                  icon={BarChart3Icon}
                  heading="No model stats yet"
                  description="Model-level breakdowns appear after the first requests."
                />
              ) : (
                <DataTable>
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-edge text-left">
                        <TableHead>Model</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>Input</TableHead>
                        <TableHead>Output</TableHead>
                        <TableHead>Total tokens</TableHead>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedModels.map((m) => (
                        <tr
                          key={`${m.provider_id}:${m.model_name}`}
                          className="border-b border-edge-subtle last:border-0 transition-colors hover:bg-surface-hover"
                        >
                          <td className="px-3 py-2.5">
                            <TabularText className="text-xs">{m.model_name}</TabularText>
                          </td>
                          <td className="px-3 py-2.5">{m.provider_name}</td>
                          <td className="px-3 py-2.5">
                            <TabularText className="text-xs">
                              {m.input.toLocaleString()}
                            </TabularText>
                          </td>
                          <td className="px-3 py-2.5">
                            <TabularText className="text-xs">
                              {m.output.toLocaleString()}
                            </TabularText>
                          </td>
                          <td className="px-3 py-2.5">
                            <TabularText className="text-xs">
                              {(m.input + m.output).toLocaleString()}
                            </TabularText>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </DataTable>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="summary" className="flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Total Requests" value={totals.requests.toLocaleString()} />
            <StatCard label="Total Failures" value={totals.failures.toLocaleString()} />
            <StatCard label="Total Input Tokens" value={totals.input.toLocaleString()} />
            <StatCard label="Total Output Tokens" value={totals.output.toLocaleString()} />
          </div>

          {quotaProviders.length > 0 ? (
            <Card>
              <CardContent className="flex flex-col gap-3 px-5 py-4">
                <span className="text-xs text-ink-secondary">Quota output</span>
                <div className="flex flex-col gap-2">
                  {quotaProviders.map((s) => (
                    <div
                      key={s.provider_id}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="text-sm">{s.provider_name}</span>
                      <TabularText className="text-xs">{s.quota_output}</TabularText>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
