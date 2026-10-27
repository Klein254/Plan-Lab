import { useMemo, useRef, useState } from 'react';
import { FolderInput, FileUp, Search, Trash2, UserRound, Package, PackageOpen, ScanLine, Layers, Target, ArrowRight, ShieldCheck, Loader2 } from 'lucide-react';
import { useStore, openPatient, deletePatientById, withBusy, toast, refreshPatients } from '../../state/store.ts';
import { parseFiles, importSeries, type ParseResult } from '../../state/importer.ts';
import { groupSeries, summarise, type SeriesSummary } from '../../core/dicom/series.ts';
import { exportPatientPackage, importPatientPackage } from '../../core/storage.ts';
import { newId } from '../../core/templates.ts';
import { Button, Panel, Badge, Toggle, TextField, confirmDialog, cx } from '../common.tsx';
import { saveBytes, safeName } from '../files.ts';
import type { ParsedInstance } from '../../core/dicom/parse.ts';

interface Found {
  result: ParseResult;
  groups: Map<string, ParsedInstance[]>;
  series: SeriesSummary[];
}

export function PatientsPage() {
  const patients = useStore((s) => s.patients);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [anonymize, setAnonymize] = useState(true);
  const [caseName, setCaseName] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const folderRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const pkgRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? patients.filter((p) => `${p.info.name} ${p.info.patientId} ${p.info.notes}`.toLowerCase().includes(t)) : patients;
  }, [patients, q]);
  const sel = patients.find((p) => p.info.id === selected) ?? null;

  const scan = async (files: File[]) => {
    if (!files.length) return;
    setFound(null);
    setProgress({ done: 0, total: files.length });
    try {
      const result = await parseFiles(files, (done, total) => setProgress({ done, total }));
      const groups = groupSeries(result.instances);
      const series = [...groups].map(([uid, l]) => summarise(uid, l)).sort((a, b) => (a.modality === 'CT' ? -1 : 1) - (b.modality === 'CT' ? -1 : 1) || b.count - a.count);
      setFound({ result, groups, series });
      const firstCt = series.find((s) => s.modality === 'CT' && s.usable);
      setChosen(firstCt?.seriesUid ?? null);
      if (!result.instances.length) toast('No DICOM images found in those files.', 'warn');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setProgress(null);
    }
  };

  const doImport = async () => {
    if (!found || !chosen) return;
    const ct = found.groups.get(chosen)!;
    const forUid = ct[0].frameOfReferenceUid;
    const structs = found.series
      .filter((s) => s.modality === 'RTSTRUCT' && s.usable)
      .flatMap((s) => found.groups.get(s.seriesUid)!)
      .filter((i) => !forUid || !i.rtstruct!.frameOfReferenceUid || i.rtstruct!.frameOfReferenceUid === forUid);
    const res = await withBusy('Importing CT into the database…', () => importSeries({ ct, structs, anonymize, caseName }));
    if (!res) return;
    for (const w of res.warnings) toast(w, 'warn');
    toast(`Imported "${caseName || ct[0].patientName || 'patient'}": ${ct.length} slices${structs.length ? ` + ${structs.length} structure set(s)` : ''}.`, 'success');
    setFound(null);
    setCaseName('');
    setSelected(res.pid);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const items = [...e.dataTransfer.items];
    const files: File[] = [];
    const walk = async (entry: FileSystemEntry): Promise<void> => {
      if (entry.isFile) {
        files.push(await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej)));
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const b of batch) await walk(b);
        }
      }
    };
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    if (entries.length) for (const en of entries) await walk(en);
    else files.push(...e.dataTransfer.files);
    void scan(files);
  };

  const ctSeries = found?.series.filter((s) => s.modality === 'CT') ?? [];
  const otherSeries = found?.series.filter((s) => s.modality !== 'CT') ?? [];

  return (
    <div className="grid h-full grid-cols-[minmax(280px,360px)_1fr] gap-3 p-3">
      {/* Patient list */}
      <Panel
        title={`Patients (${patients.length})`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => pkgRef.current?.click()} title="Import a .planlab patient file shared by someone else">
              <PackageOpen size={14} /> Open file
            </Button>
          </>
        }
      >
        <div className="p-2">
          <div className="flex items-center gap-2 rounded-md bg-black/30 px-2.5 ring-1 ring-white/10">
            <Search size={14} className="text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID, notes" className="h-8 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-600" />
          </div>
        </div>
        <ul className="px-2 pb-2">
          {list.map((p) => (
            <li key={p.info.id}>
              <button
                onClick={() => setSelected(p.info.id)}
                onDoubleClick={() => openPatient(p.info.id)}
                className={cx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left', selected === p.info.id ? 'bg-sky-500/10 ring-1 ring-sky-400/40' : 'hover:bg-white/[0.04]')}
              >
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/[0.06] text-slate-400">
                  <UserRound size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-slate-100">{p.info.name}</div>
                  <div className="truncate text-[11px] text-slate-500">
                    {p.info.patientId} · {p.imageSets.length} CT · {p.structureSets.length} contoured · {p.plans.length} plan{p.plans.length === 1 ? '' : 's'}
                  </div>
                </div>
              </button>
            </li>
          ))}
          {!list.length && <li className="px-3 py-8 text-center text-xs text-slate-500">{patients.length ? 'No matches.' : 'No patients yet. Import a CT scan to start.'}</li>}
        </ul>
        <input
          ref={pkgRef}
          type="file"
          accept=".planlab,.zip"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const rec = await withBusy('Importing patient file…', async () => importPatientPackage(new Uint8Array(await f.arrayBuffer()), newId('p')));
            if (rec) {
              await refreshPatients();
              setSelected(rec.info.id);
              toast(`Imported ${rec.info.name}.`, 'success');
            }
          }}
        />
      </Panel>

      <div className="flex min-h-0 flex-col gap-3 overflow-auto">
        {/* Import */}
        <Panel title="Import CT (DICOM)">
          <div className="p-4">
            {!found && (
              <div
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={onDrop}
                className={cx('flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors', drag ? 'border-sky-400 bg-sky-500/5' : 'border-white/10')}
              >
                {progress ? (
                  <>
                    <Loader2 className="animate-spin text-sky-400" />
                    <div className="text-sm text-slate-300">Reading {progress.done} / {progress.total} files…</div>
                    <div className="h-1 w-64 overflow-hidden rounded bg-white/10"><div className="h-full bg-sky-400" style={{ width: `${(100 * progress.done) / progress.total}%` }} /></div>
                  </>
                ) : (
                  <>
                    <FolderInput size={30} className="text-slate-500" />
                    <div>
                      <div className="text-sm text-slate-200">Drop a DICOM folder (CT series, optional RT Structure Set) here</div>
                      <div className="mt-1 text-xs text-slate-500">Uncompressed, RLE and JPEG-Lossless CT are supported. Images are stored in PlanLab's database, so you never need the original files again.</div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="primary" onClick={() => folderRef.current?.click()}><FolderInput size={15} /> Choose folder</Button>
                      <Button onClick={() => filesRef.current?.click()}><FileUp size={15} /> Choose files</Button>
                    </div>
                  </>
                )}
                <input ref={folderRef} type="file" className="hidden" {...({ webkitdirectory: '', directory: '' } as object)} multiple onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; void scan(f); }} />
                <input ref={filesRef} type="file" className="hidden" multiple onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; void scan(f); }} />
              </div>
            )}
            {found && (
              <div className="space-y-4">
                <div className="text-xs text-slate-400">
                  Found {found.result.instances.length} DICOM objects in {found.series.length} series
                  {found.result.skipped ? ` · ${found.result.skipped} other files skipped` : ''}.
                </div>
                {found.result.errors.length > 0 && (
                  <div className="rounded-lg bg-rose-500/10 p-3 text-xs text-rose-200 ring-1 ring-rose-400/20">
                    {found.result.errors.slice(0, 4).map((e, n) => <div key={n}>{e}</div>)}
                  </div>
                )}
                <div className="space-y-1.5">
                  {ctSeries.map((s) => (
                    <label key={s.seriesUid} className={cx('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 ring-1', chosen === s.seriesUid ? 'bg-sky-500/10 ring-sky-400/50' : 'ring-white/10 hover:bg-white/[0.03]', !s.usable && 'cursor-not-allowed opacity-60')}>
                      <input type="radio" name="series" disabled={!s.usable} checked={chosen === s.seriesUid} onChange={() => setChosen(s.seriesUid)} className="accent-sky-500" />
                      <ScanLine size={16} className="text-slate-400" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-slate-100">{s.description}</div>
                        <div className="text-[11px] text-slate-500">{s.patientName || 'No name'} · {s.patientId} · {s.studyDate} · {s.count} slices · {s.cols}×{s.rows}</div>
                        {s.problem && <div className="text-[11px] text-rose-300">{s.problem}</div>}
                      </div>
                      <Badge tone="sky">CT</Badge>
                    </label>
                  ))}
                  {otherSeries.map((s) => (
                    <div key={s.seriesUid} className="flex items-center gap-3 rounded-lg px-3 py-2 text-slate-400 ring-1 ring-white/5">
                      <Layers size={16} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{s.description}</div>
                        <div className="text-[11px] text-slate-500">{s.modality === 'RTSTRUCT' ? `Contours (${found.groups.get(s.seriesUid)![0].rtstruct?.rois.length ?? 0} structures) will be imported with the matching CT` : s.problem}</div>
                      </div>
                      <Badge>{s.modality || '?'}</Badge>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-4 rounded-lg bg-white/[0.02] p-3 ring-1 ring-white/5">
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={16} className="text-emerald-400" />
                    <Toggle checked={anonymize} onChange={setAnonymize} label="Anonymise for teaching (replace name, ID and birth date)" />
                  </div>
                  <TextField label="Case name (optional)" value={caseName} onChange={setCaseName} placeholder={anonymize ? 'e.g. Prostate case 3' : 'Keep DICOM name'} className="w-64" />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setFound(null)}>Cancel</Button>
                  <Button variant="primary" disabled={!chosen} onClick={doImport}>Import into database <ArrowRight size={15} /></Button>
                </div>
              </div>
            )}
          </div>
        </Panel>

        {/* Selected patient */}
        {sel && (
          <Panel
            title="Patient"
            actions={
              <>
                <Button size="sm" variant="ghost" onClick={async () => {
                  const bytes = await withBusy('Packing patient…', () => exportPatientPackage(sel.info.id));
                  if (bytes) await saveBytes(`${safeName(sel.info.name)}.planlab`, bytes, { name: 'PlanLab patient', extensions: ['planlab'] });
                }} title="Save everything for this patient as one file to share with classmates or an instructor">
                  <Package size={14} /> Share as file
                </Button>
                <Button size="sm" variant="danger" onClick={async () => {
                  if (await confirmDialog('Delete patient', `Delete ${sel.info.name} with all images, contours and plans? This can't be undone.`, 'Delete', true)) {
                    await deletePatientById(sel.info.id);
                    setSelected(null);
                  }
                }}>
                  <Trash2 size={14} /> Delete
                </Button>
              </>
            }
          >
            <div className="grid gap-4 p-4 md:grid-cols-[1fr_auto]">
              <div>
                <div className="text-lg font-semibold text-slate-100">{sel.info.name}</div>
                <div className="mt-1 text-xs text-slate-400">ID {sel.info.patientId} · Sex {sel.info.sex || '—'} · Added {new Date(sel.info.createdAt).toLocaleDateString()}</div>
                {sel.info.notes && <div className="mt-1 text-xs text-slate-500">{sel.info.notes}</div>}
                <div className="mt-4 grid gap-2 sm:grid-cols-3">
                  <Stat icon={<ScanLine size={15} />} label="Image sets" items={sel.imageSets.map((i) => `${i.name} (${i.dims[2]} sl.)`)} />
                  <Stat icon={<Layers size={15} />} label="Contoured images" items={sel.structureSets.map((s) => s.name)} />
                  <Stat icon={<Target size={15} />} label="Plans" items={sel.plans.map((p) => p.name)} />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Button variant="primary" onClick={() => openPatient(sel.info.id, 'contour')}>Open in Anatomical Model</Button>
                <Button onClick={() => openPatient(sel.info.id, 'plan')} disabled={!sel.structureSets.length}>Open in Planning</Button>
              </div>
            </div>
          </Panel>
        )}

        {!sel && !found && (
          <div className="grid flex-1 place-items-center rounded-xl p-8 text-center ring-1 ring-white/5">
            <div className="max-w-xl text-sm text-slate-400">
              <div className="text-base font-semibold text-slate-200">Workflow</div>
              <ol className="mt-3 space-y-1.5 text-left">
                <li><b className="text-slate-200">1. Import</b> a CT series. It's saved as the patient's <i>Basic CT scan</i>.</li>
                <li><b className="text-slate-200">2. Anatomical Model</b>: contour Body, GTV/CTV (incl. nodes), PTV and organs at risk. Your work is saved as a <i>Contoured image</i>.</li>
                <li><b className="text-slate-200">3. Planning</b>: place beams, shape them with jaws, MLC (auto-fit), wedges; set the prescription and calculate 3D dose.</li>
                <li><b className="text-slate-200">4. Evaluation</b>: DVHs, tolerance-dose checks, conformity/homogeneity, and a printable plan report.</li>
              </ol>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ icon, label, items }: { icon: React.ReactNode; label: string; items: string[] }) {
  return (
    <div className="rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-slate-500 uppercase">{icon}{label}</div>
      <ul className="mt-1.5 space-y-0.5 text-xs text-slate-300">
        {items.length ? items.map((t, n) => <li key={n} className="truncate">{t}</li>) : <li className="text-slate-600">None</li>}
      </ul>
    </div>
  );
}
