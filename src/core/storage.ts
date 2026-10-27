// Local patient database. In the desktop app records are files under the app-data folder (via Rust commands);
// in a plain browser (development/tests) they live in IndexedDB. Large arrays are compressed with deflate.
import { deflate, inflate, zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { ImageSetMeta, PatientRecord, PlanMeta, StructureSetMeta, Volume, DoseGrid } from './types.ts';
import { Mask, decodeMask, encodeMask } from './mask.ts';

export interface KV {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
  remove(prefix: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

class TauriKV implements KV {
  private invoke = import('@tauri-apps/api/core').then((m) => m.invoke);
  async get(key: string) {
    const invoke = await this.invoke;
    const res = await invoke<ArrayBuffer | number[] | null>('kv_get', { key });
    if (!res) return null;
    const u = res instanceof ArrayBuffer ? new Uint8Array(res) : Uint8Array.from(res);
    return u.length ? u : null;
  }
  async put(key: string, data: Uint8Array) {
    const invoke = await this.invoke;
    await invoke('kv_put', data, { headers: { 'x-key': key } });
  }
  async remove(prefix: string) {
    const invoke = await this.invoke;
    await invoke('kv_remove', { prefix });
  }
  async list(prefix: string) {
    const invoke = await this.invoke;
    return invoke<string[]>('kv_list', { prefix });
  }
}

class IdbKV implements KV {
  private db: Promise<IDBDatabase>;
  constructor() {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open('planlab', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const t = db.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(req ? (req.result as T) : (undefined as T));
      t.onerror = () => reject(t.error);
    });
  }
  async get(key: string) {
    const v = await this.tx<Uint8Array | undefined>('readonly', (s) => s.get(key));
    return v ?? null;
  }
  async put(key: string, data: Uint8Array) {
    await this.tx('readwrite', (s) => { s.put(data, key); });
  }
  async remove(prefix: string) {
    const keys = await this.list(prefix);
    await this.tx('readwrite', (s) => { for (const k of keys) s.delete(k); });
  }
  async list(prefix: string) {
    const keys = await this.tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    return (keys as string[]).filter((k) => k.startsWith(prefix));
  }
}

export const kv: KV = isTauri() ? new TauriKV() : new IdbKV();

const z = (data: Uint8Array, level: 0 | 1 | 6 = 1) =>
  new Promise<Uint8Array>((res, rej) => deflate(data, { level }, (err, out) => (err ? rej(err) : res(out))));
const unz = (data: Uint8Array) => new Promise<Uint8Array>((res, rej) => inflate(data, (err, out) => (err ? rej(err) : res(out))));
const json = (v: unknown) => strToU8(JSON.stringify(v));
const parse = <T,>(u: Uint8Array | null): T | null => (u ? (JSON.parse(strFromU8(u)) as T) : null);
const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

const P = (pid: string) => `p/${pid}`;

export async function listPatients(): Promise<PatientRecord[]> {
  const keys = await kv.list('p/');
  const recs = await Promise.all(keys.filter((k) => k.endsWith('/record.json')).map(async (k) => parse<PatientRecord>(await kv.get(k))));
  return recs.filter((r): r is PatientRecord => !!r).sort((a, b) => b.info.createdAt.localeCompare(a.info.createdAt));
}

export async function savePatientRecord(rec: PatientRecord) {
  await kv.put(`${P(rec.info.id)}/record.json`, json(rec));
}

export async function deletePatient(pid: string) {
  await kv.remove(`${P(pid)}/`);
}

export async function saveImageSet(pid: string, meta: ImageSetMeta, vol: Volume) {
  await kv.put(`${P(pid)}/ct/${meta.id}.bin`, await z(bytesOf(vol.data)));
  await kv.put(`${P(pid)}/ct/${meta.id}.json`, json(meta));
}

export async function loadImageSet(pid: string, id: string): Promise<{ meta: ImageSetMeta; volume: Volume }> {
  const meta = parse<ImageSetMeta>(await kv.get(`${P(pid)}/ct/${id}.json`));
  const bin = await kv.get(`${P(pid)}/ct/${id}.bin`);
  if (!meta || !bin) throw new Error('The CT images for this patient are missing from the database.');
  const raw = await unz(bin);
  const data = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  return { meta, volume: { dims: meta.dims, spacing: meta.spacing, origin: meta.origin, data: data.byteOffset % 2 ? data.slice() : data } };
}

/** Structure masks are stored as one blob: [count][lengths…][runs…] of uint32 run-lengths. */
export async function saveStructureSet(pid: string, meta: StructureSetMeta, masks: Map<string, Mask>) {
  const parts = meta.structures.map((s) => encodeMask(masks.get(s.id)!));
  const total = 1 + parts.length + parts.reduce((a, p) => a + p.length, 0);
  const all = new Uint32Array(total);
  all[0] = parts.length;
  let o = 1 + parts.length;
  parts.forEach((p, n) => {
    all[1 + n] = p.length;
    all.set(p, o);
    o += p.length;
  });
  await kv.put(`${P(pid)}/ss/${meta.id}.bin`, await z(bytesOf(all)));
  await kv.put(`${P(pid)}/ss/${meta.id}.json`, json(meta));
}

export async function loadStructureSet(pid: string, id: string, dims: [number, number, number]): Promise<{ meta: StructureSetMeta; masks: Map<string, Mask> }> {
  const meta = parse<StructureSetMeta>(await kv.get(`${P(pid)}/ss/${id}.json`));
  if (!meta) throw new Error('Structure set not found.');
  const masks = new Map<string, Mask>();
  const bin = await kv.get(`${P(pid)}/ss/${id}.bin`);
  if (bin) {
    const raw = await unz(bin);
    const all = new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const n = all[0];
    let o = 1 + n;
    for (let s = 0; s < n; s++) {
      const len = all[1 + s];
      const runs = all.subarray(o, o + len);
      o += len;
      const st = meta.structures[s];
      if (st) masks.set(st.id, decodeMask(runs, ...dims));
    }
  }
  for (const st of meta.structures) if (!masks.has(st.id)) masks.set(st.id, new Mask(...dims));
  return { meta, masks };
}

export async function deleteStructureSet(pid: string, id: string) {
  await kv.remove(`${P(pid)}/ss/${id}.`);
}

export async function savePlan(pid: string, plan: PlanMeta) {
  await kv.put(`${P(pid)}/plan/${plan.id}.json`, json(plan));
}

export async function loadPlan(pid: string, id: string): Promise<PlanMeta> {
  const plan = parse<PlanMeta>(await kv.get(`${P(pid)}/plan/${id}.json`));
  if (!plan) throw new Error('Plan not found.');
  return plan;
}

export async function deletePlan(pid: string, id: string) {
  await kv.remove(`${P(pid)}/plan/${id}.`);
}

export interface StoredDose {
  grid: DoseGrid;
  signatures: Record<string, string>; // beam id → geometry signature
  densitySignature: string;
  perBeam: Map<string, Float32Array>;
}

export async function saveDose(pid: string, planId: string, d: StoredDose) {
  const ids = [...d.perBeam.keys()];
  const header = json({ grid: d.grid, signatures: d.signatures, densitySignature: d.densitySignature, ids });
  const n = d.grid.dims[0] * d.grid.dims[1] * d.grid.dims[2];
  const body = new Float32Array(ids.length * n);
  ids.forEach((id, k) => body.set(d.perBeam.get(id)!, k * n));
  await kv.put(`${P(pid)}/plan/${planId}.dose.json`, header);
  await kv.put(`${P(pid)}/plan/${planId}.dose.bin`, await z(bytesOf(body)));
}

export async function loadDose(pid: string, planId: string): Promise<StoredDose | null> {
  const h = parse<{ grid: DoseGrid; signatures: Record<string, string>; densitySignature: string; ids: string[] }>(await kv.get(`${P(pid)}/plan/${planId}.dose.json`));
  const bin = await kv.get(`${P(pid)}/plan/${planId}.dose.bin`);
  if (!h || !bin) return null;
  const raw = await unz(bin);
  const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  const n = h.grid.dims[0] * h.grid.dims[1] * h.grid.dims[2];
  const perBeam = new Map<string, Float32Array>();
  h.ids.forEach((id, k) => perBeam.set(id, all.slice(k * n, (k + 1) * n)));
  return { grid: h.grid, signatures: h.signatures, densitySignature: h.densitySignature, perBeam };
}

/** Library (machines, structure templates, CT calibration, user) */
export async function loadSetting<T>(name: string): Promise<T | null> {
  return parse<T>(await kv.get(`settings/${name}.json`));
}
export async function saveSetting(name: string, value: unknown) {
  await kv.put(`settings/${name}.json`, json(value));
}

/** Packs a whole patient (records, images, contours, plans, dose) into one .planlab file to share. */
export async function exportPatientPackage(pid: string): Promise<Uint8Array> {
  const keys = await kv.list(`${P(pid)}/`);
  const files: Record<string, Uint8Array> = {};
  for (const k of keys) {
    const v = await kv.get(k);
    if (v) files[k.slice(P(pid).length + 1)] = v;
  }
  files['planlab-package.json'] = json({ format: 'planlab-patient', version: 1, exportedAt: new Date().toISOString() });
  return zipSync(files, { level: 0 });
}

/** Imports a .planlab package; the patient gets a new internal id so it never overwrites an existing one. */
export async function importPatientPackage(bytes: Uint8Array, newPid: string): Promise<PatientRecord> {
  const files = unzipSync(bytes);
  if (!files['planlab-package.json']) throw new Error('This is not a PlanLab patient file.');
  const rec = parse<PatientRecord>(files['record.json']);
  if (!rec) throw new Error('The patient file is incomplete (no record).');
  for (const [name, data] of Object.entries(files)) {
    if (name === 'planlab-package.json' || name === 'record.json') continue;
    await kv.put(`${P(newPid)}/${name}`, data);
  }
  rec.info = { ...rec.info, id: newPid };
  await savePatientRecord(rec);
  return rec;
}
