// Field-in-field (FiF) helpers: project the hot-dose cloud into a field's beam's-eye view and shape a sub-field
// whose leaves block it, plus an estimate of how much of the field's weight to move into the sub-field.
import type { Beam, DoseGrid, Vec3 } from './types.ts';
import type { Machine } from './machines.ts';
import { dot, projectToIso, sub, type BeamAxes } from './geometry.ts';
import { growRaster, type BevRaster } from './bev.ts';

/**
 * Where dose ≥ `thresholdGy` projects onto the isocentre plane of a beam (divergent projection).
 * `inside` restricts the cloud (e.g. to the Body or a target). Returns null if nothing is that hot.
 */
export function projectDoseCloud(
  grid: DoseGrid, dose: Float32Array, thresholdGy: number, ax: BeamAxes, frame: 'display' | 'collimator',
  inside?: (p: Vec3) => boolean, res = 2, half = 260,
): BevRaster | null {
  const w = Math.round((2 * half) / res) + 1;
  const data = new Uint8Array(w * w);
  const x0 = -half, y0 = -half;
  const [nx, ny, nz] = grid.dims;
  const [sx, sy, sz] = grid.spacing;
  const foot = Math.max(sx, sy, sz) / 2 / res;
  let any = false;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        if (dose[i + nx * (j + ny * k)] < thresholdGy) continue;
        const P: Vec3 = [grid.origin[0] + i * sx, grid.origin[1] + j * sy, grid.origin[2] + k * sz];
        if (inside && !inside(P)) continue;
        const pt = projectToIso(ax, P, frame);
        if (!pt) continue;
        const r = Math.ceil(foot * (ax.sad / dot(sub(P, ax.source), ax.dir)));
        const cx = Math.round((pt[0] - x0) / res), cy = Math.round((pt[1] - y0) / res);
        for (let dy = -r; dy <= r; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= w) continue;
          for (let dx = -r; dx <= r; dx++) {
            const xx = cx + dx;
            if (xx < 0 || xx >= w) continue;
            data[xx + yy * w] = 1;
            any = true;
          }
        }
      }
  return any ? { data, w, h: w, x0, y0, res } : null;
}

export interface SubfieldShape {
  mlc: { x1: number[]; x2: number[] };
  blockedPairs: number;
  /** Fraction of the parent's open aperture area that the sub-field blocks. */
  blockedFraction: number;
}

/**
 * Leaves for a sub-field that block the projected hot region (collimator frame) within the parent's aperture.
 * Leaves can only close in from the two banks, so where the hot region sits inside a leaf pair's opening the bank
 * that blocks less of the cooler open area is moved over it (the usual way FiF segments are drawn).
 */
export function blockHotRegion(machine: Machine, parent: Beam, hot: BevRaster, marginMm = 0): SubfieldShape | null {
  if (!machine.mlc || !parent.mlc) return null;
  const B = machine.mlc.boundaries;
  const r = growRaster(hot, marginMm);
  const j = parent.jaws;
  const x1 = [...parent.mlc.x1], x2 = [...parent.mlc.x2];
  let blockedPairs = 0, openArea = 0, blockedArea = 0;
  for (let p = 0; p < B.length - 1; p++) {
    const yb0 = Math.max(B[p], j.y1), yb1 = Math.min(B[p + 1], j.y2);
    if (yb1 <= yb0) continue;
    const a = Math.max(x1[p], j.x1), b = Math.min(x2[p], j.x2);
    if (b <= a) continue;
    const h = yb1 - yb0;
    openArea += (b - a) * h;
    let hl = Infinity, hr = -Infinity;
    for (let y = 0; y < r.h; y++) {
      const cy = r.y0 + y * r.res;
      if (cy + r.res / 2 <= yb0 || cy - r.res / 2 >= yb1) continue;
      for (let x = 0; x < r.w; x++) {
        if (!r.data[x + y * r.w]) continue;
        const cx = r.x0 + x * r.res;
        if (cx + r.res / 2 <= a || cx - r.res / 2 >= b) continue;
        hl = Math.min(hl, cx - r.res / 2);
        hr = Math.max(hr, cx + r.res / 2);
      }
    }
    if (!isFinite(hl)) continue;
    hl = Math.max(a, hl);
    hr = Math.min(b, hr);
    blockedPairs++;
    const fromX1 = hr - a; // close the X1 bank up to the far edge of the hot region
    const fromX2 = b - hl; // or the X2 bank back to its near edge
    if (hl <= a + 0.5 && hr >= b - 0.5) {
      x1[p] = x2[p] = Math.round(((a + b) / 2) * 10) / 10; // whole opening is hot: close the pair
      blockedArea += (b - a) * h;
    } else if (fromX1 <= fromX2) {
      x1[p] = Math.round(hr * 10) / 10;
      blockedArea += fromX1 * h;
    } else {
      x2[p] = Math.round(hl * 10) / 10;
      blockedArea += fromX2 * h;
    }
  }
  if (!blockedPairs) return null;
  return { mlc: { x1, x2 }, blockedPairs, blockedFraction: openArea ? blockedArea / openArea : 0 };
}

/**
 * Fraction of a field's weight to move into a sub-field so the hot spot comes down to `goalGy`.
 * `hotGy` is the current maximum; `fieldShareGy` is how much of it this field delivers there (its open-field dose).
 * Assumes the sub-field delivers ~nothing under its closed leaves, which a recalculation then confirms.
 */
export function suggestSubfieldFraction(hotGy: number, goalGy: number, fieldShareGy: number): number {
  if (hotGy <= goalGy || fieldShareGy <= 0) return 0;
  return Math.max(0.03, Math.min(0.5, (hotGy - goalGy) / fieldShareGy));
}
