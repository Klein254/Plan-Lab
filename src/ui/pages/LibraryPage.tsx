import { useState } from 'react';
import { Plus, Trash2, RotateCcw } from 'lucide-react';
import { useStore, updateLibrary, toast } from '../../state/store.ts';
import { Panel, Button, NumberField, Select, TextField, cx, IconBtn, confirmDialog } from '../common.tsx';
import { STRUCTURE_LIBRARY, SITES, describeConstraint, newId, type StructureTemplate } from '../../core/templates.ts';
import { DEFAULT_MACHINES, pdd, tmr, type EnergyModel, type Machine } from '../../core/machines.ts';
import { DEFAULT_HU_CURVE } from '../../core/dose/densityGrid.ts';
import { TYPE_OPTIONS } from '../panels/StructurePanel.tsx';
import type { Constraint } from '../../core/types.ts';

type Tab = 'structures' | 'machines' | 'ct' | 'settings' | 'help';

export function LibraryPage() {
  const [tab, setTab] = useState<Tab>('structures');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'structures', label: 'Structures & tolerance doses' },
    { id: 'machines', label: 'Machines & beam data' },
    { id: 'ct', label: 'CT calibration' },
    { id: 'settings', label: 'Settings' },
    { id: 'help', label: 'Help' },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 gap-1 border-b border-white/[0.06] bg-[#0a0f19] px-3 py-1.5">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cx('rounded-md px-3 py-1.5 text-[13px]', tab === t.id ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5')}>{t.label}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'structures' && <StructuresTab />}
        {tab === 'machines' && <MachinesTab />}
        {tab === 'ct' && <CtTab />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'help' && <HelpTab />}
      </div>
    </div>
  );
}

