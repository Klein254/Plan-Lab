// Dose–volume histograms, dose statistics, plan quality indices and constraint evaluation.
import type { Constraint, DoseGrid, Volume } from './types.ts';
import type { Mask } from './mask.ts';
import { sampleGrid } from './dose/engine.ts';

export interface DVH {
  volumeCc: number;
  samples: Float32Array; // sorted ascending dose samples (Gy), uniformly representing the structure
  min: number;
  max: number;
  mean: number;
}

export function computeDVH(mask: Mask, ct: Pick<Volume, 'spacing' | 'origin'>, grid: DoseGrid, dose: Float32Array, maxSamples = 300000): DVH | null {
  const n = mask.count();
  if (!n) return null;
  const stride = Math.max(1, Math.floor(n / maxSamples));
  const out = new Float32Array(Math.ceil(n / stride));
  let c = 0, seen = 0, sum = 0;
  const { spacing, origin } = ct;
  mask.forEach((i, j, k) => {
    if (seen++ % stride) return;
    const d = sampleGrid(grid, dose, [origin[0] + i * spacing[0], origin[1] + j * spacing[1], origin[2] + k * spacing[2]]);
    out[c++] = d;
    sum += d;
  });
  const samples = out.subarray(0, c).sort();
  return {
    volumeCc: (n * spacing[0] * spacing[1] * spacing[2]) / 1000,
    samples,
    min: samples[0],
    max: samples[c - 1],
    mean: sum / c,
  };
}

/** Converts physical dose samples to EQD2 for n fractions and the given α/β (keeps the samples sorted). */
export function toEQD2(dvh: DVH, fractions: number, alphaBeta: number): DVH {
  const f = (D: number) => (D * (D / fractions + alphaBeta)) / (2 + alphaBeta);
  const samples = dvh.samples.map(f);
  let sum = 0;
  for (const s of samples) sum += s;
  return { volumeCc: dvh.volumeCc, samples, min: f(dvh.min), max: f(dvh.max), mean: sum / samples.length };
}

export const bed = (D: number, fractions: number, ab: number) => D * (1 + D / fractions / ab);
export const eqd2 = (D: number, fractions: number, ab: number) => (D * (D / fractions + ab)) / (2 + ab);

/** Volume fraction (0–1) receiving at least `dose`. */
export function vAt(dvh: DVH, dose: number): number {
  const s = dvh.samples;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid] < dose) lo = mid + 1;
    else hi = mid;
  }
  return (s.length - lo) / s.length;
}

/** Minimum dose to the hottest `fraction` (0–1) of the volume. */
export function dAt(dvh: DVH, fraction: number): number {
  const s = dvh.samples;
  if (fraction <= 0) return dvh.max;
  if (fraction >= 1) return dvh.min;
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((1 - fraction) * s.length)));
  return s[idx];
}

/** Cumulative DVH curve points [dose Gy, volume fraction] for plotting. */
export function cumulativeCurve(dvh: DVH, binGy: number, maxDose: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let d = 0; d <= maxDose + 1e-9; d += binGy) pts.push([d, vAt(dvh, d)]);
  return pts;
}

/** Differential DVH (fraction of volume per bin). */
export function differentialCurve(dvh: DVH, binGy: number, maxDose: number): [number, number][] {
  const bins = Math.ceil(maxDose / binGy) + 1;
  const h = new Float64Array(bins);
  for (const s of dvh.samples) h[Math.min(bins - 1, Math.floor(s / binGy))]++;
  const pts: [number, number][] = [];
  for (let b = 0; b < bins; b++) pts.push([(b + 0.5) * binGy, h[b] / dvh.samples.length]);
  return pts;
}

export interface ConstraintResult {
  value: number;
  unit: string;
  pass: boolean;
  text: string;
}

export function evaluateConstraint(c: Constraint, dvh: DVH, rxGy: number): ConstraintResult {
  const toGy = (v: number, u?: string) => (u === '%Rx' ? (v / 100) * rxGy : v);
  const fmtDose = (gy: number) => (c.limitUnit === '%Rx' ? (100 * gy) / rxGy : gy);
  let value = 0;
  let unit = c.limitUnit === '%Rx' ? '% Rx' : c.limitUnit === 'Gy' ? 'Gy' : c.limitUnit === '%' ? '%' : 'cc';
  switch (c.metric) {
    case 'Dmax': value = fmtDose(dvh.max); break;
    case 'Dmean': value = fmtDose(dvh.mean); break;
    case 'Dmin': value = fmtDose(dvh.min); break;
    case 'V': {
      const frac = vAt(dvh, toGy(c.param ?? 0, c.paramUnit));
      value = c.limitUnit === 'cc' ? frac * dvh.volumeCc : 100 * frac;
      break;
    }
    case 'D': {
      const frac = c.paramUnit === 'cc' ? Math.min(1, (c.param ?? 0) / dvh.volumeCc) : (c.param ?? 0) / 100;
      value = fmtDose(dAt(dvh, frac));
      break;
    }
  }
  const pass = c.cmp === '<' ? value <= c.limit + 1e-9 : value >= c.limit - 1e-9;
  if (unit === '% Rx') unit = '%';
  return { value, unit, pass, text: `${value.toFixed(c.limitUnit === 'cc' ? 1 : 2)} ${unit}` };
}

export interface TargetIndices {
  coverage95: number; // fraction of target ≥ 95% Rx
  coverage100: number;
  d98: number;
  d50: number;
  d2: number;
  hi: number; // ICRU 83 homogeneity index
  ciRtog: number | null;
  ciPaddick: number | null;
  gi: number | null;
}

export function targetIndices(target: DVH, body: DVH | null, rxGy: number): TargetIndices {
  const d98 = dAt(target, 0.98), d50 = dAt(target, 0.5), d2 = dAt(target, 0.02);
  const tvPiv = vAt(target, rxGy) * target.volumeCc;
  const piv = body ? vAt(body, rxGy) * body.volumeCc : null;
  const piv50 = body ? vAt(body, rxGy * 0.5) * body.volumeCc : null;
  return {
    coverage95: vAt(target, rxGy * 0.95),
    coverage100: vAt(target, rxGy),
    d98, d50, d2,
    hi: d50 > 0 ? (d2 - d98) / d50 : 0,
    ciRtog: piv !== null ? piv / target.volumeCc : null,
    ciPaddick: piv ? (tvPiv * tvPiv) / (target.volumeCc * piv) : null,
    gi: piv && piv50 !== null ? piv50 / piv : null,
  };
}
