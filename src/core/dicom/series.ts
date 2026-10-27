// Groups parsed instances into series and assembles CT series into an axis-aligned volume.
import type { ParsedInstance, RtStruct } from './parse.ts';
import type { Vec3, Volume } from '../types.ts';
import { Mask } from '../mask.ts';
import { fillPolygon } from '../contour2d.ts';

export interface SeriesSummary {
  seriesUid: string;
  modality: string;
  description: string;
  patientName: string;
  patientId: string;
  studyDate: string;
  frameOfReferenceUid: string;
  count: number;
  rows: number;
  cols: number;
  usable: boolean;
  problem: string | null;
}

export function groupSeries(instances: ParsedInstance[]): Map<string, ParsedInstance[]> {
  const map = new Map<string, ParsedInstance[]>();
  for (const inst of instances) {
    const key = inst.seriesUid || `no-series-${inst.modality}`;
    let l = map.get(key);
    if (!l) map.set(key, (l = []));
    l.push(inst);
  }
  return map;
}

export function summarise(seriesUid: string, list: ParsedInstance[]): SeriesSummary {
  const f = list[0];
  let problem: string | null = null;
  if (f.modality === 'RTSTRUCT') problem = null;
  else if (f.modality !== 'CT') problem = `${f.modality || 'Unknown'} images can't be planned on yet (CT only for now)`;
  else if (list.length < 2) problem = 'Only one slice: a CT volume needs a series of slices';
  else if (list.some((i) => !i.ipp || !i.iop || !i.pixelSpacing || !i.hu)) problem = 'Some slices lack position or pixel data';
  return {
    seriesUid,
    modality: f.modality,
    description: f.seriesDescription || f.studyDescription || (f.modality === 'RTSTRUCT' ? f.rtstruct?.label ?? 'Structure set' : 'Unnamed series'),
    patientName: f.patientName,
    patientId: f.patientId,
    studyDate: f.studyDate,
    frameOfReferenceUid: f.frameOfReferenceUid,
    count: list.length,
    rows: f.rows,
    cols: f.cols,
    usable: f.modality === 'RTSTRUCT' ? !!f.rtstruct?.rois.length : !problem,
    problem,
  };
}

export interface BuiltVolume {
  volume: Volume;
  sliceZ: number[];
  sopUids: string[];
  warnings: string[];
}

const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

