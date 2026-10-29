// Catalogue of organs PlanLab can auto-contour with the TotalSegmentator model, and the post-processing that turns
// its labels into planning structures (e.g. lungs from lobes, femoral heads cut at the lesser trochanter level,
// and an RTOG-style bowel bag built around the bowel loops).
import { Mask } from './mask.ts';
import { applyMargins, booleanOp, fillHoles, uniformMargins } from './maskOps.ts';
import type { StructureType, Vec3 } from './types.ts';

export type AiRegion = 'Pelvis' | 'Abdomen' | 'Thorax' | 'Head, neck & CNS' | 'Bones' | 'Vessels';
export const AI_REGIONS: AiRegion[] = ['Pelvis', 'Abdomen', 'Thorax', 'Head, neck & CNS', 'Bones', 'Vessels'];

export type Derived = 'bowelbag' | 'femhead_l' | 'femhead_r';

export interface AiOrgan {
  key: string;
  name: string; // structure name created in PlanLab
  region: AiRegion;
  ts: string[]; // TotalSegmentator classes combined (union)
  type: StructureType;
  template?: string; // structure-library key (colour, α/β, tolerance doses)
  color?: string;
  derived?: Derived;
  needs?: string[]; // extra classes the post-processing uses
  note?: string;
}

const VERTEBRAE = ['vertebrae_S1', 'vertebrae_L5', 'vertebrae_L4', 'vertebrae_L3', 'vertebrae_L2', 'vertebrae_L1', 'vertebrae_T12', 'vertebrae_T11', 'vertebrae_T10', 'vertebrae_T9', 'vertebrae_T8', 'vertebrae_T7', 'vertebrae_T6', 'vertebrae_T5', 'vertebrae_T4', 'vertebrae_T3', 'vertebrae_T2', 'vertebrae_T1', 'vertebrae_C7', 'vertebrae_C6', 'vertebrae_C5', 'vertebrae_C4', 'vertebrae_C3', 'vertebrae_C2', 'vertebrae_C1'];
const RIBS = [...Array(12).keys()].flatMap((n) => [`rib_left_${n + 1}`, `rib_right_${n + 1}`]);
const PELVIC_MUSCLES = ['iliopsoas_left', 'iliopsoas_right', 'gluteus_maximus_left', 'gluteus_maximus_right', 'gluteus_medius_left', 'gluteus_medius_right', 'gluteus_minimus_left', 'gluteus_minimus_right', 'autochthon_left', 'autochthon_right'];
const PELVIC_BONES = ['hip_left', 'hip_right', 'sacrum', 'femur_left', 'femur_right', 'vertebrae_S1', 'vertebrae_L5', 'vertebrae_L4', 'vertebrae_L3'];

