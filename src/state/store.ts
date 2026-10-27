// Application state: library, open patient, active image set / structure set / plan, dose and view state.
import { create } from 'zustand';
import type {
  Beam, DoseGrid, ImageSetMeta, PatientRecord, PlanMeta, StructureMeta, StructureSetMeta, StructureType, Vec3, Volume, ItemStatus,
} from '../core/types.ts';
import { Mask, encodeMask } from '../core/mask.ts';
import { DEFAULT_MACHINES, type Machine } from '../core/machines.ts';
import { STRUCTURE_LIBRARY, PALETTE, instantiateConstraints, newId, type StructureTemplate } from '../core/templates.ts';
import { DEFAULT_HU_CURVE, type HuCurve, buildDensity, makeDoseGrid } from '../core/dose/densityGrid.ts';
import * as db from '../core/storage.ts';
import { sampleGrid } from '../core/dose/engine.ts';
import type { DoseMessage } from '../core/dose/worker.ts';
import { computeDVH, dAt } from '../core/dvh.ts';
import { beamAxes, projectToIso } from '../core/geometry.ts';

export type Module = 'patients' | 'contour' | 'plan' | 'eval' | 'library';
export type ToolName = 'navigate' | 'pearl' | 'pen' | 'polygon' | 'eraser' | 'wand' | 'measure' | 'probe' | 'refpoint';

export interface ToolSettings {
  pearlRadius: number; // mm
  pearl3D: boolean;
  pearlMode: 'auto' | 'add' | 'erase';
  penMode: 'add' | 'erase';
  wandTolerance: number; // HU
  wand3D: boolean;
  wandRadius: number; // mm
}

export interface DoseDisplay {
  mode: 'lines' | 'wash' | 'both' | 'off';
  levels: number[]; // % of Rx
  washMin: number; // % of Rx
  opacity: number;
  showHotspot: boolean;
}

export interface DoseState {
  grid: DoseGrid;
  perBeam: Map<string, Float32Array>; // cGy per MU (or per minute)
  signatures: Record<string, string>;
  densitySignature: string;
  total: Float32Array | null; // Gy, whole course
  maxDose: number;
  maxAt: Vec3 | null;
}

export interface Library {
  machines: Machine[];
  structures: StructureTemplate[];
  huCurve: HuCurve;
  userName: string;
  dvhBin: number;
}

interface UndoEntry {
  ssId: string;
  structureId: string;
  slices: Map<number, Uint8Array | null>;
  label: string;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error' | 'warn';
  text: string;
}

interface State {
  lib: Library;
  libLoaded: boolean;
  patients: PatientRecord[];
  module: Module;
  patient: PatientRecord | null;
  ct: { meta: ImageSetMeta; volume: Volume } | null;
  ss: { meta: StructureSetMeta; masks: Map<string, Mask>; dirty: boolean } | null;
  plan: { meta: PlanMeta; dirty: boolean } | null;
  dose: DoseState | null;
  calc: { label: string; progress: number } | null;
  busy: { label: string; progress?: number } | null;
  toasts: Toast[];
  // view
  cursor: Vec3; // voxel coordinates (float)
  wl: { w: number; l: number };
  tool: ToolName;
  toolSettings: ToolSettings;
  selectedStructureId: string | null;
  selectedBeamId: string | null;
  doseDisplay: DoseDisplay;
  ssVersion: number; // bumps on any mask/structure change
  planVersion: number;
  doseVersion: number;
  undo: UndoEntry[];
  redo: UndoEntry[];
}

const DEFAULT_LIB: Library = {
  machines: DEFAULT_MACHINES,
  structures: STRUCTURE_LIBRARY,
  huCurve: DEFAULT_HU_CURVE,
  userName: 'Student',
  dvhBin: 0.1,
};

export const useStore = create<State>(() => ({
  lib: DEFAULT_LIB,
  libLoaded: false,
  patients: [],
  module: 'patients',
  patient: null,
  ct: null,
  ss: null,
  plan: null,
  dose: null,
  calc: null,
  busy: null,
  toasts: [],
  cursor: [0, 0, 0],
  wl: { w: 400, l: 40 },
  tool: 'navigate',
  toolSettings: { pearlRadius: 8, pearl3D: false, pearlMode: 'auto', penMode: 'add', wandTolerance: 60, wand3D: false, wandRadius: 60 },
  selectedStructureId: null,
  selectedBeamId: null,
  doseDisplay: { mode: 'lines', levels: [107, 105, 100, 95, 90, 80, 70, 50, 30], washMin: 30, opacity: 0.45, showHotspot: true },
  ssVersion: 0,
  planVersion: 0,
  doseVersion: 0,
  undo: [],
  redo: [],
}));

const get = useStore.getState;
const set = useStore.setState;
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- toasts / busy

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = newId('t');
  set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 8000 : 4000);
}

