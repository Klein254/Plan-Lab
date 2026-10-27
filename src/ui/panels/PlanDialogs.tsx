import { useMemo, useState } from 'react';
import { useStore, createPlan, updatePlan, updateBeam, machineById, withBusy, toast, saveStructureSet } from '../../state/store.ts';
import { TECHNIQUES, templateBeams, structureCentre, ssdOf, refitIfAuto, type Technique } from '../../state/planTools.ts';
import { Modal, Button, NumberField, Select, TextField, Toggle, Badge } from '../common.tsx';
import { TARGET_TYPES, type NormMode, type Vec3 } from '../../core/types.ts';
import { matchingAngles } from '../../core/bev.ts';

export function NewPlanDialog({ onClose }: { onClose: () => void }) {
  const ss = useStore((s) => s.ss)!;
  const lib = useStore((s) => s.lib);
  const cursor = useStore((s) => s.cursor);
  const ct = useStore((s) => s.ct)!;
  const targets = ss.meta.structures.filter((x) => TARGET_TYPES.includes(x.type) && !ss.masks.get(x.id)!.isEmpty());
  const ptv = targets.find((x) => x.type === 'PTV') ?? targets[targets.length - 1];
  const hasBody = ss.meta.structures.some((x) => x.type === 'EXTERNAL' && !ss.masks.get(x.id)!.isEmpty());
  const [name, setName] = useState('Plan 1');
  const [machineId, setMachineId] = useState(lib.machines[0].id);
  const machine = lib.machines.find((m) => m.id === machineId)!;
  const [energy, setEnergy] = useState(machine.energies[0].name);
  const [technique, setTechnique] = useState<Technique>('box4');
  const [targetId, setTargetId] = useState<string>(ptv?.id ?? '');
  const [margin, setMargin] = useState(7);
  const [isoAt, setIsoAt] = useState<'target' | 'cursor'>(ptv ? 'target' : 'cursor');
  const [dose, setDose] = useState(50);
  const [fx, setFx] = useState(25);
  const [res, setRes] = useState(3);
  const [het, setHet] = useState(true);

  const checks = useMemo(() => {
    const types = new Set(ss.meta.structures.filter((x) => !ss.masks.get(x.id)!.isEmpty()).map((x) => x.type));
    return [
      { ok: hasBody, text: 'Body (external) contour' },
      { ok: types.has('GTV'), text: 'GTV', optional: true },
      { ok: types.has('CTV'), text: 'CTV (incl. nodal CTVn if needed)', optional: true },
      { ok: types.has('PTV'), text: 'PTV' },
      { ok: types.has('OAR'), text: 'Organs at risk', optional: true },
    ];
  }, [ss, hasBody]);

  const create = async () => {
    if (ss.dirty) await saveStructureSet();
    await withBusy('Creating plan…', async () => {
      const iso: Vec3 = isoAt === 'target' && targetId ? structureCentre(targetId)! : ([
        ct.volume.origin[0] + cursor[0] * ct.volume.spacing[0], ct.volume.origin[1] + cursor[1] * ct.volume.spacing[1], ct.volume.origin[2] + cursor[2] * ct.volume.spacing[2],
      ].map(Math.round) as Vec3);
      const beams = templateBeams(technique, machine, energy, iso, targetId || null, margin);
      await createPlan({
        name, structureSetId: ss.meta.id, imageSetId: ct.meta.id, technique: TECHNIQUES.find((t) => t.value === technique)!.label,
        prescription: { totalDose: dose, fractions: fx, targetId: targetId || null, normMode: 'isocentre', normPercent: 100, refPointId: null },
        beams, refPoints: [], doseResolution: res, heterogeneity: het, notes: '',
      });
      useStore.setState({ module: 'plan' });
    });
    onClose();
  };

  return (
    <Modal title="New plan" onClose={onClose} width="max-w-2xl" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!hasBody} onClick={create}>Create plan</Button></>}>
      <div className="grid gap-5 md:grid-cols-[1fr_220px]">
        <div className="space-y-3">
          <TextField label="Plan name" value={name} onChange={setName} autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <Select label="Machine" value={machineId} onChange={(v) => { setMachineId(v); setEnergy(lib.machines.find((m) => m.id === v)!.energies[0].name); }} options={lib.machines.map((m) => ({ value: m.id, label: m.name }))} />
            <Select label="Energy" value={energy} onChange={setEnergy} options={machine.energies.map((e) => ({ value: e.name, label: e.name }))} />
          </div>
          <Select<Technique> label="Technique" value={technique} onChange={setTechnique} options={TECHNIQUES.map((t) => ({ value: t.value, label: t.label }))} />
          <div className="text-[11px] text-slate-500">{TECHNIQUES.find((t) => t.value === technique)?.hint}</div>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Target" value={targetId} onChange={setTargetId} options={[{ value: '', label: '— none —' }, ...targets.map((t) => ({ value: t.id, label: t.name }))]} />
            <NumberField label="Beam margin (BEV)" unit="mm" value={margin} onChange={setMargin} min={0} max={30} width="w-20" />
          </div>
          <Select<'target' | 'cursor'> label="Isocentre" value={isoAt} onChange={setIsoAt} options={[{ value: 'target', label: 'Centre of the target' }, { value: 'cursor', label: 'Crosshair position' }]} />
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="Dose" unit="Gy" value={dose} onChange={setDose} min={0.5} max={120} width="w-20" />
            <NumberField label="Fractions" value={fx} onChange={(v) => setFx(Math.round(v))} min={1} max={60} width="w-16" />
            <div className="self-center text-xs text-slate-400">{(dose / Math.max(1, fx)).toFixed(2)} Gy/fx</div>
          </div>
          <div className="flex items-center gap-4">
            <Select label="Dose grid" value={String(res)} onChange={(v) => setRes(+v)} options={[2, 2.5, 3, 4, 5].map((r) => ({ value: String(r), label: `${r} mm` }))} className="w-36" />
            <Toggle checked={het} onChange={setHet} label="Heterogeneity correction" />
          </div>
        </div>
        <div className="rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/5">
          <div className="mb-2 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Volumes ready?</div>
          <ul className="space-y-1.5 text-xs">
            {checks.map((c) => (
              <li key={c.text} className="flex items-center gap-2">
                <Badge tone={c.ok ? 'green' : c.optional ? 'amber' : 'rose'}>{c.ok ? '✓' : c.optional ? '?' : '✗'}</Badge>
                <span className={c.ok ? 'text-slate-300' : 'text-slate-500'}>{c.text}</span>
              </li>
            ))}
          </ul>
          {!hasBody && <p className="mt-3 text-[11px] text-rose-300">A Body contour is required: dose is only calculated inside it (Anatomical Model → Auto-seg → Body).</p>}
          <p className="mt-3 text-[11px] text-slate-500">Plans use the contoured image "{ss.meta.name}". Changes saved there show up in the plan.</p>
        </div>
      </div>
    </Modal>
  );
}

