import { useMemo } from "react";
import { PageHeader } from "@/components/common/PageHeader";
import { StatCard } from "@/components/business";
import { Badge, Card, CardContent, TabularText } from "@/components/ui";
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
            <CardContent className="flex flex-col gap-3 px-5 py-4">
              {!stats?.length ? (
                <p className="py-8 text-center text-sm text-ink-mute">
                  No provider stats yet.
                </p>
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-edge text-left text-xs text-ink-mute">
                      <th className="px-2 pb-2 font-medium">Provider</th>
                      <th className="px-2 pb-2 font-medium">Requests</th>
                      <th className="px-2 pb-2 font-medium">Failures</th>
                      <th className="px-2 pb-2 font-medium">Input tokens</th>
                      <th className="px-2 pb-2 font-medium">Output tokens</th>
                      <th className="px-2 pb-2 font-medium">Avg latency</th>
                      <th className="px-2 pb-2 font-medium">Success rate</th>
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
                          className="border-b border-edge-subtle last:border-0 hover:bg-surface-hover"
                        >
                          <td className="px-2 py-2">{s.provider_name}</td>
                          <td className="px-2 py-2">
                            <TabularText className="text-xs">
                              {s.requests.toLocaleString()}
                            </TabularText>
                          </td>
                          <td className="px-2 py-2">
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
                          <td className="px-2 py-2">
                            <TabularText className="text-xs">
                              {s.input.toLocaleString()}
                            </TabularText>
                          </td>
                          <td className="px-2 py-2">
                            <TabularText className="text-xs">
                              {s.output.toLocaleString()}
                            </TabularText>
                          </td>
                          <td className="px-2 py-2">
                            <TabularText className="text-xs">
                              {formatDuration(avg)}
                            </TabularText>
                          </td>
                          <td className="px-2 py-2">
                            <TabularText className="text-xs">
                              {rate.toFixed(1)}%
                            </TabularText>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="models">
          <Card>
            <CardContent className="flex flex-col gap-3 px-5 py-4">
              {!sortedModels.length ? (
                <p className="py-8 text-center text-sm text-ink-mute">
                  No model stats yet.
                </p>
              ) : (
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-edge text-left text-xs text-ink-mute">
                      <th className="px-2 pb-2 font-medium">Model</th>
                      <th className="px-2 pb-2 font-medium">Provider</th>
                      <th className="px-2 pb-2 font-medium">Input</th>
                      <th className="px-2 pb-2 font-medium">Output</th>
                      <th className="px-2 pb-2 font-medium">Total tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedModels.map((m) => (
                      <tr
                        key={`${m.provider_id}:${m.model_name}`}
                        className="border-b border-edge-subtle last:border-0 hover:bg-surface-hover"
                      >
                        <td className="px-2 py-2">
                          <TabularText className="text-xs">{m.model_name}</TabularText>
                        </td>
                        <td className="px-2 py-2">{m.provider_name}</td>
                        <td className="px-2 py-2">
                          <TabularText className="text-xs">
                            {m.input.toLocaleString()}
                          </TabularText>
                        </td>
                        <td className="px-2 py-2">
                          <TabularText className="text-xs">
                            {m.output.toLocaleString()}
                          </TabularText>
                        </td>
                        <td className="px-2 py-2">
                          <TabularText className="text-xs">
                            {(m.input + m.output).toLocaleString()}
                          </TabularText>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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