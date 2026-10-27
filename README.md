# PlanLab

A radiotherapy treatment planning system for **student training**, for Windows and macOS. It follows the workflow of clinical TPSs such as Plan W and Monaco:

**Import CT → contour (Anatomical Model) → plan beams → calculate 3D dose → evaluate DVHs.**

> PlanLab is a teaching tool. Its dose engine is not commissioned against a real machine and must never be used to treat patients.

## Features

**Patients and data**
- Import DICOM CT from a folder or files (drag and drop works too). Supports uncompressed, RLE, JPEG-Lossless and deflated files, any slice order, flipped orientations and uneven slice spacing (resampled). RT Structure Sets with the same frame of reference are imported as contours.
- Optional anonymisation for teaching.
- Everything is stored in PlanLab's local database, so you never need the DICOM files again.
- Patient-data panel at the bottom: **Basic CT scan → Contoured image(s) → Plans**. Each item can be opened, renamed, saved as a copy or deleted, and has a status (In progress / Completed / Approved).
- Share a whole case as one `.planlab` file. Export contours (RTSTRUCT) and dose (RTDOSE) as DICOM, readable by 3D Slicer.

**Anatomical Model (contouring)**
- Axial, sagittal, coronal and 3D views (organ surface models, skeleton, skin), with window/level presets, zoom and pan.
- **Pearl** (ball) brush with auto push-in/out, add or erase, and an optional 3D ball. Also a freehand **pen**, polygon, eraser, magic wand (2D/3D region growing) and measuring tool.
- Any number of separate parts of the same structure on a slice.
- Smart tools:
  - **Interpolation** between drawn slices (shape-based).
  - **Adapt**: snaps a contour to the organ edge.
  - **Propagate**: auto-contours neighbouring slices, stopping where the organ ends.
- Margins (uniform or per direction, GTV→CTV→PTV, with skin cropping), booleans (∪ ∩ − ⊕), fill holes, smooth, copy slice, undo/redo.
- Auto-segmentation: Body, lungs (left and right), threshold structures (e.g. bones).
- Structure library of about 60 targets and OARs with colours, α/β and tolerance doses (QUANTEC-based), editable per structure and in the Library.

**Planning**
- Linacs (6/10/15 MV) with 80×5 mm, 40×10 mm or 60-pair MLCs, and a Cobalt-60 unit (treatment time in minutes, with source decay).
- Templates: single field, AP/PA, 4-field box, 3-field with wedged laterals, opposed laterals, breast tangents.
- Beam's-eye view with **DRR**: a standard mode and a **skeleton** mode for bony landmarks. Projected contours, draggable jaws and MLC leaves, 1 cm graticule.
- **Auto-MLC** around any structure with a margin and leaf-fit options. Leaves keep following the target when you change gantry, collimator, couch or isocentre. There's also an editable leaf table.
- Independent jaws, **half-beam** blocking and field matching: mono-isocentric match, couch kick, and collimator rotation for craniospinal junctions.
- Physical wedges (15/30/45/60°) and virtual wedges; bolus and density overrides.
- Prescription and normalisation (isocentre, reference point, target mean, median or D95) with beam weights → MU per fraction. Warns when the normalisation point sits on a field edge.
- 3D dose: TMR / fluence-convolution model with radiological-depth heterogeneity correction, run in the background. Only fields that changed are recalculated. Isodose lines or colour wash, hot spot, and a 3D prescription isodose surface.

**Evaluation**
- Cumulative DVH in Gy or % of Rx, optionally in **EQD2** (per-structure α/β), with comparison against another plan.
- Dose statistics: min, mean, max, D98, D95, D50, D2, V95, V100, V107.
- Target indices: coverage, ICRU-83 HI, RTOG and Paddick CI, gradient index.
- Tolerance-dose check (pass/fail) and a BED/EQD2 calculator.
- Printable plan report with student and instructor signature lines.

**Library**: machine beam data (with a live PDD preview), the CT→electron-density curve, the structure/tolerance library, settings and keyboard help.

## Running it

| | |
|---|---|
| Develop in a browser | `npm install` then `npm run dev` → http://127.0.0.1:5180 |
| Desktop app (dev) | `npm run desktop:dev` (needs Rust) |
| Windows installer | `npm run desktop:build` → `src-tauri/target/release/bundle/nsis/` |
| macOS | GitHub → Actions → **Build PlanLab** → Run workflow (builds Windows + both Macs) |
| Tests | `npm test` (DICOM import, margins, interpolation, auto-segmentation, dose engine, DVH, RTSTRUCT round-trip) |

On macOS the app isn't notarised: right-click → **Open** the first time.

Patient data is stored per computer (Windows: `%APPDATA%\com.planlab.tps\store`, macOS: `~/Library/Application Support/com.planlab.tps/store`).
