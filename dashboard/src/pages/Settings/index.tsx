import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/common/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/StatusDot";
import { TabularText } from "@/components/ui/TabularText";
import { useSnapshot } from "@/hooks/useSnapshot";
import { useStatus } from "@/hooks/useStatus";
import { controlApi } from "@/services/control";
import { formatDuration } from "@/lib/format";

export function Settings() {
  const { data: snapshot } = useSnapshot();
  const { data: health } = useStatus();

  const config = snapshot?.config;
  const providers = config?.providers ?? [];
  const uptime =
    health?.uptime != null ? formatDuration(health.uptime) : `${health?.uptime ?? "—"} s`;

  const [limit, setLimit] = useState(() => String(config?.requestLogLimit ?? ""));
  const qc = useQueryClient();

  useEffect(() => {
    setLimit((cur) => (config?.requestLogLimit != null ? String(config.requestLogLimit) : cur));
  }, [config?.requestLogLimit]);

  const saveMut = useMutation({
    mutationFn: () => {
      if (limit.trim() === "" || !Number.isFinite(Number(limit))) {
        throw new Error("Request log limit must be a non-empty number");
      }
      return controlApi.saveConfig({ request_log_limit: Number(limit) });
    },
    onSuccess: (r) => {
      toast.success(r.message ?? "Config saved");
      qc.invalidateQueries({ queryKey: ["snapshot"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        description="Live configuration view — edit request-log retention and watch for the atomic reload."
      />

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <span className="text-sm font-medium">Listen</span>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-ink-secondary">Address</span>
            <TabularText className="text-xs">{config?.listen ?? "—"}</TabularText>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-ink-secondary">Request log limit</span>
            <TabularText className="text-xs">
              {config?.requestLogLimit ?? "—"}
            </TabularText>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-ink-secondary">Current provider</span>
            <TabularText className="text-xs">{config?.current ?? "—"}</TabularText>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <span className="text-sm font-medium">Providers</span>
          {providers.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-mute">No providers configured.</p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-edge text-left text-xs text-ink-mute">
                  <th className="px-2 pb-2 font-medium">Provider</th>
                  <th className="px-2 pb-2 font-medium">Request log limit</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((name) => (
                  <tr key={name} className="border-b border-edge-subtle last:border-0 hover:bg-surface-hover">
                    <td className="px-2 py-2">
                      <span className="flex items-center gap-2">
                        <StatusDot status="success" />
                        <TabularText className="text-xs">{name}</TabularText>
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <Badge variant="outline">
                        <TabularText className="text-xs">{config?.requestLogLimit}</TabularText>
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <span className="text-sm font-medium">Edit configuration</span>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-ink-secondary">Request log limit</span>
            <Input
              type="number"
              inputMode="numeric"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              aria-label="Request log limit"
            />
          </label>
          <div>
            <Button
              variant="default"
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending || limit === String(config?.requestLogLimit)}
            >
              {saveMut.isPending ? "Applying…" : "Apply"}
            </Button>
          </div>
          <p className="text-xs text-ink-mute">
            Config hot-reloads from <TabularText className="text-xs">$CCS_CONFIG_DIR/config.json</TabularText>{" "}
            after save.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 px-5 py-4">
          <span className="text-sm font-medium">Config source</span>
          <p className="text-sm text-ink-mute">
            Config is watched live from <TabularText className="text-xs">$CCS_CONFIG_DIR/config.json</TabularText>{" "}
            and hot-reloaded on change.
          </p>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-ink-secondary">Gateway uptime</span>
            <TabularText className="text-xs">{uptime}</TabularText>
          </div>
        </CardContent>
      </Card>

      <p className="text-sm text-ink-mute">
        About this view: the full config JSON lives server-side; this page shows only the
        active snapshot as reported by the gateway.
      </p>
    </div>
  );
}