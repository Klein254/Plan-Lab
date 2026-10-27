import { useEffect, useMemo, useState } from 'react';
import { Printer, CheckCircle2, XCircle, GitCompare, Calculator, Plus, X } from 'lucide-react';
import { useStore, doseIsStale, calculateDose, machineById, voxelToPatient } from '../../state/store.ts';
import { computeDVH, cumulativeCurve, differentialCurve, evaluateConstraint, targetIndices, toEQD2, dAt, vAt, bed, eqd2, type DVH } from '../../core/dvh.ts';
import { gEUD, lkbFor, lkbNtcp, integralDose } from '../../core/radiobiology.ts';
import { sampleGrid } from '../../core/dose/engine.ts';
import { describeConstraint } from '../../core/templates.ts';
import { Panel, Button, Toggle, Select, Badge, NumberField, cx } from '../common.tsx';
import { DVHChart, type DvhSeries } from '../views/DVHChart.tsx';
import { LineChart, type LineSeries, type Band } from '../views/LineChart.tsx';
import { DoseRangeChart, type RangeRow } from '../views/DoseRangeChart.tsx';
import { SliceView } from '../views/SliceView.tsx';
import { StructurePicker } from '../panels/StructurePicker.tsx';
import * as db from '../../core/storage.ts';
import { ssdOf, isoDepth } from '../../state/planTools.ts';
import { TARGET_TYPES, type DoseGrid, type PlanMeta, type StructureMeta, type Vec3 } from '../../core/types.ts';

interface Row {
  id: string;
  name: string;
  color: string;
  type: string;
  dvh: DVH;
}

interface Compare {
  plan: PlanMeta;
  rows: Row[];
  grid: DoseGrid;
  total: Float32Array;
}

type Graph = 'cum' | 'diff' | 'profile' | 'range';
const GRAPHS: { value: Graph; label: string; title: string }[] = [
  { value: 'cum', label: 'Cumulative DVH', title: 'Volume receiving at least each dose' },
  { value: 'diff', label: 'Differential DVH', title: 'How much volume receives each dose level' },
  { value: 'profile', label: 'Dose profile', title: 'Dose along a line through the isocentre, crosshair or hot spot' },
  { value: 'range', label: 'Dose ranges', title: 'Min / D98 / mean / D2 / max per structure, side by side' },
];

const isTarget = (t: string) => TARGET_TYPES.includes(t as never);

