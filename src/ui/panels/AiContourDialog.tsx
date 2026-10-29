import { useEffect, useRef, useState } from 'react';
import { BrainCircuit, Download, Square } from 'lucide-react';
import { useStore, addStructure, replaceMask, toast } from '../../state/store.ts';
import { aiStatus, aiInstall, aiSegment, aiCancel, type AiStatus } from '../../state/ai.ts';
import { AI_ORGANS, AI_REGIONS, buildOrgan, classesFor, type BowelBagOptions } from '../../core/aiOrgans.ts';
import { Modal, Button, Select, cx } from '../common.tsx';

const PRESETS: { label: string; keys: string[] }[] = [
  { label: 'Prostate / bladder', keys: ['bladder', 'prostate', 'bowelbag', 'femhead_l', 'femhead_r'] },
  { label: 'Cervix / endometrium', keys: ['bladder', 'bowelbag', 'colon', 'femhead_l', 'femhead_r', 'iliac_vessels', 'pelvic_bones'] },
  { label: 'Rectum', keys: ['bladder', 'bowelbag', 'small_bowel', 'femhead_l', 'femhead_r', 'iliac_vessels'] },
  { label: 'Lung / oesophagus', keys: ['lung_l', 'lung_r', 'lungs', 'heart', 'esophagus', 'spinal_cord', 'trachea'] },
  { label: 'Breast', keys: ['lung_l', 'lung_r', 'heart', 'spinal_cord', 'humerus_l', 'humerus_r'] },
  { label: 'Upper abdomen', keys: ['liver', 'kidney_l', 'kidney_r', 'stomach', 'duodenum', 'spleen', 'spinal_cord', 'small_bowel'] },
];

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Auto-contouring with a deep-learning model (TotalSegmentator) running on this computer. */
export function AiContourDialog({ onClose }: { onClose: () => void }) {
  const ct = useStore((s) => s.ct)!;
  const [status, setStatus] = useState<AiStatus | null | 'loading'>('loading');
  const [phase, setPhase] = useState<'idle' | 'installing' | 'running' | 'building'>('idle');
  const [log, setLog] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set(PRESETS[0].keys));
  const [fast, setFast] = useState(true);
  const [existing, setExisting] = useState<'copy' | 'replace'>('copy');
  const [bagTop, setBagTop] = useState<'none' | 'l5' | 'ptv'>('none');
  const [error, setError] = useState('');
  const [started, setStarted] = useState(0);
  const [now, setNow] = useState(0);
  const busy = phase !== 'idle';
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = () => aiStatus().then(setStatus).catch((e) => { setStatus(null); setError(String(e)); });
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [log]);
  const addLog = (line: string) => setLog((l) => (l.length && isProgress(line) && isProgress(l[l.length - 1]) ? [...l.slice(0, -1), line] : [...l, line]).slice(-200));

  const install = async () => {
    setError('');
    setLog([]);
    setPhase('installing');
    setStarted(Date.now());
    try {
      await aiInstall(addLog);
      toast('AI contouring installed.', 'success');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setPhase('idle');
      void refresh();
    }
  };

  const run = async () => {
    setError('');
    setLog([]);
    const keys = [...chosen];
    if (!keys.length) return setError('Choose at least one organ.');
    setPhase('running');
    const t0 = Date.now();
    setStarted(t0);
    try {
      const roi = classesFor(keys);
      const { labels, names } = await aiSegment(ct.volume, { fast, roi }, addLog);
      setPhase('building');
      addLog('Creating structures…');
      await new Promise((r) => setTimeout(r, 30));
      const idsByName = new Map<string, number>();
      for (const [id, n] of names) idsByName.set(n, id);
      const idsOf = (cls: string[]) => new Set(cls.map((c) => idsByName.get(c)).filter((x): x is number => x !== undefined));
      const s = useStore.getState();
      const v = ct.volume;
      const zOfSlice = (k: number) => v.origin[2] + k * v.spacing[2];
      const bodyMeta = s.ss?.meta.structures.find((x) => x.type === 'EXTERNAL');
      const body = bodyMeta ? s.ss!.masks.get(bodyMeta.id)! : null;
      let bowel: BowelBagOptions = { superior: { kind: 'none' } };
      if (bagTop === 'l5') bowel = { superior: { kind: 'l5' } };
      if (bagTop === 'ptv') {
        const ptv = s.ss?.meta.structures.find((x) => x.type === 'PTV' && !s.ss!.masks.get(x.id)!.isEmpty());
        const m = ptv ? s.ss!.masks.get(ptv.id)! : null;
        let top = -1;
        if (m) for (let k = m.nz - 1; k >= 0; k--) if (m.hasSlice(k)) { top = k; break; }
        if (top >= 0) bowel = { superior: { kind: 'z', z: zOfSlice(top) + 20 } };
      }
      const made: string[] = [], missing: string[] = [];
      for (const key of keys) {
        const o = AI_ORGANS.find((x) => x.key === key)!;
        const mask = buildOrgan(o, labels, ct.meta.dims, ct.meta.spacing, idsOf, zOfSlice, body, bowel);
        if (mask.isEmpty()) { missing.push(o.name); continue; }
        const lib = useStore.getState().lib.structures;
        const tpl = o.template ? lib.find((x) => x.key === o.template) : undefined;
        const name = tpl?.name ?? o.name;
        const ss = useStore.getState().ss;
        const same = ss?.meta.structures.find((x) => x.name === name);
        let id: string;
        if (same && (existing === 'replace' || ss!.masks.get(same.id)!.isEmpty())) id = same.id;
        else id = await addStructure({ name: same ? `${name} (AI)` : name, type: tpl?.type ?? o.type, color: o.color ?? tpl?.color, templateKey: tpl?.key });
        replaceMask(id, mask, 'AI contour');
        made.push(o.name);
      }
      const secs = Math.round((Date.now() - t0) / 1000);
      toast(`AI contoured ${made.length} structure${made.length === 1 ? '' : 's'} in ${fmtTime(secs)}${missing.length ? `. Not in this scan: ${missing.join(', ')}` : ''}. Review every slice before planning.`, made.length ? 'success' : 'warn');
      if (made.length) onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setPhase('idle');
    }
  };

  const toggle = (k: string) => setChosen((c) => { const n = new Set(c); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const elapsed = busy ? fmtTime(Math.max(0, (now || Date.now()) - started) / 1000) : '';
  const st = status === 'loading' ? null : status;

  return (
    <Modal
      title="AI auto-contouring"
      onClose={() => { if (!busy) onClose(); }}
      width="max-w-3xl"
      footer={
        busy ? (
          <Button variant="danger" onClick={() => void aiCancel()} disabled={phase === 'building'}><Square size={13} /> Cancel</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            {st?.installed && <Button variant="primary" onClick={() => void run()} disabled={!chosen.size}><BrainCircuit size={14} /> Contour {chosen.size} organ{chosen.size === 1 ? '' : 's'}</Button>}
          </>
        )
      }
    >
      <div className="space-y-3 text-sm" data-testid="ai-dialog">
        {status === 'loading' && <p className="text-slate-400">Checking…</p>}
        {status === null && (
          <p className="text-slate-300">AI contouring runs in the PlanLab desktop app (Windows or macOS), where the model can use this computer's processor.</p>
        )}
        {st && !st.installed && (
          <div className="space-y-2">
            <p className="text-slate-300">
              PlanLab uses <b>TotalSegmentator</b>, a published deep-learning model trained on over 1,200 CT scans, which contours 117 structures. It runs
              entirely on this computer: install it once (about 2 GB, needs internet), then it works offline.
            </p>
            {st.python ? (
              <p className="text-xs text-slate-400">Found Python {st.python}. The model is installed into PlanLab's own folder and doesn't change your Python.</p>
            ) : (
              <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-400/20">
                Python 3.10–3.13 is needed first. Install Python 3.12 from python.org (on Windows tick “Add python.exe to PATH”), then reopen this window.
              </p>
            )}
            <Button variant="primary" disabled={busy || !st.python} onClick={() => void install()}><Download size={14} /> Install AI contouring</Button>
          </div>
        )}
        {st?.installed && !busy && (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-slate-500">Presets:</span>
              {PRESETS.map((p) => (
                <button key={p.label} onClick={() => setChosen(new Set(p.keys))} className="rounded-md px-2 py-0.5 text-[11px] text-slate-300 ring-1 ring-white/10 hover:bg-white/10">{p.label}</button>
              ))}
              <button onClick={() => setChosen(new Set())} className="rounded-md px-2 py-0.5 text-[11px] text-slate-500 hover:text-slate-300">clear</button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {AI_REGIONS.map((region) => (
                <div key={region} className="rounded-lg bg-white/[0.03] p-2 ring-1 ring-white/5">
                  <div className="mb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{region}</div>
                  {AI_ORGANS.filter((o) => o.region === region).map((o) => (
                    <label key={o.key} className="flex cursor-pointer items-center gap-1.5 py-0.5 text-xs text-slate-200" title={o.note}>
                      <input type="checkbox" className="accent-violet-400" checked={chosen.has(o.key)} onChange={() => toggle(o.key)} />
                      {o.name}
                      {o.derived && <span className="text-[9px] text-violet-300">built</span>}
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <Select<string> label="Resolution" value={fast ? 'fast' : 'full'} onChange={(v) => setFast(v === 'fast')} options={[{ value: 'fast', label: 'Standard (3 mm model, a few minutes)' }, { value: 'full', label: 'High (1.5 mm model, slower; most accurate)' }]} className="w-80" />
              <Select<'copy' | 'replace'> label="Existing contours" value={existing} onChange={setExisting} options={[{ value: 'copy', label: 'Keep mine, add “(AI)” copies' }, { value: 'replace', label: 'Replace them' }]} className="w-72" />
              {chosen.has('bowelbag') && (
                <Select<'none' | 'l5' | 'ptv'> label="Bowel bag top" value={bagTop} onChange={setBagTop} options={[{ value: 'none', label: 'Whole scan' }, { value: 'l5', label: 'L4/L5 interspace' }, { value: 'ptv', label: '2 cm above the PTV' }]} className="w-64" />
              )}
            </div>
            <p className="text-[11px] text-slate-500">
              The model gives a strong starting point (average overlap with expert contours, Dice 0.94, in its published test of 104 structures) but it is not perfect, and
              the rectum, optic structures and parotids are not in the open model: draw those yourself. Always review every slice.
              {!st.weights && ' The first run also downloads the model weights.'}
            </p>
          </>
        )}
        {(busy || log.length > 0) && (
          <div>
            <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
              <span>{phase === 'installing' ? 'Installing…' : phase === 'running' ? 'Contouring with the AI model…' : phase === 'building' ? 'Creating structures…' : 'Log'}</span>
              <span className="tabular-nums">{elapsed}</span>
            </div>
            <div ref={logRef} className="h-40 overflow-auto rounded-md bg-black/50 p-2 font-mono text-[10px] leading-relaxed text-slate-400 ring-1 ring-white/10" data-testid="ai-log">
              {log.map((l, n) => <div key={n} className={cx(l.startsWith('PLANLAB') && 'text-violet-300')}>{l}</div>)}
            </div>
          </div>
        )}
        {error && <div className="rounded-md bg-rose-500/10 px-3 py-2 text-xs whitespace-pre-wrap text-rose-200 ring-1 ring-rose-400/30">{error}</div>}
      </div>
    </Modal>
  );
}

/** Progress-bar lines (tqdm / pip) replace the previous one instead of piling up. */
function isProgress(line: string) {
  return /\d+%\|/.test(line) || /━|█/.test(line) || /^\s*\d+(\.\d+)?\s*[kMG]?B\/s/.test(line);
}
