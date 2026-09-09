import type { ReactNode } from "react";
import { ActivityIcon, SunIcon, MoonIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { StatusDot, TabularText } from "@/components/ui";
import { useStatus } from "@/hooks/useStatus";
import { cn } from "@/lib/utils";

/** Brand mark: emerald StatusDot + "CCS Gateway" wordmark. */
export function BrandMark({ iconOnly = false }: { iconOnly?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <StatusDot status="success" />
      {!iconOnly && <span className="text-sm font-medium tracking-tight">CCS Gateway</span>}
    </span>
  );
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <ButtonToggle onClick={() => setTheme(dark ? "light" : "dark")} label="Toggle theme">
      {dark ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
    </ButtonToggle>
  );
}

export function ButtonToggle({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex size-7 items-center justify-center rounded-full text-ink-mute transition-colors hover:bg-accent hover:text-ink-primary"
    >
      {children}
    </button>
  );
}

/** Live status pill: uptime + active provider, pulsing emerald while healthy. */
export function StatusPill() {
  const { data: status } = useStatus();
  const uptime = status?.uptime ?? 0;
  const formatUptime = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  const ok = status?.status === "ok";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium",
        ok ? "bg-primary/12 text-primary-soft" : "bg-destructive/12 text-destructive",
      )}
    >
      <span className="relative flex size-1.5">
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-75",
            ok ? "bg-success" : "bg-destructive",
          )}
        />
        <span className={cn("relative inline-flex size-1.5 rounded-full", ok ? "bg-success" : "bg-destructive")} />
      </span>
      {ok ? (
        <span className="flex items-center gap-1">
          <ActivityIcon className="size-2.5" />
          <TabularText>up {formatUptime(uptime)}</TabularText>
        </span>
      ) : (
        "offline"
      )}
    </span>
  );
}
