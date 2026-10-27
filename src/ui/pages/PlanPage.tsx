import { useState } from 'react';
import {
  Plus, Calculator, Scissors, Maximize, SplitSquareHorizontal, Crosshair, MapPin, ClipboardList, LayoutGrid, Box, Rows3, Copy, CheckCircle2, AlertTriangle, FileOutput, FilePlus2,
} from 'lucide-react';
import { useStore, calculateDose, doseIsStale, updatePlan, addBeams, machineById, toast, voxelToPatient, openPlan, recomputeMU, fieldsMissingNormPoint } from '../../state/store.ts';
import { conformBeam, makeBeam, refitIfAuto } from '../../state/planTools.ts';
import { ToolButton, ToolGroup, Panel, Button, Select, Toggle, Badge, cx, promptDialog } from '../common.tsx';
import { SliceView } from '../views/SliceView.tsx';
import { View3D } from '../views/View3D.tsx';
import { BEVView } from '../views/BEVView.tsx';
import { ViewGrid } from '../views/ViewGrid.tsx';
import { BeamList, BeamEditor, LeafTable } from '../panels/BeamPanel.tsx';
import { NewPlanDialog, PrescriptionDialog, FieldMatchDialog } from '../panels/PlanDialogs.tsx';
import { openMlc } from '../../core/bev.ts';
import { newId } from '../../core/templates.ts';
import { exportRtDose } from '../../core/dicom/export.ts';
import { saveBytes, safeName } from '../files.ts';
import type { Vec3 } from '../../core/types.ts';
import { isodoseColor } from '../render.ts';

type Layout = 'bev' | 'slices' | 'bev3d';

