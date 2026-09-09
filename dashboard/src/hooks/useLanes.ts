import { useQuery } from "@tanstack/react-query";
import { request } from "@/services/request";
import type { LanesSnapshot } from "./types";

/** Egress lane health; content is the opaque lane-ctl status document when enabled. */
export function useLanes() {
  return useQuery<LanesSnapshot>({
    queryKey: ["lanes"],
    queryFn: () => request<LanesSnapshot>("/api/lanes"),
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
  });
}
