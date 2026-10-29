import { useMemo, useState } from 'react';
import { Wand2, RotateCcw } from 'lucide-react';
import { useStore, updatePlan, normPoint, subfieldsOf, machineById } from '../../state/store.ts';
import { isoDepth } from '../../state/planTools.ts';
import { Modal, Button, NumberField, cx } from '../common.tsx';
import { sampleGrid } from '../../core/dose/engine.ts';
import { matrix, relativeDose, suggestWeights, type FieldMatrix } from '../../core/weighting.ts';
import type { Beam, Vec3 } from '../../core/types.ts';

interface Sample { name: string; color: string; kind: 'target' | 'oar'; m: FieldMatrix }

const SITE_GUIDE: { site: string; technique: string; weights: string; why: string }[] = [
  { site: 'Pelvis (cervix, prostate, bladder, rectum)', technique: '4-field box', weights: 'AP 1 : PA 1 : laterals 1', why: 'Equal weights are the usual start. In wide patients (lateral separation > ~35 cm) the laterals lose dose at depth: use 10–15 MV, or weight AP/PA a little more. Weight the laterals less to spare the femoral heads, more to spare bladder/rectum from AP/PA.' },
  { site: 'Rectum', technique: 'PA + 2 laterals', weights: 'PA 1 : laterals 0.5–0.8', why: 'The PA field carries most dose to the posterior target; wedged laterals (thick end posterior) fill in anteriorly where the PA dose falls off. Raising the laterals moves dose forward towards bladder and small bowel.' },
  { site: 'Bladder', technique: 'AP + 2 laterals', weights: 'AP 1 : laterals 0.6–0.8', why: 'Mirror of the rectum set-up: AP field plus wedged laterals (thick end anterior) to make up the posterior fall-off. Watch rectal dose as the laterals increase.' },
  { site: 'Mediastinum / lung (palliative)', technique: 'AP/PA', weights: 'AP 1 : PA 1 (2 : 1 for anterior targets)', why: 'Equal weights for midline targets. Weighting one side more moves the high dose towards that side; for anterior disease weight AP up, but the spinal cord dose rises with PA weight.' },
  { site: 'Whole brain', technique: 'Opposed laterals', weights: 'L 1 : R 1', why: 'Symmetrical anatomy; equal weights give a flat dose across the midline.' },
  { site: 'Larynx / neck', technique: 'Opposed laterals', weights: 'L 1 : R 1', why: 'Equal weights; wedges (thick end anterior) or field-in-field correct for the sloping anterior neck rather than unequal weights.' },
  { site: 'Breast / chest wall', technique: 'Tangents', weights: 'Medial 1 : lateral 1', why: 'Start equal, then shift ±5–10% to move the hot spot medially or laterally. Remaining hot spots are usually treated with wedges or field-in-field segments.' },
  { site: 'Spine / supraclavicular', technique: 'Single field', weights: '1', why: 'Single field prescribed at depth: weighting does not apply; choose energy and prescription depth instead.' },
  { site: 'Oesophagus', technique: 'AP/PA + obliques', weights: 'AP/PA 1 : obliques 0.5–1', why: 'Obliques keep the cord below tolerance; give them more weight as AP/PA dose to the cord approaches its limit.' },
];

