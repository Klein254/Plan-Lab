// Photon dose engine: TMR / fluence-convolution model with radiological-depth (equivalent path length)
// heterogeneity correction, computed per beam as cGy per MU (or per minute for Co-60) on a regular grid.
import type { Beam, DoseGrid, Vec3 } from '../types.ts';
import { findEnergy, outputOn, sc, sp, tmr, wedgeFactor, type EnergyModel, type Machine } from '../machines.ts';
import { beamAxes, dot, len, sub, type BeamAxes } from '../geometry.ts';
import { buildFluence, equivalentSquares, gaussianBlur, sampleMap, type FluenceMap } from '../fluence.ts';

export interface BeamModel {
  beam: Beam;
  machine: Machine;
}

const LAYERS = [0, 10, 20, 30, 50, 80, 120, 160, 220, 300, 400]; // geometric depth (mm) of pre-blurred fluence layers

interface Prepared {
  ax: BeamAxes;
  e: EnergyModel;
  fluence: FluenceMap;
  layers: Float32Array[];
  cal: number; // output × Sc × Sp × wedge factor
  eqAperture: number; // cm
}

export function prepareBeam(bm: BeamModel, calcDate?: string): Prepared {
  const { beam, machine } = bm;
  const e = findEnergy(machine, beam.energy);
  const ax = beamAxes(beam, machine.sad);
  const fluence = buildFluence(beam, machine, e, 2, Math.max(60, e.scatterSigma * 2.5));
  const layers = LAYERS.map((dMm) => {
    const dCm = dMm / 10;
    const sp0 = (e.sigma0 + e.sigmaPerCm * dCm) / fluence.spacing;
    const ws = Math.min(0.5, e.scatterW0 + e.scatterWPerCm * dCm);
    const prim = gaussianBlur(fluence.data, fluence.nx, fluence.ny, sp0);
    if (ws <= 0) return prim;
    const scat = gaussianBlur(fluence.data, fluence.nx, fluence.ny, e.scatterSigma / fluence.spacing);
    const out = new Float32Array(prim.length);
    for (let p = 0; p < out.length; p++) out[p] = (1 - ws) * prim[p] + ws * scat[p];
    return out;
  });
  const eq = equivalentSquares(beam, machine);
  const cal = outputOn(machine, e, calcDate) * sc(e, eq.jaw) * sp(e, eq.aperture) * wedgeFactor(machine, e, beam.wedge.type, beam.wedge.angle);
  return { ax, e, fluence, layers, cal, eqAperture: eq.aperture };
}

function layerSample(pr: Prepared, x: number, y: number, depthMm: number): number {
  let l = 0;
  while (l < LAYERS.length - 2 && LAYERS[l + 1] < depthMm) l++;
  const t = Math.min(1, Math.max(0, (depthMm - LAYERS[l]) / (LAYERS[l + 1] - LAYERS[l])));
  const a = sampleMap(pr.fluence, pr.layers[l], x, y);
  const b = sampleMap(pr.fluence, pr.layers[l + 1], x, y);
  return a + (b - a) * t;
}

/** Dose per MU from one beam at a point with known geometric and radiological depth. */
function doseAt(pr: Prepared, p: Vec3, dGeoMm: number, dRadMm: number): number {
  const w = sub(p, pr.ax.source);
  const t = dot(w, pr.ax.dir);
  if (t <= 1) return 0;
  const f = pr.ax.sad / t;
  const x = dot(w, pr.ax.u) * f, y = dot(w, pr.ax.v) * f;
  const fieldAtDepth = pr.eqAperture / f;
  const fl = layerSample(pr, x, y, dGeoMm);
  return pr.cal * tmr(pr.e, dRadMm / 10, fieldAtDepth) * f * f * fl;
}

export interface DensityGrid {
  grid: DoseGrid;
  density: Float32Array; // relative electron density, 0 outside the calculation region
}

function sampleDensity(dg: DensityGrid, p: Vec3): number {
  const { dims, spacing, origin } = dg.grid;
  const i = Math.round((p[0] - origin[0]) / spacing[0]);
  const j = Math.round((p[1] - origin[1]) / spacing[1]);
  const k = Math.round((p[2] - origin[2]) / spacing[2]);
  if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) return 0;
  return dg.density[i + dims[0] * (j + dims[1] * k)];
}

