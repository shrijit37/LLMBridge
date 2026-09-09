import {
  ActivityIcon,
  CopyIcon,
  NetworkIcon,
  RefreshCcwIcon,
  ShieldAlertIcon,
  ZapIcon,
} from "lucide-react";
import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, StatusDot, TabularText } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { useStatus } from "@/hooks/useStatus";
import { useStats } from "@/hooks/useStats";
import { useLanes } from "@/hooks/useLanes";
import { useRequestLogs } from "@/hooks/useRequestLogs";
import { useBreakers } from "@/hooks/useBreakers";
import { controlApi } from "@/services/control";
import { cn } from "@/lib/utils";
import { ProxyScene } from "./ProxyScene";

type QueueStatus = "success" | "danger" | "warning" | "info" | "idle";

function providerStatus(
  name: string,
  current: string | null,
  failures: number,
): { status: QueueStatus; active: boolean; title?: string } {
  const active = name === current;
  if (failures >= 5) {
    return { active, status: "danger", title: `${name} · tripped (≥5 failures)` };
  }
  if (failures > 0) {
    return { active, status: "warning", title: `${name} · ${failures} failures` };
  }
  return { active, status: active ? "info" : "success" };
}

function ProviderItem({
  name,
  current,
  failures,
}: {
  name: string;
  current: string | null;
  failures: number;
}) {
  const { status, active, title } = providerStatus(name, current, failures);
  return (
    <li title={title} className="inline-flex items-center gap-1.5">
      <StatusDot status={status} pulse={active} />
      <span
        className={cn(
          "rounded-full px-2.5 py-0.5 text-sm transition-all",
          active && "font-medium text-primary-soft",
        )}
      >
        {name}
      </span>
    </li>
  );
}

