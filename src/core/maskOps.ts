// Structure operations: margins, booleans, interpolation, smoothing, auto-segmentation and edge adaptation.
import { Mask } from './mask.ts';
import { edtSquared, signedDistance2D } from './edt.ts';
import { components2D, fillHoles2D } from './contour2d.ts';
import type { Vec3, Volume } from './types.ts';

export interface Margins {
  right: number; // -x (patient right), mm
  left: number; // +x
  ant: number; // -y
  post: number; // +y
  inf: number; // -z
  sup: number; // +z
}

export const uniformMargins = (mm: number): Margins => ({ right: mm, left: mm, ant: mm, post: mm, inf: mm, sup: mm });

type Box = [number, number, number, number, number, number];

function cropBox(m: Mask, pad: Vec3): Box | null {
  const b = m.bounds();
  if (!b) return null;
  return [
    Math.max(0, b[0] - pad[0]), Math.min(m.nx - 1, b[1] + pad[0]),
    Math.max(0, b[2] - pad[1]), Math.min(m.ny - 1, b[3] + pad[1]),
    Math.max(0, b[4] - pad[2]), Math.min(m.nz - 1, b[5] + pad[2]),
  ];
}

function extract(m: Mask, box: Box): { data: Uint8Array; dims: Vec3 } {
  const [i0, i1, j0, j1, k0, k1] = box;
  const dx = i1 - i0 + 1, dy = j1 - j0 + 1, dz = k1 - k0 + 1;
  const data = new Uint8Array(dx * dy * dz);
  for (let k = k0; k <= k1; k++) {
    const s = m.slices[k];
    if (!s) continue;
    for (let j = j0; j <= j1; j++) {
      const src = j * m.nx;
      const dst = (k - k0) * dx * dy + (j - j0) * dx;
      for (let i = i0; i <= i1; i++) data[dst + i - i0] = s[src + i];
    }
  }
  return { data, dims: [dx, dy, dz] };
}

function insert(m: Mask, box: Box, data: Uint8Array) {
  const [i0, i1, j0, j1, k0, k1] = box;
  const dx = i1 - i0 + 1, dy = j1 - j0 + 1;
  for (let k = k0; k <= k1; k++) {
    let s = m.slices[k];
    for (let j = j0; j <= j1; j++) {
      const src = (k - k0) * dx * dy + (j - j0) * dx;
      const dst = j * m.nx;
      for (let i = i0; i <= i1; i++) {
        const v = data[src + i - i0];
        if (v && !s) s = m.slice(k, true);
        if (s) s[dst + i] = v;
      }
    }
    m.compact(k);
  }
}

/** Expands (positive) or contracts (negative) a structure by per-direction margins in mm. */
export function applyMargins(m: Mask, spacing: Vec3, mg: Margins): Mask {
  const vals = [mg.right, mg.left, mg.ant, mg.post, mg.inf, mg.sup];
  if (vals.every((v) => v === 0)) return m.clone();
  if (vals.every((v) => v <= 0)) return contract(m, spacing, mg);
  // Expansion: ellipsoid of the smaller margin on each axis, then sweep the remainder in its direction
  const pos = (v: number) => Math.max(0, v);
  const r: Vec3 = [Math.min(pos(mg.right), pos(mg.left)), Math.min(pos(mg.ant), pos(mg.post)), Math.min(pos(mg.inf), pos(mg.sup))];
  const pad: Vec3 = [
    Math.ceil(Math.max(pos(mg.right), pos(mg.left)) / spacing[0]) + 1,
    Math.ceil(Math.max(pos(mg.ant), pos(mg.post)) / spacing[1]) + 1,
    Math.ceil(Math.max(pos(mg.inf), pos(mg.sup)) / spacing[2]) + 1,
  ];
  const box = cropBox(m, pad);
  const out = new Mask(m.nx, m.ny, m.nz);
  if (!box) return out;
  const { data, dims } = extract(m, box);
  let grown = data;
  if (r[0] > 0 || r[1] > 0 || r[2] > 0) {
    const scaled: Vec3 = [0, 1, 2].map((a) => (r[a] > 0 ? spacing[a] / r[a] : 1e6)) as Vec3;
    const d2 = edtSquared(data, dims, scaled);
    grown = new Uint8Array(data.length);
    for (let p = 0; p < d2.length; p++) grown[p] = d2[p] <= 1.0001 ? 1 : 0;
  }
  // Directional sweeps for asymmetric margins
  const sweep = (axis: number, dir: number, mm: number) => {
    const steps = Math.round(mm / spacing[axis]);
    if (steps <= 0) return;
    const [dx, dy] = dims;
    const stride = axis === 0 ? 1 : axis === 1 ? dx : dx * dy;
    const len = dims[axis];
    const src = grown.slice();
    for (let p = 0; p < src.length; p++) {
      if (!src[p]) continue;
      const c = axis === 0 ? p % dx : axis === 1 ? Math.floor(p / dx) % dy : Math.floor(p / (dx * dy));
      for (let s = 1; s <= steps; s++) {
        const cc = c + dir * s;
        if (cc < 0 || cc >= len) break;
        grown[p + dir * s * stride] = 1;
      }
    }
  };
  sweep(0, -1, pos(mg.right) - r[0]);
  sweep(0, 1, pos(mg.left) - r[0]);
  sweep(1, -1, pos(mg.ant) - r[1]);
  sweep(1, 1, pos(mg.post) - r[1]);
  sweep(2, -1, pos(mg.inf) - r[2]);
  sweep(2, 1, pos(mg.sup) - r[2]);
  insert(out, box, grown);
  return out;
}

