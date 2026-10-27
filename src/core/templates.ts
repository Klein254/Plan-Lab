// Default structure library: names, colours, types, α/β and dose constraints (conventional fractionation,
// based on QUANTEC / common departmental protocols). Everything here is editable in Library → Structures.
import type { Constraint, StructureType } from './types.ts';

export interface StructureTemplate {
  key: string;
  name: string;
  color: string;
  type: StructureType;
  site: 'General' | 'Targets' | 'Head & Neck' | 'Thorax' | 'Abdomen' | 'Pelvis' | 'CNS';
  alphaBeta: number;
  constraints: Omit<Constraint, 'id'>[];
}

const max = (limit: number, priority: Constraint['priority'] = 'mandatory', note?: string): Omit<Constraint, 'id'> =>
  ({ metric: 'Dmax', limit, limitUnit: 'Gy', cmp: '<', priority, note });
const mean = (limit: number, priority: Constraint['priority'] = 'mandatory', note?: string): Omit<Constraint, 'id'> =>
  ({ metric: 'Dmean', limit, limitUnit: 'Gy', cmp: '<', priority, note });
const vPct = (doseGy: number, limitPct: number, priority: Constraint['priority'] = 'mandatory'): Omit<Constraint, 'id'> =>
  ({ metric: 'V', param: doseGy, paramUnit: 'Gy', limit: limitPct, limitUnit: '%', cmp: '<', priority });
const vCc = (doseGy: number, limitCc: number, priority: Constraint['priority'] = 'mandatory'): Omit<Constraint, 'id'> =>
  ({ metric: 'V', param: doseGy, paramUnit: 'Gy', limit: limitCc, limitUnit: 'cc', cmp: '<', priority });
const dCc = (cc: number, limitGy: number, priority: Constraint['priority'] = 'mandatory'): Omit<Constraint, 'id'> =>
  ({ metric: 'D', param: cc, paramUnit: 'cc', limit: limitGy, limitUnit: 'Gy', cmp: '<', priority });

// Target coverage goals, relative to the prescription
const targetGoals: Omit<Constraint, 'id'>[] = [
  { metric: 'D', param: 95, paramUnit: '%', limit: 95, limitUnit: '%Rx', cmp: '>', priority: 'mandatory', note: 'ICRU: 95% of the PTV gets ≥95% of Rx' },
  { metric: 'D', param: 2, paramUnit: '%', limit: 107, limitUnit: '%Rx', cmp: '<', priority: 'mandatory', note: 'Near-max ≤107% of Rx' },
  { metric: 'Dmax', limit: 110, limitUnit: '%Rx', cmp: '<', priority: 'optimal' },
];

