// JPEG 2000 (OpenJPEG) and JPEG-LS (CharLS) pixel decoders: WebAssembly builds from the Cornerstone codecs project.
// Many hospital PACS export CT compressed this way. Load once with loadCodecs() before parsing; decoding is synchronous.

interface Decoder {
  getEncodedBuffer(length: number): Uint8Array;
  decode(): void;
  getDecodedBuffer(): Uint8Array;
  getFrameInfo(): { width: number; height: number; bitsPerSample: number; isSigned?: boolean };
  delete(): void;
}
interface CodecModule { J2KDecoder?: new () => Decoder; JpegLSDecoder?: new () => Decoder }

const codecs: { j2k?: CodecModule; jls?: CodecModule } = {};
const quiet = () => undefined; // the decoders log every frame header
let loading: Promise<void> | null = null;

const inNode = () => typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined' && typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === 'undefined';

type Factory = (opts: { locateFile: (f: string) => string; print: () => void; printErr: () => void }) => Promise<CodecModule>;

export function loadCodecs(): Promise<void> {
  loading ??= (async () => {
    const [oj, ls] = await Promise.all([import('@cornerstonejs/codec-openjpeg/decodewasmjs'), import('@cornerstonejs/codec-charls/decodewasmjs')]);
    let ojWasm: string, lsWasm: string;
    if (inNode()) {
      const { fileURLToPath } = await import('node:url');
      ojWasm = fileURLToPath(import.meta.resolve('@cornerstonejs/codec-openjpeg/decodewasm'));
      lsWasm = fileURLToPath(import.meta.resolve('@cornerstonejs/codec-charls/decodewasm'));
    } else {
      ojWasm = (await import('@cornerstonejs/codec-openjpeg/decodewasm?url')).default;
      lsWasm = (await import('@cornerstonejs/codec-charls/decodewasm?url')).default;
    }
    const make = (m: unknown) => ((m as { default?: Factory }).default ?? (m as Factory));
    codecs.j2k = await make(oj)({ locateFile: (f) => (f.endsWith('.wasm') ? ojWasm : f), print: quiet, printErr: quiet });
    codecs.jls = await make(ls)({ locateFile: (f) => (f.endsWith('.wasm') ? lsWasm : f), print: quiet, printErr: quiet });
  })();
  return loading;
}

/** Decodes one JPEG 2000 or JPEG-LS frame to raw little-endian samples. */
export function decodeFrame(kind: 'j2k' | 'jls', frame: Uint8Array): { bytes: Uint8Array; bits: number; signed: boolean | undefined } {
  const mod = codecs[kind];
  const Ctor = kind === 'j2k' ? mod?.J2KDecoder : mod?.JpegLSDecoder;
  if (!Ctor) throw new Error(`${kind === 'j2k' ? 'JPEG 2000' : 'JPEG-LS'} decoder is not loaded`);
  const dec = new Ctor();
  try {
    dec.getEncodedBuffer(frame.length).set(frame);
    dec.decode();
    const info = dec.getFrameInfo();
    return { bytes: dec.getDecodedBuffer().slice(), bits: info.bitsPerSample, signed: info.isSigned };
  } finally {
    dec.delete();
  }
}
