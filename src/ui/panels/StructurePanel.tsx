import { useMemo, useState } from 'react';
import { Eye, EyeOff, Lock, Unlock, Plus, Trash2, ChevronUp, ChevronDown, Crosshair } from 'lucide-react';
import {
  useStore, updateStructure, deleteStructure, moveStructure, setStructureSetStatus, setCursorPatient, voxelToPatient,
} from '../../state/store.ts';
import { Panel, IconBtn, Select, NumberField, Badge, cx, confirmDialog, Button } from '../common.tsx';
import { maskVolumeCc, centroid } from '../../core/maskOps.ts';
import { describeConstraint, newId } from '../../core/templates.ts';
import type { Constraint, StructureMeta, StructureType, ItemStatus } from '../../core/types.ts';
import { AddStructureDialog } from './ContourDialogs.tsx';

export const TYPE_OPTIONS: { value: StructureType; label: string }[] = [
  { value: 'EXTERNAL', label: 'Body / External' },
  { value: 'GTV', label: 'GTV' },
  { value: 'CTV', label: 'CTV' },
  { value: 'ITV', label: 'ITV' },
  { value: 'PTV', label: 'PTV' },
  { value: 'OAR', label: 'Organ at risk' },
  { value: 'AVOIDANCE', label: 'Avoidance' },
  { value: 'BOLUS', label: 'Bolus' },
  { value: 'SUPPORT', label: 'Support (couch)' },
  { value: 'CONTROL', label: 'Control / helper' },
];

const typeTone = (t: StructureType) => (t === 'GTV' || t === 'CTV' || t === 'PTV' || t === 'ITV' ? 'rose' : t === 'EXTERNAL' ? 'amber' : t === 'OAR' ? 'sky' : 'slate');

