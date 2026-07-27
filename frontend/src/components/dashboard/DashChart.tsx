import { useMemo } from "react";

interface Point {
  label: string;
  value: number;
}

interface Props {
  points: Point[];
  height?: number;
}

function smoothPath(pts: { x: number; y: number }[]) {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const midX = (p0.x + p1.x) / 2;
    d += ` C${midX},${p0.y} ${midX},${p1.y} ${p1.x},${p1.y}`;
  }
  return d;
}

export function DashChart({ points, height = 200 }: Props) {
  const W = 620;
  const H = height;
  const padX = 8;
  const padY = 14;

  const { pathLine, pathFill, coords, gridY, lastPoint } = useMemo(() => {
    const values = points.map((p) => p.value);
    const max = Math.max(1, ...values);
    const min = Math.min(0, ...values);
    const range = max - min || 1;
    const innerW = W - padX * 2;
    const innerH = H - padY * 2;
    const coords = points.map((p, i) => ({
      x: padX + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW),
      y: padY + innerH - ((p.value - min) / range) * innerH,
      value: p.value,
      label: p.label,
    }));
    const pathLine = smoothPath(coords);
    const pathFill = pathLine
      ? pathLine +
        ` L${coords[coords.length - 1]?.x ?? W - padX},${H - padY}` +
        ` L${coords[0]?.x ?? padX},${H - padY} Z`
      : "";
    const gridY = [0.25, 0.5, 0.75].map((f) => padY + innerH * f);
    return { pathLine, pathFill, coords, gridY, lastPoint: coords[coords.length - 1] };
  }, [points, H]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={H}
      role="img"
      aria-label="Динамика продаж"
    >
      <defs>
        <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--accent2)" />
          <stop offset="100%" stopColor="var(--accent)" />
        </linearGradient>
        <linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(242,86,11,.24)" />
          <stop offset="100%" stopColor="rgba(242,86,11,0)" />
        </linearGradient>
      </defs>

      {gridY.map((y, i) => (
        <line
          key={i}
          x1={padX}
          y1={y}
          x2={W - padX}
          y2={y}
          stroke="var(--faint)"
          strokeWidth={1}
        />
      ))}

      {pathFill && <path d={pathFill} fill="url(#fillGrad)" />}
      {pathLine && (
        <path
          d={pathLine}
          fill="none"
          stroke="url(#lineGrad)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="1200"
          className="animate-nfDraw"
        />
      )}

      {lastPoint && (
        <circle
          cx={lastPoint.x}
          cy={lastPoint.y}
          r={5}
          fill="var(--accent)"
          stroke="var(--surface)"
          strokeWidth={2}
        />
      )}
    </svg>
  );
}
