import { useEffect, useState } from 'react';
import { Layers, Trash2 } from 'lucide-react';
import { useStore, updatePlan, updateBeam, deleteBeam, calculateDose, doseIsStale, machineById, toast, subfieldsOf } from '../../state/store.ts';
import { Panel, Button, NumberField, Select, Toggle, cx } from '../common.tsx';
import { beamAxes } from '../../core/geometry.ts';
import { sampleGrid } from '../../core/dose/engine.ts';
import { projectDoseCloud, blockHotRegion, suggestSubfieldFraction } from '../../core/fif.ts';
import { newId } from '../../core/templates.ts';
import type { Beam, Vec3 } from '../../core/types.ts';

/**
 * Field-in-field: finds where the dose is above a chosen level, projects that hot region into each field's
 * beam's-eye view and adds a sub-field (segment) whose leaves block it, moving part of the field's weight into it.
 */
export function FifPanel({ onClose }: { onClose: () => void }) {
  const plan = useStore((s) => s.plan)?.meta;
  const dose = useStore((s) => s.dose);
  const calc = useStore((s) => s.calc);
  const hotOverlay = useStore((s) => s.hotOverlay);
  useStore((s) => s.planVersion);
  useStore((s) => s.doseVersion);
  const rx = plan?.prescription.totalDose ?? 1;
  const maxPct = dose?.total && plan ? (100 * dose.maxDose) / rx : 0;
  const [level, setLevel] = useState(() => (maxPct > 105.5 ? 105 : Math.max(100, Math.floor(maxPct - 1))));
  const [region, setRegion] = useState<'body' | 'target'>('body');
  const [margin, setMargin] = useState(0);
  const [auto, setAuto] = useState(true);
  const [manualPct, setManualPct] = useState(15);
  const [calcNow, setCalcNow] = useState(true);
  const mains = plan?.beams.filter((b) => !b.parentId) ?? [];
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(mains.map((b) => b.id)));

  // Show the hot region in the BEV while this panel is open
  useEffect(() => {
    useStore.setState({ hotOverlay: { level, region } });
  }, [level, region]);
  useEffect(() => () => useStore.setState({ hotOverlay: null }), []);
  void hotOverlay;

  if (!plan) return null;
  const stale = doseIsStale();
  const fx = plan.prescription.fractions;

  /** Dose (Gy, whole course) a field and its existing sub-fields deliver at a point. */
  const fieldDoseAt = (f: Beam, p: Vec3) => {
    if (!dose) return 0;
    let g = 0;
    for (const b of [f, ...subfieldsOf(plan.beams, f.id)]) {
      const d = dose.perBeam.get(b.id);
      if (d) g += (sampleGrid(dose.grid, d, p) * (plan.mu[b.id] ?? 0) * fx) / 100;
    }
    return g;
  };

  const insideFn = () => {
    const s = useStore.getState();
    const id = region === 'target' ? plan.prescription.targetId : s.ss?.meta.structures.find((x) => x.type === 'EXTERNAL')?.id;
    const m = id ? s.ss?.masks.get(id) : undefined;
    const v = s.ct!.volume;
    return m ? (p: Vec3) => m.get(Math.round((p[0] - v.origin[0]) / v.spacing[0]), Math.round((p[1] - v.origin[1]) / v.spacing[1]), Math.round((p[2] - v.origin[2]) / v.spacing[2])) === 1 : undefined;
  };

  const create = async () => {
    if (!dose?.total || stale) return toast('Calculate the dose first: the hot spot comes from the current dose.', 'warn');
    const fields = mains.filter((b) => chosen.has(b.id));
    if (!fields.length) return toast('Choose at least one field.', 'warn');
    const levelGy = (level / 100) * rx;
    if (dose.maxDose <= levelGy) return toast(`The maximum (${maxPct.toFixed(1)}%) is already below ${level}%. Pick a lower level.`, 'info');
    const hotAt = dose.maxAt!;
    const share = fields.reduce((a, f) => a + fieldDoseAt(f, hotAt), 0);
    const frac = auto ? suggestSubfieldFraction(dose.maxDose, levelGy, share) : manualPct / 100;
    const inside = insideFn();
    let beams = [...plan.beams];
    const made: Beam[] = [];
    const skipped: string[] = [];
    for (const f of fields) {
      const machine = machineById(f.machineId);
      if (!machine.mlc || !f.mlc) { skipped.push(`${f.name} (no MLC)`); continue; }
      const hot = projectDoseCloud(dose.grid, dose.total, levelGy, beamAxes(f, machine.sad), 'collimator', inside, 2, 260);
      const shape = hot && blockHotRegion(machine, f, hot, margin);
      if (!shape) { skipped.push(`${f.name} (hot region not in its field)`); continue; }
      const n = subfieldsOf(beams, f.id).length + 1;
      const child: Beam = { ...f, id: newId('b'), name: `${f.name} FiF${n}`, parentId: f.id, mlc: shape.mlc, autoMlc: null, weight: Math.round(f.weight * frac * 1000) / 1000 };
      const parentNow = beams.find((b) => b.id === f.id)!;
      beams = beams.map((b) => (b.id === f.id ? { ...parentNow, weight: Math.round(parentNow.weight * (1 - frac) * 1000) / 1000 } : b));
      // keep segments right after their field in the list
      const last = beams.reduce((idx, b, i) => (b.id === f.id || b.parentId === f.id ? i : idx), -1);
      beams.splice(last + 1, 0, child);
      made.push(child);
    }
    if (!made.length) return toast(`No sub-field made: ${skipped.join(', ')}.`, 'warn');
    updatePlan({ beams }, false);
    useStore.setState({ selectedBeamId: made[0].id });
    toast(`Added ${made.length} sub-field${made.length > 1 ? 's' : ''} at ${level}% with ${Math.round(frac * 100)}% of the field weight${skipped.length ? `; skipped ${skipped.join(', ')}` : ''}.`, 'success');
    if (calcNow) await calculateDose();
  };

  const removeSub = (sub: Beam) => {
    const parent = plan.beams.find((b) => b.id === sub.parentId);
    if (parent) updateBeam(parent.id, { weight: Math.round((parent.weight + sub.weight) * 1000) / 1000 });
    deleteBeam(sub.id);
  };

  const groups = mains.map((f) => ({ f, subs: subfieldsOf(plan.beams, f.id) })).filter((g) => g.subs.length);
  const hotShares = dose?.total && dose.maxAt && !stale ? mains.map((f) => ({ f, gy: fieldDoseAt(f, dose.maxAt!) })) : [];

  return (
    <Panel
      className="shrink-0 ring-pink-400/30"
      title={<span className="flex items-center gap-1.5 text-pink-200"><Layers size={12} /> Field-in-field</span>}
      actions={<button className="text-[11px] text-slate-400 hover:text-slate-200" onClick={onClose}>Close</button>}
    >
      <div className="space-y-2.5 p-3 text-xs" data-testid="fif-panel">
        {!dose?.total || stale ? (
          <div className="rounded-md bg-amber-500/10 px-2.5 py-2 text-amber-200 ring-1 ring-amber-400/20">
            Calculate the dose first; sub-fields are shaped around the current hot spot.
            <Button size="sm" className="ml-2" disabled={!!calc} onClick={() => calculateDose()}>Calculate</Button>
          </div>
        ) : (
          <div className="text-slate-300">
            Maximum <b className={cx(maxPct > 107 ? 'text-rose-300' : maxPct > 105 ? 'text-amber-300' : 'text-emerald-300')}>{maxPct.toFixed(1)}%</b> ({dose.maxDose.toFixed(2)} Gy)
            {hotShares.length > 0 && <span className="text-slate-500"> · at the hot spot: {hotShares.map((h) => `${h.f.name} ${((100 * h.gy) / dose.maxDose).toFixed(0)}%`).join(', ')}</span>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <NumberField label="Block dose above" unit="%" value={level} onChange={(v) => setLevel(Math.round(v * 10) / 10)} min={80} max={130} step={1} width="w-20" />
          {[103, 105, 107].map((l) => (
            <button key={l} onClick={() => setLevel(l)} className={cx('h-7 rounded-md px-2 ring-1 ring-white/10', level === l ? 'bg-pink-500/20 text-pink-100' : 'text-slate-400 hover:bg-white/10')}>{l}%</button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select<'body' | 'target'> label="Hot spots in" value={region} onChange={setRegion} options={[{ value: 'body', label: 'Whole body' }, { value: 'target', label: 'Target only' }]} className="w-44" />
          <NumberField label="Margin" unit="mm" value={margin} onChange={setMargin} min={0} max={15} width="w-16" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle checked={auto} onChange={setAuto} label="Auto sub-field weight" />
          {!auto && <NumberField label="Sub-field" unit="%" value={manualPct} onChange={setManualPct} min={2} max={60} width="w-16" />}
        </div>
        <div>
          <div className="mb-1 text-slate-500">Fields to segment</div>
          <div className="flex flex-wrap gap-1">
            {mains.map((b) => (
              <label key={b.id} className={cx('flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 ring-1 ring-white/10', chosen.has(b.id) ? 'bg-pink-500/15 text-pink-100' : 'text-slate-400')}>
                <input type="checkbox" className="accent-pink-400" checked={chosen.has(b.id)} onChange={() => setChosen((c) => { const n = new Set(c); if (n.has(b.id)) n.delete(b.id); else n.add(b.id); return n; })} />
                {b.name}
              </label>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="primary" disabled={!dose?.total || stale || !!calc} onClick={() => void create()}>Create sub-fields</Button>
          <Toggle checked={calcNow} onChange={setCalcNow} label="Recalculate after" />
        </div>
        <div className="text-[10px] leading-relaxed text-slate-500">
          The pink dashed outline in the BEV is the region above {level}% seen from each field. Each new segment closes the leaves over it and takes part of
          the field's weight, so the hot spot gets less dose while the rest of the field is unchanged. Work down in steps (e.g. 107% → 105% → 103%),
          recalculating each time. Fine-tune a segment by dragging its leaves in the BEV.
        </div>
        {groups.length > 0 && (
          <table className="w-full text-[11px] tabular-nums">
            <thead className="text-slate-500"><tr className="border-b border-white/5"><th className="py-1 text-left font-medium">Segment</th><th className="text-right font-medium">Share of field</th><th className="text-right font-medium">MU</th><th /></tr></thead>
            <tbody>
              {groups.flatMap(({ f, subs }) => {
                const total = f.weight + subs.reduce((a, b) => a + b.weight, 0) || 1;
                return [f, ...subs].map((b) => (
                  <tr key={b.id} className={cx('border-b border-white/[0.03]', b.parentId && 'text-pink-100')}>
                    <td className="py-1">{b.parentId ? `↳ ${b.name}` : `${b.name} (open)`}</td>
                    <td className="text-right">{((100 * b.weight) / total).toFixed(0)}%</td>
                    <td className="text-right">{(plan.mu[b.id] ?? 0).toFixed(0)}</td>
                    <td className="w-6 text-right">{b.parentId && <button title="Remove this sub-field (its weight returns to the open field)" className="text-slate-500 hover:text-rose-300" onClick={() => removeSub(b)}><Trash2 size={12} /></button>}</td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}