export function EvalPage() {
  const plan = useStore((s) => s.plan)?.meta;
  const ss = useStore((s) => s.ss);
  const ct = useStore((s) => s.ct)!;
  const dose = useStore((s) => s.dose);
  const doseVersion = useStore((s) => s.doseVersion);
  const ssVersion = useStore((s) => s.ssVersion);
  const cursor = useStore((s) => s.cursor);
  const patient = useStore((s) => s.patient)!;
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [relative, setRelative] = useState(false);
  const [useEqd2, setUseEqd2] = useState(false);
  const [compareId, setCompareId] = useState('');
  const [compare, setCompare] = useState<Compare | null>(null);
  const [report, setReport] = useState(false);
  const [graph, setGraph] = useState<Graph>('cum');
  const [profAxis, setProfAxis] = useState<0 | 1 | 2>(0);
  const [profAt, setProfAt] = useState<'iso' | 'cursor' | 'max'>('iso');

  const rows = useMemo<Row[]>(() => {
    if (!dose?.total || !ss) return [];
    const out: Row[] = [];
    for (const st of ss.meta.structures) {
      const m = ss.masks.get(st.id)!;
      if (m.isEmpty()) continue;
      const d = computeDVH(m, ct.volume, dose.grid, dose.total, st.type === 'EXTERNAL' ? 200000 : 150000);
      if (d) out.push({ id: st.id, name: st.name, color: st.color, type: st.type, dvh: d });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doseVersion, ssVersion, dose?.total]);

  // Comparison plan: its stored dose on the same structures
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!compareId || !ss) return setCompare(null);
      const p = await db.loadPlan(patient.info.id, compareId);
      const d = await db.loadDose(patient.info.id, compareId);
      if (!d || p.structureSetId !== ss.meta.id) return setCompare(null);
      const n = d.grid.dims[0] * d.grid.dims[1] * d.grid.dims[2];
      const total = new Float32Array(n);
      for (const b of p.beams) {
        const arr = d.perBeam.get(b.id);
        const mu = p.mu[b.id] ?? 0;
        if (!arr) continue;
        const f = (mu * p.prescription.fractions) / 100;
        for (let q = 0; q < n; q++) total[q] += arr[q] * f;
      }
      const cr: Row[] = [];
      for (const st of ss.meta.structures) {
        const m = ss.masks.get(st.id)!;
        if (m.isEmpty()) continue;
        const dv = computeDVH(m, ct.volume, d.grid, total, 100000);
        if (dv) cr.push({ id: st.id, name: st.name, color: st.color, type: st.type, dvh: dv });
      }
      if (!cancelled) setCompare({ plan: p, rows: cr, grid: d.grid, total });
    })();
    return () => { cancelled = true; };
  }, [compareId, ss, ct, patient.info.id]);

  if (!plan) return <Empty text="Open a plan to evaluate it (bottom panel)." />;
  if (!dose?.total) return <Empty text="This plan has no dose yet." action={<Button variant="primary" onClick={() => calculateDose()}>Calculate dose</Button>} />;

  const rx = plan.prescription.totalDose;
  const fx = plan.prescription.fractions;
  const metaOf = (id: string) => ss!.meta.structures.find((x) => x.id === id);
  const conv = (r: Row, fractions = fx) => (useEqd2 ? toEQD2(r.dvh, fractions, metaOf(r.id)?.alphaBeta ?? 3) : r.dvh);
  const convCmp = (r: Row) => conv(r, compare?.plan.prescription.fractions ?? fx);
  const allDvhs = rows.map((r) => conv(r));
  const maxDose = Math.max(rx * 1.15, ...allDvhs.map((d) => d.max), ...(compare?.rows.map((r) => convCmp(r).max) ?? []));
  const xMax = relative ? Math.ceil((100 * maxDose) / rx / 10) * 10 : Math.ceil(maxDose / 5) * 5;
  const toX = (d: number) => (relative ? (100 * d) / rx : d);
  const binGy = Math.max(0.05, maxDose / 300);
  const shownRows = rows.filter((r) => !hidden.has(r.id));
  const shownCmp = compare?.rows.filter((r) => !hidden.has(r.id)) ?? [];
  const doseAxis = relative ? 'Dose (% of prescription)' : useEqd2 ? 'EQD2 (Gy)' : 'Dose (Gy)';

  const series: DvhSeries[] = shownRows.map((r) => ({
    id: r.id, name: r.name, color: r.color, points: cumulativeCurve(conv(r), binGy, maxDose).map(([d, v]) => [toX(d), v] as [number, number]),
  }));
  for (const r of shownCmp) series.push({ id: `cmp-${r.id}`, name: r.name, color: r.color, dashed: true, points: cumulativeCurve(convCmp(r), binGy, maxDose).map(([d, v]) => [toX(d), v] as [number, number]) });

  const target = rows.find((r) => r.id === plan.prescription.targetId) ?? rows.find((r) => r.type === 'PTV');
  const body = rows.find((r) => r.type === 'EXTERNAL');
  const ti = target ? targetIndices(target.dvh, body?.dvh ?? null, rx) : null;
  const stale = doseIsStale();
  const otherPlans = patient.plans.filter((p) => p.id !== plan.id && p.structureSetId === ss?.meta.id);

  const constraintsOf = (list: Row[], conversion: (r: Row) => DVH, rxGy: number) => (ss?.meta.structures ?? []).flatMap((st) => {
    const r = list.find((x) => x.id === st.id);
    if (!r) return [];
    const dv = conversion(r);
    return st.constraints.map((c) => ({ st, c, res: evaluateConstraint(c, dv, rxGy) }));
  });
  const constraintRows = constraintsOf(rows, conv, rx);
  const passed = constraintRows.filter((x) => x.res.pass).length;

  // ---------------------------------------------------------------- graphs
  const graphBody = () => {
    if (graph === 'cum') {
      return <DVHChart series={series} xMax={xMax} xLabel={doseAxis} rxLine={relative ? 100 : useEqd2 ? undefined : rx} />;
    }
    if (graph === 'diff') {
      const bin = Math.max(0.1, maxDose / 120);
      const mk = (r: Row, d: DVH, dashed: boolean): LineSeries => ({
        id: `${dashed ? 'cmp-' : ''}${r.id}`, name: r.name, color: r.color, dashed,
        points: differentialCurve(d, bin, maxDose).map(([x, v]) => [toX(x), 100 * v] as [number, number]),
      });
      const ls = [...shownRows.map((r) => mk(r, conv(r), false)), ...shownCmp.map((r) => mk(r, convCmp(r), true))];
      const yMax = Math.max(1, ...ls.flatMap((s) => s.points.map((p) => p[1]))) * 1.08;
      return <LineChart series={ls} xMin={0} xMax={xMax} yMax={yMax} xLabel={doseAxis} yLabel={`Volume (% per ${toX(bin).toFixed(2)} ${relative ? '%' : 'Gy'} bin)`} yUnit="%" xUnit={relative ? '%' : 'Gy'} />;
    }
    if (graph === 'profile') return profileChart();
    const rr: RangeRow[] = shownRows.map((r) => {
      const st = metaOf(r.id);
      const stat = (d: DVH) => ({ min: toX(d.min), d98: toX(dAt(d, 0.98)), mean: toX(d.mean), d50: toX(dAt(d, 0.5)), d2: toX(dAt(d, 0.02)), max: toX(d.max) });
      const cmpRow = shownCmp.find((c) => c.id === r.id);
      const lim = st?.constraints.find((c) => (c.metric === 'Dmax' || (c.metric === 'D' && (c.param ?? 0) <= 2)) && c.cmp === '<' && c.limitUnit !== 'cc' && c.limitUnit !== '%');
      const limGy = lim ? (lim.limitUnit === '%Rx' ? (lim.limit / 100) * rx : lim.limit) : undefined;
      return { id: r.id, name: r.name, color: r.color, stats: [stat(conv(r)), ...(cmpRow ? [stat(convCmp(cmpRow))] : [])], limit: limGy !== undefined ? toX(limGy) : undefined };
    });
    return <DoseRangeChart rows={rr} xMax={xMax} xLabel={doseAxis} rxLine={relative ? 100 : useEqd2 ? undefined : rx} compareName={compare?.plan.name} />;
  };

  const profileChart = () => {
    const v = ct.volume;
    const through: Vec3 =
      profAt === 'cursor' ? voxelToPatient(v, cursor)
        : profAt === 'max' && dose.maxAt ? dose.maxAt
          : plan.beams[0]?.iso ?? voxelToPatient(v, cursor);
    const lo = v.origin[profAxis], hi = v.origin[profAxis] + (v.dims[profAxis] - 1) * v.spacing[profAxis];
    const step = 2;
    const xs: number[] = [];
    for (let t = lo; t <= hi; t += step) xs.push(t);
    const at = (t: number): Vec3 => { const p = [...through] as Vec3; p[profAxis] = t; return p; };
    const yOf = (gy: number) => (relative ? (100 * gy) / rx : gy);
    const ls: LineSeries[] = [{ id: 'plan', name: plan.name, color: '#38bdf8', points: xs.map((t) => [t / 10, yOf(sampleGrid(dose.grid, dose.total!, at(t)))] as [number, number]) }];
    if (compare) ls.push({ id: 'cmp', name: compare.plan.name, color: '#f472b6', dashed: true, points: xs.map((t) => [t / 10, yOf(sampleGrid(compare.grid, compare.total, at(t)))] as [number, number]) });
    // Where the line passes through each shown structure
    const bands: Band[] = [];
    for (const r of shownRows) {
      const m = ss!.masks.get(r.id)!;
      const spans: [number, number][] = [];
      let start: number | null = null;
      for (const t of xs) {
        const p = at(t);
        const inside = m.get(Math.round((p[0] - v.origin[0]) / v.spacing[0]), Math.round((p[1] - v.origin[1]) / v.spacing[1]), Math.round((p[2] - v.origin[2]) / v.spacing[2])) === 1;
        if (inside && start === null) start = t;
        if (!inside && start !== null) { spans.push([start / 10, (t - step) / 10]); start = null; }
      }
      if (start !== null) spans.push([start / 10, xs[xs.length - 1] / 10]);
      if (spans.length) bands.push({ id: r.id, name: r.name, color: r.color, spans });
    }
    const yMax = Math.max(relative ? 110 : rx * 1.1, ...ls.flatMap((s) => s.points.map((p) => p[1]))) * 1.05;
    const axisName = profAxis === 0 ? 'Right → left, x (cm)' : profAxis === 1 ? 'Anterior → posterior, y (cm)' : 'Inferior → superior, z (cm)';
    return (
      <>
        <LineChart series={ls} xMin={lo / 10} xMax={hi / 10} yMax={yMax} xLabel={axisName} yLabel={relative ? 'Dose (% of prescription)' : 'Dose (Gy)'} yUnit={relative ? '%' : 'Gy'} xUnit="cm" bands={bands} refX={[{ x: through[profAxis] / 10, label: profAt === 'iso' ? 'iso' : profAt === 'max' ? 'max' : 'crosshair' }]} />
        <div className="px-2 text-[10px] text-slate-500">Physical dose along the line through ({(through[0] / 10).toFixed(1)}, {(through[1] / 10).toFixed(1)}, {(through[2] / 10).toFixed(1)}) cm. Strips under the plot show where the line crosses each structure.</div>
      </>
    );
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.35fr)_minmax(380px,1fr)] gap-2 overflow-hidden p-2">
      <div className="flex min-h-0 flex-col gap-2 overflow-auto">
        <Panel
          className="shrink-0"
          title="Dose evaluation graphs"
          actions={
            <>
              <Toggle checked={relative} onChange={setRelative} label="% of Rx" />
              <Toggle checked={useEqd2} onChange={setUseEqd2} label="EQD2" />
              <Select value={compareId} onChange={setCompareId} options={[{ value: '', label: 'Compare with…' }, ...otherPlans.map((p) => ({ value: p.id, label: p.name }))]} className="w-40" />
              <Button size="sm" onClick={() => setReport(true)}><Printer size={13} /> Report</Button>
            </>
          }
        >
          {stale && <div className="mx-3 mt-2 rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 ring-1 ring-amber-400/20">Fields changed since the last calculation; graphs show the old dose. <button className="underline" onClick={() => calculateDose()}>Recalculate</button></div>}
          <div className="flex flex-wrap items-center gap-2 px-3 pt-2" data-testid="eval-graphs">
            <div className="flex rounded-md bg-black/30 p-0.5 ring-1 ring-white/10">
              {GRAPHS.map((g) => (
                <button key={g.value} title={g.title} onClick={() => setGraph(g.value)} className={cx('rounded px-2.5 py-1 text-[11px]', graph === g.value ? 'bg-sky-500/25 text-sky-100' : 'text-slate-400 hover:text-slate-200')}>{g.label}</button>
              ))}
            </div>
            <StructurePicker
              testId="eval-structures"
              label="On graph"
              items={rows}
              shown={new Set(shownRows.map((r) => r.id))}
              onChange={(next) => setHidden(new Set(rows.filter((r) => !next.has(r.id)).map((r) => r.id)))}
            />
            {graph === 'profile' && (
              <>
                <Select<string> value={String(profAxis)} onChange={(v) => setProfAxis(+v as 0 | 1 | 2)} options={[{ value: '0', label: 'Left–right' }, { value: '1', label: 'Anterior–posterior' }, { value: '2', label: 'Superior–inferior' }]} className="w-40" />
                <Select<'iso' | 'cursor' | 'max'> label="through" value={profAt} onChange={setProfAt} options={[{ value: 'iso', label: 'Isocentre' }, { value: 'cursor', label: 'Crosshair' }, { value: 'max', label: 'Hot spot' }]} className="w-40" />
              </>
            )}
          </div>
          <div className="p-2">
            {graphBody()}
            {compare && graph !== 'profile' && <div className="px-2 text-[11px] text-slate-500"><GitCompare size={12} className="mr-1 inline" />Dashed: {compare.plan.name}</div>}
            <div className="mt-2 flex flex-wrap gap-1 px-2">
              {rows.map((r) => (
                <button key={r.id} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} className={cx('flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] ring-1 ring-white/10', hidden.has(r.id) ? 'opacity-40' : '')}>
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: r.color }} />{r.name}
                </button>
              ))}
            </div>
          </div>
        </Panel>
        {compare && <ComparisonPanel plan={plan} rows={rows} compare={compare} conv={conv} convCmp={convCmp} constraintsOf={constraintsOf} body={body} target={target} />}
        <Panel title="Dose statistics" className="shrink-0" collapseKey="eval-stats">
          <table className="w-full text-[11px] tabular-nums">
            <thead className="text-slate-500">
              <tr className="border-b border-white/5">
                {['Structure', 'Vol cc', 'Min', 'Mean', 'Max', 'D98', 'D95', 'D50', 'D2', 'V95%', 'V100%', 'V107%'].map((h) => <th key={h} className="px-1.5 py-1 text-right font-medium first:text-left">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = conv(r);
                const g = (v: number) => v.toFixed(2);
                const isT = isTarget(r.type);
                return (
                  <tr key={r.id} className="border-b border-white/[0.03]">
                    <td className="px-1.5 py-1 text-left"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />{r.name}</td>
                    <td className="px-1.5 text-right">{r.dvh.volumeCc.toFixed(1)}</td>
                    <td className="px-1.5 text-right">{g(d.min)}</td>
                    <td className="px-1.5 text-right">{g(d.mean)}</td>
                    <td className="px-1.5 text-right">{g(d.max)}</td>
                    <td className="px-1.5 text-right">{g(dAt(d, 0.98))}</td>
                    <td className="px-1.5 text-right">{g(dAt(d, 0.95))}</td>
                    <td className="px-1.5 text-right">{g(dAt(d, 0.5))}</td>
                    <td className="px-1.5 text-right">{g(dAt(d, 0.02))}</td>
                    <td className={cx('px-1.5 text-right', isT && 'text-sky-200')}>{(100 * vAt(d, 0.95 * rx)).toFixed(1)}</td>
                    <td className={cx('px-1.5 text-right', isT && 'text-sky-200')}>{(100 * vAt(d, rx)).toFixed(1)}</td>
                    <td className="px-1.5 text-right">{(100 * vAt(d, 1.07 * rx)).toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-2 py-1.5 text-[10px] text-slate-500">Doses in {useEqd2 ? 'EQD2 Gy (each structure\'s α/β)' : 'Gy'}; V in % of the structure volume. Dx = minimum dose to the hottest x%.</div>
        </Panel>
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-auto">
        {ti && target && (
          <Panel title={`Target quality: ${target.name}`} className="shrink-0" collapseKey="eval-target">
            <div className="grid grid-cols-3 gap-2 p-3 text-center">
              <Metric label="V95% (coverage)" value={`${(100 * ti.coverage95).toFixed(1)}%`} good={ti.coverage95 >= 0.95} />
              <Metric label="D98 / D2" value={`${((100 * ti.d98) / rx).toFixed(1)} / ${((100 * ti.d2) / rx).toFixed(1)}%`} good={ti.d98 >= 0.95 * rx && ti.d2 <= 1.07 * rx} />
              <Metric label="HI (ICRU 83)" value={ti.hi.toFixed(3)} good={ti.hi <= 0.12} />
              <Metric label="CI (RTOG)" value={ti.ciRtog?.toFixed(2) ?? '—'} good={ti.ciRtog !== null && ti.ciRtog >= 0.9 && ti.ciRtog <= 2} />
              <Metric label="Paddick CI" value={ti.ciPaddick?.toFixed(2) ?? '—'} good={ti.ciPaddick !== null && ti.ciPaddick >= 0.6} />
              <Metric label="Gradient index" value={ti.gi?.toFixed(2) ?? '—'} />
            </div>
          </Panel>
        )}
        <Panel title={`Tolerance doses · ${passed}/${constraintRows.length} met${useEqd2 ? ' (EQD2)' : ''}`} className="shrink-0" collapseKey="eval-tolerances">
          {constraintRows.length ? (
            <table className="w-full text-[11px]">
              <tbody>
                {constraintRows.map(({ st, c, res }) => (
                  <tr key={c.id} className="border-b border-white/[0.03]">
                    <td className="py-1 pl-2"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: st.color }} />{st.name}</td>
                    <td className="text-slate-400">{describeConstraint(c)}</td>
                    <td className="text-right text-slate-200 tabular-nums">{res.text}</td>
                    <td className="w-20 pr-2 text-right">
                      {res.pass ? <Badge tone="green"><CheckCircle2 size={11} className="mr-1" />pass</Badge> : <Badge tone={c.priority === 'mandatory' ? 'rose' : 'amber'}><XCircle size={11} className="mr-1" />{c.priority === 'mandatory' ? 'fail' : 'over goal'}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-3 text-xs text-slate-500">No tolerance doses on the contoured structures. Add them in the Anatomical Model (structure → Tolerance doses) or Library.</div>
          )}
        </Panel>
        <CalculationsPanel plan={plan} rows={rows} compare={compare} structures={ss?.meta.structures ?? []} doseTotal={dose.total} grid={dose.grid} maxAt={dose.maxAt} />
        <BedCalculator rx={rx} fx={fx} />
        <div className="h-72 shrink-0"><SliceView plane="axial" mode="eval" /></div>
      </div>
      {report && <PlanReport rows={rows} series={series} xMax={xMax} relative={relative} constraintRows={constraintRows} onClose={() => setReport(false)} />}
    </div>
  );
}

type ConstraintRow = { st: StructureMeta; c: StructureMeta['constraints'][number]; res: ReturnType<typeof evaluateConstraint> };

/** Side-by-side numbers for the open plan (A) and the comparison plan (B). */
function ComparisonPanel({ plan, rows, compare, conv, convCmp, constraintsOf, body, target }: {
  plan: PlanMeta; rows: Row[]; compare: Compare; conv: (r: Row) => DVH; convCmp: (r: Row) => DVH;
  constraintsOf: (list: Row[], conversion: (r: Row) => DVH, rxGy: number) => ConstraintRow[]; body?: Row; target?: Row;
}) {
  const rxA = plan.prescription.totalDose, rxB = compare.plan.prescription.totalDose;
  const consA = constraintsOf(rows, conv, rxA), consB = constraintsOf(compare.rows, convCmp, rxB);
  const tB = target ? compare.rows.find((r) => r.id === target.id) : undefined;
  const bB = body ? compare.rows.find((r) => r.id === body.id) : undefined;
  const tiA = target ? targetIndices(target.dvh, body?.dvh ?? null, rxA) : null;
  const tiB = tB ? targetIndices(tB.dvh, bB?.dvh ?? null, rxB) : null;
  const cell = (a: number, b: number, lowerIsBetter: boolean, digits = 2) => {
    const d = b - a;
    const better = Math.abs(d) < 10 ** -digits ? null : (d < 0) === lowerIsBetter;
    return (
      <>
        <td className="px-1.5 text-right">{a.toFixed(digits)}</td>
        <td className="px-1.5 text-right">{b.toFixed(digits)}</td>
        <td className={cx('px-1.5 text-right', better === null ? 'text-slate-500' : better ? 'text-emerald-300' : 'text-amber-300')}>{d > 0 ? '+' : ''}{d.toFixed(digits)}</td>
      </>
    );
  };
  return (
    <Panel title={`Plan comparison · A = ${plan.name}, B = ${compare.plan.name}`} className="shrink-0" collapseKey="eval-compare">
      <div className="flex flex-wrap gap-4 px-3 pt-2 text-[11px] text-slate-400">
        <span>Tolerances met: A <b className="text-slate-100">{consA.filter((x) => x.res.pass).length}/{consA.length}</b> · B <b className="text-slate-100">{consB.filter((x) => x.res.pass).length}/{consB.length}</b></span>
        {tiA && tiB && <span>{target!.name}: V95 A {(100 * tiA.coverage95).toFixed(1)}% · B {(100 * tiB.coverage95).toFixed(1)}% · HI A {tiA.hi.toFixed(3)} · B {tiB.hi.toFixed(3)}{tiA.ciPaddick !== null && tiB.ciPaddick !== null ? ` · Paddick CI A ${tiA.ciPaddick.toFixed(2)} · B ${tiB.ciPaddick.toFixed(2)}` : ''}</span>}
      </div>
      <table className="mt-1 w-full text-[11px] tabular-nums">
        <thead className="text-slate-500">
          <tr className="border-b border-white/5">
            <th className="px-1.5 py-1 text-left font-medium">Structure</th>
            <th colSpan={3} className="px-1.5 text-center font-medium">Mean (A · B · Δ)</th>
            <th colSpan={3} className="px-1.5 text-center font-medium">D2 (A · B · Δ)</th>
            <th colSpan={3} className="px-1.5 text-center font-medium">D98 (A · B · Δ)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const c = compare.rows.find((x) => x.id === r.id);
            if (!c) return null;
            const a = conv(r), b = convCmp(c);
            const t = isTarget(r.type);
            return (
              <tr key={r.id} className="border-b border-white/[0.03]">
                <td className="px-1.5 py-1"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />{r.name}</td>
                {cell(a.mean, b.mean, !t)}
                {cell(dAt(a, 0.02), dAt(b, 0.02), true)}
                {cell(dAt(a, 0.98), dAt(b, 0.98), !t)}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="px-3 py-1.5 text-[10px] text-slate-500">Δ = B − A. Green: B is better (lower for organs at risk and hot spots, higher minimum dose for targets).</div>
    </Panel>
  );
}

type Query = { id: number; structureId: string; metric: 'D%' | 'Dcc' | 'VGy' | 'V%Rx' | 'Vcc'; value: number };
const QUERY_LABELS: Record<Query['metric'], string> = { 'D%': 'D at % volume', Dcc: 'D at cc', VGy: 'V at dose (Gy)', 'V%Rx': 'V at % Rx', Vcc: 'cc at dose (Gy)' };

/** DVH queries, radiobiology (gEUD / NTCP) and point / integral doses. */
function CalculationsPanel({ plan, rows, compare, structures, doseTotal, grid, maxAt }: {
  plan: PlanMeta; rows: Row[]; compare: Compare | null; structures: StructureMeta[]; doseTotal: Float32Array; grid: DoseGrid; maxAt: Vec3 | null;
}) {
  const [tab, setTab] = useState<'query' | 'bio' | 'points'>('query');
  const [queries, setQueries] = useState<Query[]>([]);
  const [q, setQ] = useState<Omit<Query, 'id'>>({ structureId: '', metric: 'VGy', value: 20 });
  const rx = plan.prescription.totalDose, fx = plan.prescription.fractions;
  const sid = q.structureId || rows.find((r) => r.type === 'OAR')?.id || rows[0]?.id || '';
  const ab = (id: string) => structures.find((s) => s.id === id)?.alphaBeta ?? 3;
  const evalQuery = (query: Omit<Query, 'id'>, list: Row[], rxGy: number) => {
    const r = list.find((x) => x.id === query.structureId);
    if (!r) return '—';
    const d = r.dvh;
    switch (query.metric) {
      case 'D%': return `${dAt(d, query.value / 100).toFixed(2)} Gy`;
      case 'Dcc': return `${dAt(d, Math.min(1, query.value / d.volumeCc)).toFixed(2)} Gy`;
      case 'VGy': return `${(100 * vAt(d, query.value)).toFixed(1)} %`;
      case 'V%Rx': return `${(100 * vAt(d, (query.value / 100) * rxGy)).toFixed(1)} %`;
      case 'Vcc': return `${(vAt(d, query.value) * d.volumeCc).toFixed(1)} cc`;
    }
  };
  const name = (id: string) => rows.find((r) => r.id === id)?.name ?? '?';
  const qText = (x: Omit<Query, 'id'>) => x.metric === 'D%' ? `D${x.value}%` : x.metric === 'Dcc' ? `D${x.value}cc` : x.metric === 'VGy' ? `V${x.value}Gy` : x.metric === 'V%Rx' ? `V${x.value}%` : `V${x.value}Gy (cc)`;
  const tabBtn = (v: typeof tab, label: string) => (
    <button onClick={() => setTab(v)} className={cx('rounded px-2 py-0.5 text-[11px]', tab === v ? 'bg-sky-500/25 text-sky-100' : 'text-slate-400 hover:text-slate-200')}>{label}</button>
  );
  const body = rows.find((r) => r.type === 'EXTERNAL');
  const cmpBody = body && compare?.rows.find((r) => r.id === body.id);
  const points: { name: string; pos: Vec3 }[] = [
    ...[...new Map(plan.beams.map((b) => [b.iso.join(','), b.iso])).values()].map((p, n, arr) => ({ name: arr.length > 1 ? `Isocentre ${n + 1}` : 'Isocentre', pos: p })),
    ...plan.refPoints.map((r) => ({ name: r.name, pos: r.pos })),
    ...(maxAt ? [{ name: 'Hot spot (max)', pos: maxAt }] : []),
  ];
  return (
    <Panel
      className="shrink-0"
      collapseKey="eval-calcs"
      title={<span className="flex items-center gap-1.5"><Calculator size={12} /> Calculations</span>}
      actions={<div className="flex gap-0.5">{tabBtn('query', 'DVH query')}{tabBtn('bio', 'NTCP / EUD')}{tabBtn('points', 'Points')}</div>}
    >
      {tab === 'query' && (
        <div className="space-y-2 p-3" data-testid="dvh-query">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={sid} onChange={(v) => setQ({ ...q, structureId: v })} options={rows.map((r) => ({ value: r.id, label: r.name }))} className="w-36" />
            <Select<Query['metric']> value={q.metric} onChange={(v) => setQ({ ...q, metric: v })} options={(Object.keys(QUERY_LABELS) as Query['metric'][]).map((k) => ({ value: k, label: QUERY_LABELS[k] }))} className="w-36" />
            <NumberField value={q.value} onChange={(v) => setQ({ ...q, value: v })} min={0} width="w-16" />
            <Button size="sm" onClick={() => setQueries((l) => [...l, { ...q, structureId: sid, id: Date.now() }])}><Plus size={12} /> Add</Button>
          </div>
          <div className="rounded-md bg-black/30 px-3 py-2 text-xs text-slate-300">
            {name(sid)} {qText({ ...q, structureId: sid })} = <b className="text-slate-100">{evalQuery({ ...q, structureId: sid }, rows, rx)}</b>
            {compare && <span className="text-slate-500"> · B: {evalQuery({ ...q, structureId: sid }, compare.rows, compare.plan.prescription.totalDose)}</span>}
          </div>
          {queries.length > 0 && (
            <table className="w-full text-[11px] tabular-nums">
              <tbody>
                {queries.map((x) => (
                  <tr key={x.id} className="border-b border-white/[0.03]">
                    <td className="py-1">{name(x.structureId)}</td>
                    <td className="text-slate-400">{qText(x)}</td>
                    <td className="text-right text-slate-100">{evalQuery(x, rows, rx)}</td>
                    {compare && <td className="text-right text-slate-500">B {evalQuery(x, compare.rows, compare.plan.prescription.totalDose)}</td>}
                    <td className="w-6 text-right"><button className="text-slate-500 hover:text-rose-300" onClick={() => setQueries((l) => l.filter((y) => y.id !== x.id))} title="Remove"><X size={12} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="text-[10px] text-slate-500">Physical dose. Examples: lung V20Gy, rectum V70Gy, parotid mean, cord D0.03cc.</div>
        </div>
      )}
      {tab === 'bio' && (
        <div className="p-2" data-testid="ntcp">
          <table className="w-full text-[11px] tabular-nums">
            <thead className="text-slate-500">
              <tr className="border-b border-white/5">
                <th className="py-1 text-left font-medium">Structure</th><th className="text-left font-medium">Model</th><th className="text-right font-medium">gEUD</th><th className="text-right font-medium">NTCP</th>
                {compare && <th className="pr-1 text-right font-medium">B</th>}
              </tr>
            </thead>
            <tbody>
              {rows.filter((r) => r.type !== 'EXTERNAL' && r.type !== 'SUPPORT').map((r) => {
                const p = isTarget(r.type) ? null : lkbFor(r.name);
                const eq = toEQD2(r.dvh, fx, ab(r.id));
                const c = compare?.rows.find((x) => x.id === r.id);
                const eqB = c ? toEQD2(c.dvh, compare!.plan.prescription.fractions, ab(r.id)) : null;
                if (isTarget(r.type)) {
                  return (
                    <tr key={r.id} className="border-b border-white/[0.03]">
                      <td className="py-1"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />{r.name}</td>
                      <td className="text-slate-500">EUD (a = −10)</td>
                      <td className="text-right text-slate-100">{gEUD(eq, -10).toFixed(1)} Gy</td>
                      <td className="text-right text-slate-500">—</td>
                      {compare && <td className="pr-1 text-right text-slate-500">{eqB ? `${gEUD(eqB, -10).toFixed(1)} Gy` : '—'}</td>}
                    </tr>
                  );
                }
                if (!p) return null;
                const res = lkbNtcp(eq, p);
                const resB = eqB ? lkbNtcp(eqB, p) : null;
                return (
                  <tr key={r.id} className="border-b border-white/[0.03]" title={`LKB: n ${p.n}, m ${p.m}, TD50 ${p.td50} Gy (${p.endpoint})`}>
                    <td className="py-1"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: r.color }} />{r.name}</td>
                    <td className="text-slate-500">{p.endpoint}</td>
                    <td className="text-right text-slate-100">{res.geud.toFixed(1)} Gy</td>
                    <td className={cx('text-right font-medium', res.ntcp < 0.05 ? 'text-emerald-300' : res.ntcp < 0.2 ? 'text-amber-300' : 'text-rose-300')}>{(100 * res.ntcp).toFixed(1)}%</td>
                    {compare && <td className="pr-1 text-right text-slate-500">{resB ? `${(100 * resB.ntcp).toFixed(1)}%` : '—'}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-1 pt-1.5 text-[10px] text-slate-500">Lyman–Kutcher–Burman model with Burman 1991 parameters, on EQD2 dose (each structure's α/β). Organs are matched by name; hover a row for n, m, TD50. Teaching estimates only.</div>
        </div>
      )}
      {tab === 'points' && (
        <div className="p-2" data-testid="points">
          <table className="w-full text-[11px] tabular-nums">
            <thead className="text-slate-500">
              <tr className="border-b border-white/5"><th className="py-1 text-left font-medium">Point</th><th className="text-right font-medium">Total</th><th className="text-right font-medium">% Rx</th><th className="text-right font-medium">Per fx</th>{compare && <th className="pr-1 text-right font-medium">B</th>}</tr>
            </thead>
            <tbody>
              {points.map((pt) => {
                const d = sampleGrid(grid, doseTotal, pt.pos);
                return (
                  <tr key={pt.name} className="border-b border-white/[0.03]">
                    <td className="py-1">{pt.name}</td>
                    <td className="text-right text-slate-100">{d.toFixed(2)} Gy</td>
                    <td className="text-right">{((100 * d) / rx).toFixed(1)}%</td>
                    <td className="text-right">{(d / fx).toFixed(3)} Gy</td>
                    {compare && <td className="pr-1 text-right text-slate-500">{sampleGrid(compare.grid, compare.total, pt.pos).toFixed(2)} Gy</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {body && (
            <div className="mt-2 rounded-md bg-black/30 px-3 py-2 text-xs text-slate-300">
              Integral dose (Body): <b className="text-slate-100">{integralDose(body.dvh).toFixed(1)} J</b> (Gy·kg, unit density) · mean body dose {body.dvh.mean.toFixed(2)} Gy
              {cmpBody && <span className="text-slate-500"> · B: {integralDose(cmpBody.dvh).toFixed(1)} J</span>}
            </div>
          )}
          <div className="px-1 pt-1.5 text-[10px] text-slate-500">Add reference points in Planning (Points → Ref point).</div>
        </div>
      )}
    </Panel>
  );
}

function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return <div className="grid h-full place-items-center text-sm text-slate-400"><div className="text-center"><p>{text}</p>{action && <div className="mt-3">{action}</div>}</div></div>;
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="rounded-lg bg-white/[0.03] px-2 py-2 ring-1 ring-white/5">
      <div className={cx('text-sm font-semibold tabular-nums', good === undefined ? 'text-slate-100' : good ? 'text-emerald-300' : 'text-amber-300')}>{value}</div>
      <div className="mt-0.5 text-[10px] text-slate-500">{label}</div>
    </div>
  );
}

function BedCalculator({ rx, fx }: { rx: number; fx: number }) {
  const [D, setD] = useState(rx);
  const [n, setN] = useState(fx);
  const [ab, setAb] = useState(10);
  return (
    <Panel title={<span className="flex items-center gap-1.5"><Calculator size={12} /> BED / EQD2</span>}>
      <div className="flex flex-wrap items-center gap-3 p-3">
        <NumberField label="Dose" unit="Gy" value={D} onChange={setD} width="w-20" />
        <NumberField label="in" value={n} onChange={(v) => setN(Math.max(1, Math.round(v)))} width="w-14" />
        <span className="text-xs text-slate-500">fx</span>
        <NumberField label="α/β" unit="Gy" value={ab} onChange={setAb} min={0.5} width="w-20" />
        <div className="text-xs text-slate-300">BED <b className="text-slate-100">{bed(D, n, ab).toFixed(1)}</b> Gy · EQD2 <b className="text-slate-100">{eqd2(D, n, ab).toFixed(1)}</b> Gy</div>
      </div>
    </Panel>
  );
}

function PlanReport({ rows, series, xMax, relative, constraintRows, onClose }: {
  rows: Row[]; series: DvhSeries[]; xMax: number; relative: boolean;
  constraintRows: { st: { name: string; color: string }; c: Parameters<typeof describeConstraint>[0]; res: ReturnType<typeof evaluateConstraint> }[];
  onClose: () => void;
}) {
  const s = useStore.getState();
  const plan = s.plan!.meta;
  const p = s.patient!.info;
  const rx = plan.prescription;
  return (
    <div className="fixed inset-0 z-50 overflow-auto bg-white text-black">
      <div className="no-print sticky top-0 flex justify-end gap-2 border-b bg-white p-3">
        <button className="rounded border px-3 py-1.5 text-sm" onClick={onClose}>Close</button>
        <button className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white" onClick={() => window.print()}>Print / Save as PDF</button>
      </div>
      <div className="mx-auto max-w-[900px] p-8 text-[12px]">
        <div className="flex items-start justify-between border-b pb-3">
          <div>
            <h1 className="text-xl font-bold">Treatment plan report</h1>
            <div className="text-gray-600">PlanLab training TPS: not for clinical use</div>
          </div>
          <div className="text-right">
            <div className="font-semibold">{p.name}</div>
            <div>ID {p.patientId}</div>
            <div>Printed {new Date().toLocaleString()}</div>
          </div>
        </div>
        <table className="mt-4 w-full">
          <tbody>
            <tr><td className="w-40 text-gray-600">Plan</td><td>{plan.name} ({plan.technique}) · {plan.status}</td></tr>
            <tr><td className="text-gray-600">Planner</td><td>{plan.planner}</td></tr>
            <tr><td className="text-gray-600">Contoured image</td><td>{s.ss!.meta.name} on {s.ct!.meta.name}</td></tr>
            <tr><td className="text-gray-600">Prescription</td><td>{rx.totalDose} Gy in {rx.fractions} fractions ({(rx.totalDose / rx.fractions).toFixed(2)} Gy/fx), normalised: {rx.normMode} = {rx.normPercent}%</td></tr>
            <tr><td className="text-gray-600">Calculation</td><td>{plan.doseResolution} mm grid, heterogeneity {plan.heterogeneity ? 'on' : 'off'}, {plan.calculatedAt ? new Date(plan.calculatedAt).toLocaleString() : '—'}</td></tr>
          </tbody>
        </table>
        <h2 className="mt-5 mb-1 font-semibold">Fields</h2>
        <table className="w-full border-collapse text-[11px]">
          <thead><tr className="border-b bg-gray-50">{['Field', 'Machine', 'Energy', 'Gantry', 'Coll', 'Couch', 'X1/X2 (cm)', 'Y1/Y2 (cm)', 'Wedge', 'SSD (cm)', 'Depth (cm)', 'Weight', 'MU/fx'].map((h) => <th key={h} className="px-1 py-1 text-left">{h}</th>)}</tr></thead>
          <tbody>
            {plan.beams.map((b) => {
              const m = machineById(b.machineId);
              const ssd = ssdOf(b), depth = isoDepth(b);
              return (
                <tr key={b.id} className="border-b">
                  <td className="px-1 py-1">{b.name}</td><td className="px-1">{m.name}</td><td className="px-1">{b.energy}</td>
                  <td className="px-1">{b.gantry}</td><td className="px-1">{b.collimator}</td><td className="px-1">{b.couch}</td>
                  <td className="px-1">{(b.jaws.x1 / 10).toFixed(1)} / {(b.jaws.x2 / 10).toFixed(1)}</td>
                  <td className="px-1">{(b.jaws.y1 / 10).toFixed(1)} / {(b.jaws.y2 / 10).toFixed(1)}</td>
                  <td className="px-1">{b.wedge.type === 'none' ? '—' : `${b.wedge.type} ${b.wedge.angle}° (${b.wedge.orientation})`}</td>
                  <td className="px-1">{ssd !== null ? (ssd / 10).toFixed(1) : '—'}</td><td className="px-1">{depth !== null ? (depth / 10).toFixed(1) : '—'}</td>
                  <td className="px-1">{b.weight}</td><td className="px-1 font-semibold">{(plan.mu[b.id] ?? 0).toFixed(m.doseUnit === 'min' ? 2 : 0)}{m.doseUnit === 'min' ? ' min' : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <h2 className="mt-5 mb-1 font-semibold">DVH</h2>
        <DVHChart series={series} xMax={xMax} xLabel={relative ? 'Dose (% of prescription)' : 'Dose (Gy)'} print height={300} />
        <div className="flex flex-wrap gap-3 text-[11px]">{rows.map((r) => <span key={r.id}><span className="mr-1 inline-block h-2 w-2" style={{ background: r.color }} />{r.name}</span>)}</div>
        <h2 className="mt-5 mb-1 font-semibold">Dose statistics (Gy)</h2>
        <table className="w-full border-collapse text-[11px]">
          <thead><tr className="border-b bg-gray-50">{['Structure', 'Volume cc', 'Min', 'Mean', 'Max', 'D95%', 'D2%', 'V100% Rx'].map((h) => <th key={h} className="px-1 py-1 text-left">{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="px-1 py-0.5">{r.name}</td><td className="px-1">{r.dvh.volumeCc.toFixed(1)}</td><td className="px-1">{r.dvh.min.toFixed(2)}</td><td className="px-1">{r.dvh.mean.toFixed(2)}</td>
                <td className="px-1">{r.dvh.max.toFixed(2)}</td><td className="px-1">{dAt(r.dvh, 0.95).toFixed(2)}</td><td className="px-1">{dAt(r.dvh, 0.02).toFixed(2)}</td><td className="px-1">{(100 * vAt(r.dvh, rx.totalDose)).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        {constraintRows.length > 0 && (
          <>
            <h2 className="mt-5 mb-1 font-semibold">Tolerance doses</h2>
            <table className="w-full border-collapse text-[11px]">
              <tbody>
                {constraintRows.map(({ st, c, res }) => (
                  <tr key={c.id} className="border-b"><td className="px-1 py-0.5">{st.name}</td><td className="px-1">{describeConstraint(c)}</td><td className="px-1">{res.text}</td><td className="px-1 font-semibold">{res.pass ? 'PASS' : c.priority === 'mandatory' ? 'FAIL' : 'over goal'}</td></tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {plan.notes && (<><h2 className="mt-5 mb-1 font-semibold">Notes</h2><p className="whitespace-pre-wrap">{plan.notes}</p></>)}
        <div className="mt-10 grid grid-cols-2 gap-10">
          <div className="border-t pt-1 text-gray-600">Student signature / date</div>
          <div className="border-t pt-1 text-gray-600">Instructor signature / date</div>
        </div>
      </div>
    </div>
  );
}
