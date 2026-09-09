import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, TableHead } from "@/components/ui/data-table";
import { TabularText } from "@/components/ui/TabularText";
import { EmptyState } from "@/components/common/EmptyState";
import { useRequestLogs } from "@/hooks/useRequestLogs";
import { cn } from "@/lib/utils";
import { formatDuration, formatTokenK } from "@/lib/format";
import type { RequestLogRecord } from "@/hooks/types";

function statusVariant(status: number): "success" | "info" | "danger" | "warning" | "muted" {
  if (status === 0) return "danger";
  if (status >= 200 && status < 300) return "success";
  if (status >= 400 && status < 500) return "warning";
  if (status >= 500) return "danger";
  return "muted";
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 1000) return "now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusLabel(status: number): string {
  if (status === 0) return "ERR";
  return String(status);
}

/** Live request monitor feed: newest first, refreshes via SSE + poll. */
export function RequestMonitor({ pageSize = 10 }: { pageSize?: number }) {
  const { data: logs } = useRequestLogs(pageSize);

  const items = useMemo<RequestLogRecord[]>(() => logs ?? [], [logs]);

  return (
    <Card>
      <CardContent className="px-5 py-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-ink-primary">Live Requests</h3>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-ink-mute">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex size-1.5 rounded-full bg-success" />
              </span>
              streaming
            </span>
            <Badge variant="muted">
              <TabularText>{items.length}</TabularText>
            </Badge>
          </div>
        </div>

        {items.length === 0 ? (
          <EmptyState
            heading="No requests yet"
            description="Send traffic through the gateway and it appears here live."
          />
        ) : (
          <DataTable>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-edge text-left">
                  <TableHead>Status</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead align="right">Latency</TableHead>
                  <TableHead align="right">Tokens</TableHead>
                  <TableHead align="right">Age</TableHead>
                </tr>
              </thead>
              <tbody>
                {items.map((log, idx) => (
                  <tr
                    key={log.id ?? `${log.timestamp_ms}-${idx}`}
                    className="border-b border-edge-subtle last:border-0 transition-colors hover:bg-surface-hover"
                  >
                    <td className="px-3 py-2.5">
                      <Badge variant={statusVariant(log.status)}>
                        <TabularText>{statusLabel(log.status)}</TabularText>
                      </Badge>
                      {log.is_stream ? (
                        <span className="ml-1.5 text-[10px] text-ink-mute">stream</span>
                      ) : null}
                    </td>
                    <td className={cn("px-3 py-2.5 font-mono text-xs", log.model ? "text-ink-primary" : "text-ink-mute")}>
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
                    <td className="px-3 py-2.5 text-right text-xs text-ink-mute">
                      {timeAgo(log.timestamp_ms)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        )}
      </CardContent>
    </Card>
  );
}