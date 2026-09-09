import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { TabularText } from "@/components/ui/TabularText";
import { useRequestLogs } from "@/hooks/useRequestLogs";
import { cn } from "@/lib/utils";
import { formatDuration, formatTokenK } from "@/lib/format";
import type { RequestLogRecord } from "@/hooks/types";

function statusVariant(status: number): "success" | "info" | "danger" | "warning" | "muted" {
  if (status === 0) return "danger"; // transport error
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
      <CardContent className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-ink-primary">Live Requests</h3>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-mute">
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
          <p className="py-8 text-center text-sm text-ink-mute">
            No requests yet — send traffic through the gateway and it appears here live.
          </p>
        ) : (
          <div className="overflow-x-auto scrollbar-none">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-edge text-left text-xs text-ink-mute">
                  <th className="px-2 pb-2 font-medium">Status</th>
                  <th className="px-2 pb-2 font-medium">Model</th>
                  <th className="px-2 pb-2 font-medium">Provider</th>
                  <th className="px-2 pb-2 text-right font-medium">Latency</th>
                  <th className="px-2 pb-2 text-right font-medium">Tokens</th>
                  <th className="px-2 pb-2 text-right font-medium">Age</th>
                </tr>
              </thead>
              <tbody>
                {items.map((log, idx) => (
                  <tr
                    key={log.id ?? `${log.timestamp_ms}-${idx}`}
                    className="border-b border-edge-subtle last:border-0 hover:bg-surface-hover"
                  >
                    <td className="px-2 py-2">
                      <Badge variant={statusVariant(log.status)}>
                        <TabularText>{statusLabel(log.status)}</TabularText>
                      </Badge>
                      {log.is_stream ? (
                        <span className="ml-1.5 text-[10px] text-ink-mute">stream</span>
                      ) : null}
                    </td>
                    <td className={cn("px-2 py-2 font-mono text-xs", log.model ? "text-ink-primary" : "text-ink-mute")}>
                      {log.model || "—"}
                    </td>
                    <td className="px-2 py-2 text-ink-secondary">{log.provider_name}</td>
                    <td className="px-2 py-2 text-right">
                      <TabularText className="text-xs">{formatDuration(log.latency_ms)}</TabularText>
                    </td>
                    <td className="px-2 py-2 text-right">
                      <TabularText className="text-xs">
                        {formatTokenK(log.input_tokens + log.output_tokens)}
                      </TabularText>
                    </td>
                    <td className="px-2 py-2 text-right text-xs text-ink-mute">
                      {timeAgo(log.timestamp_ms)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}