/** Live beam-weighting guide: preview, suggested weights and typical starting points by site. */
export function WeightingGuide({ onClose }: { onClose: () => void }) {
  const plan = useStore((s) => s.plan)!.meta;
  const dose = useStore((s) => s.dose);
  const ss = useStore((s) => s.ss)!;
  const ct = useStore((s) => s.ct)!;
  const fields = plan.beams.filter((b) => !b.parentId);
  const fieldWeight = (f: Beam) => f.weight + subfieldsOf(plan.beams, f.id).reduce((a, b) => a + b.weight, 0);
  const [weights, setWeights] = useState<number[]>(() => fields.map((f) => Math.round(fieldWeight(f) * 100) / 100));
  const original = useMemo(() => fields.map((f) => fieldWeight(f)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [importance, setImportance] = useState<Record<string, number>>({});
  const [tab, setTab] = useState<'adjust' | 'sites'>('adjust');
  const ready = !!dose && fields.every((f) => [f, ...subfieldsOf(plan.beams, f.id)].every((b) => dose.perBeam.has(b.id)));

  // Sampled, field-wise dose per unit weight (relative to each field's dose at the normalisation point)
  const data = useMemo(() => {
    if (!dose || !ready) return null;
    const pt = normPoint();
    if (!pt) return null;
    const v = ct.volume;
    const per = (f: Beam, p: Vec3) => {
      const segs = [f, ...subfieldsOf(plan.beams, f.id)];
      const pd = dose.perBeam.get(f.id)!;
      let ref = sampleGrid(dose.grid, pd, pt);
      if (ref < 1e-4) ref = sampleGrid(dose.grid, pd, f.iso) || 1;
      const W = segs.reduce((a, b) => a + b.weight, 0) || 1;
      let s = 0;
      for (const b of segs) s += (b.weight / W) * sampleGrid(dose.grid, dose.perBeam.get(b.id)!, p);
      return s / ref;
    };
    const fill = (pts: Vec3[]) => {
      const m = matrix(pts.length, fields.length);
      pts.forEach((p, r) => fields.forEach((f, c) => { m.a[r * fields.length + c] = per(f, p); }));
      return m;
    };
    const maskPoints = (id: string, max: number): Vec3[] => {
      const m = ss.masks.get(id)!;
      const stride = Math.max(1, Math.floor(m.count() / max));
      const out: Vec3[] = [];
      let n = 0;
      m.forEach((i, j, k) => { if (n++ % stride === 0) out.push([v.origin[0] + i * v.spacing[0], v.origin[1] + j * v.spacing[1], v.origin[2] + k * v.spacing[2]]); });
      return out;
    };
    const targetId = plan.prescription.targetId ?? ss.meta.structures.find((x) => x.type === 'PTV')?.id;
    const samples: Sample[] = [];
    if (targetId && !ss.masks.get(targetId)!.isEmpty()) {
      const st = ss.meta.structures.find((x) => x.id === targetId)!;
      samples.push({ name: st.name, color: st.color, kind: 'target', m: fill(maskPoints(targetId, 2500)) });
    }
    for (const st of ss.meta.structures) {
      if (st.type !== 'OAR' || ss.masks.get(st.id)!.isEmpty()) continue;
      samples.push({ name: st.name, color: st.color, kind: 'oar', m: fill(maskPoints(st.id, 1200)) });
    }
    // Candidate hot-spot points across everything any field irradiates (not just today's hot spot: new weights can
    // move the maximum to another field's entrance), plus every point that is hot now.
    const hotPts: Vec3[] = [];
    {
      const [nx, ny] = dose.grid.dims;
      const n = nx * ny * dose.grid.dims[2];
      const reach = new Float32Array(n);
      for (const f of fields) {
        const d = dose.perBeam.get(f.id)!;
        let mx = 0;
        for (let q = 0; q < n; q++) if (d[q] > mx) mx = d[q];
        for (let q = 0; q < n; q++) if (mx > 0) reach[q] = Math.max(reach[q], d[q] / mx);
      }
      const wide: number[] = [], hotNow: number[] = [];
      for (let q = 0; q < n; q++) {
        if (reach[q] > 0.3) wide.push(q);
        if (dose.total && dose.total[q] >= 0.9 * dose.maxDose) hotNow.push(q);
      }
      const push = (q: number) => {
        const i = q % nx, j = Math.floor(q / nx) % ny, k = Math.floor(q / (nx * ny));
        hotPts.push([dose.grid.origin[0] + i * dose.grid.spacing[0], dose.grid.origin[1] + j * dose.grid.spacing[1], dose.grid.origin[2] + k * dose.grid.spacing[2]]);
      };
      const s1 = Math.max(1, Math.floor(wide.length / 12000));
      for (let m = 0; m < wide.length; m += s1) push(wide[m]);
      const s2 = Math.max(1, Math.floor(hotNow.length / 2000));
      for (let m = 0; m < hotNow.length; m += s2) push(hotNow[m]);
    }
    return { samples, hot: fill(hotPts), norm: fill([pt]) };
  }, [dose, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const rx = plan.prescription.totalDose;
  const mode = plan.prescription.normMode;

  /** Absolute dose (Gy) per sample set for weights w, following the plan's normalisation. */
  const evaluate = (w: number[]) => {
    if (!data) return null;
    const sets = data.samples.map((s) => ({ ...s, d: relativeDose(s.m, w) }));
    const hot = relativeDose(data.hot, w);
    let scale = (rx * plan.prescription.normPercent) / 100;
    const target = sets.find((s) => s.kind === 'target');
    if ((mode === 'targetMean' || mode === 'targetMedian' || mode === 'targetD95') && target && target.d.length) {
      const sorted = Float64Array.from(target.d).sort();
      const metric = mode === 'targetMean' ? sorted.reduce((a, b) => a + b, 0) / sorted.length : mode === 'targetMedian' ? sorted[Math.floor(sorted.length / 2)] : sorted[Math.floor(sorted.length * 0.05)];
      scale = metric > 0 ? ((rx * plan.prescription.normPercent) / 100) / metric : scale;
    }
    const pct = (arr: Float64Array, q: number) => { const s = Float64Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] ?? 0; };
    return {
      target: target ? { d98: pct(target.d, 0.02) * scale, mean: (target.d.reduce((a, b) => a + b, 0) / target.d.length) * scale, d2: pct(target.d, 0.98) * scale } : null,
      hotMax: hot.length ? Math.max(...hot) * scale : 0,
      oars: sets.filter((s) => s.kind === 'oar').map((s) => ({ name: s.name, color: s.color, mean: (s.d.reduce((a, b) => a + b, 0) / Math.max(1, s.d.length)) * scale, max: (s.d.length ? Math.max(...s.d) : 0) * scale })),
    };
  };
  const before = useMemo(() => evaluate(original), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const after = evaluate(weights);

  const suggest = () => {
    if (!data) return;
    const target = data.samples.find((s) => s.kind === 'target');
    if (!target) return;
    const w = suggestWeights({
      target: target.m,
      oars: data.samples.filter((s) => s.kind === 'oar').map((s) => ({ m: s.m, importance: importance[s.name] ?? 1 })),
      hot: data.hot,
      stayNear: 0.05,
    }, weights);
    setWeights(w);
  };

  const apply = () => {
    const beams = plan.beams.map((b) => {
      const fi = fields.findIndex((f) => f.id === (b.parentId ?? b.id));
      if (fi < 0) return b;
      const old = original[fi] || 1;
      return { ...b, weight: Math.round(((b.weight * weights[fi]) / old) * 1000) / 1000 };
    });
    updatePlan({ beams }, true);
    onClose();
  };

  const pctRx = (gy: number) => `${((100 * gy) / rx).toFixed(1)}%`;
  const delta = (a: number, b: number, lowerBetter: boolean) => {
    const d = b - a;
    if (Math.abs(d) < 0.005 * rx) return 'text-slate-400';
    return (d < 0) === lowerBetter ? 'text-emerald-300' : 'text-amber-300';
  };
  const W = weights.reduce((a, b) => a + Math.max(0, b), 0) || 1;

  return (
    <Modal
      title="Beam weighting guide"
      onClose={onClose}
      width="max-w-5xl"
      footer={
        <>
          <Button variant="ghost" onClick={() => setWeights(original.map((x) => Math.round(x * 100) / 100))}><RotateCcw size={13} /> Reset</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={apply}>Apply weights</Button>
        </>
      }
    >
      <div className="mb-3 flex gap-1">
        {(['adjust', 'sites'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cx('rounded-md px-3 py-1 text-xs', tab === t ? 'bg-sky-500/25 text-sky-100' : 'text-slate-400 hover:text-slate-200')}>{t === 'adjust' ? 'Adjust & preview' : 'Typical weights by site'}</button>
        ))}
      </div>
      {tab === 'sites' ? (
        <div data-testid="site-guide">
          <p className="mb-2 text-xs text-slate-400">Starting points for practice. Each field's weight is its share of the dose at the normalisation point. Always check the result in the isodoses and DVH, and follow your department's protocol.</p>
          <table className="w-full text-xs">
            <thead className="text-slate-500"><tr className="border-b border-white/5"><th className="py-1 text-left font-medium">Site</th><th className="text-left font-medium">Technique</th><th className="text-left font-medium">Weights</th><th className="text-left font-medium">Why / how to adjust</th></tr></thead>
            <tbody>
              {SITE_GUIDE.map((r) => (
                <tr key={r.site} className="border-b border-white/[0.04] align-top">
                  <td className="py-1.5 pr-2 text-slate-100">{r.site}</td><td className="pr-2 text-slate-300">{r.technique}</td><td className="pr-2 whitespace-nowrap text-sky-200">{r.weights}</td><td className="text-slate-400">{r.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !ready ? (
        <p className="text-sm text-slate-300">Calculate the dose first. The guide previews new weights instantly by recombining each field's calculated dose, so no recalculation is needed while you adjust.</p>
      ) : mode === 'none' ? (
        <p className="text-sm text-slate-300">This plan uses fixed MU (no normalisation), so weights have no effect. Choose a normalisation in Prescribe first.</p>
      ) : (
        <div className="grid grid-cols-[1.1fr_1fr] gap-5" data-testid="weighting-guide">
          <div>
            <table className="w-full text-xs">
              <thead className="text-slate-500"><tr className="border-b border-white/5"><th className="py-1 text-left font-medium">Field</th><th className="text-right font-medium">Gantry</th><th className="text-right font-medium">Iso depth</th><th className="pl-3 text-left font-medium">Weight</th><th className="text-right font-medium">Share</th></tr></thead>
              <tbody>
                {fields.map((f, i) => {
                  const depth = isoDepth(f);
                  const segs = subfieldsOf(plan.beams, f.id).length;
                  return (
                    <tr key={f.id} className="border-b border-white/[0.04]">
                      <td className="py-1.5 text-slate-100">{f.name}{segs > 0 && <span className="ml-1 text-[10px] text-pink-300">+{segs} FiF</span>}</td>
                      <td className="text-right text-slate-400">{f.gantry.toFixed(0)}°</td>
                      <td className="text-right text-slate-400">{depth !== null ? `${(depth / 10).toFixed(1)} cm` : '—'}</td>
                      <td className="pl-3">
                        <div className="flex items-center gap-2">
                          <input type="range" min={0} max={2} step={0.05} value={weights[i]} onChange={(e) => setWeights((w) => w.map((x, k) => (k === i ? +e.target.value : x)))} className="w-28 accent-sky-400" aria-label={`${f.name} weight`} />
                          <NumberField value={weights[i]} onChange={(v) => setWeights((w) => w.map((x, k) => (k === i ? Math.max(0, v) : x)))} step={0.05} min={0} max={10} width="w-16" />
                        </div>
                      </td>
                      <td className="text-right text-slate-300 tabular-nums">{((100 * Math.max(0, weights[i])) / W).toFixed(0)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              Share = the field's part of the dose at the normalisation point. A field gives most dose near where it enters, so raising its weight moves the
              high-dose region towards its side of the patient. Shallow fields (small iso depth) need less weight for the same dose at depth.
              {machineById(fields[0]?.machineId ?? '').doseUnit === 'min' ? ' (Cobalt: times follow from the weights.)' : ''}
            </p>
            <div className="mt-4 rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/5">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-semibold text-slate-300">Suggest weights</div>
                <Button size="sm" variant="primary" onClick={suggest}><Wand2 size={13} /> Suggest</Button>
              </div>
              <p className="mb-2 text-[11px] text-slate-500">Finds weights that make the target dose as even as possible, keep hot spots under 105% and lower dose to the organs you mark as important.</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {data?.samples.filter((s) => s.kind === 'oar').map((s) => (
                  <label key={s.name} className="flex items-center gap-1.5 text-[11px] text-slate-300">
                    <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />{s.name}
                    <select value={importance[s.name] ?? 1} onChange={(e) => setImportance((m) => ({ ...m, [s.name]: +e.target.value }))} className="h-6 rounded bg-black/40 px-1 text-[11px] ring-1 ring-white/10">
                      <option value={0}>ignore</option><option value={1}>low</option><option value={2}>medium</option><option value={3}>high</option>
                    </select>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-slate-300">Preview (no recalculation needed)</div>
            <table className="w-full text-xs tabular-nums" data-testid="weighting-preview">
              <thead className="text-slate-500"><tr className="border-b border-white/5"><th className="py-1 text-left font-medium" /><th className="text-right font-medium">Current</th><th className="text-right font-medium">New</th></tr></thead>
              <tbody>
                {after?.target && before?.target && (
                  <>
                    <tr className="border-b border-white/[0.04]"><td className="py-1 text-slate-300">Target D98 (coverage)</td><td className="text-right">{pctRx(before.target.d98)}</td><td className={cx('text-right', delta(before.target.d98, after.target.d98, false))}>{pctRx(after.target.d98)}</td></tr>
                    <tr className="border-b border-white/[0.04]"><td className="py-1 text-slate-300">Target mean</td><td className="text-right">{pctRx(before.target.mean)}</td><td className="text-right">{pctRx(after.target.mean)}</td></tr>
                    <tr className="border-b border-white/[0.04]"><td className="py-1 text-slate-300">Target D2</td><td className="text-right">{pctRx(before.target.d2)}</td><td className={cx('text-right', delta(before.target.d2, after.target.d2, true))}>{pctRx(after.target.d2)}</td></tr>
                  </>
                )}
                {after && before && <tr className="border-b border-white/[0.04]"><td className="py-1 text-slate-300">Hot spot (max)</td><td className="text-right">{pctRx(before.hotMax)}</td><td className={cx('text-right font-medium', after.hotMax > 1.07 * rx ? 'text-rose-300' : delta(before.hotMax, after.hotMax, true))}>{pctRx(after.hotMax)}</td></tr>}
                {after?.oars.map((o, n) => (
                  <tr key={o.name} className="border-b border-white/[0.04]">
                    <td className="py-1 text-slate-300"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: o.color }} />{o.name} mean / max</td>
                    <td className="text-right">{before!.oars[n].mean.toFixed(1)} / {before!.oars[n].max.toFixed(1)} Gy</td>
                    <td className={cx('text-right', delta(before!.oars[n].mean, o.mean, true))}>{o.mean.toFixed(1)} / {o.max.toFixed(1)} Gy</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-slate-500">Estimated from sampled points of each field's calculated dose. After applying, the plan's MU and isodoses update straight away.</p>
          </div>
        </div>
      )}
    </Modal>
  );
}
