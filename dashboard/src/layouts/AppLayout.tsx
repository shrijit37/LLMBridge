import { Suspense } from "react";
import { motion, AnimatePresence } from "motion/react";
import { CopyIcon } from "lucide-react";

import { ButtonToggle, StatusPill, ThemeToggle } from "./TopBar";
import { SideNav } from "./SideNav";
import { useLayoutStore } from "@/stores";

import { Dashboard } from "@/pages/Dashboard";
import { TrafficTimeline } from "@/pages/TrafficTimeline";
import { Providers } from "@/pages/Providers";
import { Statistics } from "@/pages/Statistics";
import { Logs } from "@/pages/Logs";
import { LaneEgress } from "@/pages/LaneEgress";
import { GatewayKeys } from "@/pages/GatewayKeys";
import { Settings } from "@/pages/Settings";
import { About } from "@/pages/About";

const PAGES = {
  dashboard: Dashboard,
  trafficTimeline: TrafficTimeline,
  providers: Providers,
  statistics: Statistics,
  logs: Logs,
  laneEgress: LaneEgress,
  gatewayKeys: GatewayKeys,
  settings: Settings,
  about: About,
} as const;

function CopyGatewayUrl() {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText("http://127.0.0.1:7896");
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <ButtonToggle onClick={copy} label="Copy gateway URL">
      <CopyIcon className="size-3.5" />
    </ButtonToggle>
  );
}

export function AppLayout() {
  const activeView = useLayoutStore((s) => s.activeView);
  const ActivePage = PAGES[activeView];

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-end border-b border-edge bg-surface px-6">
        <div className="flex items-center gap-2">
          <StatusPill />
          <ThemeToggle />
          <CopyGatewayUrl />
        </div>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <SideNav />
        <main className="flex-1 min-w-0 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeView}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
            >
              <Suspense fallback={null}>
                <ActivePage />
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
