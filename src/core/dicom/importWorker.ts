// Parses dropped/selected DICOM files off the UI thread.
import { parseInstance, type ParsedInstance } from './parse.ts';

export type ImportMessage =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; instances: ParsedInstance[]; errors: string[]; skipped: number };

self.onmessage = async (ev: MessageEvent<{ files: File[] }>) => {
  const { files } = ev.data;
  const instances: ParsedInstance[] = [];
  const errors: string[] = [];
  let skipped = 0;
  const post = (m: ImportMessage, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);
  for (let n = 0; n < files.length; n++) {
    const f = files[n];
    try {
      // Skip obvious non-DICOM files quickly (DICOMDIR is an index, not an image)
      if (/\.(txt|xml|json|jpg|jpeg|png|pdf|exe|ini|htm|html)$/i.test(f.name) || f.name.toUpperCase() === 'DICOMDIR' || f.size < 132) {
        skipped++;
      } else {
        const inst = parseInstance((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, await f.arrayBuffer());
        if (inst) instances.push(inst);
        else skipped++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (errors.length < 20) errors.push(msg);
    }
    if (n % 10 === 9 || n === files.length - 1) post({ type: 'progress', done: n + 1, total: files.length });
  }
  const transfer = instances.flatMap((i) => (i.hu ? [i.hu.buffer] : []));
  post({ type: 'result', instances, errors, skipped }, transfer);
};
