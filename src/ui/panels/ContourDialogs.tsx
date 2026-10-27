import { useMemo, useState } from 'react';
import { useStore, addStructure, replaceMask, withBusy, toast, editMask } from '../../state/store.ts';
import { Modal, Button, NumberField, Select, TextField, Toggle, cx } from '../common.tsx';
import { SITES } from '../../core/templates.ts';
import { applyMargins, autoBody, autoLungs, booleanOp, thresholdMask, uniformMargins, type BoolOp, type Margins } from '../../core/maskOps.ts';
import type { StructureType } from '../../core/types.ts';
import { TYPE_OPTIONS } from './StructurePanel.tsx';

export function AddStructureDialog({ onClose }: { onClose: () => void }) {
  const lib = useStore((s) => s.lib.structures);
  const current = useStore((s) => s.ss?.meta.structures);
  const existing = useMemo(() => current?.map((x) => x.name) ?? [], [current]);
  const [site, setSite] = useState<string>('Targets');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [custom, setCustom] = useState({ name: '', type: 'OAR' as StructureType, color: '#22c55e' });
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return lib.filter((x) => (t ? x.name.toLowerCase().includes(t) : x.site === site));
  }, [lib, site, q]);

  const add = async () => {
    for (const key of picked) {
      const t = lib.find((x) => x.key === key)!;
      await addStructure({ name: t.name, color: t.color, type: t.type, templateKey: t.key });
    }
    if (custom.name.trim()) await addStructure({ name: custom.name.trim(), color: custom.color, type: custom.type });
    onClose();
  };

  return (
    <Modal
      title="Add structures"
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!picked.size && !custom.name.trim()} onClick={add}>
            Add {picked.size + (custom.name.trim() ? 1 : 0) || ''}
          </Button>
        </>
      }
    >
      <div className="flex gap-4">
        <div className="w-36 shrink-0 space-y-0.5">
          {SITES.map((s) => (
            <button key={s} onClick={() => { setSite(s); setQ(''); }} className={cx('block w-full rounded-md px-2.5 py-1.5 text-left text-sm', site === s && !q ? 'bg-sky-500/15 text-sky-200' : 'text-slate-400 hover:bg-white/5')}>
              {s}
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all organs…" className="mb-2 h-8 w-full rounded-md bg-black/40 px-3 text-sm ring-1 ring-white/10 outline-none focus:ring-sky-400/60" />
          <div className="grid max-h-80 grid-cols-2 gap-1 overflow-auto">
            {list.map((t) => {
              const on = picked.has(t.key);
              const has = existing.includes(t.name);
              return (
                <button
                  key={t.key}
                  onClick={() => setPicked((p) => { const n = new Set(p); if (n.has(t.key)) n.delete(t.key); else n.add(t.key); return n; })}
                  className={cx('flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ring-1', on ? 'bg-sky-500/15 ring-sky-400/50' : 'ring-white/5 hover:bg-white/5')}
                >
                  <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: t.color }} />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  {has && <span className="text-[10px] text-slate-500">exists</span>}
                  {t.constraints.length > 0 && <span className="text-[10px] text-slate-500" title="Has tolerance doses">{t.constraints.length} tol.</span>}
                </button>
              );
            })}
          </div>
          <div className="mt-4 rounded-lg bg-white/[0.02] p-3 ring-1 ring-white/5">
            <div className="mb-2 text-xs font-medium text-slate-400">Or a custom structure</div>
            <div className="flex items-end gap-2">
              <input type="color" value={custom.color} onChange={(e) => setCustom({ ...custom, color: e.target.value })} className="h-9 w-10 rounded bg-transparent" />
              <TextField value={custom.name} onChange={(v) => setCustom({ ...custom, name: v })} placeholder="Name, e.g. CTV_LN_pelvic" className="flex-1" />
              <Select value={custom.type} onChange={(v) => setCustom({ ...custom, type: v })} options={TYPE_OPTIONS} className="w-44" />
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function MarginDialog({ onClose }: { onClose: () => void }) {
  const ss = useStore((s) => s.ss)!;
  const ct = useStore((s) => s.ct)!;
  const sel = useStore((s) => s.selectedStructureId);
  const structures = ss.meta.structures;
  const [source, setSource] = useState(sel ?? structures[0]?.id ?? '');
  const [target, setTarget] = useState<string>('__new__');
  const [newName, setNewName] = useState('PTV');
  const [newType, setNewType] = useState<StructureType>('PTV');
  const [uniform, setUniform] = useState(true);
  const [mm, setMm] = useState(5);
  const [m, setM] = useState<Margins>(uniformMargins(5));
  const [cropBody, setCropBody] = useState(0);
  const body = structures.find((x) => x.type === 'EXTERNAL');

  const run = async () => {
    await withBusy('Applying margin…', async () => {
      const src = ss.masks.get(source)!;
      if (src.isEmpty()) throw new Error('The source structure is empty.');
      let out = applyMargins(src, ct.meta.spacing, uniform ? uniformMargins(mm) : m);
      if (body && cropBody > 0) {
        const inner = applyMargins(ss.masks.get(body.id)!, ct.meta.spacing, uniformMargins(-cropBody));
        out = booleanOp(out, inner, 'intersect');
      } else if (body && cropBody === 0 && newType !== 'EXTERNAL') {
        // Keep expansions inside the patient
        out = booleanOp(out, ss.masks.get(body.id)!, 'intersect');
      }
      let id = target;
      if (target === '__new__') {
        const tpl = useStore.getState().lib.structures.find((x) => x.name.toLowerCase() === newName.trim().toLowerCase());
        id = await addStructure({ name: newName.trim() || 'Expanded', type: newType, color: tpl?.color, templateKey: tpl?.key });
      }
      replaceMask(id, out, `Margin ${uniform ? mm : 'anisotropic'} mm`);
      toast('Margin applied.', 'success');
    });
    onClose();
  };

  const opts = structures.map((x) => ({ value: x.id, label: x.name }));
  const dir = (k: keyof Margins, label: string) => <NumberField label={label} unit="mm" value={m[k]} onChange={(v) => setM({ ...m, [k]: v })} min={-50} max={100} width="w-20" />;
  return (
    <Modal title="Margins (expand / contract)" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={run}>Apply</Button></>}>
      <div className="space-y-3">
        <Select label="From" value={source} onChange={setSource} options={opts} />
        <Select label="Result into" value={target} onChange={setTarget} options={[{ value: '__new__', label: '＋ New structure' }, ...opts]} />
        {target === '__new__' && (
          <div className="flex gap-2">
            <TextField value={newName} onChange={setNewName} className="flex-1" />
            <Select value={newType} onChange={setNewType} options={TYPE_OPTIONS} className="w-44" />
          </div>
        )}
        <Toggle checked={uniform} onChange={setUniform} label="Same margin in every direction" />
        {uniform ? (
          <NumberField label="Margin" unit="mm" value={mm} onChange={setMm} min={-50} max={100} width="w-24" />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {dir('right', 'Right')}{dir('left', 'Left')}{dir('ant', 'Anterior')}{dir('post', 'Posterior')}{dir('sup', 'Superior')}{dir('inf', 'Inferior')}
          </div>
        )}
        {body && <NumberField label="Keep this far inside the skin (0 = just inside Body)" unit="mm" value={cropBody} onChange={setCropBody} min={0} max={20} width="w-20" />}
        <p className="text-[11px] text-slate-500">Typical: GTV → CTV 5–10 mm, CTV → PTV 5–10 mm (larger sup/inf when slices are thick). Negative values shrink.</p>
      </div>
    </Modal>
  );
}

