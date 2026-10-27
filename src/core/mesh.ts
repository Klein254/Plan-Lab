// Surface extraction for the 3D view: naive surface nets on a (downsampled) occupancy field, with smoothing.
import type { Vec3 } from './types.ts';

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface Field {
  data: Float32Array; // occupancy / scalar values
  dims: Vec3;
  spacing: Vec3; // mm between samples
  origin: Vec3; // patient position of sample (0,0,0)
}

/**
 * Builds an occupancy field by averaging f×f×f blocks of a voxel predicate, so meshes stay light and smooth.
 */
export function downsampleField(dims: Vec3, spacing: Vec3, origin: Vec3, value: (i: number, j: number, k: number) => number, maxDim = 140): Field {
  const f = Math.max(1, Math.ceil(Math.max(dims[0], dims[1]) / maxDim));
  const fz = Math.max(1, Math.round((f * spacing[0]) / spacing[2]));
  const fac: Vec3 = [f, f, fz];
  const nd: Vec3 = [Math.ceil(dims[0] / f), Math.ceil(dims[1] / f), Math.ceil(dims[2] / fz)];
  const data = new Float32Array(nd[0] * nd[1] * nd[2]);
  for (let K = 0; K < nd[2]; K++)
    for (let J = 0; J < nd[1]; J++)
      for (let I = 0; I < nd[0]; I++) {
        let acc = 0, cnt = 0;
        for (let k = K * fac[2]; k < Math.min(dims[2], (K + 1) * fac[2]); k++)
          for (let j = J * fac[1]; j < Math.min(dims[1], (J + 1) * fac[1]); j++)
            for (let i = I * fac[0]; i < Math.min(dims[0], (I + 1) * fac[0]); i++) {
              acc += value(i, j, k);
              cnt++;
            }
        data[I + nd[0] * (J + nd[1] * K)] = cnt ? acc / cnt : 0;
      }
  const sp: Vec3 = [spacing[0] * fac[0], spacing[1] * fac[1], spacing[2] * fac[2]];
  const org: Vec3 = [origin[0] + ((fac[0] - 1) * spacing[0]) / 2, origin[1] + ((fac[1] - 1) * spacing[1]) / 2, origin[2] + ((fac[2] - 1) * spacing[2]) / 2];
  return { data, dims: nd, spacing: sp, origin: org };
}

/**
 * Occupancy field of a binary mask, cropped to the mask's bounding box (plus a margin), read slice by slice.
 */
export function maskField(m: { nx: number; ny: number; nz: number; slices: (Uint8Array | null)[]; bounds(): [number, number, number, number, number, number] | null }, spacing: Vec3, origin: Vec3, maxDim = 160): Field | null {
  const b = m.bounds();
  if (!b) return null;
  const f = Math.max(1, Math.ceil(Math.max(m.nx, m.ny) / maxDim));
  const fz = Math.max(1, Math.round((f * spacing[0]) / spacing[2]));
  // Align the crop to the block grid and pad by one block on each side
  const i0 = Math.max(0, (Math.floor(b[0] / f) - 1) * f), j0 = Math.max(0, (Math.floor(b[2] / f) - 1) * f), k0 = Math.max(0, (Math.floor(b[4] / fz) - 1) * fz);
  const i1 = Math.min(m.nx, (Math.floor(b[1] / f) + 2) * f), j1 = Math.min(m.ny, (Math.floor(b[3] / f) + 2) * f), k1 = Math.min(m.nz, (Math.floor(b[5] / fz) + 2) * fz);
  const nd: Vec3 = [Math.ceil((i1 - i0) / f), Math.ceil((j1 - j0) / f), Math.ceil((k1 - k0) / fz)];
  const acc = new Float32Array(nd[0] * nd[1] * nd[2]);
  const cnt = f * f * fz;
  for (let k = k0; k < k1; k++) {
    const s = m.slices[k];
    if (!s) continue;
    const K = Math.floor((k - k0) / fz);
    for (let j = j0; j < j1; j++) {
      const J = Math.floor((j - j0) / f);
      const row = j * m.nx;
      const base = nd[0] * (J + nd[1] * K);
      for (let i = i0; i < i1; i++) if (s[row + i]) acc[base + Math.floor((i - i0) / f)] += 1;
    }
  }
  for (let p = 0; p < acc.length; p++) acc[p] /= cnt;
  const sp: Vec3 = [spacing[0] * f, spacing[1] * f, spacing[2] * fz];
  const org: Vec3 = [
    origin[0] + i0 * spacing[0] + ((f - 1) * spacing[0]) / 2,
    origin[1] + j0 * spacing[1] + ((f - 1) * spacing[1]) / 2,
    origin[2] + k0 * spacing[2] + ((fz - 1) * spacing[2]) / 2,
  ];
  return { data: acc, dims: nd, spacing: sp, origin: org };
}

