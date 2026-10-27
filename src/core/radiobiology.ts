// Radiobiological plan metrics for teaching: generalised EUD, LKB normal-tissue complication probability,
// and integral dose. Parameters are the classic Burman et al. (1991) fits to the Emami tolerance data.
import type { DVH } from './dvh.ts';

/** Generalised equivalent uniform dose: (Σ vᵢ Dᵢ^a)^(1/a), a = 1/n. a → 1 gives the mean dose, a ≫ 1 tends to the max, a < 0 to the min. */
export function gEUD(dvh: DVH, a: number): number {
  const s = dvh.samples;
  if (!s.length) return 0;
  if (Math.abs(a) < 1e-6) {
    // geometric mean (limit a → 0)
    let l = 0;
    for (const d of s) l += Math.log(Math.max(d, 1e-6));
    return Math.exp(l / s.length);
  }
  let sum = 0;
  for (const d of s) sum += Math.pow(Math.max(d, 1e-6), a);
  return Math.pow(sum / s.length, 1 / a);
}

/** Standard normal cumulative distribution (Abramowitz–Stegun 7.1.26 erf, |error| < 1.5e-7). */
export function normalCdf(t: number): number {
  const x = Math.abs(t) / Math.SQRT2;
  const k = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * k - 1.453152027) * k + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-x * x);
  return t >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export interface LkbParams {
  organ: string;
  endpoint: string;
  n: number; // volume effect (a = 1/n)
  m: number; // slope
  td50: number; // Gy (2 Gy fractions) for 50% complication probability, whole organ
}

/** LKB NTCP = Φ((gEUD − TD50) / (m·TD50)) with gEUD computed using a = 1/n. Give it an EQD2 DVH. */
export function lkbNtcp(dvh: DVH, p: Pick<LkbParams, 'n' | 'm' | 'td50'>): { geud: number; ntcp: number } {
  const geud = gEUD(dvh, 1 / p.n);
  return { geud, ntcp: normalCdf((geud - p.td50) / (p.m * p.td50)) };
}

// Burman 1991 (Int J Radiat Oncol Biol Phys 21:123) fits; brainstem/optic values as commonly tabulated with them.
export const LKB_TABLE: (LkbParams & { match: RegExp })[] = [
  { organ: 'Lung', endpoint: 'Pneumonitis', n: 0.87, m: 0.18, td50: 24.5, match: /lung/i },
  { organ: 'Heart', endpoint: 'Pericarditis', n: 0.35, m: 0.1, td50: 48, match: /heart|cardi/i },
  { organ: 'Spinal cord', endpoint: 'Myelitis / necrosis', n: 0.05, m: 0.175, td50: 66.5, match: /cord|spinal/i },
  { organ: 'Brainstem', endpoint: 'Necrosis / infarction', n: 0.16, m: 0.14, td50: 65, match: /brain\s*stem|brainstem/i },
  { organ: 'Brain', endpoint: 'Necrosis', n: 0.25, m: 0.15, td50: 60, match: /^brain(?!\s*stem)/i },
  { organ: 'Optic nerve / chiasm', endpoint: 'Blindness', n: 0.25, m: 0.14, td50: 65, match: /optic|chiasm/i },
  { organ: 'Lens', endpoint: 'Cataract', n: 0.3, m: 0.27, td50: 18, match: /lens/i },
  { organ: 'Parotid', endpoint: 'Xerostomia', n: 0.7, m: 0.18, td50: 46, match: /parotid/i },
  { organ: 'Larynx', endpoint: 'Oedema', n: 0.11, m: 0.17, td50: 80, match: /larynx|laryn/i },
  { organ: 'Oesophagus', endpoint: 'Stricture / perforation', n: 0.06, m: 0.11, td50: 68, match: /oesoph|esoph/i },
  { organ: 'Liver', endpoint: 'Liver failure', n: 0.32, m: 0.15, td50: 40, match: /liver/i },
  { organ: 'Kidney', endpoint: 'Clinical nephritis', n: 0.7, m: 0.1, td50: 28, match: /kidney|renal/i },
  { organ: 'Stomach', endpoint: 'Ulceration / perforation', n: 0.15, m: 0.14, td50: 65, match: /stomach/i },
  { organ: 'Small bowel', endpoint: 'Obstruction / perforation', n: 0.15, m: 0.16, td50: 55, match: /bowel|intestin|duoden/i },
  { organ: 'Rectum', endpoint: 'Severe proctitis / necrosis', n: 0.12, m: 0.15, td50: 80, match: /rectum|rectal/i },
  { organ: 'Bladder', endpoint: 'Contracture / volume loss', n: 0.5, m: 0.11, td50: 80, match: /bladder/i },
  { organ: 'Femoral head', endpoint: 'Necrosis', n: 0.25, m: 0.12, td50: 65, match: /femo|femur/i },
];

export function lkbFor(name: string): LkbParams | null {
  return LKB_TABLE.find((p) => p.match.test(name)) ?? null;
}

/** Integral dose (Gy·kg = J) for a structure, assuming unit density unless given. */
export function integralDose(dvh: DVH, densityGPerCc = 1): number {
  return (dvh.mean * dvh.volumeCc * densityGPerCc) / 1000;
}
