import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { request, subscribe, Events } from "@/services/request";
import type { RequestLogRecord } from "./types";

/** Live request monitor: last N request logs, refreshed on log events + 3s poll. */
export function useRequestLogs(limit = 50) {
  const qc = useQueryClient();
  useEffect(() => {
    const un = subscribe(Events.log, () => qc.invalidateQueries({ queryKey: ["logs", limit] }));
    return un;
  }, [qc, limit]);

  return useQuery<RequestLogRecord[]>({
    queryKey: ["logs", limit],
    queryFn: () => request<{ logs: RequestLogRecord[] }>(`/api/logs?limit=${limit}`).then((r) => r.logs),
    refetchInterval: 3000,
    refetchOnWindowFocus: false,
  });
}