export const AI_ORGANS: AiOrgan[] = [
  // Pelvis
  { key: 'bowelbag', name: 'Bowel bag', region: 'Pelvis', ts: ['small_bowel', 'colon', 'duodenum'], type: 'OAR', template: 'small_bowel', derived: 'bowelbag', needs: [...PELVIC_BONES, ...PELVIC_MUSCLES, 'urinary_bladder', 'prostate', 'iliac_artery_left', 'iliac_artery_right', 'iliac_vena_left', 'iliac_vena_right'], note: 'Space around the bowel loops (RTOG style), excluding bones, muscles, bladder and iliac vessels' },
  { key: 'bladder', name: 'Bladder', region: 'Pelvis', ts: ['urinary_bladder'], type: 'OAR', template: 'bladder' },
  { key: 'prostate', name: 'Prostate', region: 'Pelvis', ts: ['prostate'], type: 'OAR', template: 'prostate' },
  { key: 'small_bowel', name: 'Small bowel', region: 'Pelvis', ts: ['small_bowel'], type: 'OAR', color: '#f4a460', note: 'Individual loops' },
  { key: 'colon', name: 'Colon', region: 'Pelvis', ts: ['colon'], type: 'OAR', color: '#c08040', note: 'Includes sigmoid; the rectum must still be drawn by hand' },
  { key: 'femhead_l', name: 'Femoral head L', region: 'Pelvis', ts: ['femur_left'], type: 'OAR', template: 'femur_l', derived: 'femhead_l', needs: ['hip_left'], note: 'Head and neck down to the lesser-trochanter level' },
  { key: 'femhead_r', name: 'Femoral head R', region: 'Pelvis', ts: ['femur_right'], type: 'OAR', template: 'femur_r', derived: 'femhead_r', needs: ['hip_right'], note: 'Head and neck down to the lesser-trochanter level' },
  { key: 'pelvic_bones', name: 'Pelvic bones', region: 'Pelvis', ts: ['hip_left', 'hip_right', 'sacrum'], type: 'OAR', color: '#e6e6c8', note: 'Bone marrow sparing' },
  // Abdomen
  { key: 'liver', name: 'Liver', region: 'Abdomen', ts: ['liver'], type: 'OAR', template: 'liver' },
  { key: 'kidney_l', name: 'Kidney L', region: 'Abdomen', ts: ['kidney_left', 'kidney_cyst_left'], type: 'OAR', template: 'kidney_l' },
  { key: 'kidney_r', name: 'Kidney R', region: 'Abdomen', ts: ['kidney_right', 'kidney_cyst_right'], type: 'OAR', template: 'kidney_r' },
  { key: 'spleen', name: 'Spleen', region: 'Abdomen', ts: ['spleen'], type: 'OAR', template: 'spleen' },
  { key: 'stomach', name: 'Stomach', region: 'Abdomen', ts: ['stomach'], type: 'OAR', template: 'stomach' },
  { key: 'duodenum', name: 'Duodenum', region: 'Abdomen', ts: ['duodenum'], type: 'OAR', template: 'duodenum' },
  { key: 'pancreas', name: 'Pancreas', region: 'Abdomen', ts: ['pancreas'], type: 'OAR', color: '#d8a0d8' },
  { key: 'gallbladder', name: 'Gallbladder', region: 'Abdomen', ts: ['gallbladder'], type: 'OAR', color: '#6b8e23' },
  // Thorax
  { key: 'lung_l', name: 'Lung L', region: 'Thorax', ts: ['lung_upper_lobe_left', 'lung_lower_lobe_left'], type: 'OAR', template: 'lung_l' },
  { key: 'lung_r', name: 'Lung R', region: 'Thorax', ts: ['lung_upper_lobe_right', 'lung_middle_lobe_right', 'lung_lower_lobe_right'], type: 'OAR', template: 'lung_r' },
  { key: 'lungs', name: 'Lungs (total)', region: 'Thorax', ts: ['lung_upper_lobe_left', 'lung_lower_lobe_left', 'lung_upper_lobe_right', 'lung_middle_lobe_right', 'lung_lower_lobe_right'], type: 'OAR', template: 'lungs' },
  { key: 'heart', name: 'Heart', region: 'Thorax', ts: ['heart', 'atrial_appendage_left'], type: 'OAR', template: 'heart' },
  { key: 'esophagus', name: 'Oesophagus', region: 'Thorax', ts: ['esophagus'], type: 'OAR', template: 'esophagus' },
  { key: 'trachea', name: 'Trachea', region: 'Thorax', ts: ['trachea'], type: 'OAR', template: 'trachea' },
  // Head, neck & CNS
  { key: 'spinal_cord', name: 'Spinal cord', region: 'Head, neck & CNS', ts: ['spinal_cord'], type: 'OAR', template: 'spinal_cord' },
  { key: 'brain', name: 'Brain', region: 'Head, neck & CNS', ts: ['brain'], type: 'OAR', template: 'brain' },
  { key: 'thyroid', name: 'Thyroid', region: 'Head, neck & CNS', ts: ['thyroid_gland'], type: 'OAR', template: 'thyroid' },
  // Bones
  { key: 'vertebrae', name: 'Vertebrae', region: 'Bones', ts: VERTEBRAE, type: 'OAR', color: '#f0e68c' },
  { key: 'sacrum', name: 'Sacrum', region: 'Bones', ts: ['sacrum'], type: 'OAR', color: '#eee8aa' },
  { key: 'femur_l_full', name: 'Femur L', region: 'Bones', ts: ['femur_left'], type: 'OAR', color: '#ffd27f' },
  { key: 'femur_r_full', name: 'Femur R', region: 'Bones', ts: ['femur_right'], type: 'OAR', color: '#ffc04d' },
  { key: 'ribs', name: 'Ribs', region: 'Bones', ts: RIBS, type: 'OAR', color: '#e8dcb8' },
  { key: 'sternum', name: 'Sternum', region: 'Bones', ts: ['sternum'], type: 'OAR', color: '#dcd0a0' },
  { key: 'humerus_l', name: 'Humeral head L', region: 'Bones', ts: ['humerus_left'], type: 'OAR', color: '#d2b48c' },
  { key: 'humerus_r', name: 'Humeral head R', region: 'Bones', ts: ['humerus_right'], type: 'OAR', color: '#c8a878' },
  // Vessels
  { key: 'aorta', name: 'Aorta', region: 'Vessels', ts: ['aorta'], type: 'OAR', color: '#e53935' },
  { key: 'ivc', name: 'Inferior vena cava', region: 'Vessels', ts: ['inferior_vena_cava'], type: 'OAR', color: '#3f51b5' },
  { key: 'iliac_vessels', name: 'Iliac vessels', region: 'Vessels', ts: ['iliac_artery_left', 'iliac_artery_right', 'iliac_vena_left', 'iliac_vena_right'], type: 'CONTROL', color: '#ef5350', note: 'Guide for pelvic nodal CTV (vessels + 7 mm)' },
];