export async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  set({ busy: { label } });
  try {
    // let the overlay paint before heavy synchronous work
    await new Promise((r) => setTimeout(r, 30));
    return await fn();
  } catch (err) {
    console.error(err);
    toast(err instanceof Error ? err.message : String(err), 'error');
    return undefined;
  } finally {
    set({ busy: null });
  }
}

// ---------------------------------------------------------------- library

export async function loadLibrary() {
  const [machines, structures, huCurve, user] = await Promise.all([
    db.loadSetting<Machine[]>('machines'),
    db.loadSetting<StructureTemplate[]>('structures'),
    db.loadSetting<HuCurve>('huCurve'),
    db.loadSetting<{ userName: string; dvhBin: number }>('user'),
  ]);
  set({
    lib: {
      machines: machines?.length ? machines : DEFAULT_MACHINES,
      structures: structures?.length ? structures : STRUCTURE_LIBRARY,
      huCurve: huCurve?.length ? huCurve : DEFAULT_HU_CURVE,
      userName: user?.userName || 'Student',
      dvhBin: user?.dvhBin || 0.1,
    },
    libLoaded: true,
  });
}

export async function updateLibrary(patch: Partial<Library>) {
  const lib = { ...get().lib, ...patch };
  set({ lib });
  if (patch.machines) await db.saveSetting('machines', lib.machines);
  if (patch.structures) await db.saveSetting('structures', lib.structures);
  if (patch.huCurve) await db.saveSetting('huCurve', lib.huCurve);
  if (patch.userName !== undefined || patch.dvhBin !== undefined) await db.saveSetting('user', { userName: lib.userName, dvhBin: lib.dvhBin });
}

export const machineById = (id: string) => get().lib.machines.find((m) => m.id === id) ?? get().lib.machines[0];

// ---------------------------------------------------------------- patients

export async function refreshPatients() {
  set({ patients: await db.listPatients() });
}

export async function persistRecord(rec: PatientRecord) {
  await db.savePatientRecord(rec);
  set((s) => ({
    patient: s.patient?.info.id === rec.info.id ? rec : s.patient,
    patients: [rec, ...s.patients.filter((p) => p.info.id !== rec.info.id)].sort((a, b) => b.info.createdAt.localeCompare(a.info.createdAt)),
  }));
}

export function closePatient() {
  set({ patient: null, ct: null, ss: null, plan: null, dose: null, undo: [], redo: [], selectedBeamId: null, selectedStructureId: null, module: 'patients' });
}

export async function openPatient(pid: string, module: Module = 'contour') {
  const rec = get().patients.find((p) => p.info.id === pid);
  if (!rec) return;
  await withBusy('Opening patient…', async () => {
    set({ patient: rec, ct: null, ss: null, plan: null, dose: null, undo: [], redo: [] });
    const img = rec.imageSets[0];
    if (img) await openImageSet(img.id);
    // Most recently changed structure set, if any
    const ssList = [...rec.structureSets].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    if (ssList[0]) await openStructureSet(ssList[0].id);
    set({ module });
  });
}

export async function deletePatientById(pid: string) {
  await db.deletePatient(pid);
  if (get().patient?.info.id === pid) closePatient();
  set((s) => ({ patients: s.patients.filter((p) => p.info.id !== pid) }));
}

export async function openImageSet(id: string) {
  const p = get().patient!;
  const { meta, volume } = await db.loadImageSet(p.info.id, id);
  const c: Vec3 = [(meta.dims[0] - 1) / 2, (meta.dims[1] - 1) / 2, Math.floor((meta.dims[2] - 1) / 2)];
  set({ ct: { meta, volume }, cursor: c, ss: get().ss?.meta.imageSetId === id ? get().ss : null });
}

// ---------------------------------------------------------------- structure sets

export async function openStructureSet(id: string) {
  const p = get().patient!;
  if (!(await confirmDiscard())) return;
  const entry = p.structureSets.find((s) => s.id === id);
  if (!entry) return;
  if (get().ct?.meta.id !== entry.imageSetId) await openImageSet(entry.imageSetId);
  const ct = get().ct!;
  const { meta, masks } = await db.loadStructureSet(p.info.id, id, ct.meta.dims);
  set((s) => ({
    ss: { meta, masks, dirty: false },
    undo: [], redo: [],
    selectedStructureId: meta.structures[0]?.id ?? null,
    ssVersion: s.ssVersion + 1,
    plan: s.plan && s.plan.meta.structureSetId === id ? s.plan : null,
    dose: s.plan && s.plan.meta.structureSetId === id ? s.dose : null,
  }));
}

let discardPrompt: ((what: string) => Promise<boolean>) | null = null;
export function setDiscardPrompt(fn: (what: string) => Promise<boolean>) {
  discardPrompt = fn;
}
/** Asks before throwing away unsaved contour/plan changes. */
export async function confirmDiscard(): Promise<boolean> {
  const s = get();
  const what = s.ss?.dirty ? `"${s.ss.meta.name}"` : s.plan?.dirty ? `"${s.plan.meta.name}"` : null;
  if (!what) return true;
  return discardPrompt ? discardPrompt(what) : window.confirm(`Discard unsaved changes to ${what}?`);
}

