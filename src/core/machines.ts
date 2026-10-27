// Treatment machines and their beam models. The dose model is a fluence-convolution / TMR model with
// equivalent-path-length heterogeneity correction: good for teaching, not commissioned for clinical use.

export interface MlcModel {
  name: string;
  /** Leaf-pair boundaries at the isocentre plane, mm, from the Y1 side upward (length = pairs + 1). */
  boundaries: number[];
  transmission: number;
  maxTipTravel: number; // mm either side of the central axis
}

export interface EnergyModel {
  name: string; // "6X", "Co-60"
  dmax: number; // cm
  mu: number; // linear term of −ln TMR beyond dmax (1/cm), 10×10
  beta: number; // quadratic term (1/cm²)
  fsCoef: number; // field-size dependence of attenuation
  surfaceDose: number; // TMR at the surface relative to dmax, 10×10
  output: number; // cGy/MU (or cGy/min for Co-60) at isocentre, dmax, 10×10
  scA: number; // collimator scatter slope Sc = 1 + scA·ln(s/10)
  spA: number; // phantom scatter slope Sp = 1 + spA·ln(s/10)
  sigma0: number; // penumbra Gaussian σ at the surface (mm)
  sigmaPerCm: number; // σ growth with depth (mm per cm)
  scatterW0: number; // weight of the broad scatter kernel at the surface
  scatterWPerCm: number;
  scatterSigma: number; // mm
  horn: number; // relative fluence increase at 20 cm off axis
  wedgeFactors: Record<number, number>; // physical wedge transmission at the central axis
}

export interface Machine {
  id: string;
  name: string;
  kind: 'linac' | 'cobalt';
  sad: number; // mm
  energies: EnergyModel[];
  mlc: MlcModel | null;
  maxField: { x: number; y: number }; // mm, full width
  jawTransmission: number;
  physicalWedges: number[];
  virtualWedge: boolean;
  physicalWedgeMaxWidth: number; // mm, across the wedge direction
  doseUnit: 'MU' | 'min';
  cobalt?: { calibrationDate: string; halfLifeYears: number };
}

const range = (from: number, to: number, step: number) => {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
};

export const MLC_80x5: MlcModel = { name: '80 leaf pairs × 5 mm', boundaries: range(-200, 200, 5), transmission: 0.015, maxTipTravel: 200 };
export const MLC_40x10: MlcModel = { name: '40 leaf pairs × 10 mm', boundaries: range(-200, 200, 10), transmission: 0.02, maxTipTravel: 200 };
export const MLC_60_MIXED: MlcModel = {
  name: '60 leaf pairs (40 × 5 mm centre, 20 × 10 mm outer)',
  boundaries: [...range(-200, -110, 10), ...range(-100, 100, 5), ...range(110, 200, 10)],
  transmission: 0.015,
  maxTipTravel: 200,
};

const X6: EnergyModel = {
  name: '6X', dmax: 1.5, mu: 0.024, beta: 0.00046, fsCoef: 0.3, surfaceDose: 0.2, output: 1.0,
  scA: 0.03, spA: 0.03, sigma0: 3.0, sigmaPerCm: 0.1, scatterW0: 0.02, scatterWPerCm: 0.004, scatterSigma: 30, horn: 0.03,
  wedgeFactors: { 15: 0.8, 30: 0.66, 45: 0.52, 60: 0.42 },
};
const X10: EnergyModel = {
  name: '10X', dmax: 2.4, mu: 0.0229, beta: 0.00025, fsCoef: 0.28, surfaceDose: 0.14, output: 1.0,
  scA: 0.028, spA: 0.026, sigma0: 3.3, sigmaPerCm: 0.11, scatterW0: 0.02, scatterWPerCm: 0.0035, scatterSigma: 32, horn: 0.025,
  wedgeFactors: { 15: 0.84, 30: 0.71, 45: 0.58, 60: 0.48 },
};
const X15: EnergyModel = {
  name: '15X', dmax: 3.0, mu: 0.0195, beta: 0.00029, fsCoef: 0.26, surfaceDose: 0.11, output: 1.0,
  scA: 0.026, spA: 0.022, sigma0: 3.6, sigmaPerCm: 0.12, scatterW0: 0.02, scatterWPerCm: 0.003, scatterSigma: 34, horn: 0.02,
  wedgeFactors: { 15: 0.86, 30: 0.73, 45: 0.61, 60: 0.51 },
};
const CO60: EnergyModel = {
  name: 'Co-60', dmax: 0.5, mu: 0.0339, beta: 0.000546, fsCoef: 0.35, surfaceDose: 0.35, output: 150,
  scA: 0.03, spA: 0.04, sigma0: 5.5, sigmaPerCm: 0.15, scatterW0: 0.03, scatterWPerCm: 0.006, scatterSigma: 25, horn: 0,
  wedgeFactors: { 15: 0.82, 30: 0.69, 45: 0.56, 60: 0.45 },
};

