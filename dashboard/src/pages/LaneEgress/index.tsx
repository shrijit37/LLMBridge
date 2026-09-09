import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, RefreshCcw } from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/common/PageHeader";
import { Badge, Button, Card, CardContent, StatusDot, Switch, TabularText } from "@/components/ui";
import { useLanes } from "@/hooks/useLanes";
import { controlApi } from "@/services/control";
import { request } from "@/services/request";
import { cn } from "@/lib/utils";
import { LanesEditDialog, type LanesFormData } from "./LanesEditDialog";

type LaneConfigData = {
  enabled: boolean;
  proxy_base: string;
  ctl_url: string;
  token: string;
  ports: number[];
  endpoint_name?: string | null;
  max_rotations_per_window?: number | null;
  window_secs?: number | null;
};

type LaneRec = { key: string; port: number; status: string };

/** Walk an opaque status doc; find the first array of objects carrying a numeric port. */
function extractLanes(doc: Record<string, unknown> | null): unknown[] | null {
  if (!doc) return null;
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      const objs = node.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object" && !Array.isArray(item),
      );
      for (const obj of objs) {
        const port = obj["port"] ?? obj["Port"];
        if (typeof port === "number") {
          return objs.map((o) => {
            const p = o["port"] ?? o["Port"];
            return {
              port: typeof p === "number" ? p : null,
              status: String(o["status"] ?? o["State"] ?? "active"),
            };
          });
        }
      }
      continue;
    }
    if (node && typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) {
        stack.push(value);
      }
    }
  }
  return null;
}

function PortPill({ rec }: { rec: LaneRec }) {
  const s = rec.status.toLowerCase();
  const active = s === "active" || s === "ok" || s === "open";
  const rotating = s.includes("rotat") || s.includes("cycling") || s.includes("chang");
  const quarantined = s.includes("quarant") || s.includes("down") || s.includes("closed");
  return (
    <span
      key={rec.key}
      title={rec.status}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-edge bg-surface px-2 py-1 font-mono text-[11px] font-medium",
        active && "border-transparent bg-success/12 text-primary-soft",
        rotating && "animate-pulse border-transparent bg-warning/12 text-warning",
        quarantined && "border-transparent bg-destructive/12 text-destructive",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          active ? "bg-success" : rotating ? "bg-warning animate-pulse" : quarantined ? "bg-destructive" : "bg-ink-mute",
        )}
      />
      :{rec.port}
    </span>
  );
}

export function LaneEgress() {
  const { data } = useLanes();
  const status = data?.status ?? null;
  const enabled = !!data?.enabled;
  const qc = useQueryClient();

  const { data: laneConfig } = useQuery<{ data: LaneConfigData | null }>({
    queryKey: ["lanes", "config"],
    queryFn: () => request<{ data: LaneConfigData | null }>("/api/lanes/config"),
    refetchOnWindowFocus: false,
  });

  const [editOpen, setEditOpen] = useState(false);

  const toggleMut = useMutation({
    mutationFn: () => controlApi.toggleLanes(),
    onSuccess: (r) => {
      toast.success(r.message ?? `Egress ${r.enabled ? "enabled" : "disabled"}`);
      qc.invalidateQueries({ queryKey: ["lanes"] });
      qc.invalidateQueries({ queryKey: ["snapshot"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const rotateMut = useMutation({
    mutationFn: (port: number) => controlApi.rotateLane(port),
    onSuccess: (r) => {
      toast.success(r.message ?? `Rotation requested :${r.port}`);
      qc.invalidateQueries({ queryKey: ["lanes"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const lanes =
    useMemo(() => {
      const raw = extractLanes(status && typeof status === "object" ? status : null);
      return (
        raw?.map((r) => ({
          key: String((r as { port?: number | null }).port ?? "?"),
          port: (r as { port?: number | null }).port ?? 0,
          status: String((r as { status?: string }).status ?? "active"),
        })) ??
        [8001, 8002, 8003, 8004].map((port) => ({
          key: String(port),
          port,
          status: enabled ? "active" : "quarantined",
        }))
      );
    }, [status, enabled]);

  const entries = useMemo(() => {
    if (status && typeof status === "object") {
      return Object.entries(status);
    }
    return [];
  }, [status]);

  const editInitial = useMemo<LanesFormData | null>(() => {
    const cfg = laneConfig?.data;
    if (!cfg) return null;
    return {
      proxy_base: cfg.proxy_base,
      ctl_url: cfg.ctl_url,
      token: cfg.token,
      ports: cfg.ports.map(String).join(", "),
      endpoint_name: cfg.endpoint_name ?? "",
      max_rotations_per_window: cfg.max_rotations_per_window != null ? String(cfg.max_rotations_per_window) : "",
      window_secs: cfg.window_secs != null ? String(cfg.window_secs) : "",
    };
  }, [laneConfig]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <PageHeader
        eyebrow="Networking"
        title="Lane Egress"
        description="Egress VPN lane relay health — opaque lane-ctl status rendered as-is."
        actions={
          <Button
            variant="outline"
            onClick={() => setEditOpen(true)}
            disabled={!editInitial}
          >
            <Pencil />
            Edit config
          </Button>
        }
      />

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            {enabled ? (
              <Badge variant="success">
                <StatusDot status="success" pulse />
                Egress
              </Badge>
            ) : (
              <Badge variant="outline">
                <StatusDot status="idle" />
                Egress
              </Badge>
            )}
            <span className="text-sm text-ink-secondary">
              {enabled ? (
                <>
                  via{" "}
                  <TabularText className="text-xs">{lanes.length}</TabularText> lane relays
                </>
              ) : (
                <>Direct</>
              )}
            </span>
            <label className="ml-auto flex items-center gap-2 text-xs text-ink-mute">
              egress
              <Switch
                checked={enabled}
                disabled={toggleMut.isPending}
                onCheckedChange={() => toggleMut.mutate()}
                aria-label="Toggle egress lanes"
              />
            </label>
          </div>
          {!enabled ? (
            <p className="py-8 text-center text-sm text-ink-mute">
              Egress lanes disabled — traffic exits directly.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-ink-primary">Lane Ports</h3>
            {enabled ? (
              <span className="text-[11px] text-ink-mute">click ↻ to rotate an exit IP</span>
            ) : null}
          </div>
          {lanes.length === 0 ? (
            <p className="text-sm text-ink-mute">No lane ports exposed.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {lanes.map((rec) => (
                <div key={rec.key} className="flex items-center gap-1">
                  <PortPill rec={rec} />
                  {enabled ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={rotateMut.isPending}
                      onClick={() => rotateMut.mutate(rec.port)}
                      aria-label={`Rotate port ${rec.port}`}
                      title="Rotate lane"
                    >
                      <RefreshCcw className="size-3" />
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <h3 className="text-sm font-medium text-ink-primary">Lane Control Plane</h3>
          {entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-mute">
              {status == null ? "No status from lane-ctl." : String(status)}
            </p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <tbody>
                {entries.map(([key, value]) => (
                  <tr key={key} className="border-b border-edge-subtle last:border-0">
                    <td className="px-2 py-1.5 align-top font-mono text-xs text-ink-mute">
                      {key}
                    </td>
                    <td className="px-2 py-1.5 align-top font-mono text-xs text-ink-primary">
                      {typeof value === "object" && value !== null
                        ? JSON.stringify(value)
                        : String(value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {editInitial ? (
        <LanesEditDialog
          key={JSON.stringify(editInitial)}
          open={editOpen}
          onOpenChange={setEditOpen}
          initial={editInitial}
        />
      ) : null}
    </div>
  );
}
