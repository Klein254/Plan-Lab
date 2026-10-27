// Slice extraction and overlay rasterisation shared by the 2D views.
import type { Volume, Vec3, DoseGrid } from '../core/types.ts';
import type { Mask } from '../core/mask.ts';
import { isoSegments } from '../core/contour2d.ts';
import { sampleGrid } from '../core/dose/engine.ts';

export type Plane = 'axial' | 'sagittal' | 'coronal';

export interface PlaneInfo {
  w: number;
  h: number;
  sw: number; // mm per pixel horizontally
  sh: number;
  axis: 0 | 1 | 2; // voxel axis perpendicular to the plane
  count: number; // number of slices along that axis
}

export function planeInfo(plane: Plane, dims: Vec3, spacing: Vec3): PlaneInfo {
  if (plane === 'axial') return { w: dims[0], h: dims[1], sw: spacing[0], sh: spacing[1], axis: 2, count: dims[2] };
  if (plane === 'sagittal') return { w: dims[1], h: dims[2], sw: spacing[1], sh: spacing[2], axis: 0, count: dims[0] };
  return { w: dims[0], h: dims[2], sw: spacing[0], sh: spacing[2], axis: 1, count: dims[1] };
}

/** Plane pixel (a, b) on slice `index` → voxel coordinates. */
export function planeToVoxel(plane: Plane, nz: number, a: number, b: number, index: number): Vec3 {
  if (plane === 'axial') return [a, b, index];
  if (plane === 'sagittal') return [index, a, nz - 1 - b];
  return [a, index, nz - 1 - b];
}

export function voxelToPlane(plane: Plane, nz: number, v: Vec3): [number, number] {
  if (plane === 'axial') return [v[0], v[1]];
  if (plane === 'sagittal') return [v[1], nz - 1 - v[2]];
  return [v[0], nz - 1 - v[2]];
}

export function sliceIndex(plane: Plane, cursor: Vec3): number {
  return Math.round(plane === 'axial' ? cursor[2] : plane === 'sagittal' ? cursor[0] : cursor[1]);
}

export function extractCT(v: Volume, plane: Plane, index: number): Int16Array {
  const [nx, ny, nz] = v.dims;
  const info = planeInfo(plane, v.dims, v.spacing);
  const out = new Int16Array(info.w * info.h);
  if (plane === 'axial') {
    out.set(v.data.subarray(index * nx * ny, (index + 1) * nx * ny));
  } else if (plane === 'sagittal') {
    for (let b = 0; b < nz; b++) {
      const k = nz - 1 - b;
      for (let j = 0; j < ny; j++) out[j + b * ny] = v.data[index + nx * (j + ny * k)];
    }
  } else {
    for (let b = 0; b < nz; b++) {
      const k = nz - 1 - b;
      const base = nx * (index + ny * k);
      for (let i = 0; i < nx; i++) out[i + b * nx] = v.data[base + i];
    }
  }
  return out;
}

export function extractMask(m: Mask, plane: Plane, index: number): Uint8Array | null {
  const { nx, ny, nz } = m;
  if (plane === 'axial') return m.slices[index] ?? null;
  const w = plane === 'sagittal' ? ny : nx;
  const out = new Uint8Array(w * nz);
  let any = false;
  for (let b = 0; b < nz; b++) {
    const s = m.slices[nz - 1 - b];
    if (!s) continue;
    if (plane === 'sagittal') {
      for (let j = 0; j < ny; j++) if (s[index + nx * j]) { out[j + b * w] = 1; any = true; }
    } else {
      const base = nx * index;
      for (let i = 0; i < nx; i++) if (s[base + i]) { out[i + b * w] = 1; any = true; }
    }
  }
  return any ? out : null;
}

const lutCache = new Map<string, Uint8Array>();
/** HU (−1024…3071) → grey level LUT for a window. */
export function windowLut(w: number, l: number): Uint8Array {
  const key = `${w}|${l}`;
  let lut = lutCache.get(key);
  if (lut) return lut;
  lut = new Uint8Array(4096);
  const lo = l - w / 2;
  for (let h = -1024; h < 3072; h++) lut[h + 1024] = Math.max(0, Math.min(255, Math.round(((h - lo) / w) * 255)));
  if (lutCache.size > 20) lutCache.clear();
  lutCache.set(key, lut);
  return lut;
}