export function BooleanDialog({ onClose }: { onClose: () => void }) {
  const ss = useStore((s) => s.ss)!;
  const ct = useStore((s) => s.ct)!;
  const structures = ss.meta.structures;
  const opts = structures.map((x) => ({ value: x.id, label: x.name }));
  const [a, setA] = useState(structures[0]?.id ?? '');
  const [b, setB] = useState(structures[1]?.id ?? structures[0]?.id ?? '');
  const [op, setOp] = useState<BoolOp>('union');
  const [marginB, setMarginB] = useState(0);
  const [target, setTarget] = useState('__new__');
  const [name, setName] = useState('Combined');
  const run = async () => {
    await withBusy('Combining structures…', async () => {
      let mb = ss.masks.get(b)!;
      if (marginB) mb = applyMargins(mb, ct.meta.spacing, uniformMargins(marginB));
      const out = booleanOp(ss.masks.get(a)!, mb, op);
      const id = target === '__new__' ? await addStructure({ name: name.trim() || 'Combined', type: 'CONTROL' }) : target;
      replaceMask(id, out, `Boolean ${op}`);
    });
    onClose();
  };
  return (
    <Modal title="Boolean operations" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={run}>Apply</Button></>}>
      <div className="space-y-3">
        <Select label="A" value={a} onChange={setA} options={opts} />
        <Select<BoolOp> label="Operation" value={op} onChange={setOp} options={[
          { value: 'union', label: 'A ∪ B (union, e.g. Lungs = Lung R ∪ Lung L)' },
          { value: 'intersect', label: 'A ∩ B (overlap)' },
          { value: 'subtract', label: 'A − B (e.g. PTV − Rectum, or "PTV crop")' },
          { value: 'xor', label: 'A ⊕ B (either, not both)' },
        ]} />
        <Select label="B" value={b} onChange={setB} options={opts} />
        <NumberField label="Expand B first by" unit="mm" value={marginB} onChange={setMarginB} min={-30} max={50} width="w-20" />
        <Select label="Result into" value={target} onChange={setTarget} options={[{ value: '__new__', label: '＋ New structure' }, ...opts]} />
        {target === '__new__' && <TextField value={name} onChange={setName} />}
      </div>
    </Modal>
  );
}

