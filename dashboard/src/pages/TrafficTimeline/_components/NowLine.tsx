import { useEffect, useState } from "react";

interface Props {
  timeToX: (ts: number) => number;
  height: number;
}

export function NowLine({ timeToX, height }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const x = timeToX(now);
  if (x < 0) return null;

  return (
    <g>
      <line
        x1={x}
        y1={0}
        x2={x}
        y2={height}
        stroke="var(--foreground)"
        strokeWidth={1}
        strokeDasharray="4 3"
        opacity={0.4}
      />
      <text
        x={x}
        y={-4}
        textAnchor="middle"
        fill="var(--foreground)"
        fontSize={9}
        fontFamily="var(--font-mono)"
        fontWeight={600}
        opacity={0.6}
      >
        NOW
      </text>
    </g>
  );
}
