import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Separator } from "@/components/ui/separator";
import { controlApi } from "@/services/control";

export type LanesFormData = {
  proxy_base: string;
  ctl_url: string;
  token: string;
  ports: string;
  endpoint_name: string;
  max_rotations_per_window: string;
  window_secs: string;
};

interface LanesEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: LanesFormData;
}

export function LanesEditDialog({
  open,
  onOpenChange,
  initial,
}: LanesEditDialogProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState<LanesFormData>(initial);

  useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);

  const set = <K extends keyof LanesFormData>(key: K, val: LanesFormData[K]) =>
    setForm((f) => ({ ...f, [key]: val }));

  const saveMut = useMutation({
    mutationFn: () => {
      const ports = form.ports
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (ports.length === 0) throw new Error("At least one valid port is required");

      const patch: Record<string, unknown> = {
        lanes: {
          proxy_base: form.proxy_base.trim(),
          ctl_url: form.ctl_url.trim(),
          token: form.token.trim() || undefined,
          ports,
          endpoint_name: form.endpoint_name.trim() || undefined,
          max_rotations_per_window: form.max_rotations_per_window
            ? Number(form.max_rotations_per_window)
            : undefined,
          window_secs: form.window_secs
            ? Number(form.window_secs)
            : undefined,
        },
      };
      return controlApi.saveConfig(patch);
    },
    onSuccess: (r) => {
      toast.success(r.message ?? "Lane config saved");
      qc.invalidateQueries({ queryKey: ["lanes"] });
      qc.invalidateQueries({ queryKey: ["lanes", "config"] });
      qc.invalidateQueries({ queryKey: ["snapshot"] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Lane Config</DialogTitle>
          <DialogDescription>
            Egress lane proxy and relay control plane settings.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-3">
            <Label className="text-xs text-ink-secondary uppercase tracking-wide">
              Proxy & Relay
            </Label>
            <label className="flex flex-col gap-1.5">
              <Label>Proxy Base</Label>
              <Input
                value={form.proxy_base}
                onChange={(e) => set("proxy_base", e.target.value)}
                placeholder="http://lane-egress"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Control URL</Label>
              <Input
                value={form.ctl_url}
                onChange={(e) => set("ctl_url", e.target.value)}
                placeholder="http://lane-egress:9100"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Token</Label>
              <Input
                type="password"
                value={form.token}
                onChange={(e) => set("token", e.target.value)}
                placeholder="Optional lane-ctl auth token"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <Label>Ports (comma-separated)</Label>
              <Input
                value={form.ports}
                onChange={(e) => set("ports", e.target.value)}
                placeholder="8001, 8002, 8003, 8004"
              />
            </label>
          </section>

          <Separator />

          <section className="flex flex-col gap-3">
            <Label className="text-xs text-ink-secondary uppercase tracking-wide">
              Rotation Control
            </Label>
            <label className="flex flex-col gap-1.5">
              <Label>Endpoint Name</Label>
              <Input
                value={form.endpoint_name}
                onChange={(e) => set("endpoint_name", e.target.value)}
                placeholder="Optional lane endpoint identifier"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <Label>Max Rotations / Window</Label>
                <Input
                  value={form.max_rotations_per_window}
                  onChange={(e) => set("max_rotations_per_window", e.target.value)}
                  placeholder="e.g. 6"
                  inputMode="numeric"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <Label>Window (seconds)</Label>
                <Input
                  value={form.window_secs}
                  onChange={(e) => set("window_secs", e.target.value)}
                  placeholder="e.g. 60"
                  inputMode="numeric"
                />
              </label>
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            {saveMut.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
