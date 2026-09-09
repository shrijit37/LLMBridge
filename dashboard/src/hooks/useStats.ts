import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { request, subscribe, Events } from "@/services/request";
import type { ProviderStat } from "./types";

/** Provider stats; refreshed via SSE stats events + 3s poll fallback. */
export function useStats() {
  const qc = useQueryClient();
  useEffect(() => {
    const un = subscribe(Events.stats, () => qc.invalidateQueries({ queryKey: ["stats"] }));
    return un;
  }, [qc]);

  return useQuery<ProviderStat[]>({
    queryKey: ["stats"],
    queryFn: () => request<{ data: ProviderStat[] }>("/stats").then((r) => r.data),
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
  });
}
