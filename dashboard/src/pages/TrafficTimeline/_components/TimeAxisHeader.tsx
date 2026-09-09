import type { TimeWindow } from "../_lib/timeline-utils";
import { formatTickTime } from "../_lib/timeline-utils";

interface Props {
  window: TimeWindow;
  windowMs: number;
  plotWidth: number;
}

export function TimeAxisHeader({ window: timeWindow, windowMs, plotWidth }: Props) {
  const tickCount = Math.min(Math.floor(plotWidth / 80), 20);
  const tickInterval = windowMs / (tickCount + 1);
  const ticks: number[] = [];
  for (let i = 1; i <= tickCount; i++) {
    ticks.push(timeWindow.startMs + tickInterval * i);
  }

  return (
    <g>
      <line x1={0} y1={0} x2={plotWidth} y2={0} stroke="var(--edge)" strokeWidth={1} />
      {ticks.map((ts) => {
        const x = ((ts - timeWindow.startMs) / windowMs) * plotWidth;
        return (
          <g key={ts}>
            <line x1={x} y1={0} x2={x} y2={4} stroke="var(--edge)" strokeWidth={1} />
            <text x={x} y={14} textAnchor="middle" fill="var(--ink-mute)" fontSize={9} fontFamily="var(--font-mono)">
              {formatTickTime(ts, windowMs)}
            </text>
          </g>
        );
      })}
    </g>
  );
}
