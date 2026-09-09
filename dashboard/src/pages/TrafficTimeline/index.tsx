import { useMemo, useState } from "react";
import { ActivityIcon, XIcon } from "lucide-react";

import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TabularText } from "@/components/ui/TabularText";
import { useTimelineStore } from "@/stores/timeline";
import { useRequestLogs } from "@/hooks/useRequestLogs";
import { useProviders } from "@/hooks/useProviders";
import type { RequestLogRecord } from "@/hooks/types";
import { formatDuration, formatTokenK } from "@/lib/format";
import {
  type TimelineRequest,
  computeTimeWindow,
  filterRequests,
  groupByLane,
  type TimelineFiltersState,
} from "./_lib/timeline-utils";
import { EgressSwimlanes } from "./_components/EgressSwimlanes";
import { LegendBar } from "./_components/LegendBar";

const WINDOW_PRESETS = [
  { key: "5m", label: "Last 5 minutes" },
  { key: "15m", label: "Last 15 minutes" },
  { key: "1h", label: "Last hour" },
  { key: "today", label: "Today" },
] as const;

function statusVariant(status: number): "success" | "info" | "danger" | "warning" | "muted" {
  if (status === 0) return "danger";
  if (status >= 200 && status < 300) return "success";
  if (status >= 400 && status < 500) return "warning";
  if (status >= 500) return "danger";
  return "muted";
}

const EMPTY_FILTERS: TimelineFiltersState = {
  providerFilter: null,
  modelFilter: "",
  statusFilter: "all",
};

function DetailPanel({ request, onClose }: { request: RequestLogRecord; onClose: () => void }) {
  return (
    <Card className="w-72 shrink-0 self-start">
      <CardContent className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink-primary">Request</span>
          <Button variant="ghost" size="icon-xs" aria-label="Close detail" onClick={onClose}>
            <XIcon className="size-3.5" />
          </Button>
        </div>
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-ink-mute">Status</span>
            <Badge variant={statusVariant(request.status)}>
              <TabularText>{request.status === 0 ? "ERR" : request.status}</TabularText>
            </Badge>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-ink-mute">Provider</span>
            <span className="text-ink-primary">{request.provider_name}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-ink-mute">Model</span>
            <TabularText className="break-all text-right text-ink-primary">{request.model}</TabularText>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-ink-mute">Latency</span>
            <TabularText className="text-ink-primary">{formatDuration(request.latency_ms)}</TabularText>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-ink-mute">Tokens</span>
            <TabularText className="text-ink-primary">
              {formatTokenK(request.input_tokens + request.output_tokens)}
              <span className="ml-1 text-ink-mute">
                ({request.input_tokens} in / {request.output_tokens} out)
              </span>
            </TabularText>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-ink-mute">Time</span>
            <TabularText className="text-ink-primary">
              {new Date(request.timestamp_ms).toLocaleTimeString()}
            </TabularText>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-ink-mute">Stream</span>
            <span className="text-ink-primary">{request.is_stream ? "yes" : "no"}</span>
          </div>
          {request.status >= 400 && request.error ? (
            <div className="rounded bg-destructive/10 p-2 text-destructive">
              <span className="line-clamp-4 block">{request.error}</span>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function TrafficTimeline() {
  const { data: logs } = useRequestLogs(500);
  const { data: providers } = useProviders();
  const { windowPreset, selectedRequestId, panelOpen, setWindowPreset, setPanelOpen } =
    useTimelineStore();
  const [filters, setFilters] = useState<TimelineFiltersState>(EMPTY_FILTERS);

  const window = useMemo(() => computeTimeWindow(windowPreset), [windowPreset]);
  const windowMs = window.endMs - window.startMs;

  const timelineRequests = useMemo<TimelineRequest[]>(
    () => (logs ?? []).map((l) => ({ ...l, laneKey: l.provider_name || "direct" })),
    [logs],
  );

  const filtered = useMemo(() => filterRequests(timelineRequests, filters), [timelineRequests, filters]);
  const laneGroups = useMemo(() => groupByLane(filtered), [filtered]);

  const inWindow = useMemo(
    () => filtered.filter((l) => l.timestamp_ms >= window.startMs && l.timestamp_ms <= window.endMs),
    [filtered, window],
  );

  const statusCount = useMemo(() => {
    const c = { ok: 0, err: 0 };
    for (const l of inWindow) {
      if (l.status === 0 || l.status >= 400) c.err++;
      else c.ok++;
    }
    return c;
  }, [inWindow]);

  const selected = useMemo(() => {
    if (!selectedRequestId || !panelOpen) return null;
    return (logs ?? []).find((l) => String(l.id ?? l.timestamp_ms) === selectedRequestId) ?? null;
  }, [selectedRequestId, panelOpen, logs]);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-8">
      <PageHeader
        eyebrow="Traffic"
        title="Traffic Timeline"
        description="Request swimlanes by provider over time — bars sized by latency, live."
      />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={windowPreset} onValueChange={(v) => setWindowPreset(v as typeof windowPreset)}>
          <SelectTrigger size="sm" className="min-w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOW_PRESETS.map((p) => (
              <SelectItem key={p.key} value={p.key}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.providerFilter ?? "all"}
          onValueChange={(v) => setFilters((f) => ({ ...f, providerFilter: v === "all" ? null : v }))}
        >
          <SelectTrigger size="sm" className="min-w-36">
            <SelectValue />
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

        <Select
          value={filters.statusFilter}
          onValueChange={(v) =>
            setFilters((f) => ({ ...f, statusFilter: v as TimelineFiltersState["statusFilter"] }))
          }
        >
          <SelectTrigger size="sm" className="min-w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All status</SelectItem>
            <SelectItem value="success">Success only</SelectItem>
            <SelectItem value="error">Errors only</SelectItem>
          </SelectContent>
        </Select>

        <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-ink-mute">
          <ActivityIcon className="size-3.5 text-success animate-pulse" />
          <TabularText>{inWindow.length}</TabularText> req ·{" "}
          <TabularText className="text-success">{statusCount.ok}</TabularText> ok ·{" "}
          <TabularText className="text-destructive">{statusCount.err}</TabularText> err
        </span>
      </div>

      {/* Swimlanes + detail panel */}
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <Card>
            <CardContent className="px-3 py-3">
              <EgressSwimlanes laneGroups={laneGroups} window={window} windowMs={windowMs} />
            </CardContent>
          </Card>
        </div>

        {selected ? (
          <DetailPanel request={selected} onClose={() => setPanelOpen(false)} />
        ) : null}
      </div>

      <LegendBar />
    </div>
  );
}