/** Distance range along any ray from the source that can cross the grid box. */
function rayRange(dg: DensityGrid, src: Vec3): [number, number] {
  const { dims, spacing, origin } = dg.grid;
  let lo = Infinity, hi = 0;
  for (let c = 0; c < 8; c++) {
    const corner: Vec3 = [
      origin[0] + (c & 1 ? dims[0] : -1) * spacing[0],
      origin[1] + (c & 2 ? dims[1] : -1) * spacing[1],
      origin[2] + (c & 4 ? dims[2] : -1) * spacing[2],
    ];
    const d = len(sub(corner, src));
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  // The nearest point of the box can be closer than its nearest corner
  const half = len([dims[0] * spacing[0], dims[1] * spacing[1], dims[2] * spacing[2]]) / 2;
  const centre: Vec3 = [
    origin[0] + ((dims[0] - 1) * spacing[0]) / 2,
    origin[1] + ((dims[1] - 1) * spacing[1]) / 2,
    origin[2] + ((dims[2] - 1) * spacing[2]) / 2,
  ];
  lo = Math.max(0, Math.min(lo, len(sub(centre, src)) - half));
  return [lo, hi];
}

/** Radiological and geometric depth at a single point, by marching the ray from the source. */
export function depthsAt(dg: DensityGrid, ax: BeamAxes, p: Vec3, heterogeneity: boolean, step = 1): { geo: number; rad: number } | null {
  const w = sub(p, ax.source);
  const total = len(w);
  const dirRay: Vec3 = [w[0] / total, w[1] / total, w[2] / total];
  const [lo] = rayRange(dg, ax.source);
  let rad = 0, entry = -1;
  for (let t = lo; t < total; t += step) {
    const q: Vec3 = [ax.source[0] + dirRay[0] * t, ax.source[1] + dirRay[1] * t, ax.source[2] + dirRay[2] * t];
    const rho = sampleDensity(dg, q);
    if (rho > 0.02) {
      if (entry < 0) entry = t;
      rad += (heterogeneity ? rho : 1) * step;
    }
  }
  if (entry < 0) return null;
  return { geo: total - entry, rad };
}

/** Dose per MU (cGy/MU, or cGy/min) at a single point, e.g. the isocentre or a reference point. */
export function pointDosePerMU(dg: DensityGrid, bm: BeamModel, p: Vec3, heterogeneity: boolean, prepared?: Prepared): number {
  const pr = prepared ?? prepareBeam(bm);
  const dd = depthsAt(dg, pr.ax, p, heterogeneity, 0.5);
  if (!dd) return 0;
  return doseAt(pr, p, dd.geo, dd.rad);
}

/**
 * Full 3D dose for one beam (cGy per MU on the grid). Radiological depths come from a fan of rays through the
 * isocentre plane, interpolated to each voxel.
 */
export function computeBeamDose(dg: DensityGrid, bm: BeamModel, heterogeneity: boolean, onProgress?: (f: number) => void): Float32Array {
  const pr = prepareBeam(bm);
  const { ax } = pr;
  const { dims, spacing, origin } = dg.grid;
  const out = new Float32Array(dims[0] * dims[1] * dims[2]);
  const [r0, r1] = rayRange(dg, ax.source);
  const step = Math.max(1, Math.min(spacing[0], spacing[1], spacing[2]) * 0.75);
  const nSteps = Math.ceil((r1 - r0) / step) + 2;

  // Ray fan over the fluence map extent (plus a margin), collimator frame
  const fm = pr.fluence;
  const rs = Math.max(2.5, Math.min(spacing[0], spacing[1], spacing[2]));
  const fx0 = fm.x0 - 40, fy0 = fm.y0 - 40;
  const fx1 = fm.x0 + (fm.nx - 1) * fm.spacing + 40, fy1 = fm.y0 + (fm.ny - 1) * fm.spacing + 40;
  const rnx = Math.ceil((fx1 - fx0) / rs) + 1, rny = Math.ceil((fy1 - fy0) / rs) + 1;
  const rad = new Float32Array(rnx * rny * nSteps);
  const entry = new Float32Array(rnx * rny).fill(-1);
  for (let iy = 0; iy < rny; iy++) {
    for (let ix = 0; ix < rnx; ix++) {
      const x = fx0 + ix * rs, y = fy0 + iy * rs;
      const dx = ax.dir[0] * ax.sad + ax.u[0] * x + ax.v[0] * y;
      const dy = ax.dir[1] * ax.sad + ax.u[1] * x + ax.v[1] * y;
      const dz = ax.dir[2] * ax.sad + ax.u[2] * x + ax.v[2] * y;
      const L = Math.hypot(dx, dy, dz);
      const ux = dx / L, uy = dy / L, uz = dz / L;
      const base = (ix + iy * rnx) * nSteps;
      let acc = 0, ent = -1;
      for (let s = 0; s < nSteps; s++) {
        const t = r0 + s * step;
        const q: Vec3 = [ax.source[0] + ux * t, ax.source[1] + uy * t, ax.source[2] + uz * t];
        const rho = sampleDensity(dg, q);
        if (rho > 0.02) {
          if (ent < 0) ent = t;
          acc += (heterogeneity ? rho : 1) * step;
        }
        rad[base + s] = acc;
      }
      entry[ix + iy * rnx] = ent;
    }
    onProgress?.(0.4 * ((iy + 1) / rny));
  }

  const nxy = dims[0] * dims[1];
  for (let k = 0; k < dims[2]; k++) {
    for (let j = 0; j < dims[1]; j++) {
      for (let i = 0; i < dims[0]; i++) {
        const idx = i + dims[0] * j + nxy * k;
        if (dg.density[idx] <= 0.02) continue;
        const p: Vec3 = [origin[0] + i * spacing[0], origin[1] + j * spacing[1], origin[2] + k * spacing[2]];
        const w = sub(p, ax.source);
        const t = dot(w, ax.dir);
        if (t <= 1) continue;
        const f = ax.sad / t;
        const x = dot(w, ax.u) * f, y = dot(w, ax.v) * f;
        const r = len(w);
        // Bilinear over the 4 neighbouring rays, linear along the ray
        const gx = (x - fx0) / rs, gy = (y - fy0) / rs;
        const ix = Math.min(rnx - 2, Math.max(0, Math.floor(gx))), iy = Math.min(rny - 2, Math.max(0, Math.floor(gy)));
        const tx = Math.min(1, Math.max(0, gx - ix)), ty = Math.min(1, Math.max(0, gy - iy));
        const fs = (r - r0) / step;
        const s0 = Math.min(nSteps - 2, Math.max(0, Math.floor(fs)));
        const ts = Math.min(1, Math.max(0, fs - s0));
        let dRad = 0, eSum = 0, wSum = 0;
        const corners = [
          [ix, iy, (1 - tx) * (1 - ty)], [ix + 1, iy, tx * (1 - ty)],
          [ix, iy + 1, (1 - tx) * ty], [ix + 1, iy + 1, tx * ty],
        ];
        for (const [cx, cy, wt] of corners) {
          const ri = cx + cy * rnx;
          const b = ri * nSteps + s0;
          dRad += wt * (rad[b] + (rad[b + 1] - rad[b]) * ts);
          const en = entry[ri];
          if (en >= 0) { eSum += wt * en; wSum += wt; }
        }
        const ent = wSum > 0 ? eSum / wSum : r;
        const dGeo = Math.max(0, r - ent);
        if (!heterogeneity) dRad = dGeo;
        const fieldAtDepth = pr.eqAperture / f;
        const fl = layerSample(pr, x, y, dGeo);
        out[idx] = pr.cal * tmr(pr.e, dRad / 10, fieldAtDepth) * f * f * fl;
      }
    }
    onProgress?.(0.4 + 0.6 * ((k + 1) / dims[2]));
  }
  return out;
}

/** Trilinear dose sample (any per-voxel array on the grid) at a patient point; 0 outside. */
export function sampleGrid(grid: DoseGrid, data: Float32Array, p: Vec3): number {
  const { dims, spacing, origin } = grid;
  const fx = (p[0] - origin[0]) / spacing[0], fy = (p[1] - origin[1]) / spacing[1], fz = (p[2] - origin[2]) / spacing[2];
  if (fx < 0 || fy < 0 || fz < 0 || fx > dims[0] - 1 || fy > dims[1] - 1 || fz > dims[2] - 1) return 0;
  const i = Math.min(dims[0] - 2, Math.floor(fx)), j = Math.min(dims[1] - 2, Math.floor(fy)), k = Math.min(dims[2] - 2, Math.floor(fz));
  const tx = fx - i, ty = fy - j, tz = fz - k;
  const nx = dims[0], nxy = dims[0] * dims[1];
  const p0 = i + nx * j + nxy * k;
  const at = (o: number) => data[p0 + o] ?? 0;
  if (dims[2] === 1) {
    return (at(0) * (1 - tx) + at(1) * tx) * (1 - ty) + (at(nx) * (1 - tx) + at(nx + 1) * tx) * ty;
  }
  const c00 = at(0) * (1 - tx) + at(1) * tx;
  const c10 = at(nx) * (1 - tx) + at(nx + 1) * tx;
  const c01 = at(nxy) * (1 - tx) + at(nxy + 1) * tx;
  const c11 = at(nxy + nx) * (1 - tx) + at(nxy + nx + 1) * tx;
  return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
}
