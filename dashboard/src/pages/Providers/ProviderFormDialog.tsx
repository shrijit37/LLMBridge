import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { controlApi } from "@/services/control";
import { KeyValueEditor } from "@/components/business/KeyValueEditor";

export type RouteFormRow = { pattern: string; target: string; enabled: boolean };

export type ProviderFormData = {
  name: string;
  base_url: string;
  api_key: string;
  api_format: string;
  api_version: string;
  enabled: boolean;
  test_model: string;
  fallback: boolean;
  max_tokens_cap: string;
  port: string;
  quota_command: string;
  inject_thinking_history: boolean;
  strict_thinking_history: boolean;
  model_map: Record<string, string>;
  extra_headers: Record<string, string>;
  routes: RouteFormRow[];
};

interface ProviderFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = new provider, otherwise = edit mode. */
  initial: ProviderFormData | null;
}

const API_FORMATS = ["anthropic", "openai", "gemini"] as const;
const API_VERSIONS = ["responses", "chat_completions"] as const;

const EMPTY: ProviderFormData = {
  name: "",
  base_url: "",
  api_key: "",
  api_format: "anthropic",
  api_version: "responses",
  enabled: true,
  test_model: "",
  fallback: false,
  max_tokens_cap: "",
  port: "",
  quota_command: "",
  inject_thinking_history: true,
  strict_thinking_history: false,
  model_map: {},
  extra_headers: {},
  routes: [],
};

