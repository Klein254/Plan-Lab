// Reads DICOM files: CT images (uncompressed, RLE, JPEG Lossless, deflated) and RT Structure Sets.
import dicomParser from 'dicom-parser';
import type * as DP from 'dicom-parser';
import { inflateSync } from 'fflate';
// @ts-expect-error - the package ships no type declarations
import { Decoder as JpegLosslessDecoder } from 'jpeg-lossless-decoder-js';
import type { Vec3 } from '../types.ts';

type DataSet = DP.DataSet;

export interface RtRoi {
  number: number;
  name: string;
  color: string | null;
  interpretedType: string;
  contours: number[][]; // each closed planar contour as x,y,z triples (mm)
}

export interface RtStruct {
  frameOfReferenceUid: string;
  referencedSeriesUid: string;
  label: string;
  rois: RtRoi[];
}

export interface ParsedInstance {
  fileName: string;
  sopClassUid: string;
  sopInstanceUid: string;
  modality: string;
  patientName: string;
  patientId: string;
  sex: string;
  birthDate: string;
  studyUid: string;
  studyDate: string;
  studyDescription: string;
  seriesUid: string;
  seriesDescription: string;
  seriesNumber: number;
  frameOfReferenceUid: string;
  patientPosition: string;
  instanceNumber: number;
  rows: number;
  cols: number;
  frames: number;
  ipp: Vec3 | null;
  iop: number[] | null;
  pixelSpacing: [number, number] | null;
  sliceThickness: number;
  hu?: Int16Array; // decoded and rescaled pixels (rows × cols)
  rtstruct?: RtStruct;
}

export const SOP_CT = '1.2.840.10008.5.1.4.1.1.2';
export const SOP_RTSTRUCT = '1.2.840.10008.5.1.4.1.1.481.3';

// Sequence tags that may appear with explicit lengths in implicit-VR files
const SEQUENCE_TAGS = new Set([
  'x30060010', 'x30060012', 'x30060014', 'x30060016', 'x30060020', 'x30060039', 'x30060040', 'x30060080',
  'x300600b0', 'x30060016', 'x00081115', 'x00081140', 'x00089215', 'x00082112', 'x52009229', 'x52009230',
]);

const str = (ds: DataSet, tag: string) => (ds.string(tag) ?? '').trim();
const num = (ds: DataSet, tag: string, fallback = 0) => {
  const v = ds.floatString(tag);
  return v === undefined || isNaN(v) ? fallback : v;
};
const nums = (ds: DataSet, tag: string): number[] | null => {
  const s = ds.string(tag);
  if (!s) return null;
  const out = s.split('\\').map(Number);
  return out.some(isNaN) ? null : out;
};

function parseBytes(bytes: Uint8Array): DataSet {
  const options = {
    vrCallback: (tag: string) => (SEQUENCE_TAGS.has(tag) ? 'SQ' : undefined),
    inflater: (arr: Uint8Array, position: number) => {
      const inflated = inflateSync(arr.subarray(position));
      const out = new Uint8Array(position + inflated.length);
      out.set(arr.subarray(0, position));
      out.set(inflated, position);
      return out;
    },
  } as unknown as DP.ParseDicomOptions;
  try {
    return dicomParser.parseDicom(bytes, options);
  } catch (err) {
    // Files without the 128-byte preamble / DICM prefix: assume implicit VR little endian
    const msg = String((err as Error)?.message ?? err);
    if (msg.includes('DICM')) {
      return dicomParser.parseDicom(bytes, { ...(options as object), TransferSyntaxUID: '1.2.840.10008.1.2' } as DP.ParseDicomOptions);
    }
    throw err;
  }
}

