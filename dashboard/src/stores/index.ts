import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ViewId =
  | "dashboard"
  | "trafficTimeline"
  | "providers"
  | "statistics"
  | "logs"
  | "laneEgress"
  | "gatewayKeys"
  | "settings"
  | "about";

interface LayoutState {
  activeView: ViewId;
  sidebarState: "expanded" | "collapsed";
  setActiveView: (view: ViewId) => void;
  toggleSidebar: () => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      activeView: "dashboard",
      sidebarState: "expanded",
      setActiveView: (view) => set({ activeView: view }),
      toggleSidebar: () =>
        set((s) => ({
          sidebarState: s.sidebarState === "expanded" ? "collapsed" : "expanded",
        })),
    }),
    { name: "ccs-layout" },
  ),
);
