import { useEffect, useMemo, useState } from "react";
import { FileTextIcon } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { StatusDot } from "@/components/ui/StatusDot";
import { TabularText } from "@/components/ui/TabularText";
import { DataTable, TableHead } from "@/components/ui/data-table";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Events, request, subscribe } from "@/services/request";
import { useProviders } from "@/hooks/useProviders";
import type { RequestLogRecord } from "@/hooks/types";
import { cn } from "@/lib/utils";
import { formatDuration, formatTokenK } from "@/lib/format";

const LIMITS = [50, 200, 500];

function statusVariant(status: number): "success" | "info" | "danger" | "warning" | "muted" {
  if (status === 0) return "danger";
  if (status >= 200 && status < 300) return "success";
  if (status >= 400 && status < 500) return "warning";
  if (status >= 500) return "danger";
  return "muted";
}

function statusLabel(status: number): string {
  return status === 0 ? "ERR" : String(status);
}

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export function Logs() {
  const qc = useQueryClient();
  const [provider, setProvider] = useState("all");
  const [limit, setLimit] = useState(200);
  const [selected, setSelected] = useState<RequestLogRecord | null>(null);

  const { data: providers } = useProviders();
  const { data: logs } = useQuery<RequestLogRecord[]>({
    queryKey: ["logs", limit],
    queryFn: () => request<{ logs: RequestLogRecord[] }>(`/api/logs?limit=${limit}`).then((r) => r.logs),
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const un = subscribe(Events.log, () =>
      qc.invalidateQueries({ queryKey: ["logs", limit] }),
    );
    return un;
  }, [qc, limit]);

  const items = useMemo(
    () => (logs ?? []).filter((l) => provider === "all" || l.provider_name === provider),
    [logs, provider],
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <PageHeader
        eyebrow="Diagnostic"
        title="Request Logs"
        description="Every request through the gateway: status, latency, tokens, and body capture."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger size="sm" className="min-w-40">
            <SelectValue placeholder="All providers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All providers</SelectItem>
            {(providers ?? []).map((p) => (
              <SelectItem key={p.id} value={p.name}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
          <SelectTrigger size="sm" className="min-w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LIMITS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {String(n)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-mute">
            <StatusDot status="success" pulse />
            streaming
          </span>
          <Badge variant="muted">
            <TabularText>{items.length}</TabularText>
          </Badge>
        </div>
      </div>

      <Card>
        <CardContent className="px-5 py-4">
          {items.length === 0 ? (
            <EmptyState
              icon={FileTextIcon}
              heading="No requests yet"
              description="Send traffic through the gateway and it appears here live."
            />
          ) : (
            <DataTable>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-edge text-left">
                    <TableHead>Status</TableHead>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead align="right">Latency</TableHead>
                    <TableHead align="right">Tokens</TableHead>
                    <TableHead>Error</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {items.map((log, idx) => (
                    <tr
                      key={log.id ?? `${log.timestamp_ms}-${idx}`}
                      onClick={() => setSelected(log)}
                      className="cursor-pointer border-b border-edge-subtle last:border-0 transition-colors hover:bg-surface-hover"
                    >
                      <td className="px-3 py-2.5">
                        <Badge variant={statusVariant(log.status)}>
                          <TabularText>{statusLabel(log.status)}</TabularText>
                        </Badge>
                        {log.is_stream ? (
                          <span className="ml-1.5 text-[10px] text-ink-mute">stream</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-ink-mute">
                        <TabularText>{fmtTime(log.timestamp_ms)}</TabularText>
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2.5 font-mono text-xs",
                          log.model ? "text-ink-primary" : "text-ink-mute",
                        )}
                      >
                        {log.model || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-ink-secondary">{log.provider_name}</td>
                      <td className="px-3 py-2.5 text-right">
                        <TabularText className="text-xs">{formatDuration(log.latency_ms)}</TabularText>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <TabularText className="text-xs">
                          {formatTokenK(log.input_tokens + log.output_tokens)}
                        </TabularText>
                      </td>
                      <td className="px-3 py-2.5">
                        {log.status >= 400 && log.error ? (
                          <span className="block max-w-[200px] truncate text-xs text-destructive">
                            {log.error}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DataTable>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected ? (
                <>
                  <Badge variant={statusVariant(selected.status)}>
                    <TabularText>{statusLabel(selected.status)}</TabularText>
                  </Badge>
                  <TabularText className="text-sm">{selected.model}</TabularText>
                </>
              ) : null}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-ink-mute">Timestamp</span>
                  <TabularText className="text-xs">
                    {new Date(selected?.timestamp_ms ?? 0).toLocaleString()}
                  </TabularText>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-ink-mute">Provider</span>
                  <span>{selected?.provider_name}</span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-ink-mute">Latency</span>
                  <TabularText className="text-xs">
                    {formatDuration(selected?.latency_ms ?? 0)}
                  </TabularText>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-ink-mute">Tokens</span>
                  <TabularText className="text-xs">
                    {formatTokenK((selected?.input_tokens ?? 0) + (selected?.output_tokens ?? 0))}{" "}
                    <span className="text-ink-mute">
                      ({selected?.input_tokens ?? 0} in / {selected?.output_tokens ?? 0} out)
                    </span>
                  </TabularText>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-ink-mute">Stream</span>
                  <span>{selected?.is_stream ? "yes" : "no"}</span>
                </div>
                {selected && selected.status >= 400 && selected.error ? (
                  <div className="flex justify-between gap-4">
                    <span className="text-ink-mute">Error</span>
                    <span className="text-right text-destructive">{selected.error}</span>
                  </div>
                ) : null}
              </div>
            </DialogDescription>
          </DialogHeader>

          {selected?.request_body ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-ink-mute">Request body</span>
              <pre className="max-h-64 overflow-auto rounded bg-surface-raised p-3 font-mono text-xs whitespace-pre-wrap">
                {selected.request_body}
              </pre>
            </div>
          ) : null}
          {selected?.response_body ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-ink-mute">Response body</span>
              <pre className="max-h-64 overflow-auto rounded bg-surface-raised p-3 font-mono text-xs whitespace-pre-wrap">
                {selected.response_body}
              </pre>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}