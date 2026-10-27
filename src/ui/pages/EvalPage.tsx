import { useEffect, useMemo, useState } from 'react';
import { Printer, CheckCircle2, XCircle, GitCompare, Calculator } from 'lucide-react';
import { useStore, doseIsStale, calculateDose, machineById } from '../../state/store.ts';
import { computeDVH, cumulativeCurve, evaluateConstraint, targetIndices, toEQD2, dAt, vAt, bed, eqd2, type DVH } from '../../core/dvh.ts';
import { describeConstraint } from '../../core/templates.ts';
import { Panel, Button, Toggle, Select, Badge, NumberField, cx } from '../common.tsx';
import { DVHChart, type DvhSeries } from '../views/DVHChart.tsx';
import { SliceView } from '../views/SliceView.tsx';
import * as db from '../../core/storage.ts';
import { ssdOf, isoDepth } from '../../state/planTools.ts';
import { TARGET_TYPES, type PlanMeta } from '../../core/types.ts';

interface Row {
  id: string;
  name: string;
  color: string;
  type: string;
  dvh: DVH;
}

export function EvalPage() {
  const plan = useStore((s) => s.plan)?.meta;
  const ss = useStore((s) => s.ss);
  const ct = useStore((s) => s.ct)!;
  const dose = useStore((s) => s.dose);
  const doseVersion = useStore((s) => s.doseVersion);
  const ssVersion = useStore((s) => s.ssVersion);
  const patient = useStore((s) => s.patient)!;
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [relative, setRelative] = useState(false);
  const [useEqd2, setUseEqd2] = useState(false);
  const [compareId, setCompareId] = useState('');
  const [compare, setCompare] = useState<{ plan: PlanMeta; rows: Row[] } | null>(null);
  const [report, setReport] = useState(false);

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
      if (!cancelled) setCompare({ plan: p, rows: cr });
    })();
    return () => { cancelled = true; };
  }, [compareId, ss, ct, patient.info.id]);

  if (!plan) return <Empty text="Open a plan to evaluate it (bottom panel)." />;
  if (!dose?.total) return <Empty text="This plan has no dose yet." action={<Button variant="primary" onClick={() => calculateDose()}>Calculate dose</Button>} />;

  const rx = plan.prescription.totalDose;
  const fx = plan.prescription.fractions;
  const conv = (r: Row) => (useEqd2 ? toEQD2(r.dvh, fx, ss!.meta.structures.find((x) => x.id === r.id)?.alphaBeta ?? 3) : r.dvh);
  const allDvhs = rows.map(conv);
  const maxDose = Math.max(rx * 1.15, ...allDvhs.map((d) => d.max)) ;
  const xMax = relative ? Math.ceil((100 * maxDose) / rx / 10) * 10 : Math.ceil(maxDose / 5) * 5;
  const toX = (d: number) => (relative ? (100 * d) / rx : d);
  const binGy = Math.max(0.05, maxDose / 300);
  const series: DvhSeries[] = rows.filter((r) => !hidden.has(r.id)).map((r) => ({
    id: r.id, name: r.name, color: r.color, points: cumulativeCurve(conv(r), binGy, maxDose).map(([d, v]) => [toX(d), v] as [number, number]),
  }));
  if (compare) {
    for (const r of compare.rows) if (!hidden.has(r.id)) series.push({ id: `cmp-${r.id}`, name: r.name, color: r.color, dashed: true, points: cumulativeCurve(useEqd2 ? toEQD2(r.dvh, compare.plan.prescription.fractions, 3) : r.dvh, binGy, maxDose).map(([d, v]) => [toX(d), v] as [number, number]) });
  }
  const target = rows.find((r) => r.id === plan.prescription.targetId) ?? rows.find((r) => r.type === 'PTV');
  const body = rows.find((r) => r.type === 'EXTERNAL');
  const ti = target ? targetIndices(target.dvh, body?.dvh ?? null, rx) : null;
  const stale = doseIsStale();
  const otherPlans = patient.plans.filter((p) => p.id !== plan.id && p.structureSetId === ss?.meta.id);

  const constraintRows = (ss?.meta.structures ?? []).flatMap((st) => {
    const r = rows.find((x) => x.id === st.id);
    if (!r) return [];
    const dv = useEqd2 ? toEQD2(r.dvh, fx, st.alphaBeta) : r.dvh;
    return st.constraints.map((c) => ({ st, c, res: evaluateConstraint(c, dv, rx) }));
  });
  const passed = constraintRows.filter((x) => x.res.pass).length;

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.35fr)_minmax(380px,1fr)] gap-2 overflow-hidden p-2">
      <div className="flex min-h-0 flex-col gap-2 overflow-auto">
        <Panel
          title="Dose–volume histogram"
          actions={
            <>
              <Toggle checked={relative} onChange={setRelative} label="% of Rx" />
              <Toggle checked={useEqd2} onChange={setUseEqd2} label="EQD2" />
              <Select value={compareId} onChange={setCompareId} options={[{ value: '', label: 'Compare with…' }, ...otherPlans.map((p) => ({ value: p.id, label: p.name }))]} className="w-40" />
              <Button size="sm" onClick={() => setReport(true)}><Printer size={13} /> Report</Button>
            </>
          }
        >
          {stale && <div className="mx-3 mt-2 rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 ring-1 ring-amber-400/20">Fields changed since the last calculation; DVHs show the old dose. <button className="underline" onClick={() => calculateDose()}>Recalculate</button></div>}
          <div className="p-2">
            <DVHChart series={series} xMax={xMax} xLabel={relative ? 'Dose (% of prescription)' : useEqd2 ? 'EQD2 (Gy)' : 'Dose (Gy)'} rxLine={relative ? 100 : useEqd2 ? undefined : rx} />
            {compare && <div className="px-2 text-[11px] text-slate-500"><GitCompare size={12} className="mr-1 inline" />Dashed: {compare.plan.name}</div>}
            <div className="mt-2 flex flex-wrap gap-1 px-2">
              {rows.map((r) => (
                <button key={r.id} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} className={cx('flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] ring-1 ring-white/10', hidden.has(r.id) ? 'opacity-40' : '')}>
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: r.color }} />{r.name}
                </button>
              ))}
            </div>
          </div>
        </Panel>
        <Panel title="Dose statistics">
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
                const isT = TARGET_TYPES.includes(r.type as never);
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
          <Panel title={`Target quality: ${target.name}`}>
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
        <Panel title={`Tolerance doses · ${passed}/${constraintRows.length} met${useEqd2 ? ' (EQD2)' : ''}`}>
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
        <BedCalculator rx={rx} fx={fx} />
        <div className="h-72 shrink-0"><SliceView plane="axial" mode="eval" /></div>
      </div>
      {report && <PlanReport rows={rows} series={series} xMax={xMax} relative={relative} constraintRows={constraintRows} onClose={() => setReport(false)} />}
    </div>
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
