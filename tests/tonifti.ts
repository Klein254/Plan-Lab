// Dev helper: import a DICOM CT folder with PlanLab's importer and write it as the NIfTI PlanLab hands the AI model.
// node tests/tonifti.ts <dicom dir> <out.nii>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInstance } from '../src/core/dicom/parse.ts';
import { buildVolume, groupSeries } from '../src/core/dicom/series.ts';
import { writeNifti } from '../src/core/nifti.ts';
import { loadCodecs } from '../src/core/dicom/codecs.ts';

const [dir, out] = process.argv.slice(2);
await loadCodecs();
const insts = readdirSync(dir).map((f) => { const b = readFileSync(join(dir, f)); return parseInstance(f, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }).filter((x) => x);
const [list] = [...groupSeries(insts as never).values()];
const { volume } = buildVolume(list);
writeFileSync(out, writeNifti(volume));
console.log(JSON.stringify({ dims: volume.dims, spacing: volume.spacing, origin: volume.origin }));
