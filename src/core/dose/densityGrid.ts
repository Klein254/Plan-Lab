// Builds the dose calculation grid and its electron-density map from the CT and structures.
import type { DoseGrid, Vec3, Volume } from '../types.ts';
import type { Mask } from '../mask.ts';
import type { DensityGrid } from './engine.ts';

/** HU → relative electron density calibration (piecewise linear). Editable in Library → CT calibration. */
export type HuCurve = [number, number][];

export const DEFAULT_HU_CURVE: HuCurve = [
  [-1000, 0.0],
  [-800, 0.2],
  [-500, 0.5],
  [-100, 0.95],
  [0, 1.0],
  [100, 1.06],
  [300, 1.17],
  [700, 1.4],
  [1200, 1.7],
  [3000, 2.6],
];

export function huToDensity(curve: HuCurve, h: number): number {
  if (h <= curve[0][0]) return curve[0][1];
  for (let n = 1; n < curve.length; n++) {
    if (h <= curve[n][0]) {
      const [h0, d0] = curve[n - 1], [h1, d1] = curve[n];
      return d0 + ((d1 - d0) * (h - h0)) / (h1 - h0);
    }
  }
  return curve[curve.length - 1][1];
}

export interface CalcRegion {
  body: Mask; // external contour; only voxels inside it (or a bolus) get dose
  extras: Mask[]; // bolus structures, added to the calculation region
  overrides: { mask: Mask; density: number }[]; // later entries win
}

/** Grid covering the body (and bolus) bounding box at the requested resolution. */
export function makeDoseGrid(ct: Volume, region: CalcRegion, resolution: number): DoseGrid {
  let b = region.body.bounds();
  for (const m of region.extras) {
    const eb = m.bounds();
    if (!eb) continue;
    b = b ? [Math.min(b[0], eb[0]), Math.max(b[1], eb[1]), Math.min(b[2], eb[2]), Math.max(b[3], eb[3]), Math.min(b[4], eb[4]), Math.max(b[5], eb[5])] : eb;
  }
  if (!b) throw new Error('The Body structure is empty. Contour the external outline first.');
  const lo: Vec3 = [0, 1, 2].map((a) => ct.origin[a] + b![a * 2] * ct.spacing[a] - resolution) as Vec3;
  const hi: Vec3 = [0, 1, 2].map((a) => ct.origin[a] + b![a * 2 + 1] * ct.spacing[a] + resolution) as Vec3;
  const dims = [0, 1, 2].map((a) => Math.max(2, Math.ceil((hi[a] - lo[a]) / resolution) + 1)) as Vec3;
  return { dims, spacing: [resolution, resolution, resolution], origin: lo };
}

export function buildDensity(ct: Volume, region: CalcRegion, grid: DoseGrid, curve: HuCurve): DensityGrid {
  const { dims, spacing, origin } = grid;
  const density = new Float32Array(dims[0] * dims[1] * dims[2]);
  const [nx, ny, nz] = ct.dims;
  // Lookup table for HU → density
  const lut = new Float32Array(4096 + 1024);
  for (let h = -1024; h < 4096; h++) lut[h + 1024] = huToDensity(curve, h);
  for (let k = 0; k < dims[2]; k++) {
    const ck = Math.round((origin[2] + k * spacing[2] - ct.origin[2]) / ct.spacing[2]);
    if (ck < 0 || ck >= nz) continue;
    const bodyS = region.body.slices[ck];
    const extraS = region.extras.map((m) => m.slices[ck]);
    const ovS = region.overrides.map((o) => o.mask.slices[ck]);
    for (let j = 0; j < dims[1]; j++) {
      const cj = Math.round((origin[1] + j * spacing[1] - ct.origin[1]) / ct.spacing[1]);
      if (cj < 0 || cj >= ny) continue;
      for (let i = 0; i < dims[0]; i++) {
        const ci = Math.round((origin[0] + i * spacing[0] - ct.origin[0]) / ct.spacing[0]);
        if (ci < 0 || ci >= nx) continue;
        const p = ci + nx * cj;
        let inside = !!bodyS?.[p];
        if (!inside) for (const s of extraS) if (s?.[p]) { inside = true; break; }
        if (!inside) continue;
        const h = ct.data[p + nx * ny * ck];
        let rho = lut[Math.min(5119, Math.max(0, h + 1024))];
        for (let o = 0; o < ovS.length; o++) if (ovS[o]?.[p]) rho = region.overrides[o].density;
        density[i + dims[0] * (j + dims[1] * k)] = Math.max(0.021, rho);
      }
    }
  }
  return { grid, density };
}
