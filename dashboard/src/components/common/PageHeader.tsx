import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Props {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}

/** Standard page header: micro-cap eyebrow + thin display title + optional actions. */
export function PageHeader({ eyebrow, title, description, actions, className }: Props) {
  return (
    <header className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-medium tracking-[0.06em] text-ink-secondary uppercase">
            {eyebrow}
          </span>
          <h1 className="text-2xl font-light tracking-tight">{title}</h1>
          {description ? <p className="text-sm text-ink-mute">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