/** All TotalSegmentator classes needed for a set of organs. */
export function classesFor(keys: string[]): string[] {
  const set = new Set<string>();
  for (const k of keys) {
    const o = AI_ORGANS.find((x) => x.key === k);
    if (!o) continue;
    o.ts.forEach((c) => set.add(c));
    o.needs?.forEach((c) => set.add(c));
  }
  return [...set];
}

/** Mask of every voxel whose label is one of `ids`. */
export function labelMask(labels: Uint8Array, dims: Vec3, ids: Set<number>): Mask {
  const [nx, ny, nz] = dims;
  const m = new Mask(nx, ny, nz);
  const per = nx * ny;
  for (let k = 0; k < nz; k++) {
    let s: Uint8Array | null = null;
    const base = k * per;
    for (let p = 0; p < per; p++) {
      if (ids.has(labels[base + p])) {
        if (!s) s = m.slice(k, true)!;
        s[p] = 1;
      }
    }
  }
  return m;
}

export interface BowelBagOptions {
  /** Superior limit: none, the top of L5 (L4/L5 interspace), or a given z (mm), e.g. 2 cm above the PTV. */
  superior: { kind: 'none' } | { kind: 'l5' } | { kind: 'z'; z: number };
}

/**
 * Builds the structure for one catalogue organ from the label volume.
 * `idsOf` maps class names to label ids; `zOfSlice` gives the patient z (mm) of an axial slice.
 */
export function buildOrgan(o: AiOrgan, labels: Uint8Array, dims: Vec3, spacing: Vec3, idsOf: (names: string[]) => Set<number>, zOfSlice: (k: number) => number, body: Mask | null, bowel: BowelBagOptions): Mask {
  const base = labelMask(labels, dims, idsOf(o.ts));
  if (!o.derived) return base;
  if (o.derived === 'femhead_l' || o.derived === 'femhead_r') {
    // Head and neck: the part of the femur above the lowest point of the same-side hip bone (ischial tuberosity),
    // which lies at about the level of the lesser trochanter.
    const hip = labelMask(labels, dims, idsOf([o.derived === 'femhead_l' ? 'hip_left' : 'hip_right']));
    let kLow = -1;
    for (let k = 0; k < hip.nz; k++) if (hip.hasSlice(k)) { kLow = k; break; }
    if (kLow > 0) for (let k = 0; k < kLow; k++) base.slices[k] = null;
    base.version++;
    return base;
  }
  // Bowel bag: bowel loops, closed by 10 mm to take in the spaces between loops (mesentery), holes filled slice by
  // slice, then bones, muscles, bladder, prostate and iliac vessels removed; limited to the Body and the chosen extent.
  if (base.isEmpty()) return base;
  let bag = applyMargins(base, spacing, uniformMargins(10));
  bag = applyMargins(bag, spacing, uniformMargins(-10));
  bag = booleanOp(bag, base, 'union');
  fillHoles(bag);
  const exclude = labelMask(labels, dims, idsOf([...PELVIC_BONES, ...PELVIC_MUSCLES, 'urinary_bladder', 'prostate', 'iliac_artery_left', 'iliac_artery_right', 'iliac_vena_left', 'iliac_vena_right', ...VERTEBRAE]));
  bag = booleanOp(bag, exclude, 'subtract');
  if (body) bag = booleanOp(bag, body, 'intersect');
  let zTop = Infinity;
  if (bowel.superior.kind === 'z') zTop = bowel.superior.z;
  if (bowel.superior.kind === 'l5') {
    const l5 = labelMask(labels, dims, idsOf(['vertebrae_L5']));
    for (let k = l5.nz - 1; k >= 0; k--) if (l5.hasSlice(k)) { zTop = zOfSlice(k); break; }
  }
  if (isFinite(zTop)) for (let k = 0; k < bag.nz; k++) if (zOfSlice(k) > zTop) bag.slices[k] = null;
  bag.version++;
  return bag;
}