export const DEFAULT_MACHINES: Machine[] = [
  {
    id: 'linac-a', name: 'Linac A (80-leaf MLC)', kind: 'linac', sad: 1000, energies: [X6, X10, X15], mlc: MLC_80x5,
    maxField: { x: 400, y: 400 }, jawTransmission: 0.005, physicalWedges: [15, 30, 45, 60], virtualWedge: true,
    physicalWedgeMaxWidth: 200, doseUnit: 'MU',
  },
  {
    id: 'linac-b', name: 'Linac B (40-leaf MLC)', kind: 'linac', sad: 1000, energies: [X6, X15], mlc: MLC_40x10,
    maxField: { x: 400, y: 400 }, jawTransmission: 0.005, physicalWedges: [15, 30, 45, 60], virtualWedge: false,
    physicalWedgeMaxWidth: 200, doseUnit: 'MU',
  },
  {
    id: 'linac-c', name: 'Linac C (60-pair MLC)', kind: 'linac', sad: 1000, energies: [X6, X10], mlc: MLC_60_MIXED,
    maxField: { x: 400, y: 400 }, jawTransmission: 0.005, physicalWedges: [15, 30, 45, 60], virtualWedge: true,
    physicalWedgeMaxWidth: 200, doseUnit: 'MU',
  },
  {
    id: 'cobalt', name: 'Cobalt-60 unit', kind: 'cobalt', sad: 800, energies: [CO60], mlc: null,
    maxField: { x: 350, y: 350 }, jawTransmission: 0.02, physicalWedges: [15, 30, 45, 60], virtualWedge: false,
    physicalWedgeMaxWidth: 150, doseUnit: 'min',
    cobalt: { calibrationDate: '2026-01-01', halfLifeYears: 5.2713 },
  },
];

/** Output on a given date (Co-60 decays; linacs are constant). */
export function outputOn(machine: Machine, energy: EnergyModel, isoDate = new Date().toISOString()): number {
  if (!machine.cobalt) return energy.output;
  const days = (Date.parse(isoDate) - Date.parse(machine.cobalt.calibrationDate)) / 86400000;
  return energy.output * Math.pow(0.5, days / (machine.cobalt.halfLifeYears * 365.25));
}

const clampFs = (s: number) => Math.min(40, Math.max(1, s));

export function tmr(e: EnergyModel, depthCm: number, fieldCm: number): number {
  const s = clampFs(fieldCm);
  const fs = Math.max(0.4, 1 - e.fsCoef * Math.log(s / 10));
  if (depthCm >= e.dmax) {
    const x = depthCm - e.dmax;
    return Math.exp(-fs * (e.mu * x + e.beta * x * x));
  }
  const d = Math.max(0, depthCm);
  const surf = Math.min(0.9, e.surfaceDose * (1 + 0.02 * (s - 10)));
  const k = 3 / e.dmax;
  return surf + (1 - surf) * (1 - Math.exp(-k * d)) / (1 - Math.exp(-k * e.dmax));
}

export const sc = (e: EnergyModel, s: number) => Math.max(0.8, 1 + e.scA * Math.log(clampFs(s) / 10));
export const sp = (e: EnergyModel, s: number) => Math.max(0.8, 1 + e.spA * Math.log(clampFs(s) / 10));

/** Effective attenuation slope near 10 cm depth, used to shape wedge profiles (1/cm). */
export const effectiveMu = (e: EnergyModel) => e.mu + 2 * e.beta * (10 - e.dmax);

export function wedgeFactor(machine: Machine, e: EnergyModel, type: 'none' | 'physical' | 'virtual', angle: number): number {
  if (type === 'none' || !angle) return 1;
  if (type === 'virtual') return 1 - 0.004 * angle;
  const table = e.wedgeFactors;
  if (table[angle] !== undefined) return table[angle];
  // Interpolate between listed angles
  const angles = Object.keys(table).map(Number).sort((a, b) => a - b);
  let lo = 0, loF = 1;
  for (const a of angles) {
    if (a <= angle) { lo = a; loF = table[a]; }
    else return loF + ((table[a] - loF) * (angle - lo)) / (a - lo);
  }
  return loF;
}

/** Percentage depth dose on the central axis for a square field at a given SSD (cm), for the beam-data viewer. */
export function pdd(machine: Machine, e: EnergyModel, depthCm: number, fieldCm: number, ssdCm = machine.sad / 10): number {
  const sAt = (d: number) => (fieldCm * (ssdCm + d)) / ssdCm;
  const doseAt = (d: number) => tmr(e, d, sAt(d)) * sp(e, sAt(d)) * Math.pow((ssdCm + e.dmax) / (ssdCm + d), 2);
  return (100 * doseAt(depthCm)) / doseAt(e.dmax);
}

export function findEnergy(machine: Machine, name: string): EnergyModel {
  return machine.energies.find((e) => e.name === name) ?? machine.energies[0];
}
