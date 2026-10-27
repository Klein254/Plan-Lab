// Beam's-eye-view projections of structures, auto-MLC fitting, jaw fitting and field matching.
import type { Beam, Jaws, Vec3, Volume } from './types.ts';
import type { Machine } from './machines.ts';
import type { Mask } from './mask.ts';
import { beamAxes, deg, dot, projectToIso, sub, type BeamAxes } from './geometry.ts';
import { fillHoles2D } from './contour2d.ts';
import { edtSquared } from './edt.ts';

export interface BevRaster {
  data: Uint8Array;
  w: number;
  h: number;
  x0: number; // isocentre-plane coordinate of pixel 0 centre (mm)
  y0: number;
  res: number; // mm per pixel
}

/**
 * Silhouette of a structure projected onto the isocentre plane (divergent projection from the source).
 * Only surface voxels are projected; the silhouette is then filled.
 */
export function projectStructure(mask: Mask, ct: Pick<Volume, 'spacing' | 'origin'>, ax: BeamAxes, frame: 'display' | 'collimator', res = 1, half = 260): BevRaster | null {
  const w = Math.round((2 * half) / res) + 1;
  const data = new Uint8Array(w * w);
  const x0 = -half, y0 = -half;
  const { nx, ny, nz } = mask;
  const [sx, sy, sz] = ct.spacing;
  const [ox, oy, oz] = ct.origin;
  let any = false;
  // Footprint radius of a voxel at the isocentre plane, in pixels
  const foot = Math.max(sx, sy, sz) / 2 / res;
  for (let k = 0; k < nz; k++) {
    const s = mask.slices[k];
    if (!s) continue;
    const below = k > 0 ? mask.slices[k - 1] : null, above = k < nz - 1 ? mask.slices[k + 1] : null;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const p = i + nx * j;
        if (!s[p]) continue;
        const surface = i === 0 || i === nx - 1 || j === 0 || j === ny - 1 || !s[p - 1] || !s[p + 1] || !s[p - nx] || !s[p + nx] || !below?.[p] || !above?.[p];
        if (!surface) continue;
        const P: Vec3 = [ox + i * sx, oy + j * sy, oz + k * sz];
        const pt = projectToIso(ax, P, frame);
        if (!pt) continue;
        const scale = ax.sad / dot(sub(P, ax.source), ax.dir);
        const fx = (pt[0] - x0) / res, fy = (pt[1] - y0) / res;
        const r = Math.ceil(foot * scale * 1.2);
        const cx = Math.round(fx), cy = Math.round(fy);
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
    }
  }
  if (!any) return null;
  fillHoles2D(data, w, w);
  return { data, w, h: w, x0, y0, res };
}

/** Grows a BEV silhouette by a margin (mm). */
export function growRaster(r: BevRaster, marginMm: number): BevRaster {
  if (marginMm <= 0) return r;
  const d2 = edtSquared(r.data, [r.w, r.h, 1], [r.res, r.res, 1]);
  const data = new Uint8Array(r.data.length);
  const m2 = marginMm * marginMm;
  for (let p = 0; p < d2.length; p++) data[p] = d2[p] <= m2 ? 1 : 0;
  return { ...r, data };
}

export function rasterBounds(r: BevRaster): { x1: number; x2: number; y1: number; y2: number } | null {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++)
      if (r.data[x + y * r.w]) {
        if (x < a) a = x;
        if (x > b) b = x;
        if (y < c) c = y;
        if (y > d) d = y;
      }
  if (!isFinite(a)) return null;
  return { x1: r.x0 + (a - 0.5) * r.res, x2: r.x0 + (b + 0.5) * r.res, y1: r.y0 + (c - 0.5) * r.res, y2: r.y0 + (d + 0.5) * r.res };
}

export type MlcFit = 'outside' | 'centre' | 'inside';

/**
 * Fits MLC leaves around a collimator-frame silhouette (already including any margin), and returns jaws that just
 * enclose the opening. Leaf pairs that don't see the target are closed and parked under the X1 jaw.
 */
