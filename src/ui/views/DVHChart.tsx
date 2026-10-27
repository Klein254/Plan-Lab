import { useMemo, useRef, useState } from 'react';

export interface DvhSeries {
  id: string;
  name: string;
  color: string;
  points: [number, number][]; // [dose, volume fraction 0–1]
  dashed?: boolean;
}

/** Cumulative DVH plot (SVG). x in Gy or % of Rx, y in % volume. */
export function DVHChart({ series, xMax, xLabel, rxLine, height = 360, print = false }: {
  series: DvhSeries[]; xMax: number; xLabel: string; rxLine?: number; height?: number; print?: boolean;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 760, H = height, L = 48, R = 14, T = 12, B = 36;
  const pw = W - L - R, ph = H - T - B;
  const x = (d: number) => L + (d / xMax) * pw;
  const y = (v: number) => T + (1 - v) * ph;
  const ticks = useMemo(() => {
    const step = xMax > 100 ? 20 : xMax > 50 ? 10 : xMax > 20 ? 5 : xMax > 8 ? 2 : 1;
    const out: number[] = [];
    for (let t = 0; t <= xMax + 1e-9; t += step) out.push(+t.toFixed(3));
    return out;
  }, [xMax]);
  const fg = print ? '#111' : '#94a3b8';
  const grid = print ? '#ddd' : 'rgba(148,163,184,0.12)';
  const valueAt = (pts: [number, number][], d: number) => {
    for (let n = 1; n < pts.length; n++) if (pts[n][0] >= d) {
      const [d0, v0] = pts[n - 1], [d1, v1] = pts[n];
      return v0 + ((v1 - v0) * (d - d0)) / (d1 - d0 || 1);
    }
    return 0;
  };
  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full select-none"
        onMouseMove={(e) => {
          const r = ref.current!.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const d = ((px - L) / pw) * xMax;
          setHover(d >= 0 && d <= xMax ? d : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <rect x={L} y={T} width={pw} height={ph} fill={print ? '#fff' : 'rgba(0,0,0,0.25)'} stroke={grid} />
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map((v) => (
          <g key={v}>
            <line x1={L} x2={L + pw} y1={y(v)} y2={y(v)} stroke={grid} />
            <text x={L - 6} y={y(v) + 4} fontSize="11" textAnchor="end" fill={fg}>{v * 100}</text>
          </g>
        ))}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={T} y2={T + ph} stroke={grid} />
            <text x={x(t)} y={T + ph + 15} fontSize="11" textAnchor="middle" fill={fg}>{t}</text>
          </g>
        ))}
        <text x={L + pw / 2} y={H - 4} fontSize="11" textAnchor="middle" fill={fg}>{xLabel}</text>
        <text x={12} y={T + ph / 2} fontSize="11" textAnchor="middle" fill={fg} transform={`rotate(-90 12 ${T + ph / 2})`}>Volume (%)</text>
        {rxLine !== undefined && <line x1={x(rxLine)} x2={x(rxLine)} y1={T} y2={T + ph} stroke="#f59e0b" strokeDasharray="4 4" opacity={0.7} />}
        {series.map((s) => (
          <polyline
            key={s.id}
            fill="none"
            stroke={s.color}
            strokeWidth={1.8}
            strokeDasharray={s.dashed ? '6 4' : undefined}
            points={s.points.map(([d, v]) => `${x(Math.min(d, xMax)).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
          />
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + ph} stroke={fg} opacity={0.5} />}
      </svg>
      {hover !== null && !print && (
        <div className="pointer-events-none absolute top-3 right-4 max-h-[85%] overflow-hidden rounded-lg bg-black/80 px-3 py-2 text-[11px] ring-1 ring-white/10">
          <div className="mb-1 text-slate-300">{hover.toFixed(2)} {xLabel.includes('%') ? '%' : 'Gy'}</div>
          {series.slice(0, 14).map((s) => (
            <div key={s.id} className="flex justify-between gap-4">
              <span style={{ color: s.color }}>{s.name}{s.dashed ? ' (cmp)' : ''}</span>
              <span className="text-slate-200 tabular-nums">{(100 * valueAt(s.points, hover)).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
