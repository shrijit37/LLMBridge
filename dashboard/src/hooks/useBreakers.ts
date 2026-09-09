import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { request, subscribe, Events } from "@/services/request";
import type { BreakerInfo } from "./types";

export function useBreakers() {
  const qc = useQueryClient();
  useEffect(() => {
    const un = subscribe(Events.stats, () => qc.invalidateQueries({ queryKey: ["breakers"] }));
    return un;
  }, [qc]);

  return useQuery<BreakerInfo[]>({
    queryKey: ["breakers"],
    queryFn: () => request<{ data: BreakerInfo[] }>("/api/breakers").then((r) => r.data),
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
  });
}