/** Parses one file. Returns null for files that aren't DICOM. Throws with a readable message for unsupported data. */
export function parseInstance(fileName: string, buffer: ArrayBuffer): ParsedInstance | null {
  const bytes = new Uint8Array(buffer);
  let ds: DataSet;
  try {
    ds = parseBytes(bytes);
  } catch {
    return null;
  }
  const sopClassUid = str(ds, 'x00080016');
  const modality = str(ds, 'x00080060');
  if (!sopClassUid && !modality) return null;
  const ipp = nums(ds, 'x00200032');
  const ps = nums(ds, 'x00280030');
  const inst: ParsedInstance = {
    fileName,
    sopClassUid,
    sopInstanceUid: str(ds, 'x00080018'),
    modality,
    patientName: str(ds, 'x00100010').replace(/\^/g, ' ').trim(),
    patientId: str(ds, 'x00100020'),
    sex: str(ds, 'x00100040'),
    birthDate: str(ds, 'x00100030'),
    studyUid: str(ds, 'x0020000d'),
    studyDate: str(ds, 'x00080020'),
    studyDescription: str(ds, 'x00081030'),
    seriesUid: str(ds, 'x0020000e'),
    seriesDescription: str(ds, 'x0008103e'),
    seriesNumber: num(ds, 'x00200011'),
    frameOfReferenceUid: str(ds, 'x00200052'),
    patientPosition: str(ds, 'x00185100') || 'HFS',
    instanceNumber: num(ds, 'x00200013'),
    rows: ds.uint16('x00280010') ?? 0,
    cols: ds.uint16('x00280011') ?? 0,
    frames: num(ds, 'x00280008', 1),
    ipp: ipp && ipp.length === 3 ? (ipp as Vec3) : null,
    iop: nums(ds, 'x00200037'),
    pixelSpacing: ps && ps.length === 2 ? [ps[0], ps[1]] : null,
    sliceThickness: num(ds, 'x00180050'),
  };
  if (modality === 'RTSTRUCT' || sopClassUid === SOP_RTSTRUCT) {
    inst.rtstruct = parseRtStruct(ds);
  } else if (ds.elements.x7fe00010 && inst.rows && inst.cols) {
    inst.hu = decodePixels(ds, inst);
  }
  return inst;
}

function decodePixels(ds: DataSet, inst: ParsedInstance): Int16Array {
  const ts = str(ds, 'x00020010') || '1.2.840.10008.1.2';
  const bits = ds.uint16('x00280100') ?? 16;
  const signed = (ds.uint16('x00280103') ?? 0) === 1;
  const spp = ds.uint16('x00280002') ?? 1;
  if (spp !== 1) throw new Error(`${inst.fileName}: colour images can't be used as CT`);
  if (inst.frames > 1) throw new Error(`${inst.fileName}: multi-frame (enhanced) CT is not supported yet; export the series as single-frame CT images`);
  const slope = num(ds, 'x00281053', 1) || 1;
  const intercept = num(ds, 'x00281052', 0);
  const n = inst.rows * inst.cols;
  const el = ds.elements.x7fe00010;
  let raw: ArrayLike<number>;
  const encapsulated = !!el.encapsulatedPixelData || ts.startsWith('1.2.840.10008.1.2.4') || ts === '1.2.840.10008.1.2.5';
  if (!encapsulated) {
    const bytes = ds.byteArray;
    const bigEndian = ts === '1.2.840.10008.1.2.2';
    if (bits === 16) {
      const buf = new ArrayBuffer(n * 2);
      const dst = new Uint8Array(buf);
      dst.set(bytes.subarray(el.dataOffset, el.dataOffset + n * 2));
      if (bigEndian) for (let p = 0; p < dst.length; p += 2) { const t = dst[p]; dst[p] = dst[p + 1]; dst[p + 1] = t; }
      raw = signed ? new Int16Array(buf) : new Uint16Array(buf);
    } else if (bits === 8) {
      raw = bytes.subarray(el.dataOffset, el.dataOffset + n);
    } else if (bits === 32) {
      const buf = new ArrayBuffer(n * 4);
      new Uint8Array(buf).set(bytes.subarray(el.dataOffset, el.dataOffset + n * 4));
      raw = signed ? new Int32Array(buf) : new Uint32Array(buf);
    } else throw new Error(`${inst.fileName}: ${bits}-bit pixels are not supported`);
  } else {
    const frame = dicomParser.readEncapsulatedPixelData(ds, el, 0);
    if (ts === '1.2.840.10008.1.2.5') raw = decodeRle(frame, n, bits, signed);
    else if (ts === '1.2.840.10008.1.2.4.57' || ts === '1.2.840.10008.1.2.4.70') {
      const dec = new JpegLosslessDecoder();
      const out = dec.decode(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length), 0, frame.length);
      const bytesOut = new Uint8Array(out.buffer ?? out, out.byteOffset ?? 0, out.byteLength ?? out.length);
      if (bits === 16) {
        const u = new Uint8Array(n * 2);
        u.set(bytesOut.subarray(0, n * 2));
        raw = signed ? new Int16Array(u.buffer) : new Uint16Array(u.buffer);
      } else raw = bytesOut;
    } else {
      const names: Record<string, string> = {
        '1.2.840.10008.1.2.4.90': 'JPEG 2000 (lossless)', '1.2.840.10008.1.2.4.91': 'JPEG 2000',
        '1.2.840.10008.1.2.4.80': 'JPEG-LS (lossless)', '1.2.840.10008.1.2.4.81': 'JPEG-LS', '1.2.840.10008.1.2.4.50': 'JPEG baseline (lossy)',
      };
      throw new Error(`${inst.fileName}: compression ${names[ts] ?? ts} isn't supported. Export the CT uncompressed (or JPEG Lossless / RLE) and import again.`);
    }
  }
  const hu = new Int16Array(n);
  for (let p = 0; p < n; p++) {
    const v = raw[p] * slope + intercept;
    hu[p] = v < -1024 ? -1024 : v > 3071 ? 3071 : Math.round(v);
  }
  return hu;
}