function contract(m: Mask, spacing: Vec3, mg: Margins): Mask {
  const r: Vec3 = [Math.max(-mg.right, -mg.left), Math.max(-mg.ant, -mg.post), Math.max(-mg.inf, -mg.sup)];
  const box = cropBox(m, [1, 1, 1]);
  const out = new Mask(m.nx, m.ny, m.nz);
  if (!box) return out;
  const { data, dims } = extract(m, box);
  // Pad by one voxel of background on every side so the border counts as outside
  const [dx, dy, dz] = dims;
  const pd: Vec3 = [dx + 2, dy + 2, dz + 2];
  const bg = new Uint8Array(pd[0] * pd[1] * pd[2]).fill(1);
  for (let k = 0; k < dz; k++)
    for (let j = 0; j < dy; j++)
      for (let i = 0; i < dx; i++)
        if (data[i + dx * (j + dy * k)]) bg[i + 1 + pd[0] * (j + 1 + pd[1] * (k + 1))] = 0;
  const scaled: Vec3 = [0, 1, 2].map((a) => (r[a] > 0 ? spacing[a] / r[a] : 1e6)) as Vec3;
  const d2 = edtSquared(bg, pd, scaled);
  const res = new Uint8Array(data.length);
  for (let k = 0; k < dz; k++)
    for (let j = 0; j < dy; j++)
      for (let i = 0; i < dx; i++) {
        const q = i + 1 + pd[0] * (j + 1 + pd[1] * (k + 1));
        if (!bg[q] && d2[q] > 1.0001) res[i + dx * (j + dy * k)] = 1;
      }
  insert(out, box, res);
  return out;
}

export type BoolOp = 'union' | 'intersect' | 'subtract' | 'xor';

export function booleanOp(a: Mask, b: Mask, op: BoolOp): Mask {
  const out = new Mask(a.nx, a.ny, a.nz);
  for (let k = 0; k < a.nz; k++) {
    const sa = a.slices[k], sb = b.slices[k];
    if (!sa && !sb) continue;
    if (op === 'intersect' && (!sa || !sb)) continue;
    if (op === 'subtract' && !sa) continue;
    const n = a.nx * a.ny;
    const s = new Uint8Array(n);
    const A = sa ?? new Uint8Array(n), B = sb ?? new Uint8Array(n);
    if (op === 'union') for (let p = 0; p < n; p++) s[p] = A[p] | B[p];
    else if (op === 'intersect') for (let p = 0; p < n; p++) s[p] = A[p] & B[p];
    else if (op === 'subtract') for (let p = 0; p < n; p++) s[p] = A[p] & (B[p] ^ 1);
    else for (let p = 0; p < n; p++) s[p] = A[p] ^ B[p];
    out.slices[k] = s;
    out.compact(k);
  }
  return out;
}

