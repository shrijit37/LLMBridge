import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { TabularText } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { formatTokenCompact } from "@/lib/format";
import { cn } from "@/lib/utils";

type StatColor = "primary" | "destructive" | "info" | "warning" | "success";

const colorClasses: Record<StatColor, string> = {
  primary: "bg-primary/10 text-primary-soft",
  destructive: "bg-destructive/10 text-destructive",
  info: "bg-info/10 text-info",
  warning: "bg-warning/10 text-warning",
  success: "bg-success/10 text-primary-soft",
};

interface Props {
  label: string;
  value: number | string;
  icon?: LucideIcon;
  color?: StatColor;
  hint?: ReactNode;
  /** When true, helper hint is below the value (vertically stacked); default is to the right. */
  hintBelow?: boolean;
}

/** Shared StatCard: optional icon badge + label + large value + optional hint. */
export function StatCard({ label, value, icon: Icon, color, hint, hintBelow = false }: Props) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 px-5 py-4">
        <span className="flex items-center gap-2 text-xs text-ink-secondary">
          {Icon && color ? (
            <span className={cn("inline-flex size-5 items-center justify-center rounded-md", colorClasses[color])}>
              <Icon className="size-3" />
            </span>
          ) : null}
          {label}
        </span>
        <div
          className={
            hintBelow ? "flex flex-col gap-0.5" : "flex items-center justify-between gap-2"
          }
        >
          <TabularText className="text-2xl text-foreground">{value}</TabularText>
          {hint}
        </div>
      </CardContent>
    </Card>
  );
}

/** Token hint shown only at >=10k; otherwise the exact value reads clearly. */
export function TokenHint({ value }: { value: number }) {
  if (value < 1e4) return null;
  return <span className="text-xs text-ink-secondary">{formatTokenCompact(value)}</span>;
}
