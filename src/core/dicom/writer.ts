// Minimal DICOM Part 10 writer (explicit VR little endian), for RTSTRUCT / RTDOSE export and test data.

export type DicomValue = string | number | number[] | Uint8Array | Int16Array | Uint16Array | Uint32Array | DicomElement[][];

export interface DicomElement {
  tag: number; // 0xGGGGEEEE
  vr: string;
  value: DicomValue;
}

const LONG_VRS = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN', 'UC', 'UR', 'OD', 'OL']);
const enc = new TextEncoder();

class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;
  push(b: Uint8Array) {
    this.chunks.push(b);
    this.length += b.length;
  }
  u16(v: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.push(b);
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.push(b);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

function valueBytes(el: DicomElement): Uint8Array {
  const { vr, value } = el;
  if (vr === 'SQ') {
    const w = new Writer();
    for (const item of value as DicomElement[][]) {
      const body = encodeElements(item);
      w.u16(0xfffe);
      w.u16(0xe000);
      w.u32(body.length);
      w.push(body);
    }
    return w.bytes();
  }
  if (value instanceof Uint8Array) return padEven(value, 0);
  if (value instanceof Int16Array || value instanceof Uint16Array || value instanceof Uint32Array) {
    return padEven(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), 0);
  }
  const arr = Array.isArray(value) ? (value as number[]) : [value as number | string];
  switch (vr) {
    case 'US': case 'SS': {
      const b = new Uint8Array(arr.length * 2);
      const dv = new DataView(b.buffer);
      arr.forEach((v, n) => (vr === 'US' ? dv.setUint16(n * 2, Number(v), true) : dv.setInt16(n * 2, Number(v), true)));
      return b;
    }
    case 'UL': case 'SL': {
      const b = new Uint8Array(arr.length * 4);
      const dv = new DataView(b.buffer);
      arr.forEach((v, n) => (vr === 'UL' ? dv.setUint32(n * 4, Number(v), true) : dv.setInt32(n * 4, Number(v), true)));
      return b;
    }
    case 'FL': case 'FD': {
      const sz = vr === 'FL' ? 4 : 8;
      const b = new Uint8Array(arr.length * sz);
      const dv = new DataView(b.buffer);
      arr.forEach((v, n) => (vr === 'FL' ? dv.setFloat32(n * sz, Number(v), true) : dv.setFloat64(n * sz, Number(v), true)));
      return b;
    }
    case 'DS': {
      const s = arr.map((v) => formatDS(Number(v))).join('\\');
      return padEven(enc.encode(s), 0x20);
    }
    case 'IS':
      return padEven(enc.encode(arr.map((v) => String(Math.round(Number(v)))).join('\\')), 0x20);
    case 'UI':
      return padEven(enc.encode(String(arr.join('\\'))), 0);
    default:
      return padEven(enc.encode(String(arr.join('\\'))), 0x20);
  }
}

/** Decimal strings are limited to 16 characters. */
function formatDS(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  for (let p = 10; p >= 0; p--) {
    const s = String(Number(v.toFixed(p)));
    if (s.length <= 16) return s;
  }
  return v.toExponential(6);
}

function padEven(b: Uint8Array, pad: number): Uint8Array {
  if (b.length % 2 === 0) return b;
  const out = new Uint8Array(b.length + 1);
  out.set(b);
  out[b.length] = pad;
  return out;
}

function encodeElements(elements: DicomElement[]): Uint8Array {
  const w = new Writer();
  for (const el of [...elements].sort((a, b) => a.tag - b.tag)) {
    const v = valueBytes(el);
    w.u16(el.tag >>> 16);
    w.u16(el.tag & 0xffff);
    w.push(enc.encode(el.vr));
    if (LONG_VRS.has(el.vr)) {
      w.u16(0);
      w.u32(v.length);
    } else {
      w.u16(v.length);
    }
    w.push(v);
  }
  return w.bytes();
}

/** Encodes a complete Part 10 file. */
export function writeDicom(elements: DicomElement[], sopClassUid: string, sopInstanceUid: string): Uint8Array {
  const meta: DicomElement[] = [
    { tag: 0x00020001, vr: 'OB', value: new Uint8Array([0, 1]) },
    { tag: 0x00020002, vr: 'UI', value: sopClassUid },
    { tag: 0x00020003, vr: 'UI', value: sopInstanceUid },
    { tag: 0x00020010, vr: 'UI', value: '1.2.840.10008.1.2.1' },
    { tag: 0x00020012, vr: 'UI', value: '1.2.826.0.1.3680043.10.1415' },
    { tag: 0x00020013, vr: 'SH', value: 'PLANLAB_1' },
  ];
  const metaBytes = encodeElements(meta);
  const groupLen = encodeElements([{ tag: 0x00020000, vr: 'UL', value: metaBytes.length }]);
  const body = encodeElements(elements.filter((e) => e.tag >>> 16 !== 0x0002));
  const out = new Uint8Array(128 + 4 + groupLen.length + metaBytes.length + body.length);
  out.set(enc.encode('DICM'), 128);
  out.set(groupLen, 132);
  out.set(metaBytes, 132 + groupLen.length);
  out.set(body, 132 + groupLen.length + metaBytes.length);
  return out;
}

/** A new UID under the UUID-derived 2.25 root. */
export function newUid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return '2.25.' + n.toString();
}

export function dicomDate(d = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
export function dicomTime(d = new Date()): string {
  return d.toISOString().slice(11, 19).replace(/:/g, '');
}
