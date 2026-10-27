// Planning helpers: beam templates, auto-MLC / jaw fitting, SSD, isocentre placement.
import type { Beam, Vec3 } from '../core/types.ts';
import { useStore, machineById, voxelToPatient } from './store.ts';
import { beamAxes, beamLabel, rayEntry, normAngle } from '../core/geometry.ts';
import { projectStructure, growRaster, fitMlc, openMlc, clampJaws, rasterBounds, type MlcFit } from '../core/bev.ts';
import { centroid } from '../core/maskOps.ts';
import { newId } from '../core/templates.ts';
import type { Machine } from '../core/machines.ts';

export type Technique = 'single' | 'appa' | 'box4' | 'three' | 'laterals' | 'tangents' | 'custom';

export const TECHNIQUES: { value: Technique; label: string; angles: number[]; hint: string }[] = [
  { value: 'single', label: 'Single field (AP)', angles: [0], hint: 'One anterior field, e.g. supraclavicular or spine' },
  { value: 'appa', label: 'Parallel opposed AP/PA', angles: [0, 180], hint: 'Palliative, whole-pelvis, mediastinum' },
  { value: 'box4', label: '4-field box', angles: [0, 270, 90, 180], hint: 'Pelvis (cervix, rectum, bladder, prostate)' },
  { value: 'three', label: '3-field (AP + wedged laterals)', angles: [0, 90, 270], hint: 'Rectum / bladder: posterior PA + wedged laterals also common' },
  { value: 'laterals', label: 'Parallel opposed laterals', angles: [90, 270], hint: 'Larynx, whole brain' },
  { value: 'tangents', label: 'Breast tangents (wedged)', angles: [50, 230], hint: 'Medial/lateral tangents; set angles for the patient' },
  { value: 'custom', label: 'Empty (add beams yourself)', angles: [], hint: '' },
];

const BOX_NAMES: Record<number, string> = { 0: 'AP', 90: 'LT LAT', 180: 'PA', 270: 'RT LAT' };

export function makeBeam(machine: Machine, gantry: number, iso: Vec3, energy?: string, name?: string): Beam {
  const jaws = { x1: -50, x2: 50, y1: -50, y2: 50 };
  return {
    id: newId('b'),
    name: name ?? BOX_NAMES[normAngle(gantry)] ?? beamLabel(gantry),
    machineId: machine.id,
    energy: energy ?? machine.energies[0].name,
    gantry: normAngle(gantry),
    collimator: 0,
    couch: 0,
    iso: [...iso] as Vec3,
    jaws,
    mlc: openMlc(machine, jaws),
    wedge: { type: 'none', angle: 0, orientation: 'left' },
    weight: 1,
    autoMlc: null,
  };
}

/** Centre of a structure in patient coordinates (rounded to 1 mm). */
export function structureCentre(id: string): Vec3 | null {
  const s = useStore.getState();
  const m = s.ss?.masks.get(id);
  if (!m || !s.ct) return null;
  const c = centroid(m);
  if (!c) return null;
  return voxelToPatient(s.ct.volume, c).map((v) => Math.round(v)) as Vec3;
}

/** Shapes a beam to a structure: MLC leaves (if any) and jaws, with a BEV margin. */
export function conformBeam(beam: Beam, structureId: string, margin: number, fit: MlcFit = 'outside'): Beam {
  const s = useStore.getState();
  const m = s.ss?.masks.get(structureId);
  if (!m || !s.ct || m.isEmpty()) return beam;
  const machine = machineById(beam.machineId);
  const ax = beamAxes(beam, machine.sad);
  const sil = projectStructure(m, s.ct.volume, ax, 'collimator', 1, 260);
  if (!sil) return beam;
  const grown = growRaster(sil, margin);
  if (machine.mlc) {
    const r = fitMlc(machine, grown, fit);
    if (!r) return beam;
    return { ...beam, jaws: clampJaws(machine, r.jaws), mlc: r.mlc, autoMlc: { structureId, margin, fit } };
  }
  const b = rasterBounds(grown);
  if (!b) return beam;
  return { ...beam, jaws: clampJaws(machine, { x1: Math.floor(b.x1), x2: Math.ceil(b.x2), y1: Math.floor(b.y1), y2: Math.ceil(b.y2) }), autoMlc: { structureId, margin, fit } };
}

/** Re-runs auto-MLC for beams that follow a structure (after gantry/collimator/isocentre changes). */
export function refitIfAuto(beam: Beam): Beam {
  return beam.autoMlc ? conformBeam(beam, beam.autoMlc.structureId, beam.autoMlc.margin, beam.autoMlc.fit) : beam;
}

/** Source–skin distance along the central axis (mm), or null if the beam misses the Body. */
export function ssdOf(beam: Beam): number | null {
  const s = useStore.getState();
  const ss = s.ss, ct = s.ct;
  const body = ss?.meta.structures.find((x) => x.type === 'EXTERNAL');
  if (!ss || !ct || !body) return null;
  const m = ss.masks.get(body.id)!;
  const machine = machineById(beam.machineId);
  const ax = beamAxes(beam, machine.sad);
  const { origin, spacing } = ct.volume;
  const inside = (p: Vec3) => {
    const i = Math.round((p[0] - origin[0]) / spacing[0]), j = Math.round((p[1] - origin[1]) / spacing[1]), k = Math.round((p[2] - origin[2]) / spacing[2]);
    return m.get(i, j, k) === 1;
  };
  const extras = ss.meta.structures.filter((x) => x.type === 'BOLUS').map((x) => ss.masks.get(x.id)!);
  const insideAny = (p: Vec3) => {
    if (inside(p)) return true;
    const i = Math.round((p[0] - origin[0]) / spacing[0]), j = Math.round((p[1] - origin[1]) / spacing[1]), k = Math.round((p[2] - origin[2]) / spacing[2]);
    return extras.some((e) => e.get(i, j, k) === 1);
  };
  return rayEntry(ax.source, ax.dir, insideAny, machine.sad * 1.6, 2);
}

/** Depth of the isocentre along the central axis (mm). */
export function isoDepth(beam: Beam): number | null {
  const ssd = ssdOf(beam);
  return ssd === null ? null : machineById(beam.machineId).sad - ssd;
}

/** Wedge orientation (heel side in the collimator frame, collimator 0) that puts the thick end anteriorly. */
export function heelAnterior(gantry: number): 'left' | 'right' {
  return Math.sin((gantry * Math.PI) / 180) > 0 ? 'left' : 'right';
}

export function templateBeams(t: Technique, machine: Machine, energy: string, iso: Vec3, targetId: string | null, margin: number): Beam[] {
  const def = TECHNIQUES.find((x) => x.value === t)!;
  return def.angles.map((g, n) => {
    let b = makeBeam(machine, g, iso, energy, t === 'tangents' ? (n === 0 ? 'Medial tangent' : 'Lateral tangent') : undefined);
    if (t === 'three' && g !== 0) b.wedge = { type: machine.virtualWedge ? 'virtual' : 'physical', angle: 30, orientation: heelAnterior(g) };
    if (t === 'tangents') b.wedge = { type: machine.virtualWedge ? 'virtual' : 'physical', angle: 15, orientation: heelAnterior(g) };
    if (t === 'three') b.weight = g === 0 ? 1 : 0.6;
    if (targetId) b = conformBeam(b, targetId, margin);
    return b;
  });
}
