import { useEffect, useRef } from 'react';
import { useStore, beginStroke, editMask, toast, machineById, type Stroke } from '../../state/store.ts';
import {
  planeInfo, planeToVoxel, voxelToPlane, sliceIndex, extractCT, greyImage, maskOutline, sampleDosePlane, doseSegments,
  isodoseColor, washColor, hexToRgb, extractMask, type Plane, type DosePlane,
} from '../render.ts';
import { fillPolygon } from '../../core/contour2d.ts';
import { regionGrow } from '../../core/maskOps.ts';
import { fieldSection } from '../../core/bev.ts';
import { sampleGrid } from '../../core/dose/engine.ts';
import type { Vec3 } from '../../core/types.ts';

interface Props {
  plane: Plane;
  mode: 'contour' | 'plan' | 'eval';
  onMaximize?: () => void;
  maximized?: boolean;
}

const LABELS: Record<Plane, [string, string, string, string]> = {
  axial: ['A', 'P', 'R', 'L'],
  sagittal: ['S', 'I', 'A', 'P'],
  coronal: ['S', 'I', 'R', 'L'],
};
const TITLES: Record<Plane, string> = { axial: 'Axial', sagittal: 'Sagittal', coronal: 'Coronal' };
const BEAM_COLORS = ['#facc15', '#38bdf8', '#f472b6', '#4ade80', '#fb923c', '#a78bfa', '#f87171', '#2dd4bf'];

// CT images are cached per slice/window so scrolling back is instant
const ctCache = new Map<string, HTMLCanvasElement>();
const doseCache = new Map<string, DosePlane>();

