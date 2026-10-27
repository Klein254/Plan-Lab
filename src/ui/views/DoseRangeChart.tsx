import { useState } from 'react';

export interface RangeRow {
  id: string;
  name: string;
  color: string;
  /** min, D98, mean, D50, D2, max in the chart's unit; a second entry (dashed) for the comparison plan. */
  stats: { min: number; d98: number; mean: number; d50: number; d2: number; max: number }[];
  limit?: number; // tolerance marker (same unit), e.g. a Dmax constraint
}

/** One row per structure: whisker min–max, box D98–D2, tick at D50, dot at the mean. Plan and comparison side by side. */
export function DoseRangeChart({ rows, xMax, xLabel, rxLine, compareName }: { rows: RangeRow[]; xMax: number; xLabel: string; rxLine?: number; compareName?: string }) {
  const [hover, setHover] = useState<string | null>(null);
  const per = rows.some((r) => r.stats.length > 1) ? 26 : 18;
  const W = 760, L = 132, R = 14, T = 10, B = 34;
  const H = T + B + rows.length * per;
  const pw = W - L - R;
  const x = (d: number) => L + (Math.max(0, Math.min(xMax, d)) / xMax) * pw;
  const step = xMax > 100 ? 20 : xMax > 50 ? 10 : xMax > 20 ? 5 : 2;
  const ticks: number[] = [];
  for (let t = 0; t <= xMax + 1e-9; t += step) ticks.push(t);
  const fg = '#94a3b8', grid = 'rgba(148,163,184,0.12)';
  const hovered = rows.find((r) => r.id === hover);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full select-none" onMouseLeave={() => setHover(null)}>
        <rect x={L} y={T} width={pw} height={rows.length * per} fill="rgba(0,0,0,0.25)" stroke={grid} />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={T} y2={T + rows.length * per} stroke={grid} />
            <text x={x(t)} y={T + rows.length * per + 15} fontSize="11" textAnchor="middle" fill={fg}>{t}</text>
          </g>
        ))}
        <text x={L + pw / 2} y={H - 4} fontSize="11" textAnchor="middle" fill={fg}>{xLabel}</text>
        {rxLine !== undefined && <line x1={x(rxLine)} x2={x(rxLine)} y1={T} y2={T + rows.length * per} stroke="#f59e0b" strokeDasharray="4 4" opacity={0.7} />}
        {rows.map((r, n) => {
          const y0 = T + n * per;
          return (
            <g key={r.id} onMouseEnter={() => setHover(r.id)}>
              <rect x={0} y={y0} width={W} height={per} fill={hover === r.id ? 'rgba(255,255,255,0.04)' : 'transparent'} />
              <rect x={6} y={y0 + per / 2 - 4} width={8} height={8} rx={1.5} fill={r.color} />
              <text x={20} y={y0 + per / 2 + 4} fontSize="11" fill="#e2e8f0">{r.name.length > 16 ? `${r.name.slice(0, 15)}…` : r.name}</text>
              {r.stats.map((s, q) => {
                const cy = y0 + (r.stats.length > 1 ? (q === 0 ? per * 0.32 : per * 0.72) : per / 2);
                const dash = q === 1 ? '3 3' : undefined;
                return (
                  <g key={q} opacity={q === 1 ? 0.75 : 1}>
                    <line x1={x(s.min)} x2={x(s.max)} y1={cy} y2={cy} stroke={r.color} strokeWidth={1.2} strokeDasharray={dash} />
                    <rect x={x(s.d98)} y={cy - 4} width={Math.max(1.5, x(s.d2) - x(s.d98))} height={8} fill={r.color} fillOpacity={q === 1 ? 0.15 : 0.35} stroke={r.color} strokeDasharray={dash} />
                    <line x1={x(s.d50)} x2={x(s.d50)} y1={cy - 5} y2={cy + 5} stroke="#fff" strokeWidth={1.4} />
                    <circle cx={x(s.mean)} cy={cy} r={2.6} fill="#fff" stroke={r.color} />
                  </g>
                );
              })}
              {r.limit !== undefined && <path d={`M${x(r.limit)} ${y0 + 2} l4 -2 l-4 ${per - 1} l-4 ${-(per - 1)} z`} fill="#f43f5e" opacity={0.8} />}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 px-2 text-[10px] text-slate-500">
        <span>line: min–max</span><span>box: D98–D2</span><span>white tick: median (D50)</span><span>dot: mean</span><span className="text-rose-400">▼ tolerance (max-type)</span>
        {compareName && <span>lower / dashed: {compareName}</span>}
      </div>
      {hovered && (
        <div className="pointer-events-none absolute top-2 right-4 rounded-lg bg-black/85 px-3 py-2 text-[11px] ring-1 ring-white/10">
          <div className="mb-1 font-medium" style={{ color: hovered.color }}>{hovered.name}</div>
          {hovered.stats.map((s, q) => (
            <div key={q} className="text-slate-300 tabular-nums">
              {hovered.stats.length > 1 && <span className="mr-1 text-slate-500">{q === 0 ? 'Plan' : 'Cmp'}</span>}
              min {s.min.toFixed(1)} · D98 {s.d98.toFixed(1)} · mean {s.mean.toFixed(1)} · D2 {s.d2.toFixed(1)} · max {s.max.toFixed(1)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