export function fitMlc(machine: Machine, sil: BevRaster, fit: MlcFit): { mlc: { x1: number[]; x2: number[] }; jaws: Jaws } | null {
  const mlc = machine.mlc;
  const b = rasterBounds(sil);
  if (!b) return null;
  const jaws: Jaws = { x1: Math.floor(b.x1), x2: Math.ceil(b.x2), y1: Math.floor(b.y1), y2: Math.ceil(b.y2) };
  if (!mlc) return { mlc: { x1: [], x2: [] }, jaws };
  const pairs = mlc.boundaries.length - 1;
  const x1: number[] = new Array(pairs), x2: number[] = new Array(pairs);
  // Per raster row: open extent
  const rowL = new Float64Array(sil.h).fill(Infinity), rowR = new Float64Array(sil.h).fill(-Infinity);
  for (let y = 0; y < sil.h; y++)
    for (let x = 0; x < sil.w; x++)
      if (sil.data[x + y * sil.w]) {
        const cx = sil.x0 + x * sil.res;
        if (cx - sil.res / 2 < rowL[y]) rowL[y] = cx - sil.res / 2;
        if (cx + sil.res / 2 > rowR[y]) rowR[y] = cx + sil.res / 2;
      }
  let openX1 = Infinity, openX2 = -Infinity;
  for (let p = 0; p < pairs; p++) {
    const yb0 = mlc.boundaries[p], yb1 = mlc.boundaries[p + 1];
    const rowsIn: number[] = [];
    for (let y = 0; y < sil.h; y++) {
      const cy = sil.y0 + y * sil.res;
      if (cy + sil.res / 2 > yb0 && cy - sil.res / 2 < yb1) rowsIn.push(y);
    }
    let L = Infinity, R = -Infinity;
    if (fit === 'outside') {
      for (const y of rowsIn) { L = Math.min(L, rowL[y]); R = Math.max(R, rowR[y]); }
    } else if (fit === 'centre') {
      const cy = Math.round(((yb0 + yb1) / 2 - sil.y0) / sil.res);
      if (cy >= 0 && cy < sil.h) { L = rowL[cy]; R = rowR[cy]; }
    } else {
      L = -Infinity; R = Infinity;
      for (const y of rowsIn) { L = Math.max(L, rowL[y]); R = Math.min(R, rowR[y]); }
      if (!rowsIn.length) { L = Infinity; R = -Infinity; }
    }
    if (isFinite(L) && isFinite(R) && R > L) {
      x1[p] = Math.round(L * 10) / 10;
      x2[p] = Math.round(R * 10) / 10;
      openX1 = Math.min(openX1, x1[p]);
      openX2 = Math.max(openX2, x2[p]);
    } else {
      x1[p] = x2[p] = NaN; // closed, parked below
    }
  }
  if (!isFinite(openX1)) return null;
  jaws.x1 = Math.floor(openX1);
  jaws.x2 = Math.ceil(openX2);
  const park = jaws.x1 - 5;
  for (let p = 0; p < pairs; p++) if (isNaN(x1[p])) x1[p] = x2[p] = park;
  return { mlc: { x1, x2 }, jaws };
}

/** Opens every leaf pair to the jaws (MLC fully retracted inside the field). */
export function openMlc(machine: Machine, jaws: Jaws): { x1: number[]; x2: number[] } | null {
  if (!machine.mlc) return null;
  const pairs = machine.mlc.boundaries.length - 1;
  return { x1: new Array(pairs).fill(jaws.x1), x2: new Array(pairs).fill(jaws.x2) };
}

/** Clamps jaws to the machine's limits, keeping x1 ≤ x2 and y1 ≤ y2. */
export function clampJaws(machine: Machine, j: Jaws): Jaws {
  const hx = machine.maxField.x / 2, hy = machine.maxField.y / 2;
  const c = (v: number, h: number) => Math.max(-h, Math.min(h, v));
  const out = { x1: c(j.x1, hx), x2: c(j.x2, hx), y1: c(j.y1, hy), y2: c(j.y2, hy) };
  if (out.x2 < out.x1) [out.x1, out.x2] = [out.x2, out.x1];
  if (out.y2 < out.y1) [out.y1, out.y2] = [out.y2, out.y1];
  return out;
}

