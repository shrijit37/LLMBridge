import { Badge } from "@/components/ui/badge";

export function LegendBar() {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-mute">
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-success" /> success
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-warning" /> 4xx
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-destructive" /> 5xx / error
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-sm bg-ink-disabled" /> transport error
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-px w-6 border-t border-dashed border-foreground/40" /> now
      </span>
      <Badge variant="muted" className="font-mono text-[10px]">
        bars · duration → width
      </Badge>
    </div>
  );
}