/** Fills enclosed holes on every slice. */
export function fillHoles(m: Mask) {
  for (let k = 0; k < m.nz; k++) {
    const s = m.slices[k];
    if (s) fillHoles2D(s, m.nx, m.ny);
  }
}

/** Smooths outlines slice by slice (box blur then re-threshold). Radius in voxels. */
export function smoothMask(m: Mask, radius = 1, iterations = 2) {
  const { nx, ny } = m;
  const tmp = new Float32Array(nx * ny), tmp2 = new Float32Array(nx * ny);
  for (let k = 0; k < m.nz; k++) {
    const s = m.slices[k];
    if (!s) continue;
    for (let p = 0; p < s.length; p++) tmp[p] = s[p];
    for (let it = 0; it < iterations; it++) {
      boxBlur(tmp, tmp2, nx, ny, radius, true);
      boxBlur(tmp2, tmp, nx, ny, radius, false);
    }
    for (let p = 0; p < s.length; p++) s[p] = tmp[p] >= 0.5 ? 1 : 0;
    m.compact(k);
  }
}

function boxBlur(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean) {
  const n = 2 * r + 1;
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let d = -r; d <= r; d++) {
          const xx = Math.min(w - 1, Math.max(0, x + d));
          acc += src[y * w + xx];
        }
        dst[y * w + x] = acc / n;
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let d = -r; d <= r; d++) {
          const yy = Math.min(h - 1, Math.max(0, y + d));
          acc += src[yy * w + x];
        }
        dst[y * w + x] = acc / n;
      }
    }
  }
}

/** Indices of slices that contain any voxels. */
export function filledSlices(m: Mask): number[] {
  const out: number[] = [];
  for (let k = 0; k < m.nz; k++) if (m.hasSlice(k)) out.push(k);
  return out;
}

/**
 * Shape-based interpolation: fills empty slices lying between drawn slices by blending the signed distance
 * maps of the neighbouring drawn slices. Only slices in [kFrom, kTo] are written. Returns slices filled.
 */
export function interpolateSlices(m: Mask, spacing: Vec3, kFrom = 0, kTo = m.nz - 1): number[] {
  const keys = filledSlices(m);
  const filled: number[] = [];
  for (let n = 0; n + 1 < keys.length; n++) {
    const ka = keys[n], kb = keys[n + 1];
    if (kb - ka < 2 || kb < kFrom || ka > kTo) continue;
    const sa = m.slices[ka]!, sb = m.slices[kb]!;
    // Work inside the union bounding box, padded, to keep it quick
    let i0 = m.nx, i1 = 0, j0 = m.ny, j1 = 0;
    for (const s of [sa, sb]) {
      for (let p = 0; p < s.length; p++) {
        if (!s[p]) continue;
        const i = p % m.nx, j = (p / m.nx) | 0;
        if (i < i0) i0 = i;
        if (i > i1) i1 = i;
        if (j < j0) j0 = j;
        if (j > j1) j1 = j;
      }
    }
    i0 = Math.max(0, i0 - 3); j0 = Math.max(0, j0 - 3);
    i1 = Math.min(m.nx - 1, i1 + 3); j1 = Math.min(m.ny - 1, j1 + 3);
    const w = i1 - i0 + 1, h = j1 - j0 + 1;
    const crop = (s: Uint8Array) => {
      const c = new Uint8Array(w * h);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) c[i + j * w] = s[i0 + i + (j0 + j) * m.nx];
      return c;
    };
    const da = signedDistance2D(crop(sa), w, h, spacing[0], spacing[1]);
    const db = signedDistance2D(crop(sb), w, h, spacing[0], spacing[1]);
    for (let k = Math.max(ka + 1, kFrom); k < kb && k <= kTo; k++) {
      if (m.hasSlice(k)) continue;
      const t = (k - ka) / (kb - ka);
      const s = m.slice(k, true)!;
      for (let j = 0; j < h; j++)
        for (let i = 0; i < w; i++) {
          const p = i + j * w;
          if ((1 - t) * da[p] + t * db[p] <= 0) s[i0 + i + (j0 + j) * m.nx] = 1;
        }
      m.compact(k);
      filled.push(k);
    }
  }
  return filled;
}