export function PlanPage() {
  const ss = useStore((s) => s.ss);
  const plan = useStore((s) => s.plan);
  const patient = useStore((s) => s.patient)!;
  const dose = useStore((s) => s.dose);
  const calc = useStore((s) => s.calc);
  const dd = useStore((s) => s.doseDisplay);
  const sel = useStore((s) => s.selectedBeamId);
  useStore((s) => s.planVersion);
  const [dialog, setDialog] = useState<'new' | 'rx' | 'match' | null>(null);
  const [layout, setLayout] = useState<Layout>('bev');

  if (!ss) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-slate-400">
        <div>
          <div className="text-base font-semibold text-slate-200">No contoured image open</div>
          <p className="mt-2">Plans are built on a contoured image. Contour the Body, targets and OARs in the Anatomical Model first, or open an existing contoured image from the bottom panel.</p>
          <Button className="mt-4" variant="primary" onClick={() => useStore.setState({ module: 'contour' })}>Go to Anatomical Model</Button>
        </div>
      </div>
    );
  }

  if (!plan) {
    const plans = patient.plans.filter((p) => p.structureSetId === ss.meta.id);
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="w-full max-w-lg rounded-xl bg-[#0c111c] p-6 ring-1 ring-white/[0.06]">
          <div className="text-base font-semibold text-slate-100">Plans on "{ss.meta.name}"</div>
          <ul className="mt-3 space-y-1.5">
            {plans.map((p) => (
              <li key={p.id}>
                <button onClick={() => openPlan(p.id)} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ring-1 ring-white/10 hover:bg-white/5">
                  <span className="text-slate-100">{p.name}</span>
                  <Badge tone={p.status === 'Approved' ? 'green' : 'amber'}>{p.status}</Badge>
                </button>
              </li>
            ))}
            {!plans.length && <li className="text-sm text-slate-500">No plans yet.</li>}
          </ul>
          <Button className="mt-4 w-full" variant="primary" onClick={() => setDialog('new')}><Plus size={15} /> New plan</Button>
        </div>
        {dialog === 'new' && <NewPlanDialog onClose={() => setDialog(null)} />}
      </div>
    );
  }

  const meta = plan.meta;
  const beam = meta.beams.find((b) => b.id === sel);
  const stale = doseIsStale();
  const unit = meta.beams[0] ? machineById(meta.beams[0].machineId).doseUnit : 'MU';
  const totalMu = meta.beams.reduce((a, b) => a + (meta.mu[b.id] ?? 0), 0);

  const addAtCrosshair = () => {
    const s = useStore.getState();
    const iso = beam?.iso ?? (voxelToPatient(s.ct!.volume, s.cursor).map(Math.round) as Vec3);
    const machine = machineById(beam?.machineId ?? s.lib.machines[0].id);
    const nb = makeBeam(machine, 0, iso, beam?.energy);
    addBeams([meta.prescription.targetId ? conformBeam(nb, meta.prescription.targetId, 7) : nb]);
  };

  const views = {
    bev: { id: 'bev', render: () => <BEVView /> },
    axial: { id: 'axial', render: (m: () => void, x: boolean) => <SliceView plane="axial" mode="plan" onMaximize={m} maximized={x} /> },
    sagittal: { id: 'sagittal', render: (m: () => void, x: boolean) => <SliceView plane="sagittal" mode="plan" onMaximize={m} maximized={x} /> },
    coronal: { id: 'coronal', render: (m: () => void, x: boolean) => <SliceView plane="coronal" mode="plan" onMaximize={m} maximized={x} /> },
    d3: { id: '3d', render: (m: () => void, x: boolean) => <View3D mode="plan" onMaximize={m} maximized={x} /> },
  };
  const items = layout === 'bev' ? [views.bev, views.axial, views.sagittal, views.coronal] : layout === 'slices' ? [views.axial, views.sagittal, views.coronal, views.d3] : [views.bev, views.axial, views.d3];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="no-print flex shrink-0 items-stretch overflow-x-auto border-b border-white/[0.06] bg-[#0a0f19] px-1 py-1">
        <ToolGroup title="Plan">
          <ToolButton icon={<FilePlus2 size={18} />} label="New plan" onClick={() => setDialog('new')} title="Create another plan on this contoured image" />
        </ToolGroup>
        <ToolGroup title="Fields">
          <ToolButton icon={<Plus size={18} />} label="Add field" onClick={addAtCrosshair} title="Add an AP field at the current isocentre" />
          <ToolButton icon={<Copy size={18} />} label="Duplicate" disabled={!beam} onClick={() => beam && addBeams([{ ...beam, id: newId('b'), name: `${beam.name} copy`, mlc: beam.mlc ? { x1: [...beam.mlc.x1], x2: [...beam.mlc.x2] } : null }])} />
        </ToolGroup>
        <ToolGroup title="Shape">
          <ToolButton icon={<Scissors size={18} />} label="Auto-MLC" disabled={!beam || !meta.prescription.targetId} onClick={() => {
            if (!beam || !meta.prescription.targetId) return;
            updatePlan({ beams: meta.beams.map((b) => (b.id === beam.id ? conformBeam(b, meta.prescription.targetId!, b.autoMlc?.margin ?? 7) : b)) }, false);
          }} title="Fit MLC + jaws of the selected field to the target (+7 mm)" accent="text-amber-300" />
          <ToolButton icon={<Maximize size={18} />} label="Open MLC" disabled={!beam} onClick={() => beam && updatePlan({ beams: meta.beams.map((b) => (b.id === beam.id ? { ...b, mlc: openMlc(machineById(b.machineId), b.jaws), autoMlc: null } : b)) }, false)} />
          <ToolButton icon={<SplitSquareHorizontal size={18} />} label="Match" onClick={() => setDialog('match')} title="Half-beam blocking and field matching" />
        </ToolGroup>
        <ToolGroup title="Points">
          <ToolButton icon={<Crosshair size={18} />} label="Iso → cross" onClick={() => {
            const s = useStore.getState();
            const p = voxelToPatient(s.ct!.volume, s.cursor).map(Math.round) as Vec3;
            updatePlan({ beams: meta.beams.map((b) => refitIfAuto({ ...b, iso: p })) }, false);
            toast('Isocentre moved to the crosshair (all fields).');
          }} title="Move the isocentre of all fields to the crosshair" />
          <ToolButton icon={<MapPin size={18} />} label="Ref point" onClick={async () => {
            const s = useStore.getState();
            const name = await promptDialog('Reference point', 'Name for a reference point at the crosshair:', `Point ${meta.refPoints.length + 1}`, 'Add');
            if (name) updatePlan({ refPoints: [...meta.refPoints, { id: newId('r'), name, pos: voxelToPatient(s.ct!.volume, s.cursor).map((v) => Math.round(v * 10) / 10) as Vec3 }] }, false);
          }} title="Add a dose reference point at the crosshair" />
        </ToolGroup>
        <ToolGroup title="Dose">
          <ToolButton icon={<ClipboardList size={18} />} label="Prescribe" onClick={() => setDialog('rx')} title="Prescription and normalisation" />
          <ToolButton icon={<Calculator size={18} />} label={calc ? 'Running…' : 'Calculate'} disabled={!!calc} onClick={() => calculateDose()} title="Calculate 3D dose (only changed fields are recalculated)" accent={stale ? 'text-amber-300' : 'text-emerald-300'} />
          <ToolButton icon={<FileOutput size={18} />} label="RTDOSE" disabled={!dose?.total} onClick={async () => {
            const s = useStore.getState();
            if (!s.dose?.total || !s.patient || !s.ct) return;
            const bytes = exportRtDose(s.patient.info, s.ct.meta, s.dose.grid, s.dose.total, meta.name);
            if (await saveBytes(`RD_${safeName(s.patient.info.name)}_${safeName(meta.name)}.dcm`, bytes, { name: 'DICOM', extensions: ['dcm'] })) toast('RT Dose exported.', 'success');
          }} title="Export the dose as DICOM RT Dose" />
        </ToolGroup>
        <ToolGroup title="Layout">
          <ToolButton icon={<Rows3 size={18} />} label="BEV" active={layout === 'bev'} onClick={() => setLayout('bev')} />
          <ToolButton icon={<LayoutGrid size={18} />} label="Slices" active={layout === 'slices'} onClick={() => setLayout('slices')} />
          <ToolButton icon={<Box size={18} />} label="BEV + 3D" active={layout === 'bev3d'} onClick={() => setLayout('bev3d')} />
        </ToolGroup>
      </div>
      {/* Dose bar */}
      <div className="no-print flex h-9 shrink-0 items-center gap-4 border-b border-white/[0.06] bg-[#0b1019] px-3 text-xs">
        <span className={cx('flex items-center gap-1.5', !dose ? 'text-slate-500' : stale ? 'text-amber-300' : 'text-emerald-300')}>
          {dose && !stale ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          {!dose ? 'Not calculated' : stale ? 'Dose out of date: recalculate' : `Dose OK · max ${dose.maxDose.toFixed(2)} Gy (${((100 * dose.maxDose) / meta.prescription.totalDose).toFixed(1)}%)`}
        </span>
        <span className="text-slate-500">Rx {meta.prescription.totalDose} Gy / {meta.prescription.fractions}# · total {totalMu.toFixed(unit === 'min' ? 2 : 0)} {unit} per fraction</span>
        <Select<typeof dd.mode> label="Display" value={dd.mode} onChange={(v) => useStore.setState((s) => ({ doseDisplay: { ...s.doseDisplay, mode: v } }))} options={[
          { value: 'lines', label: 'Isodose lines' }, { value: 'wash', label: 'Colour wash' }, { value: 'both', label: 'Both' }, { value: 'off', label: 'Off' },
        ]} className="w-40" />
        <div className="flex items-center gap-0.5">
          {[110, 107, 105, 100, 95, 90, 80, 70, 50, 30, 10].map((l) => {
            const on = dd.levels.includes(l);
            return (
              <button
                key={l}
                onClick={() => useStore.setState((s) => ({ doseDisplay: { ...s.doseDisplay, levels: on ? s.doseDisplay.levels.filter((x) => x !== l) : [...s.doseDisplay.levels, l].sort((a, b) => b - a) } }))}
                className={cx('h-6 rounded px-1.5 text-[10px] tabular-nums', on ? 'text-black' : 'bg-white/5 text-slate-500')}
                style={on ? { background: isodoseColor(l) } : undefined}
                title={`${l}% isodose`}
              >
                {l}
              </button>
            );
          })}
        </div>
        <Select label="Grid" value={String(meta.doseResolution)} onChange={(v) => updatePlan({ doseResolution: +v }, false)} options={[2, 2.5, 3, 4, 5].map((r) => ({ value: String(r), label: `${r} mm` }))} className="w-28" />
        <Toggle checked={meta.heterogeneity} onChange={(v) => updatePlan({ heterogeneity: v }, false)} label="Heterogeneity" />
        {(() => {
          const miss = fieldsMissingNormPoint();
          return miss.length ? (
            <span className="flex items-center gap-1 text-amber-300" title="The normalisation point is in the penumbra or outside these fields, so their MU are unreliable. Normalise to a reference point well inside every field, or to the target mean.">
              <AlertTriangle size={14} /> Norm. point at the edge of: {miss.join(', ')}
            </span>
          ) : null;
        })()}
        <button className="ml-auto text-slate-500 hover:text-slate-300" onClick={() => recomputeMU()} title="Recompute MU from weights and prescription">Recompute MU</button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_360px] gap-2 p-2">
        <ViewGrid main={layout !== 'slices' ? 'left' : undefined} items={items} />
        <div className="flex min-h-0 flex-col gap-2 overflow-auto">
          <BeamList />
          <BeamEditor />
          <LeafTable />
          <Panel title="Plan">
            <div className="space-y-2 p-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-500">Status</span>
                <select value={meta.status} onChange={(e) => updatePlan({ status: e.target.value as typeof meta.status }, false)} className="h-6 rounded bg-black/40 px-1 text-[11px] ring-1 ring-white/10">
                  <option>In progress</option><option>Completed</option><option>Approved</option>
                </select>
                <span className="ml-auto text-slate-500">{meta.technique}</span>
              </div>
              {meta.refPoints.length > 0 && (
                <ul className="space-y-0.5">
                  {meta.refPoints.map((r) => (
                    <li key={r.id} className="flex items-center justify-between">
                      <span className="text-slate-300">{r.name}</span>
                      <button className="text-slate-500 hover:text-rose-300" onClick={() => updatePlan({ refPoints: meta.refPoints.filter((x) => x.id !== r.id) }, false)}>remove</button>
                    </li>
                  ))}
                </ul>
              )}
              <textarea
                value={meta.notes}
                onChange={(e) => updatePlan({ notes: e.target.value }, false)}
                placeholder="Planning notes (rationale, beam arrangement, issues…)"
                className="h-16 w-full resize-none rounded-md bg-black/40 p-2 text-xs ring-1 ring-white/10 outline-none focus:ring-sky-400/60"
              />
            </div>
          </Panel>
        </div>
      </div>
      {dialog === 'new' && <NewPlanDialog onClose={() => setDialog(null)} />}
      {dialog === 'rx' && <PrescriptionDialog onClose={() => setDialog(null)} />}
      {dialog === 'match' && <FieldMatchDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