export const STRUCTURE_LIBRARY: StructureTemplate[] = [
  // General
  { key: 'body', name: 'Body', color: '#f2d22e', type: 'EXTERNAL', site: 'General', alphaBeta: 3, constraints: [] },
  { key: 'bolus', name: 'Bolus', color: '#8fd3ff', type: 'BOLUS', site: 'General', alphaBeta: 3, constraints: [] },
  { key: 'couch', name: 'Couch', color: '#6b7280', type: 'SUPPORT', site: 'General', alphaBeta: 3, constraints: [] },
  { key: 'bones', name: 'Bones', color: '#e7e5e4', type: 'OAR', site: 'General', alphaBeta: 3, constraints: [] },
  // Targets
  { key: 'gtv', name: 'GTV', color: '#ff2d2d', type: 'GTV', site: 'Targets', alphaBeta: 10, constraints: [] },
  { key: 'gtvn', name: 'GTVn', color: '#ff7a00', type: 'GTV', site: 'Targets', alphaBeta: 10, constraints: [] },
  { key: 'ctv', name: 'CTV', color: '#ff4fd8', type: 'CTV', site: 'Targets', alphaBeta: 10, constraints: [] },
  { key: 'ctvn', name: 'CTVn', color: '#ffb000', type: 'CTV', site: 'Targets', alphaBeta: 10, constraints: [] },
  { key: 'itv', name: 'ITV', color: '#c084fc', type: 'ITV', site: 'Targets', alphaBeta: 10, constraints: [] },
  { key: 'ptv', name: 'PTV', color: '#22d3ee', type: 'PTV', site: 'Targets', alphaBeta: 10, constraints: targetGoals },
  { key: 'ptvn', name: 'PTVn', color: '#38bdf8', type: 'PTV', site: 'Targets', alphaBeta: 10, constraints: targetGoals },
  { key: 'ptv_boost', name: 'PTV_Boost', color: '#0ea5e9', type: 'PTV', site: 'Targets', alphaBeta: 10, constraints: targetGoals },
  // CNS
  { key: 'brain', name: 'Brain', color: '#f9a8d4', type: 'OAR', site: 'CNS', alphaBeta: 2, constraints: [vCc(60, 0, 'optimal'), max(60, 'optimal')] },
  { key: 'brainstem', name: 'Brainstem', color: '#a3e635', type: 'OAR', site: 'CNS', alphaBeta: 2, constraints: [max(54), dCc(1, 59, 'optimal')] },
  { key: 'spinal_cord', name: 'Spinal cord', color: '#fde047', type: 'OAR', site: 'CNS', alphaBeta: 2, constraints: [max(45, 'mandatory', 'QUANTEC: 50 Gy → 0.2% myelopathy')] },
  { key: 'optic_chiasm', name: 'Optic chiasm', color: '#fb923c', type: 'OAR', site: 'CNS', alphaBeta: 2, constraints: [max(54)] },
  { key: 'optic_nerve_r', name: 'Optic nerve R', color: '#f97316', type: 'OAR', site: 'CNS', alphaBeta: 2, constraints: [max(54)] },
  { key: 'optic_nerve_l', name: 'Optic nerve L', color: '#ea580c', type: 'OAR', site: 'CNS', alphaBeta: 2, constraints: [max(54)] },
  { key: 'eye_r', name: 'Eye R', color: '#60a5fa', type: 'OAR', site: 'CNS', alphaBeta: 3, constraints: [max(45), mean(35, 'optimal')] },
  { key: 'eye_l', name: 'Eye L', color: '#3b82f6', type: 'OAR', site: 'CNS', alphaBeta: 3, constraints: [max(45), mean(35, 'optimal')] },
  { key: 'lens_r', name: 'Lens R', color: '#a78bfa', type: 'OAR', site: 'CNS', alphaBeta: 1.2, constraints: [max(7)] },
  { key: 'lens_l', name: 'Lens L', color: '#8b5cf6', type: 'OAR', site: 'CNS', alphaBeta: 1.2, constraints: [max(7)] },
  { key: 'cochlea_r', name: 'Cochlea R', color: '#2dd4bf', type: 'OAR', site: 'CNS', alphaBeta: 3, constraints: [mean(45)] },
  { key: 'cochlea_l', name: 'Cochlea L', color: '#14b8a6', type: 'OAR', site: 'CNS', alphaBeta: 3, constraints: [mean(45)] },
  { key: 'pituitary', name: 'Pituitary', color: '#e879f9', type: 'OAR', site: 'CNS', alphaBeta: 2, constraints: [max(45, 'optimal')] },
  // Head & neck
  { key: 'parotid_r', name: 'Parotid R', color: '#34d399', type: 'OAR', site: 'Head & Neck', alphaBeta: 3, constraints: [mean(26), vPct(30, 50, 'optimal')] },
  { key: 'parotid_l', name: 'Parotid L', color: '#10b981', type: 'OAR', site: 'Head & Neck', alphaBeta: 3, constraints: [mean(26), vPct(30, 50, 'optimal')] },
  { key: 'submandibular_r', name: 'Submandibular R', color: '#86efac', type: 'OAR', site: 'Head & Neck', alphaBeta: 3, constraints: [mean(39, 'optimal')] },
  { key: 'submandibular_l', name: 'Submandibular L', color: '#4ade80', type: 'OAR', site: 'Head & Neck', alphaBeta: 3, constraints: [mean(39, 'optimal')] },
  { key: 'oral_cavity', name: 'Oral cavity', color: '#fca5a5', type: 'OAR', site: 'Head & Neck', alphaBeta: 3, constraints: [mean(30, 'optimal')] },
  { key: 'mandible', name: 'Mandible', color: '#d6d3d1', type: 'OAR', site: 'Head & Neck', alphaBeta: 3, constraints: [max(70), dCc(1, 66, 'optimal')] },
  { key: 'larynx', name: 'Larynx', color: '#c4b5fd', type: 'OAR', site: 'Head & Neck', alphaBeta: 3, constraints: [mean(44), max(66, 'optimal')] },
  { key: 'pharynx_constrictors', name: 'Pharyngeal constrictors', color: '#f0abfc', type: 'OAR', site: 'Head & Neck', alphaBeta: 3, constraints: [mean(50, 'optimal')] },
  { key: 'thyroid', name: 'Thyroid', color: '#fdba74', type: 'OAR', site: 'Head & Neck', alphaBeta: 3, constraints: [vPct(45, 50, 'optimal')] },
  { key: 'brachial_plexus', name: 'Brachial plexus', color: '#facc15', type: 'OAR', site: 'Head & Neck', alphaBeta: 2, constraints: [max(66)] },
  // Thorax
  { key: 'lung_r', name: 'Lung R', color: '#7dd3fc', type: 'OAR', site: 'Thorax', alphaBeta: 3, constraints: [] },
  { key: 'lung_l', name: 'Lung L', color: '#38bdf8', type: 'OAR', site: 'Thorax', alphaBeta: 3, constraints: [] },
  { key: 'lungs', name: 'Lungs (total)', color: '#0ea5e9', type: 'OAR', site: 'Thorax', alphaBeta: 3, constraints: [vPct(20, 30), mean(20), vPct(5, 65, 'optimal')] },
  { key: 'heart', name: 'Heart', color: '#ef4444', type: 'OAR', site: 'Thorax', alphaBeta: 3, constraints: [vPct(25, 10), mean(26, 'optimal'), vPct(30, 46, 'optimal')] },
  { key: 'esophagus', name: 'Oesophagus', color: '#d946ef', type: 'OAR', site: 'Thorax', alphaBeta: 3, constraints: [mean(34), vPct(50, 40, 'optimal')] },
  { key: 'breast_contra', name: 'Contralateral breast', color: '#fbcfe8', type: 'OAR', site: 'Thorax', alphaBeta: 3, constraints: [mean(3, 'optimal')] },
  { key: 'lad', name: 'LAD artery', color: '#b91c1c', type: 'OAR', site: 'Thorax', alphaBeta: 3, constraints: [max(20, 'optimal'), mean(10, 'optimal')] },
  { key: 'trachea', name: 'Trachea', color: '#a5f3fc', type: 'OAR', site: 'Thorax', alphaBeta: 3, constraints: [max(70, 'optimal')] },
  // Abdomen
  { key: 'liver', name: 'Liver', color: '#b45309', type: 'OAR', site: 'Abdomen', alphaBeta: 3, constraints: [mean(30), vPct(30, 60, 'optimal')] },
  { key: 'kidney_r', name: 'Kidney R', color: '#f87171', type: 'OAR', site: 'Abdomen', alphaBeta: 3, constraints: [mean(18), vPct(20, 32, 'optimal')] },
  { key: 'kidney_l', name: 'Kidney L', color: '#fb923c', type: 'OAR', site: 'Abdomen', alphaBeta: 3, constraints: [mean(18), vPct(20, 32, 'optimal')] },
  { key: 'stomach', name: 'Stomach', color: '#fcd34d', type: 'OAR', site: 'Abdomen', alphaBeta: 3, constraints: [max(54), vCc(45, 100, 'optimal')] },
  { key: 'duodenum', name: 'Duodenum', color: '#fde68a', type: 'OAR', site: 'Abdomen', alphaBeta: 3, constraints: [max(55), vCc(45, 33, 'optimal')] },
  { key: 'small_bowel', name: 'Bowel bag', color: '#f59e0b', type: 'OAR', site: 'Abdomen', alphaBeta: 3, constraints: [vCc(45, 195), max(52, 'optimal')] },
  { key: 'spleen', name: 'Spleen', color: '#9f1239', type: 'OAR', site: 'Abdomen', alphaBeta: 3, constraints: [mean(10, 'optimal')] },
  // Pelvis
  { key: 'bladder', name: 'Bladder', color: '#eab308', type: 'OAR', site: 'Pelvis', alphaBeta: 5, constraints: [vPct(65, 50), vPct(70, 35), vPct(75, 25), vPct(80, 15)] },
  { key: 'rectum', name: 'Rectum', color: '#a16207', type: 'OAR', site: 'Pelvis', alphaBeta: 3, constraints: [vPct(50, 50), vPct(60, 35), vPct(65, 25), vPct(70, 20), vPct(75, 15)] },
  { key: 'sigmoid', name: 'Sigmoid', color: '#ca8a04', type: 'OAR', site: 'Pelvis', alphaBeta: 3, constraints: [max(60, 'optimal')] },
  { key: 'femur_r', name: 'Femoral head R', color: '#3b82f6', type: 'OAR', site: 'Pelvis', alphaBeta: 3, constraints: [vPct(50, 5), max(52, 'optimal')] },
  { key: 'femur_l', name: 'Femoral head L', color: '#2563eb', type: 'OAR', site: 'Pelvis', alphaBeta: 3, constraints: [vPct(50, 5), max(52, 'optimal')] },
  { key: 'penile_bulb', name: 'Penile bulb', color: '#e11d48', type: 'OAR', site: 'Pelvis', alphaBeta: 3, constraints: [mean(52, 'optimal')] },
  { key: 'prostate', name: 'Prostate', color: '#06b6d4', type: 'OAR', site: 'Pelvis', alphaBeta: 1.5, constraints: [] },
  { key: 'seminal_vesicles', name: 'Seminal vesicles', color: '#0891b2', type: 'OAR', site: 'Pelvis', alphaBeta: 1.5, constraints: [] },
  { key: 'uterus', name: 'Uterus', color: '#f472b6', type: 'OAR', site: 'Pelvis', alphaBeta: 10, constraints: [] },
  { key: 'ovary_r', name: 'Ovary R', color: '#fda4af', type: 'OAR', site: 'Pelvis', alphaBeta: 3, constraints: [max(5, 'optimal')] },
  { key: 'ovary_l', name: 'Ovary L', color: '#fb7185', type: 'OAR', site: 'Pelvis', alphaBeta: 3, constraints: [max(5, 'optimal')] },
  { key: 'cauda_equina', name: 'Cauda equina', color: '#facc15', type: 'OAR', site: 'Pelvis', alphaBeta: 2, constraints: [max(55)] },
];