function StructuresTab() {
  const lib = useStore((s) => s.lib.structures);
  const [site, setSite] = useState<string>('Pelvis');
  const [selKey, setSelKey] = useState<string | null>(null);
  const list = lib.filter((x) => x.site === site);
  const sel = lib.find((x) => x.key === selKey) ?? null;
  const save = (next: StructureTemplate[]) => void updateLibrary({ structures: next });
  const upd = (key: string, patch: Partial<StructureTemplate>) => save(lib.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  return (
    <div className="grid h-full grid-cols-[160px_minmax(260px,1fr)_minmax(360px,1.3fr)] gap-3">
      <Panel title="Site">
        {SITES.map((s) => (
          <button key={s} onClick={() => setSite(s)} className={cx('block w-full px-3 py-1.5 text-left text-sm', site === s ? 'bg-sky-500/10 text-sky-200' : 'text-slate-400 hover:bg-white/5')}>{s}</button>
        ))}
      </Panel>
      <Panel title={`${site} (${list.length})`} actions={
        <>
          <IconBtn title="Add a structure to the library" onClick={() => {
            const key = newId('u');
            save([...lib, { key, name: 'New structure', color: '#22c55e', type: 'OAR', site: site as StructureTemplate['site'], alphaBeta: 3, constraints: [] }]);
            setSelKey(key);
          }}><Plus size={14} /></IconBtn>
          <IconBtn title="Reset the library to the defaults" onClick={async () => {
            if (await confirmDialog('Reset library', 'Restore the default structures and tolerance doses? Your edits to the library will be lost (patients are not affected).', 'Reset', true)) save(STRUCTURE_LIBRARY);
          }}><RotateCcw size={14} /></IconBtn>
        </>
      }>
        {list.map((t) => (
          <button key={t.key} onClick={() => setSelKey(t.key)} className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm', selKey === t.key ? 'bg-sky-500/10' : 'hover:bg-white/5')}>
            <span className="h-3 w-3 rounded-sm" style={{ background: t.color }} />
            <span className="flex-1 truncate">{t.name}</span>
            <span className="text-[10px] text-slate-500">{t.constraints.length ? `${t.constraints.length} tol.` : ''}</span>
          </button>
        ))}
      </Panel>
      <Panel title={sel ? sel.name : 'Details'} actions={sel && <IconBtn title="Remove from library" danger onClick={() => { save(lib.filter((x) => x.key !== sel.key)); setSelKey(null); }}><Trash2 size={14} /></IconBtn>}>
        {sel ? (
          <div className="space-y-3 p-3">
            <div className="flex items-center gap-2">
              <input type="color" value={sel.color} onChange={(e) => upd(sel.key, { color: e.target.value })} className="h-8 w-10 rounded bg-transparent" />
              <TextField value={sel.name} onChange={(v) => upd(sel.key, { name: v })} className="flex-1" />
            </div>
            <div className="flex gap-3">
              <Select label="Type" value={sel.type} onChange={(v) => upd(sel.key, { type: v })} options={TYPE_OPTIONS} className="flex-1" />
              <NumberField label="α/β" unit="Gy" value={sel.alphaBeta} onChange={(v) => upd(sel.key, { alphaBeta: v })} width="w-20" />
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">Tolerance doses (conventional fractionation)</div>
              {sel.constraints.map((c, n) => (
                <div key={n} className="flex items-center gap-2 border-b border-white/5 py-1 text-xs">
                  <span className="flex-1 text-slate-200">{describeConstraint({ ...c, id: '' } as Constraint)}</span>
                  <NumberField value={c.limit} onChange={(v) => upd(sel.key, { constraints: sel.constraints.map((x, k) => (k === n ? { ...x, limit: v } : x)) })} width="w-16" />
                  <span className="text-[10px] text-slate-500">{c.priority}</span>
                  <IconBtn title="Remove" danger onClick={() => upd(sel.key, { constraints: sel.constraints.filter((_, k) => k !== n) })}><Trash2 size={12} /></IconBtn>
                </div>
              ))}
              <div className="mt-2 flex gap-1.5">
                <Button size="sm" onClick={() => upd(sel.key, { constraints: [...sel.constraints, { metric: 'Dmax', limit: 45, limitUnit: 'Gy', cmp: '<', priority: 'mandatory' }] })}><Plus size={12} />Dmax</Button>
                <Button size="sm" onClick={() => upd(sel.key, { constraints: [...sel.constraints, { metric: 'Dmean', limit: 20, limitUnit: 'Gy', cmp: '<', priority: 'mandatory' }] })}><Plus size={12} />Dmean</Button>
                <Button size="sm" onClick={() => upd(sel.key, { constraints: [...sel.constraints, { metric: 'V', param: 20, paramUnit: 'Gy', limit: 30, limitUnit: '%', cmp: '<', priority: 'mandatory' }] })}><Plus size={12} />Vx</Button>
              </div>
              <p className="mt-3 text-[11px] text-slate-500">New structures added from the library get these tolerance doses. Existing contoured images keep their own copies (edit them in the Anatomical Model).</p>
            </div>
          </div>
        ) : <div className="p-3 text-xs text-slate-500">Select a structure.</div>}
      </Panel>
    </div>
  );
}

function MachinesTab() {
  const machines = useStore((s) => s.lib.machines);
  const [mid, setMid] = useState(machines[0].id);
  const m = machines.find((x) => x.id === mid) ?? machines[0];
  const [eName, setEName] = useState(m.energies[0].name);
  const e = m.energies.find((x) => x.name === eName) ?? m.energies[0];
  const saveM = (next: Machine) => void updateLibrary({ machines: machines.map((x) => (x.id === next.id ? next : x)) });
  const updE = (patch: Partial<EnergyModel>) => saveM({ ...m, energies: m.energies.map((x) => (x.name === e.name ? { ...x, ...patch } : x)) });
  const num = (label: string, key: keyof EnergyModel, step = 0.001, unit?: string) => (
    <NumberField label={label} unit={unit} value={e[key] as number} step={step} onChange={(v) => updE({ [key]: v } as Partial<EnergyModel>)} width="w-24" />
  );
  return (
    <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
      <Panel title="Machines" actions={<IconBtn title="Restore default machines" onClick={async () => { if (await confirmDialog('Reset machines', 'Restore the default machine data?', 'Reset', true)) { await updateLibrary({ machines: DEFAULT_MACHINES }); toast('Machines reset.'); } }}><RotateCcw size={14} /></IconBtn>}>
        {machines.map((x) => (
          <button key={x.id} onClick={() => { setMid(x.id); setEName(x.energies[0].name); }} className={cx('block w-full px-3 py-2 text-left text-sm', x.id === m.id ? 'bg-sky-500/10' : 'hover:bg-white/5')}>
            <div className="text-slate-100">{x.name}</div>
            <div className="text-[11px] text-slate-500">{x.energies.map((q) => q.name).join(', ')} · SAD {x.sad / 10} cm · {x.mlc ? x.mlc.name : 'no MLC'}</div>
          </button>
        ))}
      </Panel>
      <div className="space-y-3">
        <Panel title={m.name}>
          <div className="flex flex-wrap items-center gap-4 p-3 text-xs">
            <TextField label="Name" value={m.name} onChange={(v) => saveM({ ...m, name: v })} className="w-64" />
            <div className="text-slate-400">Max field {m.maxField.x / 10} × {m.maxField.y / 10} cm · jaw transmission {(m.jawTransmission * 100).toFixed(1)}% · MLC transmission {m.mlc ? `${(m.mlc.transmission * 100).toFixed(1)}%` : '—'} · wedges {m.physicalWedges.join('/')}°{m.virtualWedge ? ' + virtual' : ''}</div>
            {m.cobalt && (
              <label className="flex items-center gap-2 text-slate-400">Source calibration date
                <input type="date" value={m.cobalt.calibrationDate} onChange={(ev) => saveM({ ...m, cobalt: { ...m.cobalt!, calibrationDate: ev.target.value } })} className="h-7 rounded bg-black/40 px-2 ring-1 ring-white/10" />
              </label>
            )}
          </div>
        </Panel>
        <Panel title="Beam data model" actions={<Select value={e.name} onChange={setEName} options={m.energies.map((q) => ({ value: q.name, label: q.name }))} className="w-28" />}>
          <div className="grid gap-4 p-3 xl:grid-cols-[1fr_1fr]">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 self-start">
              {num('dmax', 'dmax', 0.1, 'cm')}
              {num(m.doseUnit === 'min' ? 'Output cGy/min' : 'Output cGy/MU', 'output', 0.01)}
              {num('μ (1/cm)', 'mu')}
              {num('β (1/cm²)', 'beta', 0.0001)}
              {num('Field-size coef.', 'fsCoef', 0.01)}
              {num('Surface dose', 'surfaceDose', 0.01)}
              {num('Sc slope', 'scA', 0.001)}
              {num('Sp slope', 'spA', 0.001)}
              {num('Penumbra σ', 'sigma0', 0.1, 'mm')}
              {num('σ per cm depth', 'sigmaPerCm', 0.01, 'mm')}
              {num('Scatter weight', 'scatterW0', 0.005)}
              {num('Scatter σ', 'scatterSigma', 1, 'mm')}
              {num('Horns', 'horn', 0.005)}
            </div>
            <PddPlot m={m} e={e} />
          </div>
          <p className="px-3 pb-3 text-[11px] text-slate-500">
            TMR(d, s) = exp(−k·(μ·x + β·x²)), x = d − dmax, with k decreasing for larger fields; build-up from the surface dose to dmax. Penumbra and out-of-field
            dose come from Gaussian kernels whose width grows with depth. Changing beam data invalidates calculated doses (plans will ask to recalculate).
          </p>
        </Panel>
      </div>
    </div>
  );
}

function PddPlot({ m, e }: { m: Machine; e: EnergyModel }) {
  const W = 420, H = 240, L = 36, B = 26, T = 8, R = 8;
  const fields = [5, 10, 20, 30];
  const colors = ['#38bdf8', '#facc15', '#4ade80', '#f472b6'];
  const ssd = m.sad / 10;
  const x = (d: number) => L + (d / 30) * (W - L - R);
  const y = (v: number) => T + (1 - v / 110) * (H - T - B);
  return (
    <div>
      <div className="mb-1 text-[11px] text-slate-400">PDD at SSD {ssd} cm · TMR(10, 10×10) = {tmr(e, 10, 10).toFixed(3)} · PDD(10, 10×10) = {pdd(m, e, 10, 10).toFixed(1)}%</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded bg-black/30">
        {[0, 20, 40, 60, 80, 100].map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="rgba(148,163,184,0.12)" /><text x={L - 4} y={y(v) + 3} fontSize="9" fill="#94a3b8" textAnchor="end">{v}</text></g>)}
        {[0, 5, 10, 15, 20, 25, 30].map((d) => <g key={d}><line x1={x(d)} x2={x(d)} y1={T} y2={H - B} stroke="rgba(148,163,184,0.12)" /><text x={x(d)} y={H - B + 12} fontSize="9" fill="#94a3b8" textAnchor="middle">{d}</text></g>)}
        <text x={(W + L) / 2} y={H - 4} fontSize="9" fill="#94a3b8" textAnchor="middle">Depth (cm)</text>
        {fields.map((f, n) => (
          <polyline key={f} fill="none" stroke={colors[n]} strokeWidth={1.5} points={Array.from({ length: 121 }, (_, i) => i * 0.25).map((d) => `${x(d)},${y(pdd(m, e, d, f, ssd))}`).join(' ')} />
        ))}
        {fields.map((f, n) => <text key={f} x={W - R - 4} y={T + 12 + n * 12} fontSize="10" fill={colors[n]} textAnchor="end">{f}×{f} cm</text>)}
      </svg>
    </div>
  );
}

