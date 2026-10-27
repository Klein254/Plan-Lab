// DICOM RT export: structure sets (RTSTRUCT) and dose (RTDOSE), readable by 3D Slicer and clinical systems.
import { writeDicom, newUid, dicomDate, dicomTime, type DicomElement } from './writer.ts';
import { SOP_CT, SOP_RTSTRUCT } from './parse.ts';
import { chainSegments, isoSegments, simplify } from '../contour2d.ts';
import type { Mask } from '../mask.ts';
import type { DoseGrid, ImageSetMeta, PatientInfo, StructureMeta, StructureType } from '../types.ts';

const SOP_RTDOSE = '1.2.840.10008.5.1.4.1.1.481.2';

const interpreted: Record<StructureType, string> = {
  EXTERNAL: 'EXTERNAL', GTV: 'GTV', CTV: 'CTV', ITV: 'CTV', PTV: 'PTV', OAR: 'ORGAN',
  AVOIDANCE: 'AVOIDANCE', BOLUS: 'BOLUS', SUPPORT: 'SUPPORT', CONTROL: 'CONTROL',
};

function patientModule(p: PatientInfo, img: ImageSetMeta): DicomElement[] {
  return [
    { tag: 0x00080020, vr: 'DA', value: img.studyDate || dicomDate() },
    { tag: 0x00080070, vr: 'LO', value: 'PlanLab (training)' },
    { tag: 0x00100010, vr: 'PN', value: p.name.replace(/\s+/g, '^') },
    { tag: 0x00100020, vr: 'LO', value: p.patientId },
    { tag: 0x00100030, vr: 'DA', value: p.birthDate },
    { tag: 0x00100040, vr: 'CS', value: p.sex },
    { tag: 0x0020000d, vr: 'UI', value: img.studyUid },
    { tag: 0x00200052, vr: 'UI', value: img.frameOfReferenceUid },
  ];
}

export function exportRtStruct(p: PatientInfo, img: ImageSetMeta, label: string, structures: { meta: StructureMeta; mask: Mask }[]): Uint8Array {
  const sop = newUid();
  const [sx, sy, sz] = img.spacing;
  const [ox, oy, oz] = img.origin;
  const contourImages = img.sopUids.map((uid) => [
    { tag: 0x00081150, vr: 'UI', value: SOP_CT },
    { tag: 0x00081155, vr: 'UI', value: uid },
  ] as DicomElement[]);
  const roiSeq: DicomElement[][] = [];
  const contourSeq: DicomElement[][] = [];
  const obsSeq: DicomElement[][] = [];
  structures.forEach(({ meta, mask }, n) => {
    const number = n + 1;
    roiSeq.push([
      { tag: 0x30060022, vr: 'IS', value: number },
      { tag: 0x30060024, vr: 'UI', value: img.frameOfReferenceUid },
      { tag: 0x30060026, vr: 'LO', value: meta.name },
      { tag: 0x30060036, vr: 'CS', value: 'MANUAL' },
    ]);
    const contours: DicomElement[][] = [];
    for (let k = 0; k < mask.nz; k++) {
      const s = mask.slices[k];
      if (!s) continue;
      const z = oz + k * sz;
      for (const line of chainSegments(isoSegments(s, mask.nx, mask.ny, 0.5))) {
        const pts = simplify(line, 0.15);
        const n2 = pts.length / 2 - (pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1] ? 1 : 0);
        if (n2 < 3) continue;
        const data: number[] = [];
        for (let q = 0; q < n2; q++) data.push(+(ox + pts[q * 2] * sx).toFixed(2), +(oy + pts[q * 2 + 1] * sy).toFixed(2), +z.toFixed(2));
        contours.push([
          { tag: 0x30060016, vr: 'SQ', value: img.sopUids[k] ? [contourImages[k]] : [] },
          { tag: 0x30060042, vr: 'CS', value: 'CLOSED_PLANAR' },
          { tag: 0x30060046, vr: 'IS', value: n2 },
          { tag: 0x30060050, vr: 'DS', value: data },
        ]);
      }
    }
    const rgb = [1, 3, 5].map((o) => parseInt(meta.color.slice(o, o + 2), 16));
    contourSeq.push([
      { tag: 0x3006002a, vr: 'IS', value: rgb },
      { tag: 0x30060040, vr: 'SQ', value: contours },
      { tag: 0x30060084, vr: 'IS', value: number },
    ]);
    obsSeq.push([
      { tag: 0x30060082, vr: 'IS', value: number },
      { tag: 0x30060084, vr: 'IS', value: number },
      { tag: 0x300600a4, vr: 'CS', value: interpreted[meta.type] },
      { tag: 0x300600a6, vr: 'PN', value: '' },
    ]);
  });
  const elements: DicomElement[] = [
    ...patientModule(p, img).filter((e) => e.tag !== 0x00200052),
    { tag: 0x00080016, vr: 'UI', value: SOP_RTSTRUCT },
    { tag: 0x00080018, vr: 'UI', value: sop },
    { tag: 0x00080060, vr: 'CS', value: 'RTSTRUCT' },
    { tag: 0x0008103e, vr: 'LO', value: label },
    { tag: 0x0020000e, vr: 'UI', value: newUid() },
    { tag: 0x00200011, vr: 'IS', value: 900 },
    { tag: 0x30060002, vr: 'SH', value: label.slice(0, 16) },
    { tag: 0x30060008, vr: 'DA', value: dicomDate() },
    { tag: 0x30060009, vr: 'TM', value: dicomTime() },
    {
      tag: 0x30060010, vr: 'SQ', value: [[
        { tag: 0x00200052, vr: 'UI', value: img.frameOfReferenceUid },
        {
          tag: 0x30060012, vr: 'SQ', value: [[
            { tag: 0x00081150, vr: 'UI', value: '1.2.840.10008.3.1.2.3.1' },
            { tag: 0x00081155, vr: 'UI', value: img.studyUid },
            {
              tag: 0x30060014, vr: 'SQ', value: [[
                { tag: 0x0020000e, vr: 'UI', value: img.seriesUid },
                { tag: 0x30060016, vr: 'SQ', value: contourImages.filter((_, k) => img.sopUids[k]) },
              ]],
            },
          ]],
        },
      ]],
    },
    { tag: 0x30060020, vr: 'SQ', value: roiSeq },
    { tag: 0x30060039, vr: 'SQ', value: contourSeq },
    { tag: 0x30060080, vr: 'SQ', value: obsSeq },
  ];
  return writeDicom(elements, SOP_RTSTRUCT, sop);
}