export function greyImage(values: Int16Array, w: number, h: number, win: number, lev: number): ImageData {
  const lut = windowLut(win, lev);
  const img = new ImageData(w, h);
  const d = img.data;
  for (let p = 0; p < values.length; p++) {
    const g = lut[Math.min(4095, Math.max(0, values[p] + 1024))];
    d[p * 4] = g;
    d[p * 4 + 1] = g;
    d[p * 4 + 2] = g;
    d[p * 4 + 3] = 255;
  }
  return img;
}

/** LRU-ish cache for outline segments keyed by structure/version/plane/slice. */
const segCache = new Map<string, Float32Array>();
export function maskOutline(key: string, m: Mask, plane: Plane, index: number, w: number, h: number): Float32Array | null {
  const hit = segCache.get(key);
  if (hit) return hit;
  const plane2d = extractMask(m, plane, index);
  if (!plane2d) return null;
  const seg = isoSegments(plane2d, w, h, 0.5);
  if (segCache.size > 600) segCache.clear();
  segCache.set(key, seg);
  return seg;
}

export interface DosePlane {
  data: Float32Array;
  w: number;
  h: number;
  step: number; // plane pixels per dose sample
}

/** Samples the dose grid on a slice plane, every `step` plane pixels. */
export function sampleDosePlane(v: Volume, plane: Plane, index: number, grid: DoseGrid, dose: Float32Array, step: number): DosePlane {
  const info = planeInfo(plane, v.dims, v.spacing);
  const w = Math.ceil(info.w / step), h = Math.ceil(info.h / step);
  const data = new Float32Array(w * h);
  const nz = v.dims[2];
  // Skip quickly when the slice is outside the dose grid
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const vox = planeToVoxel(plane, nz, x * step, y * step, index);
      const p: Vec3 = [v.origin[0] + vox[0] * v.spacing[0], v.origin[1] + vox[1] * v.spacing[1], v.origin[2] + vox[2] * v.spacing[2]];
      data[x + y * w] = sampleGrid(grid, dose, p);
    }
  }
  return { data, w, h, step };
}

export function doseSegments(dp: DosePlane, levelGy: number): Float32Array {
  const seg = isoSegments(dp.data, dp.w, dp.h, levelGy);
  for (let n = 0; n < seg.length; n++) seg[n] *= dp.step;
  return seg;
}

export function isodoseColor(pct: number): string {
  if (pct >= 107) return '#ff2d95';
  if (pct >= 105) return '#ff3b30';
  if (pct >= 100) return '#ff9500';
  if (pct >= 95) return '#ffd60a';
  if (pct >= 90) return '#30d158';
  if (pct >= 80) return '#00c7be';
  if (pct >= 70) return '#0a84ff';
  if (pct >= 50) return '#5e5ce6';
  if (pct >= 30) return '#bf5af2';
  return '#98989d';
}

/** Colour-wash RGBA for a dose fraction 0…1+ (blue → cyan → green → yellow → red → magenta). */
export function washColor(f: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [0, 0, 255]], [0.3, [0, 200, 255]], [0.55, [0, 230, 80]], [0.8, [255, 230, 0]], [1.0, [255, 60, 0]], [1.1, [255, 0, 200]],
  ];
  if (f <= stops[0][0]) return stops[0][1];
  for (let n = 1; n < stops.length; n++) {
    if (f <= stops[n][0]) {
      const [f0, c0] = stops[n - 1], [f1, c1] = stops[n];
      const t = (f - f0) / (f1 - f0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return stops[stops.length - 1][1];
}

export const hexToRgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

export const WINDOW_PRESETS: { name: string; w: number; l: number; key: string }[] = [
  { name: 'Soft tissue', w: 400, l: 40, key: '1' },
  { name: 'Lung', w: 1500, l: -600, key: '2' },
  { name: 'Bone', w: 1800, l: 400, key: '3' },
  { name: 'Brain', w: 80, l: 40, key: '4' },
  { name: 'Mediastinum', w: 350, l: 50, key: '5' },
  { name: 'Liver', w: 160, l: 60, key: '6' },
];
