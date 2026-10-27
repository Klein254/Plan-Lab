import { useId, useMemo, useRef, useState } from 'react';

export interface LineSeries {
  id: string;
  name: string;
  color: string;
  points: [number, number][];
  dashed?: boolean;
}

/** Coloured strips under the plot showing where structures lie along the x axis (dose profiles). */
export interface Band {
  id: string;
  name: string;
  color: string;
  spans: [number, number][];
}

const niceStep = (range: number, target: number) => {
  const raw = range / target;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
};

/** General x/y line chart (SVG) with hover read-out; used for differential DVHs and dose profiles. */
export function LineChart({ series, xMin, xMax, yMin = 0, yMax, xLabel, yLabel, yUnit = '', xUnit = '', bands = [], refX, height = 340 }: {
  series: LineSeries[]; xMin: number; xMax: number; yMin?: number; yMax: number; xLabel: string; yLabel: string; yUnit?: string; xUnit?: string;
  bands?: Band[]; refX?: { x: number; label: string }[]; height?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const clipId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const bandRow = 7;
  const W = 760, L = 52, R = 14, T = 12;
  const B = 36 + (bands.length ? bands.length * bandRow + 8 : 0);
  const H = height + (bands.length ? bands.length * bandRow + 8 : 0);
  const pw = W - L - R, ph = H - T - B;
  const span = xMax - xMin || 1, yspan = yMax - yMin || 1;
  const x = (v: number) => L + ((v - xMin) / span) * pw;
  const y = (v: number) => T + (1 - (v - yMin) / yspan) * ph;
  const xt = useMemo(() => {
    const st = niceStep(span, 8);
    const out: number[] = [];
    for (let t = Math.ceil(xMin / st) * st; t <= xMax + 1e-9; t += st) out.push(+t.toFixed(6));
    return out;
  }, [xMin, xMax, span]);
  const yt = useMemo(() => {
    const st = niceStep(yspan, 5);
    const out: number[] = [];
    for (let t = Math.ceil(yMin / st) * st; t <= yMax + 1e-9; t += st) out.push(+t.toFixed(6));
    return out;
  }, [yMin, yMax, yspan]);
  const fg = '#94a3b8', grid = 'rgba(148,163,184,0.12)';
  const valueAt = (pts: [number, number][], v: number) => {
    for (let n = 1; n < pts.length; n++) if (pts[n][0] >= v) {
      const [a0, b0] = pts[n - 1], [a1, b1] = pts[n];
      if (v < a0) return null;
      return b0 + ((b1 - b0) * (v - a0)) / (a1 - a0 || 1);
    }
    return null;
  };
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full select-none"
        onMouseMove={(e) => {
          const r = ref.current!.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const v = xMin + ((px - L) / pw) * span;
          setHover(v >= xMin && v <= xMax ? v : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <rect x={L} y={T} width={pw} height={ph} fill="rgba(0,0,0,0.25)" stroke={grid} />
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={L} x2={L + pw} y1={y(v)} y2={y(v)} stroke={grid} />
            <text x={L - 6} y={y(v) + 4} fontSize="11" textAnchor="end" fill={fg}>{fmt(v)}</text>
          </g>
        ))}
        {xt.map((v) => (
          <g key={`x${v}`}>
            <line x1={x(v)} x2={x(v)} y1={T} y2={T + ph} stroke={grid} />
            <text x={x(v)} y={T + ph + 15} fontSize="11" textAnchor="middle" fill={fg}>{fmt(v)}</text>
          </g>
        ))}
        <text x={L + pw / 2} y={T + ph + 30} fontSize="11" textAnchor="middle" fill={fg}>{xLabel}</text>
        <text x={12} y={T + ph / 2} fontSize="11" textAnchor="middle" fill={fg} transform={`rotate(-90 12 ${T + ph / 2})`}>{yLabel}</text>
        {refX?.map((r) => (
          <g key={r.label}>
            <line x1={x(r.x)} x2={x(r.x)} y1={T} y2={T + ph} stroke="#f43f5e" strokeDasharray="3 4" opacity={0.7} />
            <text x={x(r.x) + 3} y={T + 11} fontSize="10" fill="#fb7185">{r.label}</text>
          </g>
        ))}
        <clipPath id={clipId}><rect x={L} y={T} width={pw} height={ph} /></clipPath>
        <g clipPath={`url(#${clipId})`}>
          {series.map((s) => (
            <polyline
              key={s.id}
              fill="none"
              stroke={s.color}
              strokeWidth={1.8}
              strokeDasharray={s.dashed ? '6 4' : undefined}
              points={s.points.map(([a, b]) => `${x(a).toFixed(1)},${y(b).toFixed(1)}`).join(' ')}
            />
          ))}
        </g>
        {bands.map((b, n) => (
          <g key={b.id}>
            {b.spans.map(([a0, a1], q) => (
              <rect key={q} x={x(Math.max(xMin, a0))} y={T + ph + 40 + n * bandRow} width={Math.max(1, x(Math.min(xMax, a1)) - x(Math.max(xMin, a0)))} height={bandRow - 2} fill={b.color} opacity={0.85} rx={1} />
            ))}
          </g>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + ph} stroke={fg} opacity={0.5} />}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-3 right-4 max-h-[85%] overflow-hidden rounded-lg bg-black/80 px-3 py-2 text-[11px] ring-1 ring-white/10">
          <div className="mb-1 text-slate-300">{fmt(hover)} {xUnit}</div>
          {series.slice(0, 14).map((s) => {
            const v = valueAt(s.points, hover);
            return (
              <div key={s.id} className="flex justify-between gap-4">
                <span style={{ color: s.color }}>{s.name}{s.dashed ? ' (cmp)' : ''}</span>
                <span className="text-slate-200 tabular-nums">{v === null ? '—' : `${fmt(v)} ${yUnit}`}</span>
              </div>
            );
          })}
          {bands.filter((b) => b.spans.some(([a, c]) => hover >= a && hover <= c)).map((b) => (
            <div key={b.id} className="text-slate-400">in <span style={{ color: b.color }}>{b.name}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}
