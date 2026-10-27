// Synthetic CT phantoms written as real DICOM series, for tests and demos.
import { writeDicom, newUid, type DicomElement } from '../src/core/dicom/writer.ts';
import { SOP_CT } from '../src/core/dicom/parse.ts';

export interface PhantomOptions {
  site: 'pelvis' | 'thorax';
  size?: number; // rows = cols
  pixel?: number; // mm
  slices?: number;
  thickness?: number; // mm
  name?: string;
  patientId?: string;
  descending?: boolean; // write slices in reverse order (as some scanners do)
  flipRows?: boolean; // write with column direction (0,-1,0)
}

/** HU at a patient point (mm, isocentre-ish at 0,0,0). */
function huAt(site: PhantomOptions['site'], x: number, y: number, z: number): number {
  const inEll = (cx: number, cy: number, a: number, b: number) => ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 <= 1;
  const inSph = (cx: number, cy: number, cz: number, r: number) => (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r * r;
  if (!inEll(0, 0, 170, 115)) return y > 130 && y < 145 && Math.abs(x) < 220 ? 200 : -1000; // couch plate below the patient
  if (!inEll(0, 0, 163, 108)) return -90; // fat layer
  if (site === 'pelvis') {
    // Femoral heads (low slices), pelvic ring (higher slices)
    for (const sx of [-95, 95]) {
      if (inSph(sx, 10, -30, 26)) return inSph(sx, 10, -30, 21) ? 350 : 900;
      if (z < -30 && inEll(sx * 1.05, 10, 16, 16)) return inEll(sx * 1.05, 10, 11, 11) ? 300 : 900;
    }
    if (z > 0 && (inEll(-90, 5, 28, 60) || inEll(90, 5, 28, 60))) return inEll(-90, 5, 20, 52) || inEll(90, 5, 20, 52) ? 250 : 800;
    // Sacrum / spine
    if (z > 10 && inEll(0, 70, 35, 22)) return inEll(0, 70, 27, 15) ? 280 : 850;
    if (inSph(0, -40, 15, 38) || (z > 15 && inEll(0, -40, 38, 30) && z < 40)) return 8; // bladder
    if (inEll(0, 40, 17, 15)) return inEll(0, 40, 7, 6) ? -800 : 35; // rectum with gas
    if (inSph(0, 0, -5, 22)) return 48; // prostate
    return 40;
  }
  // Thorax: lungs, heart, spine, sternum
  if (inEll(0, 75, 22, 22)) return inEll(0, 75, 15, 15) ? 300 : 900; // vertebra
  if (inEll(0, 95, 6, 6)) return 900;
  if (inEll(0, -95, 22, 8)) return 600; // sternum
  if (inEll(-15, -30, 55, 50)) return 45; // heart
  if (inEll(-75, 0, 62, 85) || inEll(75, 0, 62, 85)) {
    if (inSph(70, -10, 0, 18)) return 40; // tumour in the left lung
    return -820;
  }
  if (inEll(0, -15, 12, 12) && z > 40) return -900; // trachea
  return 40;
}

export function makePhantom(opt: PhantomOptions): { name: string; bytes: Uint8Array }[] {
  const size = opt.size ?? 256, px = opt.pixel ?? 1.5, nz = opt.slices ?? 40, dz = opt.thickness ?? 3;
  const studyUid = newUid(), seriesUid = newUid(), forUid = newUid();
  const origin = -((size - 1) * px) / 2;
  const files: { name: string; bytes: Uint8Array }[] = [];
  const order = [...Array(nz).keys()];
  if (opt.descending) order.reverse();
  for (const k of order) {
    const z = -((nz - 1) * dz) / 2 + k * dz;
    const pixels = new Int16Array(size * size);
    for (let r = 0; r < size; r++) {
      const y = opt.flipRows ? -origin - r * px : origin + r * px;
      for (let c = 0; c < size; c++) {
        const x = origin + c * px;
        // Raw value = HU + 1024 (rescale intercept −1024), with a little noise
        const hu = huAt(opt.site, x, y, z) + Math.round((Math.sin(r * 12.9898 + c * 78.233 + k) * 43758.5453) % 1 * 6);
        pixels[r * size + c] = hu + 1024;
      }
    }
    const sop = newUid();
    const el: DicomElement[] = [
      { tag: 0x00080016, vr: 'UI', value: SOP_CT },
      { tag: 0x00080018, vr: 'UI', value: sop },
      { tag: 0x00080020, vr: 'DA', value: '20260720' },
      { tag: 0x00080060, vr: 'CS', value: 'CT' },
      { tag: 0x00081030, vr: 'LO', value: opt.site === 'pelvis' ? 'CT Pelvis RT planning' : 'CT Thorax RT planning' },
      { tag: 0x0008103e, vr: 'LO', value: `Phantom ${opt.site}` },
      { tag: 0x00100010, vr: 'PN', value: opt.name ?? 'PHANTOM^PELVIS' },
      { tag: 0x00100020, vr: 'LO', value: opt.patientId ?? 'PH-0001' },
      { tag: 0x00100030, vr: 'DA', value: '19700101' },
      { tag: 0x00100040, vr: 'CS', value: 'M' },
      { tag: 0x00180050, vr: 'DS', value: dz },
      { tag: 0x00185100, vr: 'CS', value: 'HFS' },
      { tag: 0x0020000d, vr: 'UI', value: studyUid },
      { tag: 0x0020000e, vr: 'UI', value: seriesUid },
      { tag: 0x00200011, vr: 'IS', value: 2 },
      { tag: 0x00200013, vr: 'IS', value: k + 1 },
      { tag: 0x00200032, vr: 'DS', value: [origin, opt.flipRows ? -origin : origin, z] },
      { tag: 0x00200037, vr: 'DS', value: [1, 0, 0, 0, opt.flipRows ? -1 : 1, 0] },
      { tag: 0x00200052, vr: 'UI', value: forUid },
      { tag: 0x00280002, vr: 'US', value: 1 },
      { tag: 0x00280004, vr: 'CS', value: 'MONOCHROME2' },
      { tag: 0x00280010, vr: 'US', value: size },
      { tag: 0x00280011, vr: 'US', value: size },
      { tag: 0x00280030, vr: 'DS', value: [px, px] },
      { tag: 0x00280100, vr: 'US', value: 16 },
      { tag: 0x00280101, vr: 'US', value: 16 },
      { tag: 0x00280102, vr: 'US', value: 15 },
      { tag: 0x00280103, vr: 'US', value: 1 },
      { tag: 0x00281052, vr: 'DS', value: -1024 },
      { tag: 0x00281053, vr: 'DS', value: 1 },
      { tag: 0x7fe00010, vr: 'OW', value: pixels },
    ];
    files.push({ name: `CT.${String(k + 1).padStart(4, '0')}.dcm`, bytes: writeDicom(el, SOP_CT, sop) });
  }
  return files;
}
