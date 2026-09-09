import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: LucideIcon;
  heading: string;
  description?: string;
  className?: string;
}

/** Shared empty state: icon + heading + description, centered. */
export function EmptyState({ icon: Icon, heading, description, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center gap-3 py-12 text-center", className)}>
      {Icon ? (
        <span className="inline-flex size-10 items-center justify-center rounded-full bg-surface-raised">
          <Icon className="size-5 text-ink-disabled" />
        </span>
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-ink-primary">{heading}</p>
        {description ? (
          <p className="max-w-sm text-xs text-ink-mute">{description}</p>
        ) : null}
      </div>
    </div>
  );
}