export function SliceView({ plane, mode, onMaximize, maximized }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ zoom: 1, panX: 0, panY: 0, w: 0, h: 0 });
  const hover = useRef<{ a: number; b: number } | null>(null);
  const drawing = useRef<{
    kind: 'paint' | 'pen' | 'pan' | 'wl' | 'cursor' | 'measure';
    stroke?: Stroke | null;
    value?: number;
    last?: [number, number];
    path?: number[];
    startX?: number;
    startY?: number;
    startW?: number;
    startL?: number;
    startPanX?: number;
    startPanY?: number;
  } | null>(null);
  const polygon = useRef<number[]>([]);
  const measure = useRef<{ a0: number; b0: number; a1: number; b1: number } | null>(null);
  const frame = useRef(0);

  // ---------------------------------------------------------------- geometry helpers
  const layout = () => {
    const s = useStore.getState();
    if (!s.ct) return null;
    const info = planeInfo(plane, s.ct.meta.dims, s.ct.meta.spacing);
    const { w, h, zoom, panX, panY } = view.current;
    const imgW = info.w * info.sw, imgH = info.h * info.sh;
    const scale = Math.min(w / imgW, h / imgH) * 0.96 * zoom;
    const cx = ((info.w - 1) / 2) * info.sw, cy = ((info.h - 1) / 2) * info.sh;
    const toScreen = (a: number, b: number): [number, number] => [w / 2 + panX + (a * info.sw - cx) * scale, h / 2 + panY + (b * info.sh - cy) * scale];
    const toPlane = (X: number, Y: number): [number, number] => [((X - w / 2 - panX) / scale + cx) / info.sw, ((Y - h / 2 - panY) / scale + cy) / info.sh];
    return { info, scale, toScreen, toPlane };
  };

  const patientOf = (vox: Vec3): Vec3 => {
    const ct = useStore.getState().ct!;
    return [ct.volume.origin[0] + vox[0] * ct.volume.spacing[0], ct.volume.origin[1] + vox[1] * ct.volume.spacing[1], ct.volume.origin[2] + vox[2] * ct.volume.spacing[2]];
  };

  // ---------------------------------------------------------------- drawing
  const draw = () => {
    frame.current = 0;
    const canvas = canvasRef.current;
    const s = useStore.getState();
    if (!canvas || !s.ct) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, w, h);
    const L = layout();
    if (!L) return;
    const { info, scale, toScreen } = L;
    const ct = s.ct;
    const nz = ct.meta.dims[2];
    const index = Math.min(info.count - 1, Math.max(0, sliceIndex(plane, s.cursor)));

    // CT
    const key = `${ct.meta.id}:${plane}:${index}:${s.wl.w}:${s.wl.l}`;
    let img = ctCache.get(key);
    if (!img) {
      img = document.createElement('canvas');
      img.width = info.w;
      img.height = info.h;
      img.getContext('2d')!.putImageData(greyImage(extractCT(ct.volume, plane, index), info.w, info.h, s.wl.w, s.wl.l), 0, 0);
      if (ctCache.size > 120) ctCache.delete(ctCache.keys().next().value!);
      ctCache.set(key, img);
    }
    const [x0, y0] = toScreen(-0.5, -0.5);
    ctx.imageSmoothingEnabled = scale * Math.min(info.sw, info.sh) < 4;
    ctx.drawImage(img, x0, y0, info.w * info.sw * scale, info.h * info.sh * scale);

    // Dose
    const showDose = (mode === 'plan' || mode === 'eval') && s.dose?.total && s.plan && s.doseDisplay.mode !== 'off';
    let dp: DosePlane | null = null;
    const rxGy = s.plan?.meta.prescription.totalDose ?? 1;
    if (showDose) {
      const step = Math.max(1, Math.round(s.dose!.grid.spacing[0] / 2 / Math.min(info.sw, info.sh)));
      const dkey = `${s.doseVersion}:${plane}:${index}:${step}`;
      dp = doseCache.get(dkey) ?? null;
      if (!dp) {
        dp = sampleDosePlane(ct.volume, plane, index, s.dose!.grid, s.dose!.total!, step);
        if (doseCache.size > 60) doseCache.clear();
        doseCache.set(dkey, dp);
      }
      if (s.doseDisplay.mode === 'wash' || s.doseDisplay.mode === 'both') {
        const off = document.createElement('canvas');
        off.width = dp.w;
        off.height = dp.h;
        const id = new ImageData(dp.w, dp.h);
        const minF = s.doseDisplay.washMin / 100;
        for (let p = 0; p < dp.data.length; p++) {
          const f = dp.data[p] / rxGy;
          if (f < minF) continue;
          const [r, g, b] = washColor(f);
          id.data[p * 4] = r; id.data[p * 4 + 1] = g; id.data[p * 4 + 2] = b;
          id.data[p * 4 + 3] = Math.round(255 * s.doseDisplay.opacity);
        }
        off.getContext('2d')!.putImageData(id, 0, 0);
        const [dx0, dy0] = toScreen(-0.5 * dp.step, -0.5 * dp.step);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(off, dx0, dy0, dp.w * dp.step * info.sw * scale, dp.h * dp.step * info.sh * scale);
      }
    }

    // Structures
    const ss = s.ss;
    if (ss) {
      for (const st of ss.meta.structures) {
        if (!st.visible) continue;
        const m = ss.masks.get(st.id);
        if (!m) continue;
        const selected = st.id === s.selectedStructureId && mode === 'contour';
        if (selected) {
          const pm = extractMask(m, plane, index);
          if (pm) {
            const off = document.createElement('canvas');
            off.width = info.w;
            off.height = info.h;
            const id = new ImageData(info.w, info.h);
            const [r, g, b] = hexToRgb(st.color);
            for (let p = 0; p < pm.length; p++) if (pm[p]) { id.data[p * 4] = r; id.data[p * 4 + 1] = g; id.data[p * 4 + 2] = b; id.data[p * 4 + 3] = 60; }
            off.getContext('2d')!.putImageData(id, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(off, x0, y0, info.w * info.sw * scale, info.h * info.sh * scale);
          }
        }
        const seg = maskOutline(`${st.id}:${m.version}:${plane}:${index}`, m, plane, index, info.w, info.h);
        if (!seg || !seg.length) continue;
        ctx.strokeStyle = st.color;
        ctx.lineWidth = selected ? 2 : 1.4;
        ctx.beginPath();
        for (let n = 0; n < seg.length; n += 4) {
          const [ax, ay] = toScreen(seg[n], seg[n + 1]);
          const [bx, by] = toScreen(seg[n + 2], seg[n + 3]);
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
        }
        ctx.stroke();
      }
    }

    // Isodose lines
    if (dp && (s.doseDisplay.mode === 'lines' || s.doseDisplay.mode === 'both')) {
      for (const lvl of s.doseDisplay.levels) {
        const seg = doseSegments(dp, (lvl / 100) * rxGy);
        if (!seg.length) continue;
        ctx.strokeStyle = isodoseColor(lvl);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let n = 0; n < seg.length; n += 4) {
          const [ax, ay] = toScreen(seg[n], seg[n + 1]);
          const [bx, by] = toScreen(seg[n + 2], seg[n + 3]);
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
        }
        ctx.stroke();
      }
    }

    // Beams (field cross-sections) and isocentres
    if ((mode === 'plan' || mode === 'eval') && s.plan) {
      const axisValue = (() => {
        const vox: Vec3 = plane === 'axial' ? [0, 0, index] : plane === 'sagittal' ? [index, 0, 0] : [0, index, 0];
        return patientOf(vox)[info.axis];
      })();
      const toPlanePt = (p: Vec3): [number, number] => {
        const vox: Vec3 = [(p[0] - ct.volume.origin[0]) / ct.volume.spacing[0], (p[1] - ct.volume.origin[1]) / ct.volume.spacing[1], (p[2] - ct.volume.origin[2]) / ct.volume.spacing[2]];
        return voxelToPlane(plane, nz, vox);
      };
      const axis = (plane === 'axial' ? 2 : plane === 'sagittal' ? 0 : 1) as 0 | 1 | 2;
      s.plan.meta.beams.forEach((b, n) => {
        const machine = machineById(b.machineId);
        const sec = fieldSection(b, machine, axis, axisValue);
        const col = BEAM_COLORS[n % BEAM_COLORS.length];
        const sel = b.id === s.selectedBeamId;
        ctx.strokeStyle = col;
        ctx.globalAlpha = sel ? 0.95 : 0.55;
        ctx.lineWidth = sel ? 1.6 : 1;
        if (sec.polygon.length >= 3) {
          ctx.setLineDash([]);
          ctx.beginPath();
          sec.polygon.forEach((p, q) => {
            const [sx, sy] = toScreen(...toPlanePt(p));
            if (q) ctx.lineTo(sx, sy);
            else ctx.moveTo(sx, sy);
          });
          ctx.closePath();
          ctx.stroke();
        }
        if (sec.cax) {
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          const [ax, ay] = toScreen(...toPlanePt(sec.cax[0]));
          const [bx, by] = toScreen(...toPlanePt(sec.cax[1]));
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          ctx.stroke();
          ctx.setLineDash([]);
          // label near the entry side
          const [lx, ly] = toScreen(...toPlanePt([
            b.iso[0] + (sec.cax[0][0] - b.iso[0]) * 0.18, b.iso[1] + (sec.cax[0][1] - b.iso[1]) * 0.18, b.iso[2] + (sec.cax[0][2] - b.iso[2]) * 0.18,
          ]));
          ctx.fillStyle = col;
          ctx.font = '11px Inter, system-ui, sans-serif';
          ctx.fillText(b.name, lx + 4, ly - 4);
        }
        ctx.globalAlpha = 1;
      });
      // Isocentres
      const isos = new Map<string, Vec3>();
      for (const b of s.plan.meta.beams) isos.set(b.iso.map((v) => v.toFixed(1)).join(','), b.iso);
      for (const iso of isos.values()) {
        const vox: Vec3 = [(iso[0] - ct.volume.origin[0]) / ct.volume.spacing[0], (iso[1] - ct.volume.origin[1]) / ct.volume.spacing[1], (iso[2] - ct.volume.origin[2]) / ct.volume.spacing[2]];
        const depth = plane === 'axial' ? vox[2] : plane === 'sagittal' ? vox[0] : vox[1];
        if (Math.abs(depth - index) > 0.6) continue;
        const [sx, sy] = toScreen(...voxelToPlane(plane, nz, vox));
        ctx.strokeStyle = '#f43f5e';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, 6, 0, Math.PI * 2);
        ctx.moveTo(sx - 10, sy); ctx.lineTo(sx + 10, sy);
        ctx.moveTo(sx, sy - 10); ctx.lineTo(sx, sy + 10);
        ctx.stroke();
      }
      // Reference points
      for (const rp of s.plan.meta.refPoints) {
        const vox: Vec3 = [(rp.pos[0] - ct.volume.origin[0]) / ct.volume.spacing[0], (rp.pos[1] - ct.volume.origin[1]) / ct.volume.spacing[1], (rp.pos[2] - ct.volume.origin[2]) / ct.volume.spacing[2]];
        const depth = plane === 'axial' ? vox[2] : plane === 'sagittal' ? vox[0] : vox[1];
        if (Math.abs(depth - index) > 0.6) continue;
        const [sx, sy] = toScreen(...voxelToPlane(plane, nz, vox));
        ctx.fillStyle = '#22d3ee';
        ctx.beginPath();
        ctx.moveTo(sx, sy - 6); ctx.lineTo(sx + 6, sy); ctx.lineTo(sx, sy + 6); ctx.lineTo(sx - 6, sy); ctx.closePath();
        ctx.fill();
        ctx.font = '11px Inter, system-ui, sans-serif';
        ctx.fillText(rp.name, sx + 8, sy + 4);
      }
      // Hotspot
      if (showDose && s.doseDisplay.showHotspot && s.dose?.maxAt) {
        const p = s.dose.maxAt;
        const vox: Vec3 = [(p[0] - ct.volume.origin[0]) / ct.volume.spacing[0], (p[1] - ct.volume.origin[1]) / ct.volume.spacing[1], (p[2] - ct.volume.origin[2]) / ct.volume.spacing[2]];
        const depth = plane === 'axial' ? vox[2] : plane === 'sagittal' ? vox[0] : vox[1];
        if (Math.abs(depth - index) <= s.dose.grid.spacing[0] / (plane === 'axial' ? ct.volume.spacing[2] : plane === 'sagittal' ? ct.volume.spacing[0] : ct.volume.spacing[1])) {
          const [sx, sy] = toScreen(...voxelToPlane(plane, nz, vox));
          ctx.strokeStyle = '#ff2d95';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(sx - 6, sy - 6); ctx.lineTo(sx + 6, sy + 6); ctx.moveTo(sx + 6, sy - 6); ctx.lineTo(sx - 6, sy + 6);
          ctx.stroke();
          ctx.fillStyle = '#ff2d95';
          ctx.font = '11px Inter, system-ui, sans-serif';
          ctx.fillText(`Max ${s.dose.maxDose.toFixed(2)} Gy (${((100 * s.dose.maxDose) / rxGy).toFixed(1)}%)`, sx + 9, sy - 8);
        }
      }
    }

    // Crosshair (positions of the other two planes)
    {
      const [ca, cb] = voxelToPlane(plane, nz, s.cursor);
      const [sx, sy] = toScreen(ca, cb);
      ctx.strokeStyle = 'rgba(34,211,238,0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, sy); ctx.lineTo(w, sy);
      ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Tool previews
    const t = s.tool;
    const hv = hover.current;
    if (mode === 'contour' && hv && (t === 'pearl' || t === 'eraser')) {
      const [sx, sy] = toScreen(hv.a, hv.b);
      const r = s.toolSettings.pearlRadius * scale;
      ctx.strokeStyle = t === 'eraser' || s.toolSettings.pearlMode === 'erase' ? '#f87171' : '#e2e8f0';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    const path = drawing.current?.kind === 'pen' ? drawing.current.path : polygon.current.length ? polygon.current : null;
    if (path && path.length >= 2) {
      const col = ss?.meta.structures.find((x) => x.id === s.selectedStructureId)?.color ?? '#fff';
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let n = 0; n < path.length; n += 2) {
        const [sx, sy] = toScreen(path[n], path[n + 1]);
        if (n) ctx.lineTo(sx, sy);
        else ctx.moveTo(sx, sy);
      }
      if (polygon.current.length && hv) ctx.lineTo(...toScreen(hv.a, hv.b));
      ctx.stroke();
      if (polygon.current.length) {
        ctx.fillStyle = col;
        for (let n = 0; n < path.length; n += 2) {
          const [sx, sy] = toScreen(path[n], path[n + 1]);
          ctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);
        }
      }
    }
    if (measure.current) {
      const m = measure.current;
      const [ax, ay] = toScreen(m.a0, m.b0), [bx, by] = toScreen(m.a1, m.b1);
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      ctx.stroke();
      const mm = Math.hypot((m.a1 - m.a0) * info.sw, (m.b1 - m.b0) * info.sh);
      ctx.fillStyle = '#fbbf24';
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.fillText(`${(mm / 10).toFixed(2)} cm`, bx + 6, by - 6);
    }

    // Text
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(226,232,240,0.9)';
    const [top, bottom, left, right] = LABELS[plane];
    ctx.textAlign = 'center';
    ctx.fillText(top, w / 2, 16);
    ctx.fillText(bottom, w / 2, h - 8);
    ctx.textAlign = 'left';
    ctx.fillText(left, 8, h / 2);
    ctx.textAlign = 'right';
    ctx.fillText(right, w - 8, h / 2);
    ctx.textAlign = 'left';
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(148,163,184,0.95)';
    const posMm = patientOf(plane === 'axial' ? [0, 0, index] : plane === 'sagittal' ? [index, 0, 0] : [0, index, 0]);
    const coord = plane === 'axial' ? `z ${(posMm[2] / 10).toFixed(2)} cm` : plane === 'sagittal' ? `x ${(posMm[0] / 10).toFixed(2)} cm` : `y ${(posMm[1] / 10).toFixed(2)} cm`;
    ctx.fillText(`${TITLES[plane]}  ${index + 1}/${info.count}  ·  ${coord}`, 8, 18);
    if (hv) {
      const vox = planeToVoxel(plane, nz, Math.round(hv.a), Math.round(hv.b), index);
      const [i, j, k] = vox;
      const [nx, ny] = ct.meta.dims;
      if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) {
        const hu = ct.volume.data[i + nx * (j + ny * k)];
        let txt = `HU ${hu}`;
        if (s.dose?.total && (mode === 'plan' || mode === 'eval')) {
          const d = sampleGrid(s.dose.grid, s.dose.total, patientOf(planeToVoxel(plane, nz, hv.a, hv.b, index)));
          txt += `  ·  ${d.toFixed(2)} Gy (${((100 * d) / rxGy).toFixed(1)}%)`;
        }
        const pp = patientOf(vox);
        txt += `  ·  (${(pp[0] / 10).toFixed(1)}, ${(pp[1] / 10).toFixed(1)}, ${(pp[2] / 10).toFixed(1)}) cm`;
        ctx.fillText(txt, 8, h - 8);
      }
    }
    // Zoom indicator
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(view.current.zoom * 100)}%`, w - 8, 18);
    ctx.textAlign = 'left';
  };

  const schedule = () => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  };

  useEffect(() => {
    const unsub = useStore.subscribe(schedule);
    const ro = new ResizeObserver(() => {
      const el = wrapRef.current, canvas = canvasRef.current;
      if (!el || !canvas) return;
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      view.current.w = Math.max(10, r.width);
      view.current.h = Math.max(10, r.height);
      canvas.width = Math.round(view.current.w * dpr);
      canvas.height = Math.round(view.current.h * dpr);
      canvas.style.width = `${view.current.w}px`;
      canvas.style.height = `${view.current.h}px`;
      draw();
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      unsub();
      ro.disconnect();
      if (frame.current) cancelAnimationFrame(frame.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plane, mode]);

  // ---------------------------------------------------------------- editing helpers

  const setVoxel = (stroke: Stroke, vox: Vec3, value: number) => {
    const [i, j, k] = vox;
    const m = stroke.mask;
    if (i < 0 || j < 0 || k < 0 || i >= m.nx || j >= m.ny || k >= m.nz) return;
    stroke.touch(k);
    m.set(i, j, k, value);
  };

  const stamp = (stroke: Stroke, a: number, b: number, value: number) => {
    const s = useStore.getState();
    const L = layout()!;
    const { info } = L;
    const nz = s.ct!.meta.dims[2];
    const index = sliceIndex(plane, s.cursor);
    const r = s.toolSettings.pearlRadius;
    const ra = r / info.sw, rb = r / info.sh;
    const sAx = s.ct!.meta.spacing[info.axis];
    const depthR = s.toolSettings.pearl3D ? Math.floor(r / sAx) : 0;
    for (let dd = -depthR; dd <= depthR; dd++) {
      const idx = index + dd;
      if (idx < 0 || idx >= info.count) continue;
      const shrink = Math.sqrt(Math.max(0, 1 - ((dd * sAx) / r) ** 2));
      const ra2 = ra * shrink, rb2 = rb * shrink;
      for (let db = Math.floor(b - rb2); db <= Math.ceil(b + rb2); db++) {
        for (let da = Math.floor(a - ra2); da <= Math.ceil(a + ra2); da++) {
          if (((da - a) / ra2) ** 2 + ((db - b) / rb2) ** 2 > 1) continue;
          setVoxel(stroke, planeToVoxel(plane, nz, da, db, idx), value);
        }
      }
    }
  };

  const fillPath = (structureId: string, path: number[], value: number, label: string) => {
    const s = useStore.getState();
    const L = layout()!;
    const { info } = L;
    const nz = s.ct!.meta.dims[2];
    const index = sliceIndex(plane, s.cursor);
    const raster = new Uint8Array(info.w * info.h);
    fillPolygon(raster, info.w, info.h, path, 1);
    const stroke = beginStroke(structureId);
    if (!stroke) return;
    for (let p = 0; p < raster.length; p++) {
      if (!raster[p]) continue;
      setVoxel(stroke, planeToVoxel(plane, nz, p % info.w, Math.floor(p / info.w), index), value);
    }
    stroke.end(label);
  };

  const finishPolygon = () => {
    const s = useStore.getState();
    const pts = polygon.current;
    polygon.current = [];
    if (pts.length >= 6 && s.selectedStructureId) {
      fillPath(s.selectedStructureId, pts, s.toolSettings.penMode === 'erase' ? 0 : 1, 'Polygon');
    }
    schedule();
  };

  // ---------------------------------------------------------------- pointer handling

  const onPointerDown = (e: React.PointerEvent) => {
    const s = useStore.getState();
    const L = layout();
    if (!L || !s.ct) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const X = e.clientX - rect.left, Y = e.clientY - rect.top;
    const [a, b] = L.toPlane(X, Y);
    (e.target as Element).setPointerCapture(e.pointerId);
    const index = sliceIndex(plane, s.cursor);
    const nz = s.ct.meta.dims[2];
    if (e.button === 1 || (e.button === 0 && e.shiftKey && s.tool === 'navigate')) {
      drawing.current = { kind: 'pan', startX: X, startY: Y, startPanX: view.current.panX, startPanY: view.current.panY };
      return;
    }
    if (e.button === 2) {
      drawing.current = { kind: 'wl', startX: X, startY: Y, startW: s.wl.w, startL: s.wl.l };
      return;
    }
    const editing = mode === 'contour';
    const sid = s.selectedStructureId;
    const needStructure = () => {
      if (!sid) {
        toast('Select or add a structure first (right-hand panel).', 'warn');
        return false;
      }
      return true;
    };
    switch (editing ? s.tool : 'navigate') {
      case 'pearl':
      case 'eraser': {
        if (!needStructure()) return;
        const stroke = beginStroke(sid!);
        if (!stroke) return;
        let value = 1;
        if (s.tool === 'eraser' || s.toolSettings.pearlMode === 'erase' || e.altKey) value = 0;
        else if (s.toolSettings.pearlMode === 'auto') {
          // Start inside the structure → push it outwards (add); outside → push it in (erase).
          // On a slice where the structure has nothing yet, always add.
          const v = planeToVoxel(plane, nz, Math.round(a), Math.round(b), index);
          value = !extractMask(stroke.mask, plane, index) || stroke.mask.get(v[0], v[1], v[2]) ? 1 : 0;
        }
        drawing.current = { kind: 'paint', stroke, value, last: [a, b] };
        stamp(stroke, a, b, value);
        stroke.changed();
        return;
      }
      case 'pen': {
        if (!needStructure()) return;
        drawing.current = { kind: 'pen', path: [a, b], value: s.toolSettings.penMode === 'erase' || e.altKey ? 0 : 1 };
        return;
      }
      case 'polygon': {
        if (!needStructure()) return;
        const pts = polygon.current;
        if (pts.length >= 6) {
          const [fx, fy] = L.toScreen(pts[0], pts[1]);
          if (Math.hypot(fx - X, fy - Y) < 8) {
            finishPolygon();
            return;
          }
        }
        pts.push(a, b);
        schedule();
        return;
      }
      case 'wand': {
        if (!needStructure()) return;
        const v = planeToVoxel(plane, nz, Math.round(a), Math.round(b), index);
        const grown = regionGrow(s.ct.volume, v, s.toolSettings.wandTolerance, { maxRadiusMm: s.toolSettings.wandRadius, threeD: s.toolSettings.wand3D });
        const touched: number[] = [];
        for (let k = 0; k < grown.nz; k++) if (grown.slices[k]) touched.push(k);
        editMask(sid!, touched, 'Magic wand', (m) => {
          for (const k of touched) {
            const src = grown.slices[k]!;
            const dst = m.slice(k, true)!;
            for (let p = 0; p < src.length; p++) if (src[p]) dst[p] = 1;
          }
        });
        return;
      }
      case 'measure': {
        measure.current = { a0: a, b0: b, a1: a, b1: b };
        drawing.current = { kind: 'measure' };
        schedule();
        return;
      }
      default: {
        // Navigate: move the crosshair (and so the other views' slices)
        drawing.current = { kind: 'cursor' };
        moveCursor(a, b);
      }
    }
  };

  const moveCursor = (a: number, b: number) => {
    const s = useStore.getState();
    const nz = s.ct!.meta.dims[2];
    const index = sliceIndex(plane, s.cursor);
    const v = planeToVoxel(plane, nz, a, b, index);
    const d = s.ct!.meta.dims;
    useStore.setState({ cursor: [Math.min(d[0] - 1, Math.max(0, v[0])), Math.min(d[1] - 1, Math.max(0, v[1])), Math.min(d[2] - 1, Math.max(0, Math.round(v[2])))] });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const L = layout();
    if (!L) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const X = e.clientX - rect.left, Y = e.clientY - rect.top;
    const [a, b] = L.toPlane(X, Y);
    hover.current = { a, b };
    const d = drawing.current;
    if (!d) {
      schedule();
      return;
    }
    switch (d.kind) {
      case 'pan':
        view.current.panX = d.startPanX! + (X - d.startX!);
        view.current.panY = d.startPanY! + (Y - d.startY!);
        break;
      case 'wl': {
        const w = Math.max(1, d.startW! + (X - d.startX!) * 4);
        const l = d.startL! + (Y - d.startY!) * 2;
        useStore.setState({ wl: { w: Math.round(w), l: Math.round(l) } });
        break;
      }
      case 'paint': {
        const [la, lb] = d.last!;
        const s = useStore.getState();
        const stepPx = Math.max(0.5, s.toolSettings.pearlRadius / Math.max(L.info.sw, L.info.sh) / 3);
        const dist = Math.hypot(a - la, b - lb);
        const n = Math.max(1, Math.ceil(dist / stepPx));
        for (let q = 1; q <= n; q++) stamp(d.stroke!, la + ((a - la) * q) / n, lb + ((b - lb) * q) / n, d.value!);
        d.last = [a, b];
        d.stroke!.changed();
        break;
      }
      case 'pen': {
        const p = d.path!;
        if (Math.hypot(a - p[p.length - 2], b - p[p.length - 1]) > 0.4) p.push(a, b);
        break;
      }
      case 'measure':
        if (measure.current) { measure.current.a1 = a; measure.current.b1 = b; }
        break;
      case 'cursor':
        moveCursor(a, b);
        break;
    }
    schedule();
  };

  const onPointerUp = () => {
    const d = drawing.current;
    drawing.current = null;
    const s = useStore.getState();
    if (!d) return;
    if (d.kind === 'paint') d.stroke?.end(d.value ? 'Pearl' : 'Erase');
    if (d.kind === 'pen' && d.path && d.path.length >= 6 && s.selectedStructureId) fillPath(s.selectedStructureId, d.path, d.value!, 'Pen');
    schedule();
  };

  const onWheel = (e: React.WheelEvent) => {
    const s = useStore.getState();
    const L = layout();
    if (!L || !s.ct) return;
    if (e.ctrlKey || e.metaKey) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const X = e.clientX - rect.left - view.current.w / 2, Y = e.clientY - rect.top - view.current.h / 2;
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const z = Math.min(20, Math.max(0.3, view.current.zoom * f));
      const k = z / view.current.zoom;
      view.current.panX = X - (X - view.current.panX) * k;
      view.current.panY = Y - (Y - view.current.panY) * k;
      view.current.zoom = z;
      schedule();
      return;
    }
    const dir = e.deltaY > 0 ? -1 : 1;
    const c = [...s.cursor] as Vec3;
    const ax = L.info.axis;
    // Wheel up moves superior / left / posterior through the stack
    c[ax] = Math.min(L.info.count - 1, Math.max(0, Math.round(c[ax]) + (plane === 'axial' ? dir : -dir)));
    polygon.current = [];
    useStore.setState({ cursor: c });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hover.current) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
      const s = useStore.getState();
      if (!s.ct) return;
      const info = planeInfo(plane, s.ct.meta.dims, s.ct.meta.spacing);
      if (e.key === 'Escape') { polygon.current = []; measure.current = null; schedule(); }
      if (e.key === 'Enter' && polygon.current.length) finishPolygon();
      const step = e.key === 'ArrowUp' || e.key === 'PageUp' ? 1 : e.key === 'ArrowDown' || e.key === 'PageDown' ? -1 : 0;
      if (step) {
        e.preventDefault();
        const c = [...s.cursor] as Vec3;
        c[info.axis] = Math.min(info.count - 1, Math.max(0, Math.round(c[info.axis]) + step * (e.key.startsWith('Page') ? 5 : 1)));
        polygon.current = [];
        useStore.setState({ cursor: c });
      }
      if (e.key === 'r' && !e.ctrlKey && !e.metaKey) { view.current.zoom = 1; view.current.panX = 0; view.current.panY = 0; schedule(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plane]);

  const cursorStyle = (() => {
    const t = useStore.getState().tool;
    if (mode !== 'contour') return 'crosshair';
    return t === 'pearl' || t === 'eraser' ? 'none' : t === 'navigate' ? 'crosshair' : 'crosshair';
  })();

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-lg bg-[#05070c] ring-1 ring-white/5" data-view={plane}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 touch-none select-none"
        style={{ cursor: cursorStyle }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { hover.current = null; schedule(); }}
        onWheel={onWheel}
        onDoubleClick={() => {
          if (polygon.current.length) finishPolygon();
          else onMaximize?.();
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      {onMaximize && (
        <button
          className="absolute right-2 bottom-2 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-black/80"
          onClick={onMaximize}
          title={maximized ? 'Back to 4 views' : 'Enlarge this view (or double-click it)'}
        >
          {maximized ? '4-up' : 'Enlarge'}
        </button>
      )}
    </div>
  );
}