/** The field outline (jaws ∩ MLC) as a polygon in collimator coordinates, for drawing. */
export function apertureOutline(beam: Beam, machine: Machine): number[] {
  const j = beam.jaws;
  if (!machine.mlc || !beam.mlc) return [j.x1, j.y1, j.x2, j.y1, j.x2, j.y2, j.x1, j.y2];
  const B = machine.mlc.boundaries;
  const right: number[] = [], left: number[] = [];
  for (let p = 0; p < B.length - 1; p++) {
    const y0 = Math.max(B[p], j.y1), y1 = Math.min(B[p + 1], j.y2);
    if (y1 <= y0) continue;
    const l = Math.max(beam.mlc.x1[p], j.x1), r = Math.min(beam.mlc.x2[p], j.x2);
    if (r <= l) continue;
    right.push(r, y0, r, y1);
    left.push(l, y1, l, y0);
  }
  if (!right.length) return [];
  const out = [...right];
  for (let n = left.length - 2; n >= 0; n -= 2) out.push(left[n], left[n + 1]);
  return out;
}

/**
 * Field matching helpers (half-beam technique):
 * - couch kick so a field's divergent superior/inferior edge lines up with a neighbouring field's flat (half-beam) edge
 * - collimator angle to match a cranial field to the divergence of a spinal field (craniospinal)
 */
export function matchingAngles(lengthMm: number, sadMm: number) {
  return {
    couchKickDeg: Math.atan(lengthMm / 2 / sadMm) / deg,
    collimatorDeg: Math.atan(lengthMm / 2 / sadMm) / deg,
  };
}

/**
 * Cross-section of a beam's jaw-defined pyramid (source → 1.5 × SAD) with a slice plane (axis 0/1/2 = x/y/z = value).
 * Returns the convex polygon in patient coordinates (may be empty), plus where the central axis meets the plane.
 */
export function fieldSection(beam: Beam, machine: Machine, axis: 0 | 1 | 2, value: number): { polygon: Vec3[]; cax: [Vec3, Vec3] | null; source: Vec3 } {
  const ax = beamAxes(beam, machine.sad);
  const far = 1.5;
  const j = beam.jaws;
  const corner = (x: number, y: number): Vec3 => {
    const d: Vec3 = [
      ax.dir[0] * ax.sad + ax.u[0] * x + ax.v[0] * y,
      ax.dir[1] * ax.sad + ax.u[1] * x + ax.v[1] * y,
      ax.dir[2] * ax.sad + ax.u[2] * x + ax.v[2] * y,
    ];
    return [ax.source[0] + d[0] * far, ax.source[1] + d[1] * far, ax.source[2] + d[2] * far];
  };
  const base = [corner(j.x1, j.y1), corner(j.x2, j.y1), corner(j.x2, j.y2), corner(j.x1, j.y2)];
  const edges: [Vec3, Vec3][] = [];
  for (let n = 0; n < 4; n++) {
    edges.push([ax.source, base[n]]);
    edges.push([base[n], base[(n + 1) % 4]]);
  }
  const pts: Vec3[] = [];
  for (const [a, b] of edges) {
    const da = a[axis] - value, db = b[axis] - value;
    if (da === 0 && db === 0) { pts.push(a, b); continue; }
    if ((da <= 0 && db >= 0) || (da >= 0 && db <= 0)) {
      const t = da / (da - db);
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  // Order the convex polygon by angle around its centroid (in the plane's two remaining axes)
  const [a1, a2] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  let polygon: Vec3[] = [];
  if (pts.length >= 3) {
    const cx = pts.reduce((s, p) => s + p[a1], 0) / pts.length, cy = pts.reduce((s, p) => s + p[a2], 0) / pts.length;
    polygon = pts.sort((p, q) => Math.atan2(p[a2] - cy, p[a1] - cx) - Math.atan2(q[a2] - cy, q[a1] - cx));
  }
  // Central axis: drawn as a line when it runs (nearly) within the plane
  let cax: [Vec3, Vec3] | null = null;
  const end: Vec3 = [ax.source[0] + ax.dir[0] * ax.sad * far, ax.source[1] + ax.dir[1] * ax.sad * far, ax.source[2] + ax.dir[2] * ax.sad * far];
  if (Math.abs(ax.dir[axis]) < 0.05 && Math.abs(ax.iso[axis] - value) < 2) cax = [ax.source, end];
  return { polygon, cax, source: ax.source };
}
