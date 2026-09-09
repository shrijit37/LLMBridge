import { create } from "zustand";

type WindowPreset = "5m" | "15m" | "1h" | "today";

interface TimelineState {
  selectedRequestId: string | null;
  panelOpen: boolean;
  hoveredRequestId: string | null;
  windowPreset: WindowPreset;
  setWindowPreset: (p: WindowPreset) => void;
  selectRequest: (id: string | null) => void;
  setHoveredRequest: (id: string | null) => void;
  setPanelOpen: (open: boolean) => void;
}

export const useTimelineStore = create<TimelineState>((set) => ({
  selectedRequestId: null,
  panelOpen: false,
  hoveredRequestId: null,
  windowPreset: "15m",
  setWindowPreset: (windowPreset) => set({ windowPreset }),
  selectRequest: (selectedRequestId) => set({ selectedRequestId, panelOpen: true }),
  setHoveredRequest: (hoveredRequestId) => set({ hoveredRequestId }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
}));

export type { WindowPreset };