export function StructurePanel() {
  const ss = useStore((s) => s.ss);
  const ct = useStore((s) => s.ct)!;
  const selectedId = useStore((s) => s.selectedStructureId);
  useStore((s) => s.ssVersion);
  const [adding, setAdding] = useState(false);
  const sel = ss?.meta.structures.find((x) => x.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Panel
        className="min-h-[200px] flex-[1.2]"
        title={ss ? ss.meta.name : 'Structures'}
        actions={
          <>
            {ss && (
              <select
                value={ss.meta.status}
                onChange={(e) => setStructureSetStatus(e.target.value as ItemStatus)}
                className="h-6 rounded bg-black/40 px-1 text-[10px] text-slate-300 ring-1 ring-white/10"
                title="Status of this contoured image"
              >
                <option>In progress</option>
                <option>Completed</option>
                <option>Approved</option>
              </select>
            )}
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              <Plus size={13} /> Add
            </Button>
          </>
        }
      >
        {!ss || !ss.meta.structures.length ? (
          <div className="p-4 text-xs text-slate-500">
            {ss ? 'No structures yet.' : 'Working on the Basic CT scan.'} Add a structure (Body, GTV, CTV, OARs…) to start contouring. A
            <i> Contoured image</i> is created automatically for your work.
          </div>
        ) : (
          <table className="w-full table-fixed text-xs">
            <colgroup><col className="w-7" /><col /><col className="w-[58px]" /><col className="w-[74px]" /><col className="w-[60px]" /></colgroup>
            <tbody>
              {ss.meta.structures.map((st) => {
                const m = ss.masks.get(st.id)!;
                return (
                  <tr
                    key={st.id}
                    onClick={() => useStore.setState({ selectedStructureId: st.id })}
                    className={cx('cursor-pointer border-b border-white/[0.03]', st.id === selectedId ? 'bg-sky-500/10' : 'hover:bg-white/[0.03]')}
                  >
                    <td className="py-1.5 pl-2">
                      <span className="block h-3.5 w-3.5 rounded-sm ring-1 ring-white/20" style={{ background: st.color }} />
                    </td>
                    <td className="truncate py-1.5 pl-1 text-slate-100" title={st.name}>{st.name}</td>
                    <td className="px-1"><Badge tone={typeTone(st.type)}>{st.type === 'EXTERNAL' ? 'Body' : st.type}</Badge></td>
                    <td className="px-1 text-right text-slate-500 tabular-nums">{m.isEmpty() ? '—' : `${maskVolumeCc(m, ct.meta.spacing).toFixed(1)} cc`}</td>
                    <td className="pr-1 text-right whitespace-nowrap">
                      <span onClick={(e) => e.stopPropagation()} className="inline-flex">
                        <IconBtn title={st.visible ? 'Hide' : 'Show'} onClick={() => updateStructure(st.id, { visible: !st.visible })}>
                          {st.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                        </IconBtn>
                        <IconBtn title={st.locked ? 'Unlock' : 'Lock (prevent edits)'} onClick={() => updateStructure(st.id, { locked: !st.locked })}>
                          {st.locked ? <Lock size={13} /> : <Unlock size={13} className="opacity-40" />}
                        </IconBtn>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
      {sel && <StructureProperties st={sel} />}
      {sel && <SliceList id={sel.id} />}
      {adding && <AddStructureDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function StructureProperties({ st }: { st: StructureMeta }) {
  const ct = useStore((s) => s.ct)!;
  const [tab, setTab] = useState<'props' | 'tol'>('props');
  return (
    <Panel
      className="flex-[1.3]"
      title={
        <span className="flex gap-1">
          <button className={cx('rounded px-1.5', tab === 'props' ? 'bg-white/10 text-slate-200' : '')} onClick={() => setTab('props')}>Properties</button>
          <button className={cx('rounded px-1.5', tab === 'tol' ? 'bg-white/10 text-slate-200' : '')} onClick={() => setTab('tol')}>Tolerance doses ({st.constraints.length})</button>
        </span>
      }
      actions={
        <>
          <IconBtn title="Move up" onClick={() => moveStructure(st.id, -1)}><ChevronUp size={14} /></IconBtn>
          <IconBtn title="Move down" onClick={() => moveStructure(st.id, 1)}><ChevronDown size={14} /></IconBtn>
          <IconBtn title="Go to centre of structure" onClick={() => {
            const m = useStore.getState().ss!.masks.get(st.id)!;
            const c = centroid(m);
            if (c) setCursorPatient(voxelToPatient(ct.volume, c));
          }}><Crosshair size={14} /></IconBtn>
          <IconBtn title="Delete structure" danger onClick={async () => {
            if (await confirmDialog('Delete structure', `Delete ${st.name}?`, 'Delete', true)) deleteStructure(st.id);
          }}><Trash2 size={14} /></IconBtn>
        </>
      }
    >
      {tab === 'props' ? (
        <div className="space-y-2.5 p-3">
          <div className="flex items-center gap-2">
            <input type="color" value={st.color} onChange={(e) => updateStructure(st.id, { color: e.target.value })} className="h-7 w-9 cursor-pointer rounded bg-transparent" title="Colour" />
            <input
              value={st.name}
              onChange={(e) => updateStructure(st.id, { name: e.target.value })}
              className="h-7 flex-1 rounded-md bg-black/40 px-2 text-sm text-slate-100 ring-1 ring-white/10 outline-none focus:ring-sky-400/60"
            />
          </div>
          <Select label="Type" value={st.type} onChange={(v) => updateStructure(st.id, { type: v, densityOverride: v === 'BOLUS' ? st.densityOverride ?? 1 : st.densityOverride })} options={TYPE_OPTIONS} />
          <div className="flex flex-wrap gap-3">
            <NumberField label="α/β" unit="Gy" value={st.alphaBeta} step={0.5} min={0.5} max={20} onChange={(v) => updateStructure(st.id, { alphaBeta: v })} width="w-20" />
            <label className="flex items-center gap-1.5 text-xs text-slate-400">
              <input type="checkbox" checked={st.densityOverride !== null} onChange={(e) => updateStructure(st.id, { densityOverride: e.target.checked ? 1 : null })} className="accent-sky-500" />
              Density override
            </label>
            {st.densityOverride !== null && (
              <NumberField value={st.densityOverride} step={0.05} min={0} max={3} onChange={(v) => updateStructure(st.id, { densityOverride: v })} unit="ρe" width="w-20" />
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-slate-500">
            Body defines where dose is calculated. Bolus structures are added to it (density 1.0). A density override replaces the CT value inside the structure (e.g. contrast, prostheses).
          </p>
        </div>
      ) : (
        <ConstraintEditor st={st} />
      )}
    </Panel>
  );
}

function ConstraintEditor({ st }: { st: StructureMeta }) {
  const set = (list: Constraint[]) => updateStructure(st.id, { constraints: list });
  const upd = (id: string, patch: Partial<Constraint>) => set(st.constraints.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-1.5 p-3">
      {st.constraints.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-1.5 rounded-md bg-white/[0.03] p-1.5 ring-1 ring-white/5">
          <select value={c.metric} onChange={(e) => upd(c.id, { metric: e.target.value as Constraint['metric'], param: e.target.value === 'V' ? 20 : e.target.value === 'D' ? 2 : undefined, paramUnit: e.target.value === 'V' ? 'Gy' : e.target.value === 'D' ? '%' : undefined })} className="h-6 rounded bg-black/40 px-1 text-[11px] ring-1 ring-white/10">
            <option value="Dmax">Dmax</option>
            <option value="Dmean">Dmean</option>
            <option value="Dmin">Dmin</option>
            <option value="V">V(dose)</option>
            <option value="D">D(volume)</option>
          </select>
          {(c.metric === 'V' || c.metric === 'D') && (
            <>
              <NumberField value={c.param ?? 0} onChange={(v) => upd(c.id, { param: v })} width="w-14" />
              <select value={c.paramUnit} onChange={(e) => upd(c.id, { paramUnit: e.target.value as Constraint['paramUnit'] })} className="h-6 rounded bg-black/40 px-1 text-[11px] ring-1 ring-white/10">
                {c.metric === 'V' ? (<><option value="Gy">Gy</option><option value="%Rx">% Rx</option></>) : (<><option value="%">%</option><option value="cc">cc</option></>)}
              </select>
            </>
          )}
          <select value={c.cmp} onChange={(e) => upd(c.id, { cmp: e.target.value as '<' | '>' })} className="h-6 rounded bg-black/40 px-1 text-[11px] ring-1 ring-white/10">
            <option value="<">≤</option>
            <option value=">">≥</option>
          </select>
          <NumberField value={c.limit} onChange={(v) => upd(c.id, { limit: v })} width="w-14" />
          <select value={c.limitUnit} onChange={(e) => upd(c.id, { limitUnit: e.target.value as Constraint['limitUnit'] })} className="h-6 rounded bg-black/40 px-1 text-[11px] ring-1 ring-white/10">
            {c.metric === 'V' ? (<><option value="%">%</option><option value="cc">cc</option></>) : (<><option value="Gy">Gy</option><option value="%Rx">% Rx</option></>)}
          </select>
          <button onClick={() => upd(c.id, { priority: c.priority === 'mandatory' ? 'optimal' : 'mandatory' })} title="Mandatory constraints must pass; optimal ones are goals">
            <Badge tone={c.priority === 'mandatory' ? 'rose' : 'slate'}>{c.priority}</Badge>
          </button>
          <span className="ml-auto" />
          <IconBtn title="Remove" danger onClick={() => set(st.constraints.filter((x) => x.id !== c.id))}><Trash2 size={12} /></IconBtn>
          {c.note && <div className="w-full text-[10px] text-slate-500">{c.note}</div>}
        </div>
      ))}
      {!st.constraints.length && <div className="text-xs text-slate-500">No tolerance doses. Add constraints to check them in Evaluation.</div>}
      <div className="flex gap-1.5 pt-1">
        <Button size="sm" onClick={() => set([...st.constraints, { id: newId('c'), metric: 'Dmax', limit: 45, limitUnit: 'Gy', cmp: '<', priority: 'mandatory' }])}><Plus size={12} /> Dmax</Button>
        <Button size="sm" onClick={() => set([...st.constraints, { id: newId('c'), metric: 'Dmean', limit: 20, limitUnit: 'Gy', cmp: '<', priority: 'mandatory' }])}><Plus size={12} /> Dmean</Button>
        <Button size="sm" onClick={() => set([...st.constraints, { id: newId('c'), metric: 'V', param: 20, paramUnit: 'Gy', limit: 30, limitUnit: '%', cmp: '<', priority: 'mandatory' }])}><Plus size={12} /> Vx</Button>
        <Button size="sm" onClick={() => set([...st.constraints, { id: newId('c'), metric: 'D', param: 95, paramUnit: '%', limit: 95, limitUnit: '%Rx', cmp: '>', priority: 'mandatory' }])}><Plus size={12} /> Dx</Button>
      </div>
      <div className="pt-1 text-[10px] text-slate-500">{st.constraints.map(describeConstraint).join(' · ')}</div>
    </div>
  );
}

/** Which slices hold this structure; click to go there. */
function SliceList({ id }: { id: string }) {
  const ct = useStore((s) => s.ct)!;
  const cursorK = useStore((s) => Math.round(s.cursor[2]));
  const v = useStore((s) => s.ssVersion);
  const m = useStore.getState().ss?.masks.get(id);
  const slices = useMemo(() => {
    if (!m) return [];
    const out: number[] = [];
    for (let k = 0; k < m.nz; k++) if (m.hasSlice(k)) out.push(k);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, v]);
  const nz = ct.meta.dims[2];
  return (
    <Panel className="min-h-[90px] flex-[0.55]" title={`Slices (${slices.length}/${nz})`}>
      <div className="flex flex-wrap gap-0.5 p-2">
        {Array.from({ length: nz }, (_, k) => nz - 1 - k).map((k) => {
          const has = slices.includes(k);
          return (
            <button
              key={k}
              title={`Slice ${k + 1} · z ${((ct.meta.origin[2] + k * ct.meta.spacing[2]) / 10).toFixed(2)} cm`}
              onClick={() => useStore.setState((s) => ({ cursor: [s.cursor[0], s.cursor[1], k] }))}
              className={cx('h-3 w-3 rounded-[2px]', k === cursorK ? 'ring-2 ring-sky-300' : '', has ? 'bg-emerald-400/80' : 'bg-white/[0.06] hover:bg-white/20')}
            />
          );
        })}
      </div>
    </Panel>
  );
}
