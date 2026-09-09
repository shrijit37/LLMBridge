import { useQuery } from "@tanstack/react-query";
import { request } from "@/services/request";
import type { ModelStat } from "./types";

export function useModels(providerId?: string) {
  return useQuery<ModelStat[]>({
    queryKey: ["models", providerId ?? null],
    queryFn: () =>
      request<{ data: ModelStat[] }>(
        `/api/models${providerId ? `?providerId=${encodeURIComponent(providerId)}` : ""}`,
      ).then((r) => r.data),
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  });
}