const hu = (v: Volume, i: number, j: number, k: number) => v.data[i + v.dims[0] * (j + v.dims[1] * k)];

/** Voxels whose HU lies in [lo, hi], optionally only inside another structure. */
export function thresholdMask(v: Volume, lo: number, hi: number, within?: Mask | null): Mask {
  const [nx, ny, nz] = v.dims;
  const m = new Mask(nx, ny, nz);
  const n = nx * ny;
  for (let k = 0; k < nz; k++) {
    const w = within ? within.slices[k] : null;
    if (within && !w) continue;
    let s: Uint8Array | null = null;
    const off = k * n;
    for (let p = 0; p < n; p++) {
      if (w && !w[p]) continue;
      const h = v.data[off + p];
      if (h >= lo && h <= hi) {
        if (!s) s = m.slice(k, true)!;
        s[p] = 1;
      }
    }
  }
  return m;
}

/** Outer body contour: threshold, keep the largest connected region on each slice, fill holes. */
export function autoBody(v: Volume, threshold = -350): Mask {
  const [nx, ny, nz] = v.dims;
  const m = new Mask(nx, ny, nz);
  const n = nx * ny;
  const tmp = new Uint8Array(n);
  for (let k = 0; k < nz; k++) {
    const off = k * n;
    for (let p = 0; p < n; p++) tmp[p] = v.data[off + p] > threshold ? 1 : 0;
    const { labels, sizes } = components2D(tmp, nx, ny);
    let best = 0;
    for (let l = 1; l < sizes.length; l++) if (sizes[l] > sizes[best]) best = l;
    if (!best || sizes[best] < 50) continue;
    const s = m.slice(k, true)!;
    for (let p = 0; p < n; p++) s[p] = labels[p] === best ? 1 : 0;
    // Close small gaps (e.g. skin folds) before filling holes
    fillHoles2D(s, nx, ny);
  }
  return m;
}

/** 3D 6-connected components of a mask. Returns per-voxel labels for set voxels as a Map from label to voxel list size. */
export function components3D(m: Mask): { labelOf: (i: number, j: number, k: number) => number; sizes: number[]; extract: (label: number) => Mask } {
  const { nx, ny, nz } = m;
  const n = nx * ny;
  const labels: (Int32Array | null)[] = new Array(nz).fill(null);
  const sizes = [0];
  const queue: number[] = [];
  let next = 1;
  for (let k0 = 0; k0 < nz; k0++) {
    const s0 = m.slices[k0];
    if (!s0) continue;
    for (let p0 = 0; p0 < n; p0++) {
      if (!s0[p0] || labels[k0]?.[p0]) continue;
      const lab = next++;
      let size = 0;
      const mark = (k: number, p: number) => {
        let l = labels[k];
        if (!l) l = labels[k] = new Int32Array(n);
        l[p] = lab;
        queue.push(k * n + p);
      };
      mark(k0, p0);
      while (queue.length) {
        const q = queue.pop()!;
        size++;
        const k = Math.floor(q / n), p = q - k * n;
        const i = p % nx, j = (p / nx) | 0;
        const tryAdd = (kk: number, pp: number) => {
          const s = m.slices[kk];
          if (s && s[pp] && !(labels[kk]?.[pp])) mark(kk, pp);
        };
        if (i > 0) tryAdd(k, p - 1);
        if (i < nx - 1) tryAdd(k, p + 1);
        if (j > 0) tryAdd(k, p - nx);
        if (j < ny - 1) tryAdd(k, p + nx);
        if (k > 0) tryAdd(k - 1, p);
        if (k < nz - 1) tryAdd(k + 1, p);
      }
      sizes.push(size);
    }
  }
  return {
    sizes,
    labelOf: (i, j, k) => labels[k]?.[i + nx * j] ?? 0,
    extract: (label) => {
      const out = new Mask(nx, ny, nz);
      labels.forEach((l, k) => {
        if (!l) return;
        let s: Uint8Array | null = null;
        for (let p = 0; p < n; p++) if (l[p] === label) {
          if (!s) s = out.slice(k, true)!;
          s[p] = 1;
        }
      });
      return out;
    },
  };
}

