import {
  ActivityIcon,
  BarChart3Icon,
  BoxesIcon,
  FileTextIcon,
  KeyRoundIcon,
  NetworkIcon,
  SettingsIcon,
  CircleHelpIcon,
  GaugeIcon,
  type LucideIcon,
} from "lucide-react";

import type { ViewId } from "@/stores";

export interface NavEntry {
  id: ViewId;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavEntry[] = [
  { id: "dashboard", label: "Dashboard", icon: GaugeIcon },
  { id: "trafficTimeline", label: "Traffic Timeline", icon: ActivityIcon },
  { id: "providers", label: "Providers", icon: BoxesIcon },
  { id: "statistics", label: "Statistics", icon: BarChart3Icon },
  { id: "logs", label: "Logs", icon: FileTextIcon },
  { id: "laneEgress", label: "Lane Egress", icon: NetworkIcon },
  { id: "gatewayKeys", label: "Gateway Keys", icon: KeyRoundIcon },
];

export const SETTINGS_ITEM: NavEntry = { id: "settings", label: "Settings", icon: SettingsIcon };
export const ABOUT_ITEM: NavEntry = { id: "about", label: "About", icon: CircleHelpIcon };
