import { useRef, useState, useEffect, useCallback, useMemo } from "react";

import type { LaneGroup, TimeWindow } from "../_lib/timeline-utils";
import { timeToX } from "../_lib/timeline-utils";
import { RequestBar } from "./RequestBar";
import { NowLine } from "./NowLine";
import { TimeAxisHeader } from "./TimeAxisHeader";

const LANE_LABEL_WIDTH = 140;
const LANE_HEIGHT = 40;
const LANE_GAP = 2;
const HEADER_HEIGHT = 24;

interface Props {
  laneGroups: LaneGroup[];
  window: TimeWindow;
  windowMs: number;
}

export function EgressSwimlanes({ laneGroups, window: timeWindow, windowMs }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(800);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setPlotWidth(Math.max(400, entry.contentRect.width - LANE_LABEL_WIDTH));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const totalTimeToX = useCallback(
    (ts: number) => timeToX(ts, timeWindow, plotWidth),
    [timeWindow, plotWidth],
  );

  const totalHeight = useMemo(
    () => HEADER_HEIGHT + laneGroups.length * (LANE_HEIGHT + LANE_GAP) + 8,
    [laneGroups.length],
  );

  const gridLines = useMemo(
    () => laneGroups.map((_, i) => HEADER_HEIGHT + (i + 1) * (LANE_HEIGHT + LANE_GAP) - LANE_GAP),
    [laneGroups],
  );

  if (laneGroups.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-edge bg-muted/10 py-16 text-sm text-ink-mute">
        No requests in the selected time window.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full overflow-x-auto scrollbar-none">
      <svg width={LANE_LABEL_WIDTH + plotWidth} height={totalHeight} className="select-none">
        {/* Time axis header */}
        <g transform={`translate(${LANE_LABEL_WIDTH}, 0)`}>
          <TimeAxisHeader window={timeWindow} windowMs={windowMs} plotWidth={plotWidth} />
        </g>

        {/* Lane rows */}
        {laneGroups.map((lane, i) => {
          const laneY = HEADER_HEIGHT + i * (LANE_HEIGHT + LANE_GAP);
          return (
            <g key={lane.laneKey}>
              {/* Lane label */}
              <text
                x={8}
                y={laneY + LANE_HEIGHT / 2}
                dominantBaseline="middle"
                fill="var(--ink-secondary)"
                fontSize={11}
                fontFamily="var(--font-sans)"
                fontWeight={500}
              >
                {lane.label}
              </text>
              <text
                x={LANE_LABEL_WIDTH - 8}
                y={laneY + LANE_HEIGHT / 2}
                textAnchor="end"
                dominantBaseline="middle"
                fill="var(--ink-mute)"
                fontSize={10}
                fontFamily="var(--font-mono)"
              >
                {lane.requests.length}
              </text>

              {/* Request bars */}
              <g transform={`translate(${LANE_LABEL_WIDTH}, 0)`}>
                {lane.requests.map((req, idx) => (
                  <RequestBar
                    key={req.id ?? `${req.timestamp_ms}-${idx}`}
                    request={req}
                    window={timeWindow}
                    plotWidth={plotWidth}
                    y={laneY}
                    height={LANE_HEIGHT}
                  />
                ))}
              </g>
            </g>
          );
        })}

        {/* Horizontal grid lines */}
        {gridLines.map((y, i) => (
          <line
            key={i}
            x1={0}
            y1={y}
            x2={LANE_LABEL_WIDTH + plotWidth}
            y2={y}
            stroke="var(--edge-subtle)"
            strokeWidth={1}
          />
        ))}

        {/* NOW line */}
        <g transform={`translate(${LANE_LABEL_WIDTH}, 0)`}>
          <NowLine timeToX={totalTimeToX} height={totalHeight - HEADER_HEIGHT} />
        </g>
      </svg>
    </div>
  );
}