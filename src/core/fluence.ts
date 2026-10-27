// Primary fluence maps at the isocentre plane (collimator frame): jaws, MLC, wedges and horns.
import type { Beam } from './types.ts';
import { effectiveMu, type EnergyModel, type Machine } from './machines.ts';
import { deg } from './geometry.ts';

export interface FluenceMap {
  data: Float32Array;
  nx: number;
  ny: number;
  x0: number; // centre of pixel 0, mm
  y0: number;
  spacing: number;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Fraction of the pixel [xa,xb]×[ya,yb] that the MLC leaves leave open. */
function mlcOpenFraction(beam: Beam, machine: Machine, xa: number, xb: number, ya: number, yb: number): number {
  const mlc = machine.mlc;
  if (!mlc || !beam.mlc) return 1;
  const B = mlc.boundaries;
  let open = 0;
  const h = yb - ya;
  // Outside the MLC's coverage the leaves don't block anything
  if (ya < B[0]) open += (Math.min(yb, B[0]) - ya) / h;
  if (yb > B[B.length - 1]) open += (yb - Math.max(ya, B[B.length - 1])) / h;
  for (let p = 0; p < B.length - 1; p++) {
    const oy = overlap(ya, yb, B[p], B[p + 1]);
    if (oy <= 0) continue;
    const ox = overlap(xa, xb, beam.mlc.x1[p], beam.mlc.x2[p]);
    open += (oy / h) * (ox / (xb - xa));
  }
  return Math.min(1, open);
}

/** Wedge transmission multiplier at collimator coordinates (normalised to 1 on the central axis). */
export function wedgeProfile(beam: Beam, e: EnergyModel, x: number, y: number): number {
  const w = beam.wedge;
  if (w.type === 'none' || !w.angle) return 1;
  const k = (effectiveMu(e) * Math.tan(w.angle * deg)) / 10; // per mm
  // Coordinate towards the heel (thick end)
  const s = w.orientation === 'left' ? -x : w.orientation === 'right' ? x : w.orientation === 'in' ? y : -y;
  return Math.exp(-k * s);
}

export function buildFluence(beam: Beam, machine: Machine, e: EnergyModel, spacing = 2, margin = 60): FluenceMap {
  const j = beam.jaws;
  const halfX = machine.maxField.x / 2 + margin, halfY = machine.maxField.y / 2 + margin;
  const xmin = Math.max(-halfX, j.x1 - margin), xmax = Math.min(halfX, j.x2 + margin);
  const ymin = Math.max(-halfY, j.y1 - margin), ymax = Math.min(halfY, j.y2 + margin);
  const nx = Math.max(2, Math.ceil((xmax - xmin) / spacing) + 1);
  const ny = Math.max(2, Math.ceil((ymax - ymin) / spacing) + 1);
  const data = new Float32Array(nx * ny);
  const tJaw = machine.jawTransmission, tMlc = machine.mlc?.transmission ?? 0;
  const h = spacing / 2;
  const hornR2 = 200 * 200;
  for (let iy = 0; iy < ny; iy++) {
    const y = ymin + iy * spacing;
    const jy = overlap(y - h, y + h, j.y1, j.y2) / spacing;
    for (let ix = 0; ix < nx; ix++) {
      const x = xmin + ix * spacing;
      const jawOpen = jy * (overlap(x - h, x + h, j.x1, j.x2) / spacing);
      const mlcOpen = jawOpen > 0 || tJaw > 0 ? mlcOpenFraction(beam, machine, x - h, x + h, y - h, y + h) : 0;
      let f = (jawOpen + (1 - jawOpen) * tJaw) * (mlcOpen + (1 - mlcOpen) * tMlc);
      f *= wedgeProfile(beam, e, x, y);
      if (e.horn) f *= 1 + (e.horn * (x * x + y * y)) / hornR2;
      data[ix + iy * nx] = f;
    }
  }
  return { data, nx, ny, x0: xmin, y0: ymin, spacing };
}

/** Equivalent squares (cm): of the jaw opening (for Sc) and of the open aperture inside jaws and MLC (for Sp/TMR). */
export function equivalentSquares(beam: Beam, machine: Machine): { jaw: number; aperture: number; areaCm2: number } {
  const j = beam.jaws;
  const X = Math.max(1, j.x2 - j.x1), Y = Math.max(1, j.y2 - j.y1);
  const jaw = (2 * X * Y) / (X + Y) / 10;
  if (!machine.mlc || !beam.mlc) return { jaw, aperture: jaw, areaCm2: (X * Y) / 100 };
  // Rasterise the aperture at 2 mm to measure area and perimeter
  const s = 2;
  const nx = Math.ceil(X / s), ny = Math.ceil(Y / s);
  const open = new Uint8Array(nx * ny);
  let area = 0;
  for (let iy = 0; iy < ny; iy++) {
    const y = j.y1 + (iy + 0.5) * s;
    for (let ix = 0; ix < nx; ix++) {
      const x = j.x1 + (ix + 0.5) * s;
      if (mlcOpenFraction(beam, machine, x - 0.01, x + 0.01, y - 0.01, y + 0.01) > 0.5) {
        open[ix + iy * nx] = 1;
        area++;
      }
    }
  }
  if (!area) return { jaw, aperture: 0.5, areaCm2: 0 };
  let edges = 0;
  for (let iy = 0; iy < ny; iy++)
    for (let ix = 0; ix < nx; ix++) {
      if (!open[ix + iy * nx]) continue;
      if (ix === 0 || !open[ix - 1 + iy * nx]) edges++;
      if (ix === nx - 1 || !open[ix + 1 + iy * nx]) edges++;
      if (iy === 0 || !open[ix + (iy - 1) * nx]) edges++;
      if (iy === ny - 1 || !open[ix + (iy + 1) * nx]) edges++;
    }
  // Pixel-edge perimeters overestimate oblique outlines by ~4/π; correct for that
  const A = area * s * s, P = (edges * s * Math.PI) / 4;
  return { jaw, aperture: Math.max(0.5, (4 * A) / P / 10), areaCm2: A / 100 };
}

/** Separable Gaussian blur (σ in pixels), zero outside the map. */
export function gaussianBlur(src: Float32Array, nx: number, ny: number, sigma: number): Float32Array {
  if (sigma < 0.3) return src.slice();
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(nx * ny), out = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < nx) a += src[y * nx + xx] * k[i + r];
      }
      tmp[y * nx + x] = a;
    }
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < ny) a += tmp[yy * nx + x] * k[i + r];
      }
      out[y * nx + x] = a;
    }
  return out;
}

export function sampleMap(m: FluenceMap, data: Float32Array, x: number, y: number): number {
  const fx = (x - m.x0) / m.spacing, fy = (y - m.y0) / m.spacing;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  if (ix < 0 || iy < 0 || ix >= m.nx - 1 || iy >= m.ny - 1) {
    // Beyond the map: clamp to the nearest edge value (transmission level)
    const cx = Math.min(m.nx - 1, Math.max(0, Math.round(fx))), cy = Math.min(m.ny - 1, Math.max(0, Math.round(fy)));
    return data[cx + cy * m.nx];
  }
  const tx = fx - ix, ty = fy - iy;
  const p = ix + iy * m.nx;
  return (data[p] * (1 - tx) + data[p + 1] * tx) * (1 - ty) + (data[p + m.nx] * (1 - tx) + data[p + m.nx + 1] * tx) * ty;
}
