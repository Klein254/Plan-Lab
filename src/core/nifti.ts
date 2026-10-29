// Minimal NIfTI-1 writer for handing a CT to the AI contouring model.
// PlanLab volumes are in DICOM patient axes (LPS: +x left, +y posterior, +z superior); NIfTI world space is RAS,
// so the affine flips x and y: RAS = (−x, −y, z).
import type { Volume } from './types.ts';

export function writeNifti(v: Volume): Uint8Array {
  const [nx, ny, nz] = v.dims;
  const [sx, sy, sz] = v.spacing;
  const [ox, oy, oz] = v.origin;
  const offset = 352;
  const out = new Uint8Array(offset + v.data.length * 2);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, 348, true); // sizeof_hdr
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((d, n) => dv.setInt16(40 + n * 2, d, true));
  dv.setInt16(70, 4, true); // datatype INT16
  dv.setInt16(72, 16, true); // bitpix
  [1, sx, sy, sz, 1, 1, 1, 1].forEach((p, n) => dv.setFloat32(76 + n * 4, p, true)); // pixdim (qfac = 1)
  dv.setFloat32(108, offset, true); // vox_offset
  dv.setFloat32(112, 1, true); // scl_slope
  dv.setFloat32(116, 0, true); // scl_inter
  out[123] = 2; // xyzt_units: mm
  dv.setInt16(252, 1, true); // qform_code: scanner
  dv.setInt16(254, 1, true); // sform_code: scanner
  // qform: 180° about z (diag −1, −1, 1)
  dv.setFloat32(256, 0, true);
  dv.setFloat32(260, 0, true);
  dv.setFloat32(264, 1, true);
  dv.setFloat32(268, -ox, true);
  dv.setFloat32(272, -oy, true);
  dv.setFloat32(276, oz, true);
  // sform rows
  [-sx, 0, 0, -ox].forEach((x, n) => dv.setFloat32(280 + n * 4, x, true));
  [0, -sy, 0, -oy].forEach((x, n) => dv.setFloat32(296 + n * 4, x, true));
  [0, 0, sz, oz].forEach((x, n) => dv.setFloat32(312 + n * 4, x, true));
  out.set([0x6e, 0x2b, 0x31, 0], 344); // magic "n+1"
  // voxel data, x fastest (same order as the Volume)
  new Int16Array(out.buffer, offset, v.data.length).set(v.data);
  return out;
}
