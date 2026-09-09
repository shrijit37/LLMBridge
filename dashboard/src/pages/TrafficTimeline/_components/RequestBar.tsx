import { useMemo } from "react";

import type { TimelineRequest, TimeWindow } from "../_lib/timeline-utils";
import {
  computeBarGeometry,
  statusColor,
} from "../_lib/timeline-utils";
import { useTimelineStore } from "@/stores/timeline";

interface Props {
  request: TimelineRequest;
  window: TimeWindow;
  plotWidth: number;
  y: number;
  height: number;
}

export function RequestBar({ request, window: timeWindow, plotWidth, y, height }: Props) {
  const { selectRequest, hoveredRequestId, setHoveredRequest } = useTimelineStore();
  const id = String(request.id ?? request.timestamp_ms);
  const isHovered = hoveredRequestId === id;

  const { x, width } = useMemo(
    () => computeBarGeometry(request, timeWindow, plotWidth),
    [request, timeWindow, plotWidth],
  );
  const color = statusColor(request.status);

  const truncatedLabel = width > 60 ? (request.model ?? "").slice(0, Math.floor(width / 6)) : "";

  return (
    <g
      onClick={() => selectRequest(id)}
      onMouseEnter={() => setHoveredRequest(id)}
      onMouseLeave={() => setHoveredRequest(null)}
      className="cursor-pointer"
    >
      <rect
        x={x}
        y={y + 2}
        width={Math.max(width, 2)}
        height={height - 4}
        rx={3}
        fill={color}
        opacity={isHovered ? 1 : 0.85}
        stroke={isHovered ? "var(--foreground)" : "none"}
        strokeWidth={isHovered ? 1.5 : 0}
      />
      {truncatedLabel && (
        <text
          x={x + 4}
          y={y + height / 2 + 1}
          dominantBaseline="middle"
          className="pointer-events-none select-none"
          fill="var(--foreground)"
          fontSize={10}
          fontFamily="var(--font-mono)"
        >
          {truncatedLabel}
        </text>
      )}
      {width > 34 && request.status != null && request.status > 0 && (
        <text
          x={x + width - 4}
          y={y + height / 2 + 1}
          dominantBaseline="middle"
          textAnchor="end"
          className="pointer-events-none select-none"
          fill="var(--foreground)"
          fontSize={9}
          fontFamily="var(--font-mono)"
          opacity={0.7}
        >
          {request.status}
        </text>
      )}
      {width > 70 && request.latency_ms != null && request.latency_ms > 0 && (
        <text
          x={x + width / 2}
          y={y + height / 2 + 1}
          dominantBaseline="middle"
          textAnchor="middle"
          className="pointer-events-none select-none"
          fill="var(--foreground)"
          fontSize={8}
          fontFamily="var(--font-mono)"
          opacity={0.55}
        >
          {request.latency_ms < 1000 ? `${request.latency_ms}ms` : `${(request.latency_ms / 1000).toFixed(1)}s`}
        </text>
      )}
    </g>
  );
}