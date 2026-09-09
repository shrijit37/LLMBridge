import type { ReactNode } from "react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StatusDot } from "@/components/ui/StatusDot";
import { TabularText } from "@/components/ui/TabularText";
import { PageHeader } from "@/components/common/PageHeader";
import { useProviders } from "@/hooks/useProviders";
import { useStats } from "@/hooks/useStats";
import { useBreakers } from "@/hooks/useBreakers";
import { controlApi } from "@/services/control";
import { cn } from "@/lib/utils";
import { ProviderFormDialog, type ProviderFormData } from "./ProviderFormDialog";
import type { ProviderInfo, ProviderStat, BreakerInfo } from "@/hooks/types";

function breakerLookup(breakers: BreakerInfo[], name: string) {
  return breakers.find((b) => b.provider_name === name);
}

const BREAKER_META: Record<
  BreakerInfo["state"],
  { status: "success" | "warning" | "danger"; label: string }
> = {
  closed: { status: "success", label: "closed" },
  half_open: { status: "warning", label: "half-open" },
  open: { status: "danger", label: "open" },
};

function RuntimeStats({ stat }: { stat?: ProviderStat }) {
  const cells: { label: string; value: ReactNode }[] = stat
    ? [
        { label: "req", value: stat.requests },
        { label: "fail", value: stat.failures },
        { label: "in", value: stat.input },
        { label: "out", value: stat.output },
      ]
    : [
        { label: "req", value: "–" },
        { label: "fail", value: "–" },
        { label: "in", value: "–" },
        { label: "out", value: "–" },
      ];

  return (
    <div className="grid grid-cols-4 gap-2">
      {cells.map((c) => (
        <div key={c.label} className="flex flex-col gap-1">
          <span className="text-[10px] font-medium tracking-[0.06em] text-ink-mute uppercase">
            {c.label}
          </span>
          <TabularText className="text-xs text-ink-secondary">{c.value}</TabularText>
        </div>
      ))}
    </div>
  );
}