export function AutoSegDialog({ onClose }: { onClose: () => void }) {
  const ct = useStore((s) => s.ct)!;
  const [lo, setLo] = useState(200);
  const [hi, setHi] = useState(3000);
  const [thName, setThName] = useState('Bones');
  const [bodyThr, setBodyThr] = useState(-350);
  const lib = useStore((s) => s.lib.structures);
  const tpl = (key: string) => lib.find((x) => x.key === key);

  const intoStructure = async (key: string, fallbackName: string, type: StructureType) => {
    const ss = useStore.getState().ss;
    const t = tpl(key);
    const existing = ss?.meta.structures.find((x) => x.templateKey === key || x.name === (t?.name ?? fallbackName));
    return existing?.id ?? addStructure({ name: t?.name ?? fallbackName, type: t?.type ?? type, color: t?.color, templateKey: t?.key });
  };
  const bodyMask = () => {
    const ss = useStore.getState().ss;
    const b = ss?.meta.structures.find((x) => x.type === 'EXTERNAL');
    return b ? ss!.masks.get(b.id)! : null;
  };

  const run = (label: string, fn: () => Promise<void>) => withBusy(label, async () => { await fn(); toast(`${label.replace('…', '')} done.`, 'success'); });

  return (
    <Modal title="Auto-segmentation" onClose={onClose} width="max-w-xl" footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-3 text-sm">
        <Row title="Body (external contour)" text="Thresholds the CT, keeps the patient (not the couch) and fills holes, slice by slice.">
          <NumberField label="HU >" value={bodyThr} onChange={setBodyThr} width="w-20" />
          <Button size="sm" variant="primary" onClick={() => run('Segmenting body…', async () => {
            const m = autoBody(ct.volume, bodyThr);
            replaceMask(await intoStructure('body', 'Body', 'EXTERNAL'), m, 'Auto body');
          })}>Run</Button>
        </Row>
        <Row title="Lungs (right and left)" text="Air-density regions inside the Body, split at the midline. Needs the Body first.">
          <Button size="sm" variant="primary" onClick={() => run('Segmenting lungs…', async () => {
            const body = bodyMask();
            if (!body || body.isEmpty()) throw new Error('Segment the Body first.');
            const { right, left } = autoLungs(ct.volume, body);
            if (right.isEmpty() && left.isEmpty()) throw new Error('No lungs found in this scan.');
            replaceMask(await intoStructure('lung_r', 'Lung R', 'OAR'), right, 'Auto lung R');
            replaceMask(await intoStructure('lung_l', 'Lung L', 'OAR'), left, 'Auto lung L');
          })}>Run</Button>
        </Row>
        <Row title="Threshold structure" text="Everything inside the Body within an HU range: bones (200–3000), fat (−150 to −50), air (−1000 to −400)…">
          <NumberField label="from" value={lo} onChange={setLo} width="w-20" />
          <NumberField label="to" value={hi} onChange={setHi} width="w-20" />
          <input value={thName} onChange={(e) => setThName(e.target.value)} className="h-7 w-24 rounded-md bg-black/40 px-2 text-xs ring-1 ring-white/10" />
          <Button size="sm" variant="primary" onClick={() => run('Thresholding…', async () => {
            const m = thresholdMask(ct.volume, lo, hi, bodyMask());
            const t = lib.find((x) => x.name.toLowerCase() === thName.trim().toLowerCase());
            const id = t ? await intoStructure(t.key, t.name, t.type) : await addStructure({ name: thName.trim() || 'Threshold', type: 'OAR' });
            replaceMask(id, m, 'Threshold');
          })}>Run</Button>
        </Row>
        <p className="text-[11px] text-slate-500">
          Auto-contours are a starting point: always review every slice. For organs without a clear HU contrast, draw a few key slices and use
          <b> Interpolate</b> and <b>Adapt</b> in the toolbar.
        </p>
      </div>
    </Modal>
  );
}

function Row({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/5">
      <div className="font-medium text-slate-200">{title}</div>
      <div className="mt-0.5 text-xs text-slate-500">{text}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Copies the selected structure's current slice to a neighbouring slice. */
export function copySlice(dir: 1 | -1) {
  const s = useStore.getState();
  const id = s.selectedStructureId;
  const m = id ? s.ss?.masks.get(id) : null;
  if (!id || !m) return;
  const k = Math.round(s.cursor[2]);
  const src = m.slices[k];
  if (!src) {
    toast('Nothing on this slice to copy.', 'warn');
    return;
  }
  const kk = k + dir;
  if (kk < 0 || kk >= m.nz) return;
  editMask(id, [kk], 'Copy slice', (mm) => { mm.slices[kk] = src.slice(); });
  useStore.setState({ cursor: [s.cursor[0], s.cursor[1], kk] });
}
