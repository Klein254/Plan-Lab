// Bridge to the desktop app's AI contouring (TotalSegmentator in a private Python environment, see src-tauri/src/ai.rs).
import { writeNifti } from '../core/nifti.ts';
import type { Volume } from '../core/types.ts';

export const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface AiStatus {
  installed: boolean;
  weights: boolean;
  python: string | null; // Python version found (only reported while not installed)
  folder: string;
}

const core = () => import('@tauri-apps/api/core');

export async function aiStatus(): Promise<AiStatus | null> {
  if (!isDesktop()) return null;
  return (await core()).invoke<AiStatus>('ai_status');
}

/** Streams the backend's log lines to `onLog` while `run` is in progress. */
async function withLog<T>(onLog: (line: string) => void, run: () => Promise<T>): Promise<T> {
  const { listen } = await import('@tauri-apps/api/event');
  const un = await listen<string>('ai-log', (e) => onLog(e.payload));
  try {
    return await run();
  } finally {
    un();
  }
}

export async function aiInstall(onLog: (line: string) => void): Promise<void> {
  const { invoke } = await core();
  await withLog(onLog, () => invoke('ai_install'));
}

export async function aiCancel(): Promise<void> {
  if (isDesktop()) await (await core()).invoke('ai_cancel');
}

/** Runs the model on the CT. Returns one label per voxel (Volume order) and the label → class-name map. */
export async function aiSegment(v: Volume, opts: { fast: boolean; roi: string[] }, onLog: (line: string) => void): Promise<{ labels: Uint8Array; names: Map<number, string> }> {
  const { invoke } = await core();
  const nifti = writeNifti(v);
  const buf = await withLog(onLog, () => invoke<ArrayBuffer>('ai_segment', nifti, { headers: { 'x-options': JSON.stringify(opts) } }));
  const bytes = new Uint8Array(buf);
  const len = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  const map = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len))) as Record<string, string>;
  const labels = bytes.subarray(4 + len);
  const n = v.dims[0] * v.dims[1] * v.dims[2];
  if (labels.length !== n) throw new Error(`The model returned ${labels.length} voxels for a ${n}-voxel CT.`);
  return { labels, names: new Map(Object.entries(map).map(([k, name]) => [+k, name])) };
}
