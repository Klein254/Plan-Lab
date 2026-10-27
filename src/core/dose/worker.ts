// Dose calculation runs here, off the UI thread.
import { computeBeamDose, type BeamModel, type DensityGrid } from './engine.ts';

export interface DoseRequest {
  dg: DensityGrid;
  beams: BeamModel[];
  heterogeneity: boolean;
}

export type DoseMessage =
  | { type: 'progress'; beam: number; of: number; fraction: number }
  | { type: 'beam'; id: string; data: Float32Array }
  | { type: 'done' }
  | { type: 'error'; message: string };

self.onmessage = (ev: MessageEvent<DoseRequest>) => {
  const { dg, beams, heterogeneity } = ev.data;
  const post = (m: DoseMessage, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);
  try {
    beams.forEach((bm, n) => {
      let last = 0;
      const data = computeBeamDose(dg, bm, heterogeneity, (f) => {
        if (f - last > 0.05 || f === 1) {
          last = f;
          post({ type: 'progress', beam: n, of: beams.length, fraction: f });
        }
      });
      post({ type: 'beam', id: bm.beam.id, data }, [data.buffer]);
    });
    post({ type: 'done' });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