export function exportRtDose(p: PatientInfo, img: ImageSetMeta, grid: DoseGrid, doseGy: Float32Array, label: string): Uint8Array {
  const sop = newUid();
  const [nx, ny, nz] = grid.dims;
  let max = 0;
  for (const d of doseGy) if (d > max) max = d;
  const scaling = max > 0 ? max / 4e9 : 1;
  const pixels = new Uint32Array(doseGy.length);
  for (let n = 0; n < doseGy.length; n++) pixels[n] = Math.max(0, Math.round(doseGy[n] / scaling));
  const elements: DicomElement[] = [
    ...patientModule(p, img),
    { tag: 0x00080016, vr: 'UI', value: SOP_RTDOSE },
    { tag: 0x00080018, vr: 'UI', value: sop },
    { tag: 0x00080060, vr: 'CS', value: 'RTDOSE' },
    { tag: 0x0008103e, vr: 'LO', value: label },
    { tag: 0x0020000e, vr: 'UI', value: newUid() },
    { tag: 0x00200011, vr: 'IS', value: 901 },
    { tag: 0x00200032, vr: 'DS', value: grid.origin },
    { tag: 0x00200037, vr: 'DS', value: [1, 0, 0, 0, 1, 0] },
    { tag: 0x00280002, vr: 'US', value: 1 },
    { tag: 0x00280004, vr: 'CS', value: 'MONOCHROME2' },
    { tag: 0x00280008, vr: 'IS', value: nz },
    { tag: 0x00280009, vr: 'AT', value: new Uint8Array([0x04, 0x30, 0x0c, 0x00]) },
    { tag: 0x00280010, vr: 'US', value: ny },
    { tag: 0x00280011, vr: 'US', value: nx },
    { tag: 0x00280030, vr: 'DS', value: [grid.spacing[1], grid.spacing[0]] },
    { tag: 0x00280100, vr: 'US', value: 32 },
    { tag: 0x00280101, vr: 'US', value: 32 },
    { tag: 0x00280102, vr: 'US', value: 31 },
    { tag: 0x00280103, vr: 'US', value: 0 },
    { tag: 0x30040002, vr: 'CS', value: 'GY' },
    { tag: 0x30040004, vr: 'CS', value: 'PHYSICAL' },
    { tag: 0x3004000a, vr: 'CS', value: 'PLAN' },
    { tag: 0x3004000c, vr: 'DS', value: Array.from({ length: nz }, (_, k) => k * grid.spacing[2]) },
    { tag: 0x3004000e, vr: 'DS', value: scaling },
    { tag: 0x7fe00010, vr: 'OW', value: pixels },
  ];
  return writeDicom(elements, SOP_RTDOSE, sop);
}