export function surfaceNets(field: Field, level = 0.5, smoothIterations = 2): MeshData | null {
  const [gx, gy, gz] = field.dims;
  // Pad with a layer of "outside" so surfaces close
  const px = gx + 2, py = gy + 2, pz = gz + 2;
  const P = new Float32Array(px * py * pz);
  for (let k = 0; k < gz; k++)
    for (let j = 0; j < gy; j++)
      for (let i = 0; i < gx; i++) P[i + 1 + px * (j + 1 + py * (k + 1))] = field.data[i + gx * (j + gy * k)];
  const at = (x: number, y: number, z: number) => P[x + px * (y + py * z)];
  const cx = px - 1, cy = py - 1, cz = pz - 1;
  const cellVert = new Int32Array(cx * cy * cz).fill(-1);
  const pos: number[] = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v = new Float32Array(8);
  for (let z = 0; z < cz; z++)
    for (let y = 0; y < cy; y++)
      for (let x = 0; x < cx; x++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = at(x + corners[c][0], y + corners[c][1], z + corners[c][2]);
          if (v[c] >= level) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of edges) {
          const ia = v[a] >= level, ib = v[b] >= level;
          if (ia === ib) continue;
          const t = (level - v[a]) / (v[b] - v[a]);
          sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
          sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
          sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
          n++;
        }
        cellVert[x + cx * (y + cy * z)] = pos.length / 3;
        pos.push(x + sx / n, y + sy / n, z + sz / n);
      }
  if (!pos.length) return null;
  const idx: number[] = [];
  const cell = (x: number, y: number, z: number) => cellVert[x + cx * (y + cy * z)];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, b, c, d);
    else idx.push(a, b, c, b, d, c);
  };
  for (let z = 1; z < pz - 1; z++)
    for (let y = 1; y < py - 1; y++)
      for (let x = 1; x < px - 1; x++) {
        const inside = at(x, y, z) >= level;
        if (x + 1 < px && inside !== at(x + 1, y, z) >= level) quad(cell(x, y - 1, z - 1), cell(x, y, z - 1), cell(x, y - 1, z), cell(x, y, z), inside);
        if (y + 1 < py && inside !== at(x, y + 1, z) >= level) quad(cell(x - 1, y, z - 1), cell(x - 1, y, z), cell(x, y, z - 1), cell(x, y, z), inside);
        if (z + 1 < pz && inside !== at(x, y, z + 1) >= level) quad(cell(x - 1, y - 1, z), cell(x, y - 1, z), cell(x - 1, y, z), cell(x, y, z), inside);
      }
  const positions = Float32Array.from(pos);
  const indices = Uint32Array.from(idx);
  // Laplacian smoothing over the triangle adjacency
  if (smoothIterations > 0) {
    const nv = positions.length / 3;
    const acc = new Float32Array(nv * 3), cnt = new Uint16Array(nv);
    for (let it = 0; it < smoothIterations; it++) {
      acc.fill(0);
      cnt.fill(0);
      for (let t = 0; t < indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = indices[t + e], b = indices[t + ((e + 1) % 3)];
          acc[a * 3] += positions[b * 3]; acc[a * 3 + 1] += positions[b * 3 + 1]; acc[a * 3 + 2] += positions[b * 3 + 2]; cnt[a]++;
          acc[b * 3] += positions[a * 3]; acc[b * 3 + 1] += positions[a * 3 + 1]; acc[b * 3 + 2] += positions[a * 3 + 2]; cnt[b]++;
        }
      }
      for (let p = 0; p < nv; p++) {
        if (!cnt[p]) continue;
        for (let c = 0; c < 3; c++) positions[p * 3 + c] = 0.5 * positions[p * 3 + c] + (0.5 * acc[p * 3 + c]) / cnt[p];
      }
    }
  }
  // To patient coordinates (padded cell (x,y,z) ↔ field sample (x-1, y-1, z-1) + corner offset)
  for (let p = 0; p < positions.length; p += 3) {
    positions[p] = field.origin[0] + (positions[p] - 1) * field.spacing[0];
    positions[p + 1] = field.origin[1] + (positions[p + 1] - 1) * field.spacing[1];
    positions[p + 2] = field.origin[2] + (positions[p + 2] - 1) * field.spacing[2];
  }
  return { positions, indices };
}
