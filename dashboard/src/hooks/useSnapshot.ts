import { useQuery } from "@tanstack/react-query";
import { request } from "@/services/request";
import type { StatusSnapshot } from "./types";

/** One-shot /api/status snapshot for the initial paint; live updates come via SSE. */
export function useSnapshot() {
  return useQuery<StatusSnapshot>({
    queryKey: ["snapshot"],
    queryFn: () => request<StatusSnapshot>("/api/status"),
    refetchInterval: 10000,
    refetchOnWindowFocus: false,
  });
}