export function ProviderFormDialog({
  open,
  onOpenChange,
  initial,
}: ProviderFormDialogProps) {
  const isEdit = initial !== null;
  const qc = useQueryClient();
  const [form, setForm] = useState<ProviderFormData>(EMPTY);

  useEffect(() => {
    if (open) setForm(initial ?? EMPTY);
  }, [open, initial]);

  const set = <K extends keyof ProviderFormData>(
    key: K,
    val: ProviderFormData[K]
  ) => setForm((f) => ({ ...f, [key]: val }));

  const saveMut = useMutation({
    mutationFn: () => {
      const name = form.name.trim();
      if (!name) throw new Error("Provider name is required");
      if (!form.base_url.trim()) throw new Error("Base URL is required");

      const patch: Record<string, unknown> = {
        providers: {
          [name]: {
            base_url: form.base_url.trim(),
            api_format: form.api_format,
            api_version: form.api_format === "openai" ? form.api_version : undefined,
            enabled: form.enabled,
            test_model: form.test_model.trim() || undefined,
            fallback: form.fallback || undefined,
            inject_thinking_history: form.inject_thinking_history || undefined,
            strict_thinking_history: form.strict_thinking_history || undefined,
            max_tokens_cap: form.max_tokens_cap
              ? Number(form.max_tokens_cap)
              : undefined,
            port: form.port ? Number(form.port) : undefined,
            quota_command: form.quota_command.trim() || undefined,
            model_map: Object.keys(form.model_map).length > 0 ? form.model_map : undefined,
            extra_headers: Object.keys(form.extra_headers).length > 0 ? form.extra_headers : undefined,
            routes: form.routes.length > 0 ? form.routes : undefined,
            // In edit mode, preserve the key unless a new one is entered.
            ...(form.api_key.trim() ? { api_key: form.api_key.trim() } : {}),
          },
        },
      };
      return controlApi.saveConfig(patch);
    },
    onSuccess: (r) => {
      toast.success(r.message ?? (isEdit ? "Provider updated" : "Provider added"));
      qc.invalidateQueries({ queryKey: ["providers"] });
      qc.invalidateQueries({ queryKey: ["breakers"] });
      qc.invalidateQueries({ queryKey: ["snapshot"] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const addRoute = () =>
    set("routes", [...form.routes, { pattern: "", target: "", enabled: true }]);
  const updRoute = (i: number, patch: Partial<RouteFormRow>) => {
    set("routes", form.routes.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  const delRoute = (i: number) => set("routes", form.routes.filter((_, idx) => idx !== i));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Provider" : "Add Provider"}</DialogTitle>
          <DialogDescription>
            Full provider configuration. Blank optional fields are omitted from the saved config.
          </DialogDescription>
        </DialogHeader>

        {/* Core */}
        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-3">
            <Label className="text-xs text-ink-secondary uppercase tracking-wide">Core</Label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  disabled={isEdit}
                  placeholder="e.g. my-anthropic"
                />
                {isEdit ? (
                  <span className="text-[11px] text-ink-mute">
                    Name is the config key; cannot be renamed after creation.
                  </span>
                ) : null}
              </label>
              <label className="flex flex-col gap-1.5">
                <Label>Base URL</Label>
                <Input
                  value={form.base_url}
                  onChange={(e) => set("base_url", e.target.value)}
                  placeholder="https://api.anthropic.com"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <Label>API Key</Label>
                <Input
                  type="password"
                  value={form.api_key}
                  onChange={(e) => set("api_key", e.target.value)}
                  placeholder={isEdit ? "(unchanged)" : "sk-..."}
                />
                {isEdit ? (
                  <span className="text-[11px] text-ink-mute">
                    Leave blank to keep the existing key.
                  </span>
                ) : null}
              </label>
              <label className="flex flex-col gap-1.5">
                <Label>Test Model</Label>
                <Input
                  value={form.test_model}
                  onChange={(e) => set("test_model", e.target.value)}
                  placeholder="e.g. claude-3-5-sonnet"
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <Label>API Format</Label>
                <Select value={form.api_format} onValueChange={(v) => set("api_format", v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {API_FORMATS.map((f) => (
                      <SelectItem key={f} value={f}>{f}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {form.api_format === "openai" ? (
                <label className="flex flex-col gap-1.5">
                  <Label>API Version</Label>
                  <Select value={form.api_version} onValueChange={(v) => set("api_version", v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {API_VERSIONS.map((v) => (
                        <SelectItem key={v} value={v}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              ) : null}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <label className="flex flex-col gap-1.5">
                <Label>Port</Label>
                <Input
                  value={form.port}
                  onChange={(e) => set("port", e.target.value)}
                  placeholder="e.g. 8000"
                  inputMode="numeric"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <Label>Max Tokens Cap</Label>
                <Input
                  value={form.max_tokens_cap}
                  onChange={(e) => set("max_tokens_cap", e.target.value)}
                  placeholder="e.g. 200000"
                  inputMode="numeric"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <Label>Quota Command</Label>
                <Input
                  value={form.quota_command}
                  onChange={(e) => set("quota_command", e.target.value)}
                  placeholder="shell cmd"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-5 pt-1">
              <label className="flex items-center gap-2">
                <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} />
                <Label>Enabled</Label>
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={form.fallback} onCheckedChange={(v) => set("fallback", v)} />
                <Label>Fallback</Label>
              </label>
              <label className="flex items-center gap-2">
                <Switch
                  checked={form.inject_thinking_history}
                  onCheckedChange={(v) => set("inject_thinking_history", v)}
                />
                <Label>Inject thinking history</Label>
              </label>
              <label className="flex items-center gap-2">
                <Switch
                  checked={form.strict_thinking_history}
                  onCheckedChange={(v) => set("strict_thinking_history", v)}
                />
                <Label>Strict thinking history</Label>
              </label>
            </div>
          </section>

          <Separator />

          {/* Model map */}
          <section className="flex flex-col gap-2">
            <Label className="text-xs text-ink-secondary uppercase tracking-wide">Model Map</Label>
            <p className="text-[11px] text-ink-mute">
              Map gateway model IDs to upstream model IDs (model → target).
            </p>
            <KeyValueEditor
              value={form.model_map}
              onChange={(v) => set("model_map", v)}
              keyPlaceholder="alias"
              valPlaceholder="target model"
            />
          </section>

          <Separator />

          {/* Extra headers */}
          <section className="flex flex-col gap-2">
            <Label className="text-xs text-ink-secondary uppercase tracking-wide">Extra Headers</Label>
            <KeyValueEditor
              value={form.extra_headers}
              onChange={(v) => set("extra_headers", v)}
              keyPlaceholder="Header-Name"
              valPlaceholder="value"
            />
          </section>

          <Separator />

          {/* Routes */}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-ink-secondary uppercase tracking-wide">Routes</Label>
              <Button variant="ghost" size="xs" onClick={addRoute}>
                <Plus className="size-3" /> Add route
              </Button>
            </div>
            {form.routes.length === 0 ? (
              <p className="text-[11px] text-ink-mute">No routes.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {form.routes.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      className="flex-[1.2]"
                      value={r.pattern}
                      placeholder="pattern e.g. /v1/messages"
                      onChange={(e) => updRoute(i, { pattern: e.target.value })}
                    />
                    <Input
                      className="flex-1"
                      value={r.target}
                      placeholder="target"
                      onChange={(e) => updRoute(i, { target: e.target.value })}
                    />
                    <Switch
                      checked={r.enabled}
                      onCheckedChange={(v) => updRoute(i, { enabled: v })}
                      aria-label={`Route ${i + 1} enabled`}
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => delRoute(i)}
                      aria-label="Remove route"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            {saveMut.isPending ? "Saving…" : isEdit ? "Update" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
