import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/ui";
import { useLayoutStore, type ViewId } from "@/stores";
import type { NavEntry } from "./navConfig";

export function NavItem({
  item,
  collapsed = false,
}: {
  item: NavEntry;
  collapsed?: boolean;
}) {
  const activeView = useLayoutStore((s) => s.activeView);
  const setActiveView = useLayoutStore((s) => s.setActiveView);
  const active = activeView === item.id;
  const Icon = item.icon;

  return (
    <button
      type="button"
      onClick={() => {
        setActiveView(item.id as ViewId);
      }}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors",
        active
          ? "bg-accent font-medium text-ink-primary"
          : "text-ink-secondary hover:bg-accent/60 hover:text-ink-primary",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className={cn("size-4 shrink-0", active && "text-primary-soft")} />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {active && <StatusDot status="info" className="ml-auto" />}
    </button>
  );
}
