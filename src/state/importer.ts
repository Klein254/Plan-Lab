// DICOM import: parse files in a worker, assemble the CT, store it as the patient's "Basic CT scan", and turn any
// matching RT Structure Set into a "Contoured image".
import type { ParsedInstance } from '../core/dicom/parse.ts';
import type { ImportMessage } from '../core/dicom/importWorker.ts';
import { buildVolume, rtstructToMasks } from '../core/dicom/series.ts';
import type { ImageSetMeta, PatientRecord, StructureMeta, StructureSetMeta, StructureType } from '../core/types.ts';
import { instantiateConstraints, newId, PALETTE } from '../core/templates.ts';
import { Mask } from '../core/mask.ts';
import * as db from '../core/storage.ts';
import { useStore, persistRecord, refreshPatients } from './store.ts';

export interface ParseResult {
  instances: ParsedInstance[];
  errors: string[];
  skipped: number;
}

export function parseFiles(files: File[], onProgress: (done: number, total: number) => void): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../core/dicom/importWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<ImportMessage>) => {
      const m = ev.data;
      if (m.type === 'progress') onProgress(m.done, m.total);
      else {
        w.terminate();
        resolve({ instances: m.instances, errors: m.errors, skipped: m.skipped });
      }
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'Could not read the files'));
    };
    w.postMessage({ files });
  });
}

const typeFromRt = (t: string, name: string): StructureType => {
  const u = (t || '').toUpperCase();
  const n = name.toLowerCase();
  if (u === 'EXTERNAL' || /^(body|external|skin|outline)$/.test(n)) return 'EXTERNAL';
  if (u === 'PTV' || n.startsWith('ptv')) return 'PTV';
  if (u === 'CTV' || n.startsWith('ctv')) return 'CTV';
  if (u === 'GTV' || n.startsWith('gtv')) return 'GTV';
  if (n.startsWith('itv')) return 'ITV';
  if (u === 'BOLUS') return 'BOLUS';
  if (u === 'SUPPORT' || n.includes('couch')) return 'SUPPORT';
  if (u === 'AVOIDANCE') return 'AVOIDANCE';
  return 'OAR';
};

/** Best library match for an imported structure name, so imported OARs get their tolerance doses. */
function templateFor(name: string) {
  const lib = useStore.getState().lib.structures;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(name);
  return lib.find((t) => norm(t.name) === n || norm(t.key) === n)
    ?? lib.find((t) => n.length > 3 && (norm(t.name).startsWith(n) || n.startsWith(norm(t.name))));
}

export interface ImportOptions {
  ct: ParsedInstance[];
  structs: ParsedInstance[];
  anonymize: boolean;
  caseName?: string;
  attachToPid?: string | null; // add as another image set of an existing patient
}

export async function importSeries(opts: ImportOptions): Promise<{ pid: string; warnings: string[] }> {
  const { volume, sliceZ, sopUids, warnings } = buildVolume(opts.ct);
  const f = opts.ct[0];
  const state = useStore.getState();
  const nowIso = new Date().toISOString();
  // Find or create the patient
  let rec: PatientRecord | undefined = opts.attachToPid ? state.patients.find((p) => p.info.id === opts.attachToPid) : undefined;
  if (!rec && !opts.anonymize && f.patientId) rec = state.patients.find((p) => p.info.patientId === f.patientId && p.info.name === f.patientName);
  if (!rec) {
    const n = state.patients.length + 1;
    rec = {
      info: {
        id: newId('p'),
        patientId: opts.anonymize ? `TRN-${String(n).padStart(4, '0')}` : f.patientId || newId('ID-').toUpperCase(),
        name: opts.caseName?.trim() || (opts.anonymize ? `Training case ${n}` : f.patientName || 'Unnamed patient'),
        sex: f.sex,
        birthDate: opts.anonymize ? '' : f.birthDate,
        createdAt: nowIso,
        notes: f.studyDescription || '',
      },
      imageSets: [], structureSets: [], plans: [],
    };
  }
  const existingNames = rec.imageSets.map((i) => i.name);
  let name = 'Basic CT scan';
  for (let k = 2; existingNames.includes(name); k++) name = `Basic CT scan ${k}`;
  const img: ImageSetMeta = {
    id: newId('ct'),
    name,
    modality: 'CT',
    studyDate: f.studyDate,
    description: f.seriesDescription || f.studyDescription,
    seriesUid: f.seriesUid,
    frameOfReferenceUid: f.frameOfReferenceUid,
    studyUid: f.studyUid,
    patientPosition: f.patientPosition,
    dims: volume.dims,
    spacing: volume.spacing,
    origin: volume.origin,
    createdAt: nowIso,
    sliceZ,
    sopUids,
  };
  await db.saveImageSet(rec.info.id, img, volume);
  rec = { ...rec, imageSets: [...rec.imageSets, img] };
  // Matching RT Structure Sets become contoured images
  for (const rs of opts.structs) {
    const s = rs.rtstruct!;
    const converted = rtstructToMasks(s, volume);
    const structures: StructureMeta[] = [];
    const masks = new Map<string, Mask>();
    converted.forEach(({ roi, mask }, n) => {
      if (mask.isEmpty()) return;
      const tpl = templateFor(roi.name);
      const type = typeFromRt(roi.interpretedType, roi.name);
      const id = newId('s');
      structures.push({
        id, name: roi.name, color: roi.color ?? tpl?.color ?? PALETTE[n % PALETTE.length], type, visible: true,
        alphaBeta: tpl?.alphaBeta ?? (['GTV', 'CTV', 'PTV', 'ITV'].includes(type) ? 10 : 3),
        constraints: instantiateConstraints(tpl?.constraints ?? []), densityOverride: type === 'BOLUS' ? 1 : null, locked: false, templateKey: tpl?.key,
      });
      masks.set(id, mask);
    });
    if (!structures.length) continue;
    const existing = rec.structureSets.map((x) => x.name);
    let ssName = 'Contoured image (imported)';
    for (let k = 2; existing.includes(ssName); k++) ssName = `Contoured image (imported) ${k}`;
    const meta: StructureSetMeta = {
      id: newId('ss'), name: ssName, imageSetId: img.id, createdAt: nowIso, modifiedAt: nowIso, status: 'In progress',
      author: s.label || 'Imported', structures,
    };
    await db.saveStructureSet(rec.info.id, meta, masks);
    rec = { ...rec, structureSets: [...rec.structureSets, { id: meta.id, name: meta.name, imageSetId: img.id, createdAt: nowIso, modifiedAt: nowIso, status: meta.status }] };
  }
  await persistRecord(rec);
  await refreshPatients();
  return { pid: rec.info.id, warnings };
}
