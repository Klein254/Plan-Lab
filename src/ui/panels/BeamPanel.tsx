import { useState } from 'react';
import { Copy, Trash2, Plus, FlipHorizontal2, Crosshair, Target } from 'lucide-react';
import { useStore, updateBeam, addBeams, deleteBeam, machineById, toast, doseIsStale, updatePlan, voxelToPatient } from '../../state/store.ts';
import { refitIfAuto, ssdOf, makeBeam, structureCentre } from '../../state/planTools.ts';
import { AutoMlcDialog } from './PlanDialogs.tsx';
import { Panel, NumberField, Select, IconBtn, Button, cx, Badge } from '../common.tsx';
import { openMlc, clampJaws } from '../../core/bev.ts';
import { newId } from '../../core/templates.ts';
import { normAngle } from '../../core/geometry.ts';
import type { Beam, Vec3, WedgeOrientation } from '../../core/types.ts';
import { TARGET_TYPES } from '../../core/types.ts';

const cm = (mm: number) => mm / 10;
const mm = (cmv: number) => Math.round(cmv * 100) / 10;

export function BeamList() {
  const plan = useStore((s) => s.plan)?.meta;
  const sel = useStore((s) => s.selectedBeamId);
  const dose = useStore((s) => s.dose);
  useStore((s) => s.planVersion);
  if (!plan) return null;
  const stale = doseIsStale();
  return (
    <Panel
      collapseKey="plan-fields"
      className="shrink-0"
      title={`Treatment fields (${plan.beams.length})`}
      actions={
        <IconBtn title="Add a beam (copy of the selected one, or AP)" onClick={() => {
          const s = useStore.getState();
          const base = plan.beams.find((b) => b.id === sel);
          const machine = machineById(base?.machineId ?? s.lib.machines[0].id);
          const iso = base?.iso ?? plan.beams[0]?.iso ?? (s.ct ? voxelToPatient(s.ct.volume, s.cursor) : [0, 0, 0] as Vec3);
          const nb = base ? { ...base, id: newId('b'), name: `${base.name} copy`, mlc: base.mlc ? { x1: [...base.mlc.x1], x2: [...base.mlc.x2] } : null } : makeBeam(machine, 0, iso);
          addBeams([nb]);
        }}><Plus size={14} /></IconBtn>
      }
    >
      <table className="w-full text-[11px]">
        <thead className="text-slate-500">
          <tr className="border-b border-white/5">
            <th className="py-1 pl-2 text-left font-medium">Field</th>
            <th className="text-right font-medium">G°</th>
            <th className="text-right font-medium">Energy</th>
            <th className="text-right font-medium">Wt</th>
            <th className="pr-2 text-right font-medium">MU</th>
          </tr>
        </thead>
        <tbody>
          {plan.beams.map((b, n) => {
            const m = machineById(b.machineId);
            const mu = plan.mu[b.id];
            const beamStale = !dose || dose.signatures[b.id] === undefined || stale;
            return (
              <tr key={b.id} onClick={() => useStore.setState({ selectedBeamId: b.id })} className={cx('cursor-pointer border-b border-white/[0.03]', b.id === sel ? 'bg-sky-500/10' : 'hover:bg-white/[0.03]')}>
                <td className={cx('py-1.5', b.parentId ? 'pl-6' : 'pl-2')}>
                  {b.parentId ? <span className="mr-1 text-pink-300">↳</span> : <span className="mr-1.5 text-slate-500">{n + 1 - plan.beams.slice(0, n).filter((x) => x.parentId).length}.</span>}
                  <span className={b.parentId ? 'text-pink-100' : 'text-slate-100'}>{b.name}</span>
                  {b.wedge.type !== 'none' && <span className="ml-1 text-sky-300">W{b.wedge.angle}</span>}
                </td>
                <td className="text-right text-slate-300 tabular-nums">{b.gantry.toFixed(0)}</td>
                <td className="text-right text-slate-300">{b.energy}</td>
                <td className="text-right text-slate-300 tabular-nums">{b.weight.toFixed(2)}</td>
                <td className={cx('pr-2 text-right tabular-nums', beamStale ? 'text-slate-500' : 'text-emerald-300')}>
                  {mu !== undefined ? `${mu.toFixed(m.doseUnit === 'min' ? 2 : 0)}${m.doseUnit === 'min' ? ' min' : ''}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!plan.beams.length && <div className="p-3 text-xs text-slate-500">No beams. Use + or the toolbar to add one.</div>}
    </Panel>
  );
}

export function BeamEditor() {
  const plan = useStore((s) => s.plan)?.meta;
  const sel = useStore((s) => s.selectedBeamId);
  const ss = useStore((s) => s.ss);
  const lib = useStore((s) => s.lib);
  const [autoMlc, setAutoMlc] = useState(false);
  const beam = plan?.beams.find((b) => b.id === sel);
  if (!plan || !beam || !ss) return <Panel title="Field" collapseKey="plan-field" className="shrink-0"><div className="p-3 text-xs text-slate-500">Select a field.</div></Panel>;
  const machine = machineById(beam.machineId);
  const ssd = ssdOf(beam);
  const targets = ss.meta.structures.filter((x) => !ss.masks.get(x.id)!.isEmpty() && x.type !== 'EXTERNAL');
  const defaultTarget = beam.autoMlc?.structureId ?? plan.prescription.targetId ?? targets.find((t) => TARGET_TYPES.includes(t.type))?.id ?? '';
  const follows = beam.autoMlc ? ss.meta.structures.find((x) => x.id === beam.autoMlc!.structureId) : null;
  const parent = beam.parentId ? plan.beams.find((b) => b.id === beam.parentId) : undefined;
  const segTotal = parent ? parent.weight + plan.beams.filter((b) => b.parentId === parent.id).reduce((a, b) => a + b.weight, 0) : 0;

  // Geometry changes keep auto-MLC beams conformed to their structure
  const geo = (patch: Partial<Beam>) => updateBeam(beam.id, refitIfAuto({ ...beam, ...patch }));
  const jaws = (patch: Partial<Beam['jaws']>) => updateBeam(beam.id, { jaws: clampJaws(machine, { ...beam.jaws, ...patch }) });

  return (
    <Panel
      collapseKey="plan-field"
      className="shrink-0"
      title={`Field: ${beam.name}`}
      actions={
        <>
          {!parent && <IconBtn title="Add the opposed field (gantry + 180°)" onClick={() => {
            const g = normAngle(beam.gantry + 180);
            let nb: Beam = { ...beam, id: newId('b'), gantry: g, name: g === 180 ? 'PA' : g === 0 ? 'AP' : g === 90 ? 'LT LAT' : g === 270 ? 'RT LAT' : `${beam.name} opp`, collimator: normAngle(-beam.collimator), mlc: beam.mlc ? { x1: [...beam.mlc.x1], x2: [...beam.mlc.x2] } : null };
            nb = refitIfAuto(nb);
            addBeams([nb]);
          }}><FlipHorizontal2 size={14} /></IconBtn>}
          <IconBtn title="Duplicate" onClick={() => addBeams([{ ...beam, id: newId('b'), name: `${beam.name} copy`, mlc: beam.mlc ? { x1: [...beam.mlc.x1], x2: [...beam.mlc.x2] } : null }])}><Copy size={14} /></IconBtn>
          <IconBtn title="Delete field" danger onClick={() => deleteBeam(beam.id)}><Trash2 size={14} /></IconBtn>
        </>
      }
    >
      <div className="space-y-3 p-3">
        {parent && (
          <div className="rounded-md bg-pink-500/10 px-2.5 py-1.5 text-[11px] text-pink-100 ring-1 ring-pink-400/20">
            Field-in-field segment of <button className="underline" onClick={() => useStore.setState({ selectedBeamId: parent.id })}>{parent.name}</button>: it shares the
            field's angles, isocentre, energy and wedge. Shape it by dragging its leaves in the BEV. It carries {((100 * beam.weight) / (segTotal || 1)).toFixed(0)}% of the field's MU.
          </div>
        )}
        <div className="flex gap-2">
          <input value={beam.name} onChange={(e) => updateBeam(beam.id, { name: e.target.value })} className="h-7 min-w-0 flex-1 rounded-md bg-black/40 px-2 text-sm ring-1 ring-white/10 outline-none focus:ring-sky-400/60" />
        </div>
        <fieldset disabled={!!parent} className="space-y-3 disabled:opacity-60">
        <div className="grid grid-cols-2 gap-2">
          <Select label="Machine" value={beam.machineId} onChange={(v) => {
            const m = lib.machines.find((x) => x.id === v)!;
            geo({ machineId: v, energy: m.energies.find((e) => e.name === beam.energy)?.name ?? m.energies[0].name, mlc: openMlc(m, beam.jaws), wedge: m.physicalWedges.includes(beam.wedge.angle) || beam.wedge.type === 'none' ? beam.wedge : { ...beam.wedge, type: 'none' } });
          }} options={lib.machines.map((m) => ({ value: m.id, label: m.name }))} />
          <Select label="Energy" value={beam.energy} onChange={(v) => updateBeam(beam.id, { energy: v })} options={machine.energies.map((e) => ({ value: e.name, label: e.name }))} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <NumberField label="Gantry" unit="°" value={beam.gantry} onChange={(v) => geo({ gantry: normAngle(v) })} step={1} width="w-16" />
          <NumberField label="Coll." unit="°" value={beam.collimator} onChange={(v) => geo({ collimator: normAngle(v) })} step={1} width="w-16" />
          <NumberField label="Couch" unit="°" value={beam.couch} onChange={(v) => geo({ couch: normAngle(v) })} step={1} width="w-16" />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
            <span>Isocentre (cm)</span>
            <span className="flex gap-1">
              <button className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10" title="Move the isocentre of ALL fields to the crosshair" onClick={() => {
                const s = useStore.getState();
                const p = voxelToPatient(s.ct!.volume, s.cursor).map(Math.round) as Vec3;
                updatePlan({ beams: plan.beams.map((b) => refitIfAuto({ ...b, iso: p })) }, false);
              }}><Crosshair size={12} /> crosshair</button>
              <button className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10" title="Move the isocentre of ALL fields to the target centre" onClick={() => {
                const t = plan.prescription.targetId ?? defaultTarget;
                const c = t ? structureCentre(t) : null;
                if (!c) return toast('Set a target in the prescription first.', 'warn');
                updatePlan({ beams: plan.beams.map((b) => refitIfAuto({ ...b, iso: c })) }, false);
              }}><Target size={12} /> target</button>
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(['x', 'y', 'z'] as const).map((a, i) => (
              <NumberField key={a} label={a.toUpperCase()} value={cm(beam.iso[i])} step={0.1} digits={1} onChange={(v) => { const iso = [...beam.iso] as Vec3; iso[i] = mm(v); geo({ iso }); }} width="w-16" />
            ))}
          </div>
        </div>
        </fieldset>
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-slate-500">
            <span>Jaws at isocentre (cm) · {cm(beam.jaws.x2 - beam.jaws.x1).toFixed(1)} × {cm(beam.jaws.y2 - beam.jaws.y1).toFixed(1)}</span>
            <span>SSD {ssd !== null ? `${cm(ssd).toFixed(1)} cm` : '—'}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
            <JawField label="X1" value={beam.jaws.x1} onChange={(v) => jaws({ x1: v })} onHalf={() => jaws({ x1: 0 })} />
            <JawField label="X2" value={beam.jaws.x2} onChange={(v) => jaws({ x2: v })} onHalf={() => jaws({ x2: 0 })} />
            <JawField label="Y1" value={beam.jaws.y1} onChange={(v) => jaws({ y1: v })} onHalf={() => jaws({ y1: 0 })} />
            <JawField label="Y2" value={beam.jaws.y2} onChange={(v) => jaws({ y2: v })} onHalf={() => jaws({ y2: 0 })} />
          </div>
          <div className="mt-1 text-[10px] text-slate-500">Asymmetric jaws: X1/Y1 are negative coordinates. "½" closes a jaw to the axis (half-beam).</div>
        </div>
        <fieldset disabled={!!parent} className="grid grid-cols-3 gap-2 disabled:opacity-60">
          <Select label="Wedge" value={beam.wedge.type} onChange={(v) => updateBeam(beam.id, { wedge: { ...beam.wedge, type: v as Beam['wedge']['type'], angle: v === 'none' ? 0 : beam.wedge.angle || 30 } })} options={[
            { value: 'none', label: 'None' },
            ...(machine.physicalWedges.length ? [{ value: 'physical', label: 'Physical' }] : []),
            ...(machine.virtualWedge ? [{ value: 'virtual', label: 'Virtual' }] : []),
          ]} />
          {beam.wedge.type !== 'none' && (
            <>
              {beam.wedge.type === 'physical' ? (
                <Select label="°" value={String(beam.wedge.angle)} onChange={(v) => updateBeam(beam.id, { wedge: { ...beam.wedge, angle: +v } })} options={machine.physicalWedges.map((a) => ({ value: String(a), label: `${a}°` }))} />
              ) : (
                <NumberField label="°" value={beam.wedge.angle} onChange={(v) => updateBeam(beam.id, { wedge: { ...beam.wedge, angle: Math.max(5, Math.min(60, Math.round(v))) } })} width="w-14" />
              )}
              <Select<WedgeOrientation> label="Heel" value={beam.wedge.orientation} onChange={(v) => updateBeam(beam.id, { wedge: { ...beam.wedge, orientation: v } })} options={[
                { value: 'left', label: 'X1 side' }, { value: 'right', label: 'X2 side' }, { value: 'in', label: 'Y2 (in)' }, { value: 'out', label: 'Y1 (out)' },
              ]} />
            </>
          )}
        </fieldset>
        {beam.wedge.type === 'physical' && Math.max(beam.jaws.x2 - beam.jaws.x1, beam.jaws.y2 - beam.jaws.y1) > machine.physicalWedgeMaxWidth && (
          <div className="text-[11px] text-amber-300">Field larger than this wedge allows ({cm(machine.physicalWedgeMaxWidth)} cm).</div>
        )}
        <div className="flex items-center gap-2">
          <NumberField label={parent ? 'Segment weight' : 'Weight'} value={beam.weight} step={0.05} min={0} max={10} onChange={(v) => updateBeam(beam.id, { weight: v })} width="w-16" />
          {plan.prescription.normMode === 'none' && (
            <NumberField label={machine.doseUnit === 'min' ? 'Time' : 'MU'} unit={machine.doseUnit === 'min' ? 'min' : ''} value={plan.mu[beam.id] ?? 0} onChange={(v) => updatePlan({ mu: { ...plan.mu, [beam.id]: v } })} width="w-20" />
          )}
        </div>
        {/* Auto MLC */}
        {!parent && <div className="rounded-lg bg-white/[0.03] p-2.5 ring-1 ring-white/5">
          <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
            {machine.mlc ? 'Auto-MLC' : 'Fit jaws to structure'}
            {follows && <Badge tone="green">follows {follows.name} + {beam.autoMlc!.margin} mm</Badge>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="primary" onClick={() => setAutoMlc(true)}>{machine.mlc ? 'Auto-MLC…' : 'Fit jaws…'}</Button>
            {machine.mlc && <Button size="sm" variant="ghost" onClick={() => updateBeam(beam.id, { mlc: openMlc(machine, beam.jaws), autoMlc: null })}>Open leaves</Button>}
          </div>
          {machine.mlc && <div className="mt-1.5 text-[10px] text-slate-500">Or drag inside the field in the BEV to shape the leaves by hand.</div>}
        </div>}
      </div>
      {autoMlc && <AutoMlcDialog beamId={beam.id} onClose={() => setAutoMlc(false)} />}
    </Panel>
  );
}

function JawField({ label, value, onChange, onHalf }: { label: string; value: number; onChange: (mm: number) => void; onHalf: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <NumberField label={label} value={cm(value)} step={0.1} digits={1} onChange={(v) => onChange(mm(v))} width="w-16" />
      <button onClick={onHalf} className="h-7 rounded px-1.5 text-[10px] text-slate-400 ring-1 ring-white/10 hover:bg-white/10" title={`Half-beam: ${label} to 0`}>½</button>
    </div>
  );
}

/** Editable leaf-position table (cm), like a TPS MLC panel. */
export function LeafTable() {
  const plan = useStore((s) => s.plan)?.meta;
  const sel = useStore((s) => s.selectedBeamId);
  const beam = plan?.beams.find((b) => b.id === sel);
  if (!beam) return null;
  const machine = machineById(beam.machineId);
  if (!machine.mlc || !beam.mlc) return null;
  const B = machine.mlc.boundaries;
  const pairs = B.length - 1;
  const setLeaf = (p: number, bank: 'x1' | 'x2', v: number) => {
    const x1 = [...beam.mlc!.x1], x2 = [...beam.mlc!.x2];
    if (bank === 'x1') x1[p] = Math.min(x2[p], mm(v));
    else x2[p] = Math.max(x1[p], mm(v));
    updateBeam(beam.id, { mlc: { x1, x2 }, autoMlc: null });
  };
  return (
    <Panel collapseKey="plan-leaves" defaultOpen={false} className="shrink-0" title={`MLC leaves (${pairs} pairs)`}>
      {(
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-[11px] tabular-nums">
            <thead className="sticky top-0 bg-[#0c111c] text-slate-500">
              <tr><th className="py-1 font-medium">#</th><th className="font-medium">Y (cm)</th><th className="font-medium">X1</th><th className="font-medium">X2</th></tr>
            </thead>
            <tbody>
              {Array.from({ length: pairs }, (_, n) => pairs - 1 - n).map((p) => {
                const inField = B[p + 1] > beam.jaws.y1 && B[p] < beam.jaws.y2;
                return (
                  <tr key={p} className={cx('border-b border-white/[0.03]', !inField && 'opacity-40')}>
                    <td className="py-0.5 text-center text-slate-500">{p + 1}</td>
                    <td className="text-center text-slate-500">{cm((B[p] + B[p + 1]) / 2).toFixed(2)}</td>
                    <td><LeafInput value={cm(beam.mlc!.x1[p])} onChange={(v) => setLeaf(p, 'x1', v)} /></td>
                    <td><LeafInput value={cm(beam.mlc!.x2[p])} onChange={(v) => setLeaf(p, 'x2', v)} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function LeafInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      key={value}
      defaultValue={value.toFixed(1)}
      onBlur={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v !== value) onChange(v); }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className="h-5 w-full bg-transparent text-center text-slate-200 outline-none focus:bg-black/40"
    />
  );
}