function uniqueName(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  for (let n = 2; ; n++) if (!existing.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** Creates a new (empty or copied) structure set and makes it active. */
export async function createStructureSet(opts: { name?: string; copyFrom?: boolean } = {}): Promise<string> {
  const s = get();
  const p = s.patient!, ct = s.ct!;
  const base = opts.name || 'Contoured image';
  const name = uniqueName(base, p.structureSets.map((x) => x.name));
  const id = newId('ss');
  const copy = opts.copyFrom && s.ss;
  const idMap = new Map<string, string>();
  const structures: StructureMeta[] = copy ? s.ss!.meta.structures.map((st) => {
    const nid = newId('s');
    idMap.set(st.id, nid);
    return { ...st, id: nid, constraints: st.constraints.map((c) => ({ ...c, id: newId('c') })) };
  }) : [];
  const masks = new Map<string, Mask>();
  if (copy) for (const [oid, nid] of idMap) masks.set(nid, s.ss!.masks.get(oid)!.clone());
  const meta: StructureSetMeta = {
    id, name, imageSetId: ct.meta.id, createdAt: now(), modifiedAt: now(), status: 'In progress', author: s.lib.userName, structures,
  };
  await db.saveStructureSet(p.info.id, meta, masks);
  await persistRecord({
    ...p,
    structureSets: [...p.structureSets, { id, name, imageSetId: ct.meta.id, createdAt: meta.createdAt, modifiedAt: meta.modifiedAt, status: meta.status }],
  });
  set((st) => ({ ss: { meta, masks, dirty: false }, undo: [], redo: [], ssVersion: st.ssVersion + 1, selectedStructureId: structures[0]?.id ?? null }));
  return id;
}

export async function saveStructureSet(): Promise<boolean> {
  const s = get();
  if (!s.ss || !s.patient) return false;
  const meta = { ...s.ss.meta, modifiedAt: now() };
  await db.saveStructureSet(s.patient.info.id, meta, s.ss.masks);
  await persistRecord({
    ...s.patient,
    structureSets: s.patient.structureSets.map((x) => (x.id === meta.id ? { ...x, name: meta.name, modifiedAt: meta.modifiedAt, status: meta.status } : x)),
  });
  set((st) => ({ ss: st.ss ? { ...st.ss, meta, dirty: false } : null }));
  return true;
}

export async function deleteStructureSetById(id: string) {
  const s = get();
  const p = s.patient!;
  const plans = p.plans.filter((pl) => pl.structureSetId === id);
  for (const pl of plans) await db.deletePlan(p.info.id, pl.id);
  await db.deleteStructureSet(p.info.id, id);
  await persistRecord({ ...p, structureSets: p.structureSets.filter((x) => x.id !== id), plans: p.plans.filter((pl) => pl.structureSetId !== id) });
  if (s.ss?.meta.id === id) set({ ss: null, plan: null, dose: null, undo: [], redo: [] });
}

export async function renameItem(kind: 'ct' | 'ss' | 'plan', id: string, name: string) {
  const s = get();
  const p = s.patient!;
  if (kind === 'ct') {
    const meta = p.imageSets.find((x) => x.id === id)!;
    const next = { ...meta, name };
    await persistRecord({ ...p, imageSets: p.imageSets.map((x) => (x.id === id ? next : x)) });
    if (s.ct?.meta.id === id) set({ ct: { ...s.ct, meta: { ...s.ct.meta, name } } });
    // Keep the stored meta in sync
    const loaded = await db.loadImageSet(p.info.id, id);
    await db.saveImageSet(p.info.id, { ...loaded.meta, name }, loaded.volume);
  } else if (kind === 'ss') {
    await persistRecord({ ...p, structureSets: p.structureSets.map((x) => (x.id === id ? { ...x, name } : x)) });
    if (s.ss?.meta.id === id) {
      set({ ss: { ...s.ss, meta: { ...s.ss.meta, name } } });
      await saveStructureSet();
    } else {
      const dims = p.imageSets.find((x) => x.id === p.structureSets.find((y) => y.id === id)!.imageSetId)!.dims;
      const loaded = await db.loadStructureSet(p.info.id, id, dims);
      await db.saveStructureSet(p.info.id, { ...loaded.meta, name }, loaded.masks);
    }
  } else {
    await persistRecord({ ...p, plans: p.plans.map((x) => (x.id === id ? { ...x, name } : x)) });
    if (s.plan?.meta.id === id) {
      set({ plan: { ...s.plan, meta: { ...s.plan.meta, name } } });
      await savePlan();
    } else {
      const pl = await db.loadPlan(p.info.id, id);
      await db.savePlan(p.info.id, { ...pl, name });
    }
  }
}

export function setStructureSetStatus(status: ItemStatus) {
  const s = get();
  if (!s.ss) return;
  set({ ss: { ...s.ss, meta: { ...s.ss.meta, status }, dirty: true } });
}

// ---------------------------------------------------------------- structures

async function ensureStructureSet() {
  if (!get().ss) await createStructureSet();
}

export async function addStructure(t: { name: string; color?: string; type: StructureType; templateKey?: string }): Promise<string> {
  await ensureStructureSet();
  const s = get();
  const ss = s.ss!;
  const tpl = t.templateKey ? s.lib.structures.find((x) => x.key === t.templateKey) : undefined;
  const id = newId('s');
  const meta: StructureMeta = {
    id,
    name: uniqueName(t.name, ss.meta.structures.map((x) => x.name)),
    color: t.color ?? tpl?.color ?? PALETTE[ss.meta.structures.length % PALETTE.length],
    type: t.type,
    visible: true,
    alphaBeta: tpl?.alphaBeta ?? (['GTV', 'CTV', 'ITV', 'PTV'].includes(t.type) ? 10 : 3),
    constraints: instantiateConstraints(tpl?.constraints ?? []),
    densityOverride: t.type === 'BOLUS' ? 1.0 : null,
    locked: false,
    templateKey: t.templateKey,
  };
  const masks = new Map(ss.masks);
  masks.set(id, new Mask(...s.ct!.meta.dims));
  set((st) => ({
    ss: { ...ss, meta: { ...ss.meta, structures: [...ss.meta.structures, meta] }, masks, dirty: true },
    selectedStructureId: id,
    ssVersion: st.ssVersion + 1,
  }));
  return id;
}

export function updateStructure(id: string, patch: Partial<StructureMeta>) {
  const ss = get().ss;
  if (!ss) return;
  set((st) => ({
    ss: { ...ss, meta: { ...ss.meta, structures: ss.meta.structures.map((x) => (x.id === id ? { ...x, ...patch } : x)) }, dirty: true },
    ssVersion: st.ssVersion + 1,
  }));
}

export function deleteStructure(id: string) {
  const ss = get().ss;
  if (!ss) return;
  const masks = new Map(ss.masks);
  masks.delete(id);
  set((st) => ({
    ss: { ...ss, meta: { ...ss.meta, structures: ss.meta.structures.filter((x) => x.id !== id) }, masks, dirty: true },
    selectedStructureId: st.selectedStructureId === id ? ss.meta.structures.find((x) => x.id !== id)?.id ?? null : st.selectedStructureId,
    ssVersion: st.ssVersion + 1,
    undo: st.undo.filter((u) => u.structureId !== id),
    redo: st.redo.filter((u) => u.structureId !== id),
  }));
}

export function moveStructure(id: string, dir: -1 | 1) {
  const ss = get().ss;
  if (!ss) return;
  const list = [...ss.meta.structures];
  const i = list.findIndex((x) => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  set((st) => ({ ss: { ...ss, meta: { ...ss.meta, structures: list }, dirty: true }, ssVersion: st.ssVersion + 1 }));
}

export const structureMeta = (id: string | null) => (id ? get().ss?.meta.structures.find((x) => x.id === id) ?? null : null);
export const maskOf = (id: string | null) => (id ? get().ss?.masks.get(id) ?? null : null);

/**
 * Edits a structure's mask with undo support. `slices` lists the axial slices the edit may touch (null = all).
 * The callback mutates the mask in place.
 */
export function editMask(structureId: string, slices: number[] | null, label: string, fn: (m: Mask) => void) {
  const s = get();
  const ss = s.ss;
  const m = ss?.masks.get(structureId);
  if (!ss || !m) return;
  const meta = ss.meta.structures.find((x) => x.id === structureId);
  if (meta?.locked) {
    toast(`${meta.name} is locked. Unlock it to edit.`, 'warn');
    return;
  }
  const snap = new Map<number, Uint8Array | null>();
  const ks = slices ?? [...Array(m.nz).keys()];
  for (const k of ks) if (k >= 0 && k < m.nz && !snap.has(k)) snap.set(k, m.slices[k] ? m.slices[k]!.slice() : null);
  fn(m);
  m.version++;
  const undo = [...s.undo, { ssId: ss.meta.id, structureId, slices: snap, label }].slice(-40);
  set((st) => ({ undo, redo: [], ss: { ...ss, dirty: true }, ssVersion: st.ssVersion + 1 }));
}

/** Replaces a structure's whole mask (e.g. after a margin or boolean), with undo. */
export function replaceMask(structureId: string, next: Mask, label: string) {
  editMask(structureId, null, label, (m) => m.assign(next));
}

function swapUndo(from: 'undo' | 'redo') {
  const s = get();
  const stack = [...s[from]];
  const entry = stack.pop();
  if (!entry || !s.ss || entry.ssId !== s.ss.meta.id) return;
  const m = s.ss.masks.get(entry.structureId);
  if (!m) return;
  const back = new Map<number, Uint8Array | null>();
  for (const [k, data] of entry.slices) {
    back.set(k, m.slices[k] ? m.slices[k]!.slice() : null);
    m.slices[k] = data ? data.slice() : null;
  }
  m.version++;
  const other = from === 'undo' ? 'redo' : 'undo';
  set((st) => ({
    [from]: stack,
    [other]: [...st[other], { ...entry, slices: back }],
    ss: st.ss ? { ...st.ss, dirty: true } : null,
    ssVersion: st.ssVersion + 1,
  }) as Partial<State>);
  toast(`${from === 'undo' ? 'Undid' : 'Redid'}: ${entry.label}`);
}
export const undo = () => swapUndo('undo');
export const redo = () => swapUndo('redo');

// ---------------------------------------------------------------- plans

export async function createPlan(meta: Omit<PlanMeta, 'id' | 'createdAt' | 'modifiedAt' | 'status' | 'planner' | 'mu' | 'calculatedAt' | 'calcSignature'>) {
  const s = get();
  const p = s.patient!;
  const plan: PlanMeta = {
    ...meta,
    name: uniqueName(meta.name, p.plans.map((x) => x.name)),
    id: newId('pl'), createdAt: now(), modifiedAt: now(), status: 'In progress', planner: s.lib.userName, mu: {}, calculatedAt: null, calcSignature: null,
  };
  await db.savePlan(p.info.id, plan);
  await persistRecord({ ...p, plans: [...p.plans, { id: plan.id, name: plan.name, structureSetId: plan.structureSetId, createdAt: plan.createdAt, modifiedAt: plan.modifiedAt, status: plan.status }] });
  set((st) => ({ plan: { meta: plan, dirty: false }, dose: null, selectedBeamId: plan.beams[0]?.id ?? null, planVersion: st.planVersion + 1 }));
  return plan.id;
}

export async function openPlan(id: string) {
  const s = get();
  const p = s.patient!;
  if (s.plan?.meta.id === id) return;
  if (!(await confirmDiscard())) return;
  await withBusy('Opening plan…', async () => {
    const plan = await db.loadPlan(p.info.id, id);
    if (get().ss?.meta.id !== plan.structureSetId) {
      set({ ss: null });
      await openStructureSet(plan.structureSetId);
    }
    const stored = await db.loadDose(p.info.id, id);
    set((st) => ({
      plan: { meta: plan, dirty: false },
      selectedBeamId: plan.beams[0]?.id ?? null,
      planVersion: st.planVersion + 1,
      dose: stored ? { grid: stored.grid, perBeam: stored.perBeam, signatures: stored.signatures, densitySignature: stored.densitySignature, total: null, maxDose: 0, maxAt: null } : null,
    }));
    if (stored) updateTotalDose();
  });
}

export async function savePlan() {
  const s = get();
  if (!s.plan || !s.patient) return;
  const meta = { ...s.plan.meta, modifiedAt: now() };
  await db.savePlan(s.patient.info.id, meta);
  if (s.dose && s.dose.perBeam.size) {
    await db.saveDose(s.patient.info.id, meta.id, { grid: s.dose.grid, signatures: s.dose.signatures, densitySignature: s.dose.densitySignature, perBeam: s.dose.perBeam });
  }
  await persistRecord({
    ...s.patient,
    plans: s.patient.plans.map((x) => (x.id === meta.id ? { ...x, name: meta.name, modifiedAt: meta.modifiedAt, status: meta.status } : x)),
  });
  set((st) => ({ plan: st.plan ? { meta, dirty: false } : null }));
}

export async function duplicatePlan(name: string) {
  const s = get();
  if (!s.plan) return;
  const src = s.plan.meta;
  const idMap = new Map<string, string>();
  const beams = src.beams.map((b) => {
    const id = newId('b');
    idMap.set(b.id, id);
    return { ...b, id, mlc: b.mlc ? { x1: [...b.mlc.x1], x2: [...b.mlc.x2] } : null };
  });
  const dose = s.dose;
  await createPlan({ ...src, name, beams, refPoints: src.refPoints.map((r) => ({ ...r })) });
  if (dose) {
    // Carry the calculated dose across (same geometry → same signatures)
    const perBeam = new Map<string, Float32Array>();
    const signatures: Record<string, string> = {};
    for (const [oid, nid] of idMap) {
      const d = dose.perBeam.get(oid);
      if (d) perBeam.set(nid, d);
      if (dose.signatures[oid]) signatures[nid] = dose.signatures[oid];
    }
    const mu: Record<string, number> = {};
    for (const [oid, nid] of idMap) if (src.mu[oid] !== undefined) mu[nid] = src.mu[oid];
    set((st) => ({ dose: { ...dose, perBeam, signatures }, plan: st.plan ? { ...st.plan, meta: { ...st.plan.meta, mu, calculatedAt: src.calculatedAt } } : null }));
    updateTotalDose();
    await savePlan();
  }
}

export async function deletePlanById(id: string) {
  const s = get();
  const p = s.patient!;
  await db.deletePlan(p.info.id, id);
  await persistRecord({ ...p, plans: p.plans.filter((x) => x.id !== id) });
  if (s.plan?.meta.id === id) set({ plan: null, dose: null });
}

export function updatePlan(patch: Partial<PlanMeta>, recalcMu = true) {
  const s = get();
  if (!s.plan) return;
  set((st) => ({ plan: { meta: { ...s.plan!.meta, ...patch }, dirty: true }, planVersion: st.planVersion + 1 }));
  if (recalcMu && get().dose) recomputeMU();
}

export function updateBeam(id: string, patch: Partial<Beam>) {
  const s = get();
  if (!s.plan) return;
  updatePlan({ beams: s.plan.meta.beams.map((b) => (b.id === id ? { ...b, ...patch } : b)) }, 'weight' in patch);
}

export function addBeams(beams: Beam[]) {
  const s = get();
  if (!s.plan) return;
  updatePlan({ beams: [...s.plan.meta.beams, ...beams] }, false);
  set({ selectedBeamId: beams[beams.length - 1]?.id ?? s.selectedBeamId });
}

export function deleteBeam(id: string) {
  const s = get();
  if (!s.plan) return;
  const beams = s.plan.meta.beams.filter((b) => b.id !== id);
  const mu = { ...s.plan.meta.mu };
  delete mu[id];
  updatePlan({ beams, mu }, false);
  if (s.dose) {
    const perBeam = new Map(s.dose.perBeam);
    perBeam.delete(id);
    set({ dose: { ...s.dose, perBeam } });
    recomputeMU();
  }
  set({ selectedBeamId: beams[0]?.id ?? null });
}

// ---------------------------------------------------------------- dose

function fnv(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
function hashRuns(h: number, runs: Uint32Array): number {
  for (let i = 0; i < runs.length; i++) {
    h ^= runs[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export function beamSignature(b: Beam): string {
  const m = machineById(b.machineId);
  const { weight: _w, name: _n, ...geom } = b;
  return fnv(fnv(2166136261, JSON.stringify(geom)), JSON.stringify(m)).toString(36);
}

export function calcRegion() {
  const s = get();
  const ss = s.ss!;
  const body = ss.meta.structures.find((x) => x.type === 'EXTERNAL');
  if (!body) throw new Error('Add a Body (External) structure first; dose is only calculated inside it.');
  const bodyMask = ss.masks.get(body.id)!;
  if (bodyMask.isEmpty()) throw new Error('The Body structure is empty. Use Auto-segment → Body.');
  const extras = ss.meta.structures.filter((x) => x.type === 'BOLUS').map((x) => ss.masks.get(x.id)!);
  const overrides = ss.meta.structures.filter((x) => x.densityOverride !== null && x.densityOverride !== undefined).map((x) => ({ mask: ss.masks.get(x.id)!, density: x.densityOverride! }));
  return { body: bodyMask, extras, overrides, bodyId: body.id };
}

export function densitySignature(): string {
  const s = get();
  const plan = s.plan!.meta;
  const r = calcRegion();
  let h = fnv(2166136261, JSON.stringify([plan.doseResolution, plan.heterogeneity, s.lib.huCurve, s.ss!.meta.id]));
  h = hashRuns(h, encodeMask(r.body));
  for (const m of r.extras) h = hashRuns(h, encodeMask(m));
  for (const o of r.overrides) h = hashRuns(fnv(h, String(o.density)), encodeMask(o.mask));
  return h.toString(36);
}

export function doseIsStale(): boolean {
  const s = get();
  if (!s.plan || !s.dose) return true;
  return s.plan.meta.beams.some((b) => s.dose!.signatures[b.id] !== beamSignature(b) || !s.dose!.perBeam.has(b.id));
}

let worker: Worker | null = null;

/** Calculates dose for beams whose geometry changed (or all, if the anatomy/density changed). */
export async function calculateDose(force = false) {
  const s = get();
  if (!s.plan || !s.ct || !s.ss) return;
  if (s.calc) return;
  const plan = s.plan.meta;
  if (!plan.beams.length) {
    toast('Add at least one beam before calculating.', 'warn');
    return;
  }
  let region;
  try {
    region = calcRegion();
  } catch (err) {
    toast((err as Error).message, 'error');
    return;
  }
  set({ calc: { label: 'Preparing density grid…', progress: 0 } });
  await new Promise((r) => setTimeout(r, 30));
  try {
    const dsig = densitySignature();
    const prev = s.dose && s.dose.densitySignature === dsig && !force ? s.dose : null;
    const grid = prev ? prev.grid : makeDoseGrid(s.ct.volume, region, plan.doseResolution);
    const todo = plan.beams.filter((b) => !prev || prev.signatures[b.id] !== beamSignature(b) || !prev.perBeam.has(b.id));
    const perBeam = new Map(prev?.perBeam ?? []);
    const signatures: Record<string, string> = { ...(prev?.signatures ?? {}) };
    for (const id of [...perBeam.keys()]) if (!plan.beams.some((b) => b.id === id)) perBeam.delete(id);
    if (todo.length) {
      const dg = buildDensity(s.ct.volume, region, grid, s.lib.huCurve);
      worker?.terminate();
      worker = new Worker(new URL('../core/dose/worker.ts', import.meta.url), { type: 'module' });
      await new Promise<void>((resolve, reject) => {
        worker!.onmessage = (ev: MessageEvent<DoseMessage>) => {
          const m = ev.data;
          if (m.type === 'progress') set({ calc: { label: `Calculating ${todo[m.beam].name} (${m.beam + 1}/${m.of})`, progress: (m.beam + m.fraction) / m.of } });
          else if (m.type === 'beam') {
            perBeam.set(m.id, m.data);
            signatures[m.id] = beamSignature(todo.find((b) => b.id === m.id)!);
          } else if (m.type === 'done') resolve();
          else if (m.type === 'error') reject(new Error(m.message));
        };
        worker!.onerror = (e) => reject(new Error(e.message || 'Dose worker failed'));
        worker!.postMessage({
          dg,
          beams: todo.map((beam) => ({ beam, machine: machineById(beam.machineId) })),
          heterogeneity: plan.heterogeneity,
        });
      });
      worker.terminate();
      worker = null;
    }
    set({ dose: { grid, perBeam, signatures, densitySignature: dsig, total: null, maxDose: 0, maxAt: null } });
    updatePlan({ calculatedAt: now() }, false);
    recomputeMU();
    toast(todo.length ? `Dose calculated (${todo.length} beam${todo.length > 1 ? 's' : ''}).` : 'Dose is up to date.', 'success');
  } catch (err) {
    toast(`Dose calculation failed: ${(err as Error).message}`, 'error');
  } finally {
    set({ calc: null });
  }
}

export function cancelCalculation() {
  worker?.terminate();
  worker = null;
  set({ calc: null });
  toast('Calculation cancelled.', 'warn');
}

/** Patient point used for normalisation. */
export function normPoint(): Vec3 | null {
  const plan = get().plan?.meta;
  if (!plan) return null;
  if (plan.prescription.normMode === 'refPoint') {
    const rp = plan.refPoints.find((r) => r.id === plan.prescription.refPointId);
    if (rp) return rp.pos;
  }
  return plan.beams[0]?.iso ?? null;
}

/** Fields whose open aperture doesn't comfortably contain the normalisation point (it sits in a penumbra or outside). */
export function fieldsMissingNormPoint(): string[] {
  const s = get();
  const plan = s.plan?.meta;
  const pt = normPoint();
  if (!plan || !pt || plan.prescription.normMode !== 'isocentre' && plan.prescription.normMode !== 'refPoint') return [];
  const out: string[] = [];
  for (const b of plan.beams) {
    const m = machineById(b.machineId);
    const ax = beamAxes(b, m.sad);
    const q = projectToIso(ax, pt, 'collimator');
    if (!q) continue;
    const [x, y] = q;
    const j = b.jaws;
    let inside = x > j.x1 + 5 && x < j.x2 - 5 && y > j.y1 + 5 && y < j.y2 - 5;
    if (inside && m.mlc && b.mlc) {
      const B = m.mlc.boundaries;
      for (let p = 0; p < B.length - 1; p++) {
        if (y >= B[p] && y < B[p + 1]) inside = x > b.mlc.x1[p] + 5 && x < b.mlc.x2[p] - 5;
      }
    }
    if (!inside) out.push(b.name);
  }
  return out;
}

/** MU per fraction from weights and prescription; then the total dose. */
export function recomputeMU() {
  const s = get();
  if (!s.plan || !s.dose) return;
  const plan = s.plan.meta;
  const rx = plan.prescription;
  const dFx = (rx.totalDose / Math.max(1, rx.fractions)) * 100; // cGy
  const mu: Record<string, number> = { ...plan.mu };
  if (rx.normMode !== 'none') {
    const pt = normPoint();
    const wSum = plan.beams.reduce((a, b) => a + Math.max(0, b.weight), 0) || 1;
    for (const b of plan.beams) {
      const d = s.dose.perBeam.get(b.id);
      if (!d || !pt) continue;
      let dpmu = sampleGrid(s.dose.grid, d, pt);
      if (dpmu < 1e-4) {
        // The beam misses the normalisation point: weight it at its own isocentre instead
        dpmu = sampleGrid(s.dose.grid, d, b.iso);
      }
      if (dpmu < 1e-4) {
        let mx = 0;
        for (const v of d) if (v > mx) mx = v;
        dpmu = mx * 0.8;
      }
      mu[b.id] = dpmu > 0 ? ((b.weight / wSum) * dFx * (rx.normPercent / 100)) / dpmu : 0;
    }
  }
  set((st) => ({ plan: st.plan ? { ...st.plan, meta: { ...st.plan.meta, mu } } : null }));
  updateTotalDose();
  // Volume-based normalisation scales every beam together
  if ((rx.normMode === 'targetMean' || rx.normMode === 'targetMedian' || rx.normMode === 'targetD95') && rx.targetId) {
    const st = get();
    const m = st.ss?.masks.get(rx.targetId);
    if (m && st.dose?.total && st.ct) {
      const dvh = computeDVH(m, st.ct.volume, st.dose.grid, st.dose.total, 60000);
      if (dvh) {
        const metric = rx.normMode === 'targetMean' ? dvh.mean : rx.normMode === 'targetMedian' ? dAt(dvh, 0.5) : dAt(dvh, 0.95);
        if (metric > 0) {
          const factor = (rx.totalDose * rx.normPercent) / 100 / metric;
          const scaled: Record<string, number> = {};
          for (const [k, v] of Object.entries(mu)) scaled[k] = v * factor;
          set((x) => ({ plan: x.plan ? { ...x.plan, meta: { ...x.plan.meta, mu: scaled } } : null }));
          updateTotalDose();
        }
      }
    }
  }
}

/** Sums the per-beam dose into the course total (Gy). */
export function updateTotalDose() {
  const s = get();
  if (!s.plan || !s.dose) return;
  const plan = s.plan.meta;
  const { grid } = s.dose;
  const n = grid.dims[0] * grid.dims[1] * grid.dims[2];
  const total = new Float32Array(n);
  const fx = plan.prescription.fractions;
  for (const b of plan.beams) {
    const d = s.dose.perBeam.get(b.id);
    const mu = plan.mu[b.id] ?? 0;
    if (!d || !mu) continue;
    const f = (mu * fx) / 100;
    for (let p = 0; p < n; p++) total[p] += d[p] * f;
  }
  let max = 0, at = -1;
  for (let p = 0; p < n; p++) if (total[p] > max) { max = total[p]; at = p; }
  let maxAt: Vec3 | null = null;
  if (at >= 0) {
    const i = at % grid.dims[0], j = Math.floor(at / grid.dims[0]) % grid.dims[1], k = Math.floor(at / (grid.dims[0] * grid.dims[1]));
    maxAt = [grid.origin[0] + i * grid.spacing[0], grid.origin[1] + j * grid.spacing[1], grid.origin[2] + k * grid.spacing[2]];
  }
  set((st) => ({ dose: st.dose ? { ...st.dose, total, maxDose: max, maxAt } : null, doseVersion: st.doseVersion + 1 }));
}

// ---------------------------------------------------------------- coordinates

export const voxelToPatient = (v: Pick<Volume, 'origin' | 'spacing'>, p: Vec3): Vec3 => [
  v.origin[0] + p[0] * v.spacing[0], v.origin[1] + p[1] * v.spacing[1], v.origin[2] + p[2] * v.spacing[2],
];
export const patientToVoxel = (v: Pick<Volume, 'origin' | 'spacing'>, p: Vec3): Vec3 => [
  (p[0] - v.origin[0]) / v.spacing[0], (p[1] - v.origin[1]) / v.spacing[1], (p[2] - v.origin[2]) / v.spacing[2],
];

export function setCursorPatient(p: Vec3) {
  const ct = get().ct;
  if (!ct) return;
  const v = patientToVoxel(ct.volume, p);
  const d = ct.meta.dims;
  set({ cursor: [Math.min(d[0] - 1, Math.max(0, v[0])), Math.min(d[1] - 1, Math.max(0, v[1])), Math.min(d[2] - 1, Math.max(0, Math.round(v[2])))] });
}

// ---------------------------------------------------------------- strokes (brush / pen) with lazy undo snapshots

export interface Stroke {
  mask: Mask;
  /** Call before changing slice k (snapshots it the first time). */
  touch(k: number): void;
  /** Redraw while drawing. */
  changed(): void;
  end(label: string): void;
}

export function beginStroke(structureId: string): Stroke | null {
  const s = get();
  const ss = s.ss;
  const m = ss?.masks.get(structureId);
  if (!ss || !m) return null;
  const meta = ss.meta.structures.find((x) => x.id === structureId);
  if (meta?.locked) {
    toast(`${meta.name} is locked. Unlock it to edit.`, 'warn');
    return null;
  }
  if (!meta?.visible) updateStructure(structureId, { visible: true });
  const snap = new Map<number, Uint8Array | null>();
  return {
    mask: m,
    touch(k) {
      if (k < 0 || k >= m.nz || snap.has(k)) return;
      snap.set(k, m.slices[k] ? m.slices[k]!.slice() : null);
    },
    changed() {
      m.version++;
      set((st) => ({ ssVersion: st.ssVersion + 1 }));
    },
    end(label) {
      if (!snap.size) return;
      for (const k of snap.keys()) m.compact(k);
      m.version++;
      set((st) => ({
        undo: [...st.undo, { ssId: ss.meta.id, structureId, slices: snap, label }].slice(-40),
        redo: [],
        ss: st.ss ? { ...st.ss, dirty: true } : null,
        ssVersion: st.ssVersion + 1,
      }));
    },
  };
}

export function bumpSS() {
  set((st) => ({ ssVersion: st.ssVersion + 1 }));
}