function CtTab() {
  const curve = useStore((s) => s.lib.huCurve);
  const save = (c: typeof curve) => void updateLibrary({ huCurve: [...c].sort((a, b) => a[0] - b[0]) });
  const W = 420, H = 240, L = 36, B = 26;
  const x = (h: number) => L + ((h + 1000) / 4000) * (W - L - 8);
  const y = (d: number) => 8 + (1 - d / 2.8) * (H - 8 - B);
  return (
    <div className="grid gap-3 lg:grid-cols-[360px_1fr]">
      <Panel title="HU → relative electron density" actions={<IconBtn title="Restore default curve" onClick={() => save(DEFAULT_HU_CURVE)}><RotateCcw size={14} /></IconBtn>}>
        <table className="w-full text-xs">
          <thead className="text-slate-500"><tr><th className="py-1 font-medium">HU</th><th className="font-medium">ρe (water = 1)</th><th /></tr></thead>
          <tbody>
            {curve.map(([h, d], n) => (
              <tr key={n} className="border-b border-white/5">
                <td className="p-1"><NumberField value={h} onChange={(v) => save(curve.map((p, k) => (k === n ? [v, p[1]] : p)))} width="w-24" /></td>
                <td className="p-1"><NumberField value={d} step={0.01} onChange={(v) => save(curve.map((p, k) => (k === n ? [p[0], v] : p)))} width="w-24" /></td>
                <td><IconBtn title="Remove point" danger onClick={() => curve.length > 2 && save(curve.filter((_, k) => k !== n))}><Trash2 size={12} /></IconBtn></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="p-2"><Button size="sm" onClick={() => save([...curve, [500, 1.3]])}><Plus size={12} /> Point</Button></div>
      </Panel>
      <Panel title="Curve">
        <svg viewBox={`0 0 ${W} ${H}`} className="m-3 w-[calc(100%-1.5rem)] rounded bg-black/30">
          {[-1000, 0, 1000, 2000, 3000].map((h) => <g key={h}><line x1={x(h)} x2={x(h)} y1={8} y2={H - B} stroke="rgba(148,163,184,0.12)" /><text x={x(h)} y={H - B + 12} fontSize="9" fill="#94a3b8" textAnchor="middle">{h}</text></g>)}
          {[0, 0.5, 1, 1.5, 2, 2.5].map((d) => <g key={d}><line x1={L} x2={W - 8} y1={y(d)} y2={y(d)} stroke="rgba(148,163,184,0.12)" /><text x={L - 4} y={y(d) + 3} fontSize="9" fill="#94a3b8" textAnchor="end">{d}</text></g>)}
          <polyline fill="none" stroke="#38bdf8" strokeWidth={1.8} points={curve.map(([h, d]) => `${x(h)},${y(d)}`).join(' ')} />
          {curve.map(([h, d], n) => <circle key={n} cx={x(h)} cy={y(d)} r={3} fill="#38bdf8" />)}
        </svg>
        <p className="px-3 pb-3 text-[11px] text-slate-500">Used for heterogeneity correction (radiological depth). Measure your CT scanner with an electron-density phantom to calibrate it.</p>
      </Panel>
    </div>
  );
}

function SettingsTab() {
  const lib = useStore((s) => s.lib);
  const [name, setName] = useState(lib.userName);
  return (
    <Panel title="Settings" className="max-w-lg">
      <div className="space-y-3 p-4">
        <TextField label="Your name (shown on plans and reports)" value={name} onChange={setName} />
        <Button variant="primary" onClick={async () => { await updateLibrary({ userName: name.trim() || 'Student' }); toast('Saved.', 'success'); }}>Save</Button>
        <p className="text-xs text-slate-500">Patients, contours and plans are stored on this computer. Use “Share as file” on the Patients page to move a case to another computer.</p>
      </div>
    </Panel>
  );
}

function HelpTab() {
  const keys: [string, string][] = [
    ['Mouse wheel / ↑ ↓ / PgUp PgDn', 'Scroll through slices'],
    ['Ctrl + wheel', 'Zoom (R resets)'],
    ['Right-drag', 'Window / level'],
    ['Shift-drag or middle-drag', 'Pan'],
    ['1–6', 'Window presets: soft tissue, lung, bone, brain, mediastinum, liver'],
    ['N  B  P  G  E  W  M', 'Navigate, Pearl, Pen, Polygon, Eraser, Wand, Measure'],
    ['[  ]', 'Pearl size'],
    ['Alt while drawing', 'Erase / cut out'],
    ['Enter / double-click / Esc', 'Close polygon / cancel'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo contour edits'],
    ['Ctrl+S', 'Save contoured image and plan'],
    ['Double-click a view', 'Enlarge / restore'],
  ];
  return (
    <div className="grid max-w-5xl gap-3 lg:grid-cols-2">
      <Panel title="Keyboard & mouse">
        <table className="w-full text-xs">
          <tbody>{keys.map(([k, v]) => <tr key={k} className="border-b border-white/5"><td className="px-3 py-1.5 font-mono text-slate-200">{k}</td><td className="text-slate-400">{v}</td></tr>)}</tbody>
        </table>
      </Panel>
      <Panel title="About the dose model">
        <div className="space-y-2 p-4 text-xs leading-relaxed text-slate-400">
          <p><b className="text-slate-200">PlanLab is for teaching.</b> Its dose engine is a TMR / fluence-convolution model with equivalent-path-length heterogeneity correction (like classic 3D-CRT planning systems). It reproduces depth dose, penumbra, field-size, wedge, MLC and inverse-square effects realistically, but it has not been commissioned against a real machine and must never be used for patient treatment.</p>
          <p>Contours: masks on the CT grid, so any number of separate parts per slice is allowed. Interpolation is shape-based (signed distance blending). Adapt / propagate snap contours to image edges using the HU statistics inside and around the structure.</p>
          <p>Coordinates follow DICOM (x = patient left, y = posterior, z = superior). Gantry angles follow IEC 61217 for head-first supine patients.</p>
        </div>
      </Panel>
    </div>
  );
}
