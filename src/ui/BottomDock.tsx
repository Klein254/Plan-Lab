// The patient-data sub-window: Basic CT scan(s) → Contoured image(s) → Plans, with open / rename / save-as / delete.
import { useState } from 'react';
import { ScanLine, Layers, Target, ChevronDown, ChevronUp, Pencil, Copy, Trash2, FolderOpen, Plus } from 'lucide-react';
import {
  useStore, openImageSet, openStructureSet, openPlan, renameItem, createStructureSet, deleteStructureSetById, deletePlanById,
  duplicatePlan, confirmDiscard, withBusy, toast,
} from '../state/store.ts';
import { cx, Badge, confirmDialog, promptDialog } from './common.tsx';
import type { ItemStatus } from '../core/types.ts';

const statusTone = (s: ItemStatus) => (s === 'Approved' ? 'green' : s === 'Completed' ? 'sky' : 'amber');
const date = (iso: string) => new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function Card({ icon, title, subtitle, active, dirty, status, onOpen, actions }: {
  icon: React.ReactNode; title: string; subtitle: string; active: boolean; dirty?: boolean; status?: ItemStatus; onOpen: () => void;
  actions: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }[];
}) {
  return (
    <div
      className={cx(
        'group relative flex w-56 shrink-0 cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2 ring-1 transition-colors',
        active ? 'bg-sky-500/10 ring-sky-400/50' : 'bg-white/[0.03] ring-white/[0.07] hover:bg-white/[0.06]',
      )}
      onClick={onOpen}
      title={`Open ${title}`}
    >
      <div className={cx('mt-0.5', active ? 'text-sky-300' : 'text-slate-500')}>{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-slate-100">{title}</span>
          {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Unsaved changes" />}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-500">
          <span className="truncate">{subtitle}</span>
          {status && <Badge tone={statusTone(status)}>{status}</Badge>}
        </div>
      </div>
      <div className="absolute top-1 right-1 hidden gap-0.5 rounded-md bg-[#0b111c] p-0.5 shadow ring-1 ring-white/10 group-hover:flex">
        {actions.map((a) => (
          <button
            key={a.label}
            title={a.label}
            aria-label={a.label}
            onClick={(e) => {
              e.stopPropagation();
              a.onClick();
            }}
            className={cx('grid h-6 w-6 place-items-center rounded', a.danger ? 'text-rose-300 hover:bg-rose-500/20' : 'text-slate-400 hover:bg-white/10 hover:text-white')}
          >
            {a.icon}
          </button>
        ))}
      </div>
    </div>
  );
}

export function BottomDock() {
  const [open, setOpen] = useState(true);
  const patient = useStore((s) => s.patient)!;
  const ct = useStore((s) => s.ct);
  const ss = useStore((s) => s.ss);
  const plan = useStore((s) => s.plan);
  const ssName = (id: string) => patient.structureSets.find((x) => x.id === id)?.name ?? '';

  const rename = async (kind: 'ct' | 'ss' | 'plan', id: string, current: string) => {
    const name = await promptDialog('Rename', 'New name:', current, 'Rename');
    if (name && name !== current) await withBusy('Renaming…', () => renameItem(kind, id, name));
  };

  return (
    <div className="no-print shrink-0 border-t border-white/[0.06] bg-[#090e17]">
      <button onClick={() => setOpen((o) => !o)} className="flex h-7 w-full items-center gap-2 px-3 text-[11px] font-semibold tracking-wider text-slate-500 uppercase hover:text-slate-300">
        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        Patient data
        <span className="font-normal tracking-normal text-slate-600 normal-case">
          · {patient.imageSets.length} image set{patient.imageSets.length === 1 ? '' : 's'}, {patient.structureSets.length} contoured, {patient.plans.length} plan{patient.plans.length === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div className="flex gap-2 overflow-x-auto px-3 pb-2.5">
          {patient.imageSets.map((img) => (
            <Card
              key={img.id}
              icon={<ScanLine size={16} />}
              title={img.name}
              subtitle={`${img.dims[2]} slices · ${img.spacing[2].toFixed(1)} mm`}
              active={ct?.meta.id === img.id && !ss}
              onOpen={async () => {
                if (!(await confirmDiscard())) return;
                useStore.setState({ ss: null, plan: null, dose: null });
                await withBusy('Loading images…', () => openImageSet(img.id));
                if (useStore.getState().module === 'patients') useStore.setState({ module: 'contour' });
              }}
              actions={[
                { icon: <Plus size={13} />, label: 'New contoured image from this scan', onClick: async () => {
                  if (!(await confirmDiscard())) return;
                  useStore.setState({ ss: null, plan: null, dose: null });
                  await withBusy('Loading…', async () => {
                    await openImageSet(img.id);
                    await createStructureSet();
                  });
                  useStore.setState({ module: 'contour' });
                } },
                { icon: <Pencil size={13} />, label: 'Rename', onClick: () => rename('ct', img.id, img.name) },
              ]}
            />
          ))}
          {patient.structureSets.length > 0 && <div className="mx-1 w-px shrink-0 bg-white/[0.06]" />}
          {[...patient.structureSets].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((x) => (
            <Card
              key={x.id}
              icon={<Layers size={16} />}
              title={x.name}
              subtitle={`Modified ${date(x.modifiedAt)}`}
              status={ss?.meta.id === x.id ? ss.meta.status : x.status}
              active={ss?.meta.id === x.id}
              dirty={ss?.meta.id === x.id && ss.dirty}
              onOpen={async () => {
                if (ss?.meta.id === x.id) return;
                await withBusy('Loading contours…', () => openStructureSet(x.id));
                if (useStore.getState().module === 'patients') useStore.setState({ module: 'contour' });
              }}
              actions={[
                { icon: <FolderOpen size={13} />, label: 'Open', onClick: () => withBusy('Loading contours…', () => openStructureSet(x.id)) },
                { icon: <Copy size={13} />, label: 'Save a copy as…', onClick: async () => {
                  if (ss?.meta.id !== x.id) await withBusy('Loading…', () => openStructureSet(x.id));
                  const name = await promptDialog('Save a copy', 'Name for the new contoured image:', `${x.name} copy`, 'Save copy');
                  if (name) await withBusy('Copying…', async () => { await createStructureSet({ name, copyFrom: true }); toast(`Saved as "${name}".`, 'success'); });
                } },
                { icon: <Pencil size={13} />, label: 'Rename', onClick: () => rename('ss', x.id, x.name) },
                { icon: <Trash2 size={13} />, label: 'Delete', danger: true, onClick: async () => {
                  const plans = patient.plans.filter((p) => p.structureSetId === x.id).length;
                  if (await confirmDialog('Delete contoured image', `Delete "${x.name}"${plans ? ` and its ${plans} plan(s)` : ''}? This can't be undone.`, 'Delete', true))
                    await withBusy('Deleting…', () => deleteStructureSetById(x.id));
                } },
              ]}
            />
          ))}
          {patient.plans.length > 0 && <div className="mx-1 w-px shrink-0 bg-white/[0.06]" />}
          {[...patient.plans].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((p) => (
            <Card
              key={p.id}
              icon={<Target size={16} />}
              title={p.name}
              subtitle={`on ${ssName(p.structureSetId)}`}
              status={plan?.meta.id === p.id ? plan.meta.status : p.status}
              active={plan?.meta.id === p.id}
              dirty={plan?.meta.id === p.id && plan.dirty}
              onOpen={async () => {
                await openPlan(p.id);
                const m = useStore.getState().module;
                if (m === 'patients' || m === 'contour') useStore.setState({ module: 'plan' });
              }}
              actions={[
                { icon: <Copy size={13} />, label: 'Save a copy as…', onClick: async () => {
                  await openPlan(p.id);
                  const name = await promptDialog('Save a copy', 'Name for the new plan:', `${p.name} copy`, 'Save copy');
                  if (name) await withBusy('Copying plan…', async () => { await duplicatePlan(name); toast(`Saved as "${name}".`, 'success'); });
                } },
                { icon: <Pencil size={13} />, label: 'Rename', onClick: () => rename('plan', p.id, p.name) },
                { icon: <Trash2 size={13} />, label: 'Delete', danger: true, onClick: async () => {
                  if (await confirmDialog('Delete plan', `Delete "${p.name}"? This can't be undone.`, 'Delete', true)) await withBusy('Deleting…', () => deletePlanById(p.id));
                } },
              ]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
