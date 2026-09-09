import { useQuery } from "@tanstack/react-query";
import { request } from "@/services/request";
import type { HealthSnapshot } from "./types";

export function useStatus() {
  return useQuery<HealthSnapshot>({
    queryKey: ["status"],
    queryFn: () => request<HealthSnapshot>("/health"),
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
  });
}