export function PrescriptionDialog({ onClose }: { onClose: () => void }) {
  const plan = useStore((s) => s.plan)!.meta;
  const ss = useStore((s) => s.ss)!;
  const [rx, setRx] = useState(plan.prescription);
  const targets = ss.meta.structures.filter((x) => TARGET_TYPES.includes(x.type));
  const apply = () => {
    updatePlan({ prescription: rx });
    onClose();
  };
  return (
    <Modal title="Prescription & normalisation" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={apply}>Apply</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <NumberField label="Total dose" unit="Gy" value={rx.totalDose} onChange={(v) => setRx({ ...rx, totalDose: v })} min={0.1} max={150} width="w-20" />
          <NumberField label="Fractions" value={rx.fractions} onChange={(v) => setRx({ ...rx, fractions: Math.max(1, Math.round(v)) })} min={1} max={60} width="w-16" />
          <div className="self-center text-xs text-slate-400">{(rx.totalDose / rx.fractions).toFixed(2)} Gy per fraction</div>
        </div>
        <Select label="Target" value={rx.targetId ?? ''} onChange={(v) => setRx({ ...rx, targetId: v || null })} options={[{ value: '', label: '— none —' }, ...targets.map((t) => ({ value: t.id, label: t.name }))]} />
        <Select<NormMode> label="Normalise" value={rx.normMode} onChange={(v) => setRx({ ...rx, normMode: v })} options={[
          { value: 'isocentre', label: 'To the isocentre (ICRU reference point)' },
          { value: 'refPoint', label: 'To a reference point' },
          { value: 'targetMean', label: 'Target mean dose' },
          { value: 'targetMedian', label: 'Target median dose (D50%)' },
          { value: 'targetD95', label: 'Target D95% (95% of the target covered)' },
          { value: 'none', label: 'None: enter MU manually' },
        ]} />
        {rx.normMode === 'refPoint' && (
          <Select label="Point" value={rx.refPointId ?? ''} onChange={(v) => setRx({ ...rx, refPointId: v || null })} options={[{ value: '', label: '— choose —' }, ...plan.refPoints.map((r) => ({ value: r.id, label: r.name }))]} />
        )}
        {rx.normMode !== 'none' && <NumberField label="…equals this % of the prescription" unit="%" value={rx.normPercent} onChange={(v) => setRx({ ...rx, normPercent: v })} min={50} max={130} width="w-24" />}
        <p className="text-[11px] text-slate-500">Beam weights set how much each beam contributes at the normalisation point. MU are recalculated instantly; the dose distribution doesn't need recalculating.</p>
      </div>
    </Modal>
  );
}

