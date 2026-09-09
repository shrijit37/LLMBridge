import { useQuery } from "@tanstack/react-query";
import { request } from "@/services/request";
import type { ProviderInfo } from "./types";

export function useProviders() {
  return useQuery<ProviderInfo[]>({
    queryKey: ["providers"],
    queryFn: () => request<{ data: ProviderInfo[] }>("/api/providers").then((r) => r.data),
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  });
}