/** Builds an axis-aligned HU volume (i → +x, j → +y, k → +z) from a CT series. */
export function buildVolume(list: ParsedInstance[]): BuiltVolume {
  const warnings: string[] = [];
  const f = list[0];
  const iop = f.iop!;
  const row: Vec3 = [iop[0], iop[1], iop[2]];
  const col: Vec3 = [iop[3], iop[4], iop[5]];
  // Only axial acquisitions (rows along ±x, columns along ±y) are supported
  const rowSign = near(Math.abs(row[0]), 1, 0.02) ? Math.sign(row[0]) : 0;
  const colSign = near(Math.abs(col[1]), 1, 0.02) ? Math.sign(col[1]) : 0;
  if (!rowSign || !colSign) throw new Error('This series is not axial (or has gantry tilt / oblique orientation). Import an axial CT.');
  const rows = f.rows, cols = f.cols;
  if (list.some((i) => i.rows !== rows || i.cols !== cols)) throw new Error('Slices have different sizes.');
  const sorted = [...list].sort((a, b) => a.ipp![2] - b.ipp![2]);
  // Drop duplicate positions (e.g. repeated exports)
  const uniq: ParsedInstance[] = [];
  for (const s of sorted) if (!uniq.length || !near(uniq[uniq.length - 1].ipp![2], s.ipp![2], 0.001)) uniq.push(s);
  if (uniq.length < sorted.length) warnings.push(`${sorted.length - uniq.length} duplicate slice(s) ignored.`);
  if (uniq.length < 2) throw new Error('Need at least two slices at different positions.');
  const zs = uniq.map((s) => s.ipp![2]);
  const gaps = zs.slice(1).map((z, n) => z - zs[n]);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const dz = sortedGaps[Math.floor(sortedGaps.length / 2)];
  const irregular = gaps.some((g) => Math.abs(g - dz) > 0.02 * dz + 0.01);
  const nz = irregular ? Math.round((zs[zs.length - 1] - zs[0]) / dz) + 1 : uniq.length;
  if (irregular) warnings.push(`Slice spacing varies (${sortedGaps[0].toFixed(2)}–${sortedGaps[sortedGaps.length - 1].toFixed(2)} mm); resampled to ${dz.toFixed(2)} mm.`);
  if (uniq.some((s) => !near(s.ipp![0], f.ipp![0], 0.5) || !near(s.ipp![1], f.ipp![1], 0.5))) warnings.push('Slice origins shift in-plane between slices; using the first slice\'s origin.');
  const [rowSpacing, colSpacing] = f.pixelSpacing!; // DICOM: row spacing (between rows, along y), column spacing (along x)
  const nx = cols, ny = rows;
  const data = new Int16Array(nx * ny * nz);
  const copySlice = (src: Int16Array, k: number, weight = 1, accumulate = false) => {
    const base = k * nx * ny;
    for (let r = 0; r < rows; r++) {
      const j = colSign > 0 ? r : rows - 1 - r;
      for (let c = 0; c < cols; c++) {
        const i = rowSign > 0 ? c : cols - 1 - c;
        const v = src[r * cols + c];
        const p = base + i + nx * j;
        data[p] = accumulate ? Math.round(data[p] + v * weight) : Math.round(v * weight);
      }
    }
  };
  const sopUids: string[] = [];
  if (!irregular) {
    uniq.forEach((s, k) => {
      copySlice(s.hu!, k);
      sopUids.push(s.sopInstanceUid);
    });
  } else {
    let n = 0;
    for (let k = 0; k < nz; k++) {
      const z = zs[0] + k * dz;
      while (n < uniq.length - 2 && zs[n + 1] < z) n++;
      const t = Math.min(1, Math.max(0, (z - zs[n]) / (zs[n + 1] - zs[n])));
      copySlice(uniq[n].hu!, k, 1 - t);
      copySlice(uniq[n + 1].hu!, k, t, true);
      sopUids.push((t < 0.5 ? uniq[n] : uniq[n + 1]).sopInstanceUid);
    }
  }
  // Origin = patient position of voxel (0,0,0) after the flips
  const ox = rowSign > 0 ? f.ipp![0] : f.ipp![0] - (cols - 1) * colSpacing;
  const oy = colSign > 0 ? f.ipp![1] : f.ipp![1] - (rows - 1) * rowSpacing;
  const volume: Volume = { dims: [nx, ny, nz], spacing: [colSpacing, rowSpacing, dz], origin: [ox, oy, zs[0]], data };
  if (f.patientPosition && f.patientPosition !== 'HFS')
    warnings.push(`Patient position is ${f.patientPosition}. Beam angles in PlanLab assume head-first supine (HFS).`);
  return { volume, sliceZ: zs, sopUids, warnings };
}

/** Converts RTSTRUCT contours to masks on the volume grid (even–odd rule within each slice for holes). */
export function rtstructToMasks(rs: RtStruct, v: Volume): { roi: RtStruct['rois'][number]; mask: Mask }[] {
  const [nx, ny, nz] = v.dims;
  const out: { roi: RtStruct['rois'][number]; mask: Mask }[] = [];
  const tmp = new Uint8Array(nx * ny);
  for (const roi of rs.rois) {
    const mask = new Mask(nx, ny, nz);
    for (const c of roi.contours) {
      const z = c[2];
      const k = Math.round((z - v.origin[2]) / v.spacing[2]);
      if (k < 0 || k >= nz || Math.abs(v.origin[2] + k * v.spacing[2] - z) > v.spacing[2] * 0.6) continue;
      const pts: number[] = [];
      for (let p = 0; p + 2 < c.length; p += 3) pts.push((c[p] - v.origin[0]) / v.spacing[0], (c[p + 1] - v.origin[1]) / v.spacing[1]);
      tmp.fill(0);
      fillPolygon(tmp, nx, ny, pts, 1);
      const s = mask.slice(k, true)!;
      for (let p = 0; p < tmp.length; p++) if (tmp[p]) s[p] ^= 1;
      mask.compact(k);
    }
    out.push({ roi, mask });
  }
  return out;
}