export function FieldMatchDialog({ onClose }: { onClose: () => void }) {
  const plan = useStore((s) => s.plan)!.meta;
  const selectedBeamId = useStore((s) => s.selectedBeamId);
  const opts = plan.beams.map((b) => ({ value: b.id, label: b.name }));
  const [a, setA] = useState(selectedBeamId ?? plan.beams[0]?.id ?? '');
  const [b, setB] = useState(plan.beams.find((x) => x.id !== a)?.id ?? '');
  const beamA = plan.beams.find((x) => x.id === a);
  const beamB = plan.beams.find((x) => x.id === b);
  const lenB = beamB ? beamB.jaws.y2 - beamB.jaws.y1 : 0;
  const sad = beamA ? machineById(beamA.machineId).sad : 1000;
  const ssdB = beamB ? ssdOf(beamB) : null;
  const kick = matchingAngles(lenB, sad).couchKickDeg;
  const collCsi = ssdB ? (Math.atan(lenB / 2 / ssdB) * 180) / Math.PI : 0;

  const halfBeam = (id: string, jaw: 'x1' | 'x2' | 'y1' | 'y2') => {
    const beam = plan.beams.find((x) => x.id === id)!;
    updateBeam(id, refitIfAuto({ ...beam, jaws: { ...beam.jaws, [jaw]: 0 } }));
    // If auto-MLC re-shaped the jaw again, keep the half-beam jaw at 0
    const after = useStore.getState().plan!.meta.beams.find((x) => x.id === id)!;
    if (after.jaws[jaw] !== 0) updateBeam(id, { jaws: { ...after.jaws, [jaw]: 0 } });
    toast(`${beam.name}: ${jaw.toUpperCase()} jaw set to 0 (half-beam block).`, 'success');
  };

  return (
    <Modal title="Field matching" onClose={onClose} width="max-w-xl" footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <Select label="Beam A" value={a} onChange={setA} options={opts} />
          <Select label="Beam B" value={b} onChange={setB} options={opts} />
        </div>
        <section className="rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/5">
          <div className="font-medium text-slate-200">Half-beam block (independent jaw at the central axis)</div>
          <p className="mt-0.5 text-xs text-slate-500">Removes divergence on one side, so two fields can share a non-divergent edge through the isocentre.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(['y1', 'y2', 'x1', 'x2'] as const).map((j) => (
              <Button key={j} size="sm" disabled={!beamA} onClick={() => halfBeam(a, j)}>A: {j.toUpperCase()} → 0</Button>
            ))}
          </div>
        </section>
        <section className="rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/5">
          <div className="font-medium text-slate-200">Mono-isocentric match (e.g. tangents + supraclavicular)</div>
          <p className="mt-0.5 text-xs text-slate-500">Puts B on A's isocentre, closes A's superior half (Y2 = 0) and B's inferior half (Y1 = 0): the match line runs through the isocentre with no divergence.</p>
          <Button size="sm" className="mt-2" disabled={!beamA || !beamB || a === b} onClick={() => {
            updateBeam(a, { jaws: { ...beamA!.jaws, y2: 0 }, autoMlc: null });
            updateBeam(b, { iso: [...beamA!.iso] as Vec3, jaws: { ...beamB!.jaws, y1: 0 }, autoMlc: null });
            toast('Mono-isocentric match applied.', 'success');
          }}>Apply</Button>
        </section>
        <section className="rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/5">
          <div className="font-medium text-slate-200">Couch kick to match B's divergence</div>
          <p className="mt-0.5 text-xs text-slate-500">
            Couch angle for A so its edge follows the divergent edge of B: θ = atan(½·L / SAD) with L = B's field length ({(lenB / 10).toFixed(1)} cm) → <b className="text-slate-200">{kick.toFixed(1)}°</b>
          </p>
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" disabled={!beamA} onClick={() => updateBeam(a, refitIfAuto({ ...beamA!, couch: +kick.toFixed(1) }))}>Couch +{kick.toFixed(1)}°</Button>
            <Button size="sm" disabled={!beamA} onClick={() => updateBeam(a, refitIfAuto({ ...beamA!, couch: +(360 - kick).toFixed(1) }))}>Couch −{kick.toFixed(1)}°</Button>
          </div>
        </section>
        <section className="rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/5">
          <div className="font-medium text-slate-200">Collimator rotation for craniospinal junction</div>
          <p className="mt-0.5 text-xs text-slate-500">
            Rotate the cranial lateral field A to follow the spinal field B's superior divergence: θ = atan(½·L / SSD) with L = {(lenB / 10).toFixed(1)} cm, SSD = {ssdB ? `${(ssdB / 10).toFixed(1)} cm` : '—'} → <b className="text-slate-200">{collCsi.toFixed(1)}°</b>.
            Combine with a couch kick ({kick.toFixed(1)}° from A's own length) to match the cranial divergence.
          </p>
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" disabled={!beamA || !ssdB} onClick={() => updateBeam(a, refitIfAuto({ ...beamA!, collimator: +collCsi.toFixed(1) }))}>Collimator +{collCsi.toFixed(1)}°</Button>
            <Button size="sm" disabled={!beamA || !ssdB} onClick={() => updateBeam(a, refitIfAuto({ ...beamA!, collimator: +(360 - collCsi).toFixed(1) }))}>Collimator −{collCsi.toFixed(1)}°</Button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