/** DICOM RLE Lossless (PackBits segments, most significant byte first). */
function decodeRle(frame: Uint8Array, n: number, bits: number, signed: boolean): ArrayLike<number> {
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const segments = dv.getUint32(0, true);
  const bytesPerSample = bits / 8;
  if (segments !== bytesPerSample) throw new Error('Unexpected RLE segment count');
  const out = new Uint8Array(n * bytesPerSample);
  for (let s = 0; s < segments; s++) {
    let pos = dv.getUint32(4 + s * 4, true);
    const end = s + 1 < segments ? dv.getUint32(8 + s * 4, true) : frame.length;
    // Segment 0 is the most significant byte; little-endian output puts it last
    const byteIndex = bytesPerSample - 1 - s;
    let o = 0;
    while (pos < end && o < n) {
      const c = (frame[pos++] << 24) >> 24;
      if (c >= 0) {
        for (let r = 0; r <= c && o < n; r++) out[(o++) * bytesPerSample + byteIndex] = frame[pos++];
      } else if (c > -128) {
        const v = frame[pos++];
        for (let r = 0; r < 1 - c && o < n; r++) out[(o++) * bytesPerSample + byteIndex] = v;
      }
    }
  }
  if (bits === 16) return signed ? new Int16Array(out.buffer) : new Uint16Array(out.buffer);
  return out;
}

function parseRtStruct(ds: DataSet): RtStruct {
  const rois = new Map<number, RtRoi>();
  for (const item of ds.elements.x30060020?.items ?? []) {
    const d = item.dataSet!;
    const number = num(d, 'x30060022');
    rois.set(number, { number, name: str(d, 'x30060026') || `ROI ${number}`, color: null, interpretedType: '', contours: [] });
  }
  for (const item of ds.elements.x30060039?.items ?? []) {
    const d = item.dataSet!;
    const roi = rois.get(num(d, 'x30060084'));
    if (!roi) continue;
    const col = nums(d, 'x3006002a');
    if (col && col.length === 3) roi.color = '#' + col.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
    for (const c of d.elements.x30060040?.items ?? []) {
      const cd = c.dataSet!;
      const type = str(cd, 'x30060042');
      if (type && type !== 'CLOSED_PLANAR') continue;
      const pts = nums(cd, 'x30060050');
      if (pts && pts.length >= 9) roi.contours.push(pts);
    }
  }
  for (const item of ds.elements.x30060080?.items ?? []) {
    const d = item.dataSet!;
    const roi = rois.get(num(d, 'x30060084'));
    if (roi) roi.interpretedType = str(d, 'x300600a4');
  }
  let frameOfReferenceUid = '', referencedSeriesUid = '';
  const forItem = ds.elements.x30060010?.items?.[0]?.dataSet;
  if (forItem) {
    frameOfReferenceUid = str(forItem, 'x00200052');
    const study = forItem.elements.x30060012?.items?.[0]?.dataSet;
    const series = study?.elements.x30060014?.items?.[0]?.dataSet;
    if (series) referencedSeriesUid = str(series, 'x0020000e');
  }
  return { frameOfReferenceUid, referencedSeriesUid, label: str(ds, 'x30060002') || 'RT Structure Set', rois: [...rois.values()] };
}