export const SITES = ['Targets', 'General', 'CNS', 'Head & Neck', 'Thorax', 'Abdomen', 'Pelvis'] as const;

/** Distinct colours for structures created without a template. */
export const PALETTE = ['#f43f5e', '#22c55e', '#3b82f6', '#eab308', '#a855f7', '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6', '#6366f1', '#facc15'];

export function newId(prefix = ''): string {
  const r = crypto.getRandomValues(new Uint32Array(2));
  return prefix + r[0].toString(36) + r[1].toString(36);
}

export function instantiateConstraints(c: Omit<Constraint, 'id'>[]): Constraint[] {
  return c.map((x) => ({ ...x, id: newId('c') }));
}

export function describeConstraint(c: Constraint): string {
  const unit = (u?: string) => (u === '%Rx' ? '% Rx' : u === '%' ? '%' : u === 'cc' ? ' cc' : ' Gy');
  switch (c.metric) {
    case 'Dmax': return `Dmax ${c.cmp} ${c.limit}${unit(c.limitUnit)}`;
    case 'Dmean': return `Dmean ${c.cmp} ${c.limit}${unit(c.limitUnit)}`;
    case 'Dmin': return `Dmin ${c.cmp} ${c.limit}${unit(c.limitUnit)}`;
    case 'V': return `V${c.param}${c.paramUnit === '%Rx' ? '%Rx' : 'Gy'} ${c.cmp} ${c.limit}${unit(c.limitUnit)}`;
    case 'D': return `D${c.param}${c.paramUnit === 'cc' ? 'cc' : '%'} ${c.cmp} ${c.limit}${unit(c.limitUnit)}`;
  }
}
