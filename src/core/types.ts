// Shared data model. Patient coordinates follow DICOM: +x = patient left, +y = posterior, +z = superior (mm).

export type Vec3 = [number, number, number];

/** A CT volume resampled onto an axis-aligned grid: i along +x, j along +y, k along +z (inferior → superior). */
export interface Volume {
  dims: Vec3; // nx, ny, nz
  spacing: Vec3; // mm
  origin: Vec3; // patient position of voxel (0,0,0) centre
  data: Int16Array; // Hounsfield units, index = i + nx * (j + ny * k)
}

export interface PatientInfo {
  id: string; // internal id
  patientId: string; // DICOM PatientID (or anonymised)
  name: string;
  sex: string;
  birthDate: string;
  createdAt: string;
  notes: string;
}

export interface ImageSetMeta {
  id: string;
  name: string; // "Basic CT scan"
  modality: string;
  studyDate: string;
  description: string;
  seriesUid: string;
  frameOfReferenceUid: string;
  studyUid: string;
  patientPosition: string; // HFS, FFS, HFP...
  dims: Vec3;
  spacing: Vec3;
  origin: Vec3;
  createdAt: string;
  sliceZ: number[]; // original slice positions, for RTSTRUCT export
  sopUids: string[]; // per resampled slice, best-matching original SOP instance
}

export type StructureType = 'EXTERNAL' | 'GTV' | 'CTV' | 'ITV' | 'PTV' | 'OAR' | 'AVOIDANCE' | 'BOLUS' | 'SUPPORT' | 'CONTROL';

export const TARGET_TYPES: StructureType[] = ['GTV', 'CTV', 'ITV', 'PTV'];

export type ConstraintMetric = 'Dmax' | 'Dmean' | 'Dmin' | 'V' | 'D';

/**
 * A dose-volume constraint.
 * - Dmax/Dmean/Dmin: limit is a dose.
 * - V: volume receiving >= param (dose) compared with limit (volume).
 * - D: dose to the hottest `param` volume compared with limit (dose).
 */
export interface Constraint {
  id: string;
  metric: ConstraintMetric;
  param?: number;
  paramUnit?: 'Gy' | '%Rx' | '%' | 'cc';
  limit: number;
  limitUnit: 'Gy' | '%Rx' | '%' | 'cc';
  cmp: '<' | '>';
  priority: 'mandatory' | 'optimal';
  note?: string;
}

export interface StructureMeta {
  id: string;
  name: string;
  color: string; // #rrggbb
  type: StructureType;
  visible: boolean;
  alphaBeta: number; // Gy, for EQD2/BED
  constraints: Constraint[];
  densityOverride: number | null; // relative electron density, null = use CT
  locked: boolean;
  templateKey?: string;
}

export type ItemStatus = 'In progress' | 'Completed' | 'Approved';

export interface StructureSetMeta {
  id: string;
  name: string; // "Contoured image"
  imageSetId: string;
  createdAt: string;
  modifiedAt: string;
  status: ItemStatus;
  author: string;
  structures: StructureMeta[];
}

export type WedgeOrientation = 'in' | 'out' | 'left' | 'right'; // direction of the thin end (toe), in collimator frame

export interface Wedge {
  type: 'none' | 'physical' | 'virtual';
  angle: number;
  orientation: WedgeOrientation;
}

export interface Jaws {
  x1: number; // mm at isocentre, coordinates (x1 <= x2, y1 <= y2)
  x2: number;
  y1: number;
  y2: number;
}

export interface Beam {
  id: string;
  name: string;
  machineId: string;
  energy: string;
  gantry: number;
  collimator: number;
  couch: number;
  iso: Vec3;
  jaws: Jaws;
  mlc: { x1: number[]; x2: number[] } | null; // leaf tips per pair, coordinates in mm (pair 0 = Y1 side)
  wedge: Wedge;
  weight: number; // relative contribution at the normalisation point
  autoMlc: { structureId: string; margin: number; fit: 'outside' | 'centre' | 'inside' } | null;
  bolusId?: string | null;
}

export type NormMode = 'isocentre' | 'refPoint' | 'targetMean' | 'targetMedian' | 'targetD95' | 'none';

export interface Prescription {
  totalDose: number; // Gy
  fractions: number;
  targetId: string | null;
  normMode: NormMode;
  normPercent: number; // e.g. 100 = 100% of Rx at the norm point
  refPointId: string | null;
}

export interface RefPoint {
  id: string;
  name: string;
  pos: Vec3;
}

export interface PlanMeta {
  id: string;
  name: string;
  structureSetId: string;
  imageSetId: string;
  createdAt: string;
  modifiedAt: string;
  status: ItemStatus;
  planner: string;
  technique: string;
  prescription: Prescription;
  beams: Beam[];
  refPoints: RefPoint[];
  doseResolution: number; // mm
  heterogeneity: boolean;
  mu: Record<string, number>; // beam id → MU per fraction (or minutes for Co-60)
  calculatedAt: string | null;
  calcSignature: string | null; // geometry hash the stored dose belongs to
  notes: string;
}

export interface PatientRecord {
  info: PatientInfo;
  imageSets: ImageSetMeta[];
  structureSets: { id: string; name: string; imageSetId: string; createdAt: string; modifiedAt: string; status: ItemStatus }[];
  plans: { id: string; name: string; structureSetId: string; createdAt: string; modifiedAt: string; status: ItemStatus }[];
}

/** Regular dose grid aligned with the patient axes. */
export interface DoseGrid {
  dims: Vec3;
  spacing: Vec3;
  origin: Vec3;
}