/** Lungs: air inside the body, split into right and left by which side of the body centre they sit. */
export function autoLungs(v: Volume, body: Mask): { right: Mask; left: Mask } {
  const air = thresholdMask(v, -1000, -400, body);
  const cc = components3D(air);
  const voxelCc = (v.spacing[0] * v.spacing[1] * v.spacing[2]) / 1000;
  const right = new Mask(...v.dims), left = new Mask(...v.dims);
  // Body centre in x
  let sx = 0, cnt = 0;
  body.forEach((i) => { sx += i; cnt++; });
  const cx = cnt ? sx / cnt : v.dims[0] / 2;
  for (let l = 1; l < cc.sizes.length; l++) {
    if (cc.sizes[l] * voxelCc < 150) continue;
    const comp = cc.extract(l);
    // Large components spanning both sides (lungs joined by the trachea) are split at the centre line
    comp.forEach((i, j, k) => (i < cx ? right : left).set(i, j, k, 1));
  }
  // Keep only the main component on each side (drops bowel gas / trachea leftovers)
  const keepLargest = (m: Mask) => {
    const c = components3D(m);
    let best = 0;
    for (let l = 1; l < c.sizes.length; l++) if (c.sizes[l] > (c.sizes[best] ?? 0)) best = l;
    return best ? c.extract(best) : m;
  };
  return { right: keepLargest(right), left: keepLargest(left) };
}

/** Flood fill from a seed voxel over voxels within ±tol HU of the seed's neighbourhood mean. */
export function regionGrow(v: Volume, seed: Vec3, tol: number, opts: { maxRadiusMm: number; threeD: boolean; plane?: 'axial' }): Mask {
  const [nx, ny, nz] = v.dims;
  const [si, sj, sk] = seed.map(Math.round);
  // Seed statistics from a 3×3 patch
  let acc = 0, c = 0;
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      const i = si + di, j = sj + dj;
      if (i >= 0 && j >= 0 && i < nx && j < ny) { acc += hu(v, i, j, sk); c++; }
    }
  const mean = acc / c;
  const lo = mean - tol, hi = mean + tol;
  const out = new Mask(nx, ny, nz);
  const r2 = opts.maxRadiusMm * opts.maxRadiusMm;
  const stack: number[] = [si, sj, sk];
  out.set(si, sj, sk, 1);
  while (stack.length) {
    const k = stack.pop()!, j = stack.pop()!, i = stack.pop()!;
    const nb: Vec3[] = [[i - 1, j, k], [i + 1, j, k], [i, j - 1, k], [i, j + 1, k]];
    if (opts.threeD) nb.push([i, j, k - 1], [i, j, k + 1]);
    for (const [a, b, d] of nb) {
      if (a < 0 || b < 0 || d < 0 || a >= nx || b >= ny || d >= nz) continue;
      if (out.get(a, b, d)) continue;
      const dx = (a - si) * v.spacing[0], dy = (b - sj) * v.spacing[1], dz = (d - sk) * v.spacing[2];
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      const h = hu(v, a, b, d);
      if (h < lo || h > hi) continue;
      out.set(a, b, d, 1);
      stack.push(a, b, d);
    }
  }
  fillHoles(out);
  return out;
}

/** Median and robust spread (scaled MAD, at least `floor`) of a sample. */
function robustStats(values: number[], floor = 15): { median: number; spread: number } {
  const s = Float32Array.from(values).sort();
  const median = s[s.length >> 1];
  const dev = s.map((x) => Math.abs(x - median)).sort();
  return { median, spread: Math.max(floor, 1.4826 * dev[dev.length >> 1]) };
}

/**
 * Edge adaptation ("auto contour adaptation"): re-segments a band around the current outline on slice k so a rough
 * contour snaps onto the organ boundary. Tissue statistics come from a deep core of the structure (inside) and a ring
 * just beyond the band (outside); band voxels join whichever class their HU matches better, falling back to a
 * ±kSigma window around the inside class when the two classes look alike. Returns true if the slice changed.
 */
