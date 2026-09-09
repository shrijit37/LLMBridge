import type { ReactNode } from "react";

import { TabularText } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";
import { formatTokenCompact } from "@/lib/format";

interface Props {
  label: string;
  value: number | string;
  hint?: ReactNode;
  /** When true, helper hint is below the value (vertically stacked); default is to the right. */
  hintBelow?: boolean;
}

/** Shared StatCard: label + large value + optional hint. */
export function StatCard({ label, value, hint, hintBelow = false }: Props) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 px-5 py-4">
        <span className="text-xs text-ink-secondary">{label}</span>
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

/** Token hint shown only at ≥10k; otherwise the exact value reads clearly. */
export function TokenHint({ value }: { value: number }) {
  if (value < 1e4) return null;
  return <span className="text-xs text-ink-secondary">{formatTokenCompact(value)}</span>;
}
