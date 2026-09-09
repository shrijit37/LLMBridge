import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useLayoutStore } from "@/stores";
import { NavItem } from "./NavItem";
import { NAV_ITEMS, SETTINGS_ITEM, ABOUT_ITEM } from "./navConfig";
import { ThemeToggle, BrandMark } from "./TopBar";

export function SideNav() {
  const sidebarState = useLayoutStore((s) => s.sidebarState);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const collapsed = sidebarState === "collapsed";

  return (
    <nav
      className={cn(
        "flex shrink-0 flex-col border-r border-edge bg-surface transition-[width] duration-200 ease-in-out",
        collapsed ? "w-14" : "w-[220px]",
      )}
    >
      <div className="flex h-14 shrink-0 items-center border-b border-edge-subtle px-4">
        <BrandMark iconOnly={collapsed} />
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <NavItem key={item.id} item={item} collapsed={collapsed} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1 border-t border-edge px-2 py-2">
        <NavItem item={SETTINGS_ITEM} collapsed={collapsed} />
        <NavItem item={ABOUT_ITEM} collapsed={collapsed} />
        <div className={cn("flex gap-1 pt-1", collapsed && "flex-col items-center")}>
          <ThemeToggle />
          <Button variant="ghost" size="icon" aria-label="Collapse sidebar" onClick={toggleSidebar}>
            {collapsed ? (
              <ChevronRightIcon className="size-4" />
            ) : (
              <ChevronLeftIcon className="size-4" />
            )}
          </Button>
        </div>
      </div>
    </nav>
  );
}