export function adaptSlice(v: Volume, m: Mask, k: number, bandMm = 4, kSigma = 2.0): boolean {
  const s = m.slices[k];
  if (!s) return false;
  const [nx, ny] = v.dims;
  const n = nx * ny;
  const off = k * n;
  const sd = signedDistance2D(s, nx, ny, v.spacing[0], v.spacing[1]);
  let sdMin = 0;
  for (let p = 0; p < n; p++) if (sd[p] < sdMin) sdMin = sd[p];
  const coreThr = Math.max(0.5 * sdMin, -bandMm);
  const inside: number[] = [], outside: number[] = [];
  for (let p = 0; p < n; p++) {
    const d = sd[p];
    if (d <= coreThr) inside.push(v.data[off + p]);
    else if (d > bandMm && d <= bandMm + 4) outside.push(v.data[off + p]);
  }
  if (inside.length < 5) return false;
  const inn = robustStats(inside);
  const out = outside.length >= 5 ? robustStats(outside) : null;
  const separable = !!out && Math.abs(inn.median - out.median) > 2 * Math.max(inn.spread, out.spread);
  const belongs = (h: number) =>
    separable
      ? Math.abs(h - inn.median) / inn.spread < Math.abs(h - out!.median) / out!.spread
      : Math.abs(h - inn.median) <= kSigma * inn.spread;
  // Candidate = core ∪ matching band voxels, then keep what's connected to the core
  const cand = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const d = sd[p];
    if (d <= coreThr) cand[p] = 1;
    else if (d <= bandMm) cand[p] = belongs(v.data[off + p]) ? 1 : 0;
  }
  const { labels, sizes } = components2D(cand, nx, ny);
  const keep = new Set<number>();
  for (let p = 0; p < n; p++) if (labels[p] && sd[p] <= coreThr) keep.add(labels[p]);
  if (!keep.size) {
    let best = 0;
    for (let l = 1; l < sizes.length; l++) if (sizes[l] > sizes[best]) best = l;
    if (best) keep.add(best);
  }
  const res = new Uint8Array(n);
  for (let p = 0; p < n; p++) res[p] = keep.has(labels[p]) ? 1 : 0;
  fillHoles2D(res, nx, ny);
  // Light smoothing
  const tmp = new Float32Array(n), tmp2 = new Float32Array(n);
  for (let p = 0; p < n; p++) tmp[p] = res[p];
  boxBlur(tmp, tmp2, nx, ny, 1, true);
  boxBlur(tmp2, tmp, nx, ny, 1, false);
  let changed = false;
  for (let p = 0; p < n; p++) {
    const val = tmp[p] >= 0.5 ? 1 : 0;
    if (val !== s[p]) changed = true;
    s[p] = val;
  }
  m.compact(k);
  return changed;
}

/**
 * Propagates the contour on slice k to neighbouring slices (copy + adapt), stopping when the organ ends
 * (area collapses or jumps). Returns the slices written.
 */
export function propagate(v: Volume, m: Mask, k: number, dir: 1 | -1, maxSlices: number, bandMm = 4): number[] {
  const written: number[] = [];
  const area = (s: Uint8Array | null) => { let a = 0; if (s) for (let p = 0; p < s.length; p++) a += s[p]; return a; };
  let prev = m.slices[k];
  let prevArea = area(prev);
  for (let step = 1; step <= maxSlices; step++) {
    const kk = k + dir * step;
    if (kk < 0 || kk >= m.nz || !prev) break;
    if (m.hasSlice(kk)) { prev = m.slices[kk]; prevArea = area(prev); continue; }
    m.slices[kk] = prev.slice();
    adaptSlice(v, m, kk, bandMm);
    const a = area(m.slices[kk]);
    if (a < prevArea * 0.35 || a > prevArea * 2.2 || a < 4) {
      m.slices[kk] = null;
      break;
    }
    written.push(kk);
    prev = m.slices[kk];
    prevArea = a;
  }
  return written;
}

/** Volume in cm³. */
export function maskVolumeCc(m: Mask, spacing: Vec3): number {
  return (m.count() * spacing[0] * spacing[1] * spacing[2]) / 1000;
}

/** Centre of mass in voxel coordinates. */
export function centroid(m: Mask): Vec3 | null {
  let si = 0, sj = 0, sk = 0, c = 0;
  m.forEach((i, j, k) => { si += i; sj += j; sk += k; c++; });
  return c ? [si / c, sj / c, sk / c] : null;
}