/** Dashboard primary card: left = provider queues, right = gateway + lane egress relay. */
export function ServiceCard() {
  const { data: status } = useStatus();
  const { data: stats } = useStats();
  const { data: lanes } = useLanes();
  const { data: logs } = useRequestLogs(20);
  const { data: breakers } = useBreakers();
  const qc = useQueryClient();

  const resetAll = useMutation({
    mutationFn: async () => {
      const trippedIds = (breakers ?? [])
        .filter((b) => b.state !== "closed")
        .map((b) => b.provider_id);
      if (trippedIds.length === 0) return { ok: true, message: "No breakers to reset." };
      await Promise.all(trippedIds.map((id) => controlApi.resetBreaker(id)));
      return { ok: true, message: `Reset ${trippedIds.length} breaker${trippedIds.length > 1 ? "s" : ""}` };
    },
    onSuccess: (r) => {
      toast.success(r.message ?? "Breakers reset");
      qc.invalidateQueries({ queryKey: ["breakers"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const failureByName = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of stats ?? []) map.set(s.provider_name, s.failures);
    return map;
  }, [stats]);

  const providerNames = useMemo(
    () => Array.from(new Set([...(stats ?? []).map((s) => s.provider_name)])),
    [stats],
  );
  const current = status?.active_provider ?? null;
  const running = status?.status === "ok";

  const activeRequests = useMemo(() => {
    // Approximate recent activity: requests logged within the last 30s.
    const windowMs = 30_000;
    const cutoff = Date.now() - windowMs;
    return (logs ?? []).filter((l) => l.timestamp_ms >= cutoff).length;
  }, [logs]);

  const uptimeSecs = status?.uptime ?? 0;
  const formatUptime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  };

  const copyGateway = async () => {
    const gatewayUrl = "http://127.0.0.1:7896";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(gatewayUrl);
      } else {
        const ta = document.createElement("textarea");
        ta.value = gatewayUrl;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
    } catch {
      /* copy failed silently */
    }
  };

  const tripped = (stats ?? []).filter((s) => s.failures >= 5).length;
  const lanePills = (() => {
    const statusDoc = lanes?.status;
    const ctlPorts = statusDoc && typeof statusDoc === "object" ? statusDoc : null;
    const ports = Array.isArray(ctlPorts) ? ctlPorts : null;
    if (ports && ports.length > 0) {
      return ports.map((lane: unknown) => {
        const rec = lane as { port?: number; status?: string };
        return {
          port: rec.port ?? 0,
          status: String(rec.status ?? "Active"),
        };
      });
    }
    // fallback: 4 static lane ports
    return [8001, 8002, 8003, 8004].map((port) => ({
      port,
      status: lanes?.enabled ? "Active" : "Quarantined",
    }));
  })();

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3 md:items-stretch">
      {/* Left 2/3: provider queues */}
      <Card className="md:col-span-2 md:min-h-full">
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-ink-primary">Provider Queue</h3>
              <TabularText className="text-xs text-ink-mute">{providerNames.length}</TabularText>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary-soft">
              <ZapIcon className="size-3" />
              cycling {status?.providers_count ?? 0} providers
            </span>
          </div>

          {providerNames.length === 0 ? (
            <p className="text-sm text-ink-mute">No providers configured yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {providerNames.map((name) => (
                <ProviderItem
                  key={name}
                  name={name}
                  current={current}
                  failures={failureByName.get(name) ?? 0}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Right 1/3: Gateway & Egress Relay */}
      <Card className="relative overflow-hidden md:col-span-1">
        <ProxyScene running={running} dark={false} />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[5] bg-gradient-to-t from-black/55 via-black/5 to-black/30"
        />
        <CardContent className="relative z-10 flex h-full flex-col gap-3 px-5 py-4 text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.55)]">
          {/* Gateway status */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">Gateway & Egress Relay</span>
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  running ? "bg-emerald-500/20 text-emerald-100" : "bg-white/10 text-white/70",
                )}
              >
                <span className="relative flex size-2">
                  <span
                    className={cn(
                      "absolute inline-flex size-2 rounded-full opacity-75",
                      running ? "bg-emerald-400 animate-ping" : "bg-slate-400",
                    )}
                  />
                  <span
                    className={cn(
                      "relative inline-flex size-2 rounded-full",
                      running ? "bg-emerald-400" : "bg-slate-400",
                    )}
                  />
                </span>
                {running ? "Active :7896" : "Stopped"}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-white/70">Uptime {formatUptime(uptimeSecs)}</span>
              <span className="text-[11px] text-white/30">·</span>
              <button
                type="button"
                onClick={copyGateway}
                className="inline-flex items-center gap-1 font-mono text-[11px] text-white/85 transition-colors hover:text-white"
                aria-label="Copy gateway URL"
              >
                http://127.0.0.1:7896 <CopyIcon className="size-3 shrink-0" />
              </button>
            </div>
            {/* Live active-request pulse */}
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  activeRequests > 0
                    ? "animate-pulse border-amber-400/30 bg-amber-400/20 text-amber-100"
                    : "border-white/15 bg-white/5 text-white/60",
                )}
              >
                <ActivityIcon className="size-3" />
                {activeRequests > 0 ? `${activeRequests} in-flight` : "0 in-flight"}
              </span>
              {activeRequests > 0 ? (
                <span className="text-[11px] text-white/50">live</span>
              ) : null}
            </div>
          </div>

          {/* Egress relay status & lane pills */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-medium text-white/90">
                <NetworkIcon className="size-3.5" />
                {lanes?.enabled ? `Egress: ${lanePills.length}× Lane Relays` : "Egress: Direct"}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {lanePills.map((lane: { port: number; status: string }) => {
                const s = String(lane.status).toLowerCase();
                const isActive = s === "active";
                const isRotating = s.includes("rotat");
                const isQuarantined = s.includes("quarant");
                return (
                  <span
                    key={lane.port}
                    title={lane.status}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-1 font-mono text-[11px] font-medium",
                      isActive
                        ? "border-emerald-400/30 bg-emerald-500/15 text-emerald-100"
                        : isRotating
                          ? "animate-pulse border-amber-400/30 bg-amber-500/15 text-amber-100"
                          : isQuarantined
                            ? "border-red-400/20 bg-red-500/10 text-red-200"
                            : "border-white/15 bg-white/5 text-white/70",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        isActive
                          ? "bg-emerald-500"
                          : isRotating
                            ? "animate-pulse bg-amber-500"
                            : isQuarantined
                              ? "bg-red-500"
                              : "bg-slate-400",
                      )}
                    />
                    :{lane.port}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Breaker summary */}
          <div className="flex items-center gap-2">
            <ShieldAlertIcon
              className={cn("size-3.5", tripped > 0 ? "text-amber-500" : "text-emerald-500")}
            />
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                tripped === 0
                  ? "border-emerald-400/20 bg-emerald-500/15 text-emerald-100"
                  : "border-amber-400/20 bg-amber-500/15 text-amber-100",
              )}
            >
              {tripped === 0 ? "All Breakers Closed" : `${tripped} Breaker${tripped > 1 ? "s" : ""} Tripped`}
            </span>
            {tripped > 0 ? (
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  if (window.confirm(`Reset ${tripped} breaker${tripped > 1 ? "s" : ""}?`)) resetAll.mutate();
                }}
                disabled={resetAll.isPending}
                className="border-white/20 bg-white/10 text-white/90 hover:bg-white/20 hover:text-white"
              >
                <RefreshCcwIcon className="size-3" />
                Reset all
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}