function ProviderCard({
  provider,
  breakers,
  statsByProvider,
  onEdit,
  onDelete,
}: {
  provider: ProviderInfo;
  breakers: BreakerInfo[];
  statsByProvider: Map<string, ProviderStat>;
  onEdit: (provider: ProviderInfo) => void;
  onDelete: (provider: ProviderInfo) => void;
}) {
  const qc = useQueryClient();
  const toggleMut = useMutation({
    mutationFn: () => controlApi.toggleProvider(provider.name),
    onSuccess: (r) => {
      toast.success(r.message ?? "Done");
      qc.invalidateQueries({ queryKey: ["providers"] });
      qc.invalidateQueries({ queryKey: ["breakers"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const resetMut = useMutation({
    mutationFn: () => controlApi.resetBreaker(provider.id),
    onSuccess: () => {
      toast.success("Breaker reset");
      qc.invalidateQueries({ queryKey: ["providers"] });
      qc.invalidateQueries({ queryKey: ["breakers"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const breaker = breakerLookup(breakers, provider.name);
  const meta = breaker ? BREAKER_META[breaker.state] : undefined;

  return (
    <Card className={cn(!provider.enabled && "border-dashed opacity-70")}>
      <CardContent className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{provider.name}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => onEdit(provider)}
              aria-label={`Edit ${provider.name}`}
              title="Edit provider"
              className="shrink-0"
            >
              <Pencil className="size-3" />
            </Button>
          </span>
          <div className="flex items-center gap-2">
            {!provider.enabled ? <Badge variant="muted">disabled</Badge> : null}
            <Badge variant="info">{provider.api_format}</Badge>
            <Switch
              checked={provider.enabled}
              disabled={toggleMut.isPending}
              onCheckedChange={() => toggleMut.mutate()}
              aria-label={`Toggle ${provider.name}`}
            />
          </div>
        </div>
        {breaker && breaker.state !== "closed" ? (
          <div>
            <Button
              variant="outline"
              size="xs"
              disabled={resetMut.isPending}
              onClick={() => resetMut.mutate()}
            >
              <RotateCcw />
              Reset breaker
            </Button>
          </div>
        ) : null}

        <div className="flex items-center justify-end">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onDelete(provider)}
            aria-label={`Delete ${provider.name}`}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 />
            Remove
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {meta ? (
            <>
              <StatusDot status={meta.status} pulse={meta.status === "warning"} />
              <span className="text-xs text-ink-secondary capitalize">{meta.label}</span>
            </>
          ) : (
            <>
              <StatusDot status="idle" />
              <span className="text-xs text-ink-mute">no breaker</span>
            </>
          )}
          {provider.port ? <Badge variant="outline">port {provider.port}</Badge> : null}
          {provider.fallback ? <Badge variant="warning">fallback</Badge> : null}
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium tracking-[0.06em] text-ink-mute uppercase">
            base url
          </span>
          <TabularText className="truncate text-xs text-ink-secondary">{provider.base_url}</TabularText>
        </div>

        <RuntimeStats stat={statsByProvider.get(provider.name)} />

        {provider.test_model || provider.model_map_keys.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {provider.test_model ? (
              <Badge variant="outline" className="font-mono text-[11px]">
                test: {provider.test_model}
              </Badge>
            ) : null}
            {provider.model_map_keys.length > 0 ? (
              <Badge variant="muted">
                {provider.model_map_keys.length} model{provider.model_map_keys.length === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </div>
        ) : null}

        {provider.routes.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-medium tracking-[0.06em] text-ink-mute uppercase">
              routes
            </span>
            <div className="flex flex-col gap-0.5">
              {provider.routes.map((r) => (
                <TabularText key={r.pattern} className="text-xs text-ink-secondary">
                  {r.pattern}
                  <span className="text-ink-mute"> → </span>
                  {r.target}
                </TabularText>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function Providers() {
  const { data: providers } = useProviders();
  const { data: stats } = useStats();
  const { data: breakers } = useBreakers();
  const qc = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderFormData | null>(null);

  const deleteMut = useMutation({
    mutationFn: (name: string) =>
      controlApi.saveConfig({ providers: { [name]: null } }),
    onSuccess: (_r, name) => {
      toast.success(`Removed ${name}`);
      qc.invalidateQueries({ queryKey: ["providers"] });
      qc.invalidateQueries({ queryKey: ["breakers"] });
      qc.invalidateQueries({ queryKey: ["snapshot"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const openAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (p: ProviderInfo) => {
    setEditing({
      name: p.name,
      base_url: p.base_url,
      api_key: "",
      api_format: p.api_format,
      api_version: p.api_version ?? "responses",
      enabled: p.enabled,
      test_model: p.test_model ?? "",
      fallback: p.fallback,
      max_tokens_cap: p.max_tokens_cap != null ? String(p.max_tokens_cap) : "",
      port: p.port != null ? String(p.port) : "",
      quota_command: p.quota_command ?? "",
      inject_thinking_history: p.inject_thinking_history,
      strict_thinking_history: p.strict_thinking_history,
      model_map: { ...p.model_map },
      extra_headers: { ...p.extra_headers },
      routes: p.routes.map((r) => ({ ...r })),
    });
    setDialogOpen(true);
  };

  const statsByProvider = new Map<string, ProviderStat>();
  for (const s of stats ?? []) statsByProvider.set(s.provider_name, s);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <PageHeader
        eyebrow="Infrastructure"
        title="Providers"
        description="Provider configuration and live health."
        actions={
          <Button onClick={openAdd}>
            <Plus />
            Add provider
          </Button>
        }
      />
      {!providers || providers.length === 0 ? (
        <Card>
          <CardContent className="px-5 py-4">
            <p className="py-8 text-center text-sm text-ink-mute">
              No providers configured.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {providers.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              breakers={breakers ?? []}
              statsByProvider={statsByProvider}
              onEdit={openEdit}
              onDelete={(provider) => {
                if (window.confirm(`Remove provider "${provider.name}"?`)) {
                  deleteMut.mutate(provider.name);
                }
              }}
            />
          ))}
        </div>
      )}

      <ProviderFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
      />
    </div>
  );
}