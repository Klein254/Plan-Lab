import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useStore, machineById, updateBeam, structureShown, voxelToPatient, addBeams, toast } from '../../state/store.ts';
import { beamAxes, collToDisplay, displayToColl, projectToIso, normAngle, type BeamAxes } from '../../core/geometry.ts';
import { projectStructure, apertureOutline } from '../../core/bev.ts';
import { makeBeam, conformBeam } from '../../state/planTools.ts';
import { isoSegments } from '../../core/contour2d.ts';
import type { Beam, Vec3, Volume } from '../../core/types.ts';

const VERT = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;
uniform sampler3D uVol;
uniform vec3 uBoxMin;   // patient coords of the volume's outer faces
uniform vec3 uBoxMax;
uniform vec3 uSource;
uniform vec3 uIso;
uniform vec3 uU;
uniform vec3 uV;
uniform vec2 uHalf;     // half extent (mm) of the view at the isocentre plane
uniform vec2 uPan;      // mm
uniform int uMode;      // 0 = standard DRR, 1 = bone (skeleton) DRR
uniform float uGain;
uniform float uGamma;

void main() {
  vec2 q = (vUv * 2.0 - 1.0) * uHalf - uPan;
  vec3 target = uIso + uU * q.x + uV * q.y;
  vec3 dir = normalize(target - uSource);
  vec3 inv = 1.0 / dir;
  vec3 t0 = (uBoxMin - uSource) * inv, t1 = (uBoxMax - uSource) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z), tf = min(min(tmax.x, tmax.y), tmax.z);
  if (tf <= tn || tf < 0.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  tn = max(tn, 0.0);
  const int STEPS = 320;
  float step = (tf - tn) / float(STEPS);
  float acc = 0.0;
  vec3 size = uBoxMax - uBoxMin;
  for (int s = 0; s < STEPS; s++) {
    vec3 p = uSource + dir * (tn + (float(s) + 0.5) * step);
    float v = texture(uVol, (p - uBoxMin) / size).r;
    float hu = v * 3000.0 - 1000.0;
    float mu;
    if (uMode == 1) mu = smoothstep(120.0, 600.0, hu) * (hu + 1000.0) / 1000.0;
    else mu = max(0.0, (hu + 1000.0) / 1000.0) * (1.0 + 1.5 * smoothstep(150.0, 900.0, hu));
    acc += mu * step;
  }
  float k = uMode == 1 ? 0.010 : 0.0045;
  float i = 1.0 - exp(-acc * k * uGain);
  i = pow(clamp(i, 0.0, 1.0), uGamma);
  outColor = vec4(vec3(i), 1.0);
}
`;

// Volume texture per image set (downsampled to ≤256 per axis)
let volTex: { id: string; tex: THREE.Data3DTexture; boxMin: THREE.Vector3; boxMax: THREE.Vector3 } | null = null;
function volumeTexture(id: string, v: Volume) {
  if (volTex?.id === id) return volTex;
  volTex?.tex.dispose();
  const [nx, ny, nz] = v.dims;
  const f = Math.max(1, Math.ceil(Math.max(nx, ny) / 256));
  const fz = Math.max(1, Math.ceil(nz / 256));
  const dx = Math.ceil(nx / f), dy = Math.ceil(ny / f), dz = Math.ceil(nz / fz);
  const data = new Uint8Array(dx * dy * dz);
  for (let k = 0; k < dz; k++)
    for (let j = 0; j < dy; j++)
      for (let i = 0; i < dx; i++) {
        // max-pool keeps thin bone visible after downsampling
        let mx = -1024;
        for (let kk = k * fz; kk < Math.min(nz, (k + 1) * fz); kk++)
          for (let jj = j * f; jj < Math.min(ny, (j + 1) * f); jj++)
            for (let ii = i * f; ii < Math.min(nx, (i + 1) * f); ii++) {
              const h = v.data[ii + nx * (jj + ny * kk)];
              if (h > mx) mx = h;
            }
        data[i + dx * (j + dy * k)] = Math.max(0, Math.min(255, Math.round(((mx + 1000) / 3000) * 255)));
      }
  const tex = new THREE.Data3DTexture(data, dx, dy, dz);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  const sx = v.spacing[0] * f, sy = v.spacing[1] * f, sz = v.spacing[2] * fz;
  const boxMin = new THREE.Vector3(v.origin[0] - v.spacing[0] / 2, v.origin[1] - v.spacing[1] / 2, v.origin[2] - v.spacing[2] / 2);
  const boxMax = new THREE.Vector3(boxMin.x + dx * sx, boxMin.y + dy * sy, boxMin.z + dz * sz);
  volTex = { id, tex, boxMin, boxMax };
  return volTex;
}


const projCache = new Map<string, { seg: Float32Array; x0: number; y0: number; res: number }>();

type Drag =
  | { kind: 'jaw'; edge: 'x1' | 'x2' | 'y1' | 'y2' }
  | { kind: 'leaf'; pair: number; bank: 'x1' | 'x2' }
  | { kind: 'sculpt'; bank: 'x1' | 'x2'; last: [number, number] }
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | null;

/** View direction: the selected field's beam's-eye view, or a reference DRR from a fixed gantry angle. */
type Orient = 'beam' | number;
const ORIENTS: { value: Orient; label: string; title: string }[] = [
  { value: 'beam', label: 'Beam', title: 'Beam’s-eye view of the selected field (editable)' },
  { value: 0, label: 'AP', title: 'Reference DRR from the front (gantry 0°)' },
  { value: 180, label: 'PA', title: 'Reference DRR from behind (gantry 180°)' },
  { value: 90, label: 'L lat', title: 'Reference DRR from the patient’s left (gantry 90°)' },
  { value: 270, label: 'R lat', title: 'Reference DRR from the patient’s right (gantry 270°)' },
];
const ORIENT_NAMES: Record<number, string> = { 0: 'AP', 90: 'Left lateral', 180: 'PA', 270: 'Right lateral' };

/** Undo stack for shapes changed by dragging in the BEV (jaws and leaves). */
const shapeUndo: { beamId: string; jaws: Beam['jaws']; mlc: Beam['mlc']; autoMlc: Beam['autoMlc'] }[] = [];
function pushShapeUndo(b: Beam) {
  shapeUndo.push({ beamId: b.id, jaws: { ...b.jaws }, mlc: b.mlc ? { x1: [...b.mlc.x1], x2: [...b.mlc.x2] } : null, autoMlc: b.autoMlc });
  if (shapeUndo.length > 50) shapeUndo.shift();
}
function undoShape(): boolean {
  const plan = useStore.getState().plan;
  while (shapeUndo.length) {
    const u = shapeUndo.pop()!;
    if (!plan?.meta.beams.some((b) => b.id === u.beamId)) continue;
    updateBeam(u.beamId, { jaws: u.jaws, mlc: u.mlc, autoMlc: u.autoMlc });
    useStore.setState({ selectedBeamId: u.beamId });
    return true;
  }
  return false;
}

/** Patient direction label for a display-frame axis (couch 0): R/L/A/P. */
function sideLabel(a: Vec3): string {
  const [x, y] = a;
  if (Math.abs(x) >= Math.abs(y)) return x > 0 ? 'L' : 'R';
  return y > 0 ? 'P' : 'A';
}

export function BEVView() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const glRef = useRef<{ renderer: THREE.WebGLRenderer; mat: THREE.ShaderMaterial; scene: THREE.Scene; cam: THREE.Camera } | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const view = useRef({ w: 0, h: 0, zoom: 1, panX: 0, panY: 0 });
  const drag = useRef<Drag>(null);
  const hoverHit = useRef<Drag>(null);
  const [drrMode, setDrrMode] = useState<0 | 1>(0);
  const [gain, setGain] = useState(1);
  const [showStructs, setShowStructs] = useState(true);
  const [orient, setOrient] = useState<Orient>('beam');
  const [customAngle, setCustomAngle] = useState(45);
  const settings = useRef({ drrMode, gain, showStructs, orient });
  settings.current = { drrMode, gain, showStructs, orient };
  const [glError, setGlError] = useState(false);
  const raf = useRef(0);

  const halfExtent = () => {
    const { w, h, zoom } = view.current;
    const base = 220 / zoom; // mm visible from centre to the shorter edge
    return w > h ? [base * (w / h), base] : [base, base * (h / w)];
  };
  const scale = () => view.current.h > view.current.w ? view.current.w / 2 / halfExtent()[0] : view.current.h / 2 / halfExtent()[1];
  const toScreen = (x: number, y: number): [number, number] => {
    const s = scale();
    return [view.current.w / 2 + (x + view.current.panX) * s, view.current.h / 2 - (y + view.current.panY) * s];
  };
  const toDisplay = (X: number, Y: number): [number, number] => {
    const s = scale();
    return [(X - view.current.w / 2) / s - view.current.panX, -(Y - view.current.h / 2) / s - view.current.panY];
  };

  const selectedBeam = (): Beam | null => {
    const s = useStore.getState();
    return s.plan?.meta.beams.find((b) => b.id === s.selectedBeamId) ?? s.plan?.meta.beams[0] ?? null;
  };

  /** Geometry of what's shown: the selected beam (editable), or a reference direction through its isocentre. */
  const viewGeometry = (): { ax: BeamAxes; beam: Beam | null; gantry: number } | null => {
    const s = useStore.getState();
    const sel = selectedBeam();
    const o = settings.current.orient;
    if (o === 'beam') return sel ? { ax: beamAxes(sel, machineById(sel.machineId).sad), beam: sel, gantry: sel.gantry } : null;
    if (!s.ct) return null;
    const iso = sel?.iso ?? voxelToPatient(s.ct.volume, s.cursor);
    const sad = sel ? machineById(sel.machineId).sad : 1000;
    return { ax: beamAxes({ gantry: o, collimator: 0, couch: 0, iso }, sad), beam: null, gantry: o };
  };

  const currentBeam = (): { beam: Beam; ax: BeamAxes } | null => {
    const g = viewGeometry();
    return g?.beam ? { beam: g.beam, ax: g.ax } : null;
  };

  const render = () => {
    raf.current = 0;
    const s = useStore.getState();
    const g = glRef.current;
    const geo = viewGeometry();
    const { w, h } = view.current;
    // DRR
    if (g && s.ct && geo) {
      const vt = volumeTexture(s.ct.meta.id, s.ct.volume);
      const u = g.mat.uniforms;
      u.uVol.value = vt.tex;
      u.uBoxMin.value.copy(vt.boxMin);
      u.uBoxMax.value.copy(vt.boxMax);
      u.uSource.value.set(...geo.ax.source);
      u.uIso.value.set(...geo.ax.iso);
      u.uU.value.set(...geo.ax.u0);
      u.uV.value.set(...geo.ax.v0);
      const [hx, hy] = halfExtent();
      u.uHalf.value.set(hx, hy);
      u.uPan.value.set(view.current.panX, view.current.panY);
      u.uMode.value = settings.current.drrMode;
      u.uGain.value = settings.current.gain;
      u.uGamma.value = settings.current.drrMode === 1 ? 0.8 : 1.3;
      g.renderer.render(g.scene, g.cam);
    } else if (g) {
      g.renderer.clear();
    }
    // Overlay
    const canvas = overlayRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!geo || !s.ct) {
      ctx.fillStyle = '#64748b';
      ctx.font = '13px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(s.plan ? 'Add a beam, or pick a reference view (AP, lateral…) above' : 'Open or create a plan', w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }
    const { ax } = geo;
    // Projected structures
    if (settings.current.showStructs && s.ss) {
      for (const st of s.ss.meta.structures) {
        if (!structureShown(st, 'plan') || st.type === 'EXTERNAL' || st.type === 'SUPPORT') continue;
        const m = s.ss.masks.get(st.id)!;
        const key = `${st.id}:${m.version}:${ax.source.join(',')}:${ax.u0.join(',')}`;
        let pr = projCache.get(key);
        if (!pr) {
          const r = projectStructure(m, s.ct.volume, ax, 'display', 1.5, 260);
          pr = r ? { seg: isoSegments(r.data, r.w, r.h, 0.5), x0: r.x0, y0: r.y0, res: r.res } : { seg: new Float32Array(), x0: 0, y0: 0, res: 1 };
          if (projCache.size > 200) projCache.clear();
          projCache.set(key, pr);
        }
        if (!pr.seg.length) continue;
        ctx.strokeStyle = st.color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let n = 0; n < pr.seg.length; n += 4) {
          const [a1, b1] = toScreen(pr.x0 + pr.seg[n] * pr.res, pr.y0 + pr.seg[n + 1] * pr.res);
          const [a2, b2] = toScreen(pr.x0 + pr.seg[n + 2] * pr.res, pr.y0 + pr.seg[n + 3] * pr.res);
          ctx.moveTo(a1, b1);
          ctx.lineTo(a2, b2);
        }
        ctx.stroke();
      }
    }
    // Graticule with 1 cm ticks along the central axes (display frame)
    const disp = (pts: [number, number][], close = false) => {
      ctx.beginPath();
      pts.forEach(([x, y], n) => {
        const [X, Y] = toScreen(x, y);
        if (n) ctx.lineTo(X, Y);
        else ctx.moveTo(X, Y);
      });
      if (close) ctx.closePath();
    };
    const graticule = (collAx: BeamAxes) => {
      const c = (x: number, y: number) => collToDisplay(collAx, x, y);
      ctx.strokeStyle = 'rgba(248,113,113,0.95)';
      ctx.lineWidth = 1;
      const ext = 200;
      disp([c(-ext, 0), c(ext, 0)]);
      ctx.stroke();
      disp([c(0, -ext), c(0, ext)]);
      ctx.stroke();
      for (let t = -ext; t <= ext; t += 10) {
        if (!t) continue;
        const big = t % 50 === 0 ? 6 : 3;
        disp([c(t, -big), c(t, big)]);
        ctx.stroke();
        disp([c(-big, t), c(big, t)]);
        ctx.stroke();
      }
    };

    if (!geo.beam) {
      // Reference view: fields that look along this direction are outlined (dashed) for orientation
      graticule(ax);
      s.plan?.meta.beams.forEach((b) => {
        if (Math.abs(((b.gantry - geo.gantry + 540) % 360) - 180) > 0.5 || b.couch !== 0) return;
        const m = machineById(b.machineId);
        const bax = beamAxes(b, m.sad);
        const off = projectToIso(ax, b.iso, 'display') ?? [0, 0];
        const out = apertureOutline(b, m);
        if (out.length < 6) return;
        const pts: [number, number][] = [];
        for (let n = 0; n < out.length; n += 2) {
          const [x, y] = collToDisplay(bax, out[n], out[n + 1]);
          pts.push([x + off[0], y + off[1]]);
        }
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([6, 4]);
        disp(pts, true);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#fde68a';
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        const [lx, ly] = toScreen(pts[0][0], pts[0][1]);
        ctx.fillText(b.name, lx + 4, ly - 4);
      });
      ctx.font = '600 12px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(`Reference DRR · ${ORIENT_NAMES[geo.gantry] ?? `gantry ${geo.gantry}°`}`, 10, 18);
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('Through the selected field’s isocentre · “Add field” creates a beam from this direction', 10, 34);
    } else {
      const { beam } = geo;
      const machine = machineById(beam.machineId);
      const coll = (x: number, y: number) => toScreen(...collToDisplay(ax, x, y));
      const poly = (pts: [number, number][], close = true) => {
        ctx.beginPath();
        pts.forEach(([x, y], n) => {
          const [X, Y] = coll(x, y);
          if (n) ctx.lineTo(X, Y);
          else ctx.moveTo(X, Y);
        });
        if (close) ctx.closePath();
      };
      const j = beam.jaws;
      // MLC leaves
      if (machine.mlc && beam.mlc) {
        const B = machine.mlc.boundaries;
        const xl = j.x1 - 40, xr = j.x2 + 40;
        ctx.lineWidth = 1;
        for (let p = 0; p < B.length - 1; p++) {
          const y0 = B[p], y1 = B[p + 1];
          if (y1 < j.y1 - 25 || y0 > j.y2 + 25) continue;
          const inField = y1 > j.y1 && y0 < j.y2;
          const hot = hoverHit.current?.kind === 'leaf' && hoverHit.current.pair === p;
          ctx.strokeStyle = inField ? (hot ? '#fff59d' : 'rgba(250,204,21,0.9)') : 'rgba(250,204,21,0.35)';
          ctx.fillStyle = inField ? 'rgba(250,204,21,0.14)' : 'rgba(250,204,21,0.05)';
          const a = Math.max(xl, Math.min(xr, beam.mlc.x1[p])), b = Math.max(xl, Math.min(xr, beam.mlc.x2[p]));
          poly([[xl, y0], [a, y0], [a, y1], [xl, y1]]);
          ctx.fill();
          ctx.stroke();
          poly([[b, y0], [xr, y0], [xr, y1], [b, y1]]);
          ctx.fill();
          ctx.stroke();
        }
      }
      // Jaws
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2;
      poly([[j.x1, j.y1], [j.x2, j.y1], [j.x2, j.y2], [j.x1, j.y2]]);
      ctx.stroke();
      if (hoverHit.current?.kind === 'jaw') {
        const e = hoverHit.current.edge;
        ctx.strokeStyle = '#fff59d';
        ctx.lineWidth = 4;
        const seg: [number, number][] = e === 'x1' ? [[j.x1, j.y1], [j.x1, j.y2]] : e === 'x2' ? [[j.x2, j.y1], [j.x2, j.y2]] : e === 'y1' ? [[j.x1, j.y1], [j.x2, j.y1]] : [[j.x1, j.y2], [j.x2, j.y2]];
        poly(seg, false);
        ctx.stroke();
      }
      // Jaw labels
      ctx.fillStyle = '#fde68a';
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      const lbl = (t: string, x: number, y: number) => { const [X, Y] = coll(x, y); ctx.fillText(t, X + 4, Y - 4); };
      lbl('X1', j.x1, (j.y1 + j.y2) / 2);
      lbl('X2', j.x2, (j.y1 + j.y2) / 2);
      lbl('Y1', (j.x1 + j.x2) / 2, j.y1);
      lbl('Y2', (j.x1 + j.x2) / 2, j.y2);
      graticule(ax);
      // Wedge indicator: triangle pointing from heel to toe
      if (beam.wedge.type !== 'none' && beam.wedge.angle) {
        const o = beam.wedge.orientation;
        const L = 30;
        const [cx, cy] = o === 'left' || o === 'right' ? [0, j.y2 + 18] : [j.x2 + 18, 0];
        const heel: [number, number] = o === 'left' ? [cx - L, cy] : o === 'right' ? [cx + L, cy] : o === 'in' ? [cx, cy + L] : [cx, cy - L];
        const toe: [number, number] = o === 'left' ? [cx + L, cy] : o === 'right' ? [cx - L, cy] : o === 'in' ? [cx, cy - L] : [cx, cy + L];
        const perp: [number, number] = o === 'left' || o === 'right' ? [0, 10] : [10, 0];
        ctx.fillStyle = 'rgba(56,189,248,0.6)';
        poly([toe, [heel[0] + perp[0], heel[1] + perp[1]], heel]);
        ctx.fill();
        ctx.fillStyle = '#7dd3fc';
        const [tx, ty] = coll(heel[0], heel[1]);
        ctx.fillText(`${beam.wedge.type === 'virtual' ? 'VW' : 'W'}${beam.wedge.angle}°`, tx + 6, ty + 14);
      }
      // Header
      ctx.font = '600 12px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(`${beam.name}  ·  BEV`, 10, 18);
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`G ${beam.gantry.toFixed(1)}°  C ${beam.collimator.toFixed(1)}°  T ${beam.couch.toFixed(1)}°  ·  ${beam.energy}  ·  ${((j.x2 - j.x1) / 10).toFixed(1)} × ${((j.y2 - j.y1) / 10).toFixed(1)} cm`, 10, 34);
      if (machine.mlc && beam.mlc) {
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(148,163,184,0.8)';
        ctx.fillText('Drag inside the field to shape the leaves · drag an edge to move it · Ctrl+Z undo', w - 10, h - 10);
        ctx.textAlign = 'left';
      }
    }
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(drrMode === 1 ? 'DRR: skeleton' : 'DRR: standard', 10, h - 10);
    // Patient orientation at the edges (display frame: +u0 to the right, +v0 up)
    if ((geo.beam?.couch ?? 0) === 0) {
      ctx.font = '600 12px Inter, system-ui, sans-serif';
      ctx.fillStyle = 'rgba(226,232,240,0.75)';
      ctx.textAlign = 'center';
      ctx.fillText('H', w / 2, 56);
      ctx.fillText('F', w / 2, h - 26);
      ctx.textAlign = 'left';
      ctx.fillText(sideLabel([-ax.u0[0], -ax.u0[1], 0]), 8, h / 2);
      ctx.textAlign = 'right';
      ctx.fillText(sideLabel(ax.u0), w - 8, h / 2);
      ctx.textAlign = 'left';
    }
  };

  const schedule = () => {
    if (!raf.current) raf.current = requestAnimationFrame(render);
  };

  useEffect(() => {
    const wrap = wrapRef.current!;
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    } catch {
      setGlError(true);
    }
    if (renderer) {
      renderer.setClearColor(0x000000);
      renderer.domElement.style.position = 'absolute';
      renderer.domElement.style.inset = '0';
      wrap.insertBefore(renderer.domElement, wrap.firstChild);
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uVol: { value: null }, uBoxMin: { value: new THREE.Vector3() }, uBoxMax: { value: new THREE.Vector3() },
          uSource: { value: new THREE.Vector3() }, uIso: { value: new THREE.Vector3() }, uU: { value: new THREE.Vector3() }, uV: { value: new THREE.Vector3() },
          uHalf: { value: new THREE.Vector2(200, 200) }, uPan: { value: new THREE.Vector2() }, uMode: { value: 0 }, uGain: { value: 1 }, uGamma: { value: 1 },
        },
        depthTest: false,
      });
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      glRef.current = { renderer, mat, scene, cam: new THREE.Camera() };
    }
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      view.current.w = Math.max(10, r.width);
      view.current.h = Math.max(10, r.height);
      if (glRef.current) {
        // Render the DRR at up to 1× device pixels for speed
        glRef.current.renderer.setPixelRatio(Math.min(dpr, 1.5));
        glRef.current.renderer.setSize(view.current.w, view.current.h, false);
        glRef.current.renderer.domElement.style.width = `${view.current.w}px`;
        glRef.current.renderer.domElement.style.height = `${view.current.h}px`;
      }
      const c = overlayRef.current!;
      c.width = Math.round(view.current.w * dpr);
      c.height = Math.round(view.current.h * dpr);
      c.style.width = `${view.current.w}px`;
      c.style.height = `${view.current.h}px`;
      render();
    });
    ro.observe(wrap);
    const unsub = useStore.subscribe(schedule);
    // Ctrl+Z undoes the last jaw / leaf drag while planning
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && useStore.getState().module === 'plan') {
        e.preventDefault();
        if (!undoShape()) toast('Nothing to undo in the field shape.', 'info');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      unsub();
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      if (raf.current) cancelAnimationFrame(raf.current);
      if (glRef.current) {
        glRef.current.renderer.dispose();
        glRef.current.renderer.domElement.remove();
        glRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(schedule, [drrMode, gain, showStructs, orient]);

  // ---------------------------------------------------------------- interaction
  const pairAt = (machine: ReturnType<typeof machineById>, y: number) => {
    const B = machine.mlc?.boundaries;
    if (!B) return -1;
    for (let p = 0; p < B.length - 1; p++) if (y >= B[p] && y < B[p + 1]) return p;
    return -1;
  };

  const hitTest = (X: number, Y: number): Drag => {
    const cur = currentBeam();
    if (!cur) return null;
    const { beam, ax } = cur;
    const [dx, dy] = toDisplay(X, Y);
    const [x, y] = displayToColl(ax, dx, dy);
    const tol = 6 / scale();
    const j = beam.jaws;
    const machine = machineById(beam.machineId);
    // Leaves first (they sit inside the jaws)
    if (machine.mlc && beam.mlc) {
      const B = machine.mlc.boundaries;
      for (let p = 0; p < B.length - 1; p++) {
        if (y < B[p] || y > B[p + 1]) continue;
        if (Math.abs(x - beam.mlc.x1[p]) < tol) return { kind: 'leaf', pair: p, bank: 'x1' };
        if (Math.abs(x - beam.mlc.x2[p]) < tol) return { kind: 'leaf', pair: p, bank: 'x2' };
      }
    }
    const inY = y > j.y1 - tol && y < j.y2 + tol, inX = x > j.x1 - tol && x < j.x2 + tol;
    if (inY && Math.abs(x - j.x1) < tol) return { kind: 'jaw', edge: 'x1' };
    if (inY && Math.abs(x - j.x2) < tol) return { kind: 'jaw', edge: 'x2' };
    if (inX && Math.abs(y - j.y1) < tol) return { kind: 'jaw', edge: 'y1' };
    if (inX && Math.abs(y - j.y2) < tol) return { kind: 'jaw', edge: 'y2' };
    return null;
  };

  /** Moves the leaf tips of one bank along the path from `from` to `to` (collimator mm), like painting the field edge. */
  const sculpt = (beam: Beam, bank: 'x1' | 'x2', from: [number, number], to: [number, number]) => {
    const machine = machineById(beam.machineId);
    if (!machine.mlc || !beam.mlc) return;
    const x1 = [...beam.mlc.x1], x2 = [...beam.mlc.x2];
    const lim = machine.mlc.maxTipTravel;
    const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 1.5));
    let changed = false;
    for (let q = 0; q <= steps; q++) {
      const x = from[0] + ((to[0] - from[0]) * q) / steps, y = from[1] + ((to[1] - from[1]) * q) / steps;
      const p = pairAt(machine, y);
      if (p < 0) continue;
      const v = Math.round(x * 10) / 10;
      if (bank === 'x1') {
        const nv = Math.max(-lim, Math.min(x2[p], v));
        if (nv !== x1[p]) { x1[p] = nv; changed = true; }
      } else {
        const nv = Math.min(lim, Math.max(x1[p], v));
        if (nv !== x2[p]) { x2[p] = nv; changed = true; }
      }
    }
    if (changed) updateBeam(beam.id, { mlc: { x1, x2 }, autoMlc: null });
  };

  const onDown = (e: React.PointerEvent) => {
    const r = overlayRef.current!.getBoundingClientRect();
    const X = e.clientX - r.left, Y = e.clientY - r.top;
    (e.target as Element).setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || e.shiftKey) {
      drag.current = { kind: 'pan', sx: X, sy: Y, px: view.current.panX, py: view.current.panY };
      return;
    }
    const hit = hitTest(X, Y);
    const cur = currentBeam();
    if (hit && cur) pushShapeUndo(cur.beam);
    drag.current = hit;
    if (hit || !cur) return;
    // Plain drag elsewhere: shape the MLC. The bank is the one nearer the starting point.
    const machine = machineById(cur.beam.machineId);
    if (!machine.mlc || !cur.beam.mlc) return;
    const [x, y] = displayToColl(cur.ax, ...toDisplay(X, Y));
    const p = pairAt(machine, y);
    if (p < 0) return;
    const bank = x < (cur.beam.mlc.x1[p] + cur.beam.mlc.x2[p]) / 2 ? 'x1' : 'x2';
    pushShapeUndo(cur.beam);
    drag.current = { kind: 'sculpt', bank, last: [x, y] };
    sculpt(cur.beam, bank, [x, y], [x, y]);
  };

  const onMove = (e: React.PointerEvent) => {
    const r = overlayRef.current!.getBoundingClientRect();
    const X = e.clientX - r.left, Y = e.clientY - r.top;
    const d = drag.current;
    if (!d) {
      const hit = hitTest(X, Y);
      const changed = JSON.stringify(hit) !== JSON.stringify(hoverHit.current);
      hoverHit.current = hit;
      const cur = currentBeam();
      const canSculpt = !!cur && !!machineById(cur.beam.machineId).mlc && !!cur.beam.mlc;
      overlayRef.current!.style.cursor = hit ? (hit.kind === 'jaw' && (hit.edge === 'y1' || hit.edge === 'y2') ? 'ns-resize' : 'ew-resize') : canSculpt ? 'crosshair' : 'default';
      if (changed) schedule();
      return;
    }
    if (d.kind === 'pan') {
      const s = scale();
      view.current.panX = d.px + (X - d.sx) / s;
      view.current.panY = d.py - (Y - d.sy) / s;
      schedule();
      return;
    }
    const cur = currentBeam();
    if (!cur) return;
    const { beam, ax } = cur;
    const [x, y] = displayToColl(ax, ...toDisplay(X, Y));
    const round = (v: number) => Math.round(v);
    const machine = machineById(beam.machineId);
    if (d.kind === 'jaw') {
      const jw = { ...beam.jaws };
      const hx = machine.maxField.x / 2, hy = machine.maxField.y / 2;
      if (d.edge === 'x1') jw.x1 = Math.max(-hx, Math.min(jw.x2, round(x)));
      if (d.edge === 'x2') jw.x2 = Math.min(hx, Math.max(jw.x1, round(x)));
      if (d.edge === 'y1') jw.y1 = Math.max(-hy, Math.min(jw.y2, round(y)));
      if (d.edge === 'y2') jw.y2 = Math.min(hy, Math.max(jw.y1, round(y)));
      updateBeam(beam.id, { jaws: jw, autoMlc: null });
    } else if (d.kind === 'leaf' && beam.mlc) {
      const x1 = [...beam.mlc.x1], x2 = [...beam.mlc.x2];
      const lim = machine.mlc!.maxTipTravel;
      if (d.bank === 'x1') x1[d.pair] = Math.max(-lim, Math.min(x2[d.pair], Math.round(x * 10) / 10));
      else x2[d.pair] = Math.min(lim, Math.max(x1[d.pair], Math.round(x * 10) / 10));
      updateBeam(beam.id, { mlc: { x1, x2 }, autoMlc: null });
    } else if (d.kind === 'sculpt') {
      sculpt(beam, d.bank, d.last, [x, y]);
      d.last = [x, y];
    }
  };

  const onUp = () => {
    drag.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    view.current.zoom = Math.min(8, Math.max(0.4, view.current.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    schedule();
  };

  const addFieldFromView = () => {
    const s = useStore.getState();
    if (!s.plan || !s.ct || orient === 'beam') return;
    const sel = selectedBeam();
    const machine = machineById(sel?.machineId ?? s.lib.machines[0].id);
    const iso = sel?.iso ?? (voxelToPatient(s.ct.volume, s.cursor).map(Math.round) as Vec3);
    const target = s.plan.meta.prescription.targetId;
    const nb = makeBeam(machine, orient, iso, sel?.energy);
    addBeams([target ? conformBeam(nb, target, sel?.autoMlc?.margin ?? 7) : nb]);
    setOrient('beam');
    toast(`Added ${nb.name} (gantry ${orient}°).`, 'success');
  };

  const btn = 'rounded px-1.5 py-0.5 text-[10px] ring-1 ring-white/10';
  const isCustom = orient !== 'beam' && !ORIENTS.some((o) => o.value === orient);
  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-lg bg-black ring-1 ring-white/5" data-view="bev">
      {glError && <div className="absolute inset-0 grid place-items-center text-xs text-slate-500">DRR needs WebGL 2</div>}
      <canvas
        ref={overlayRef}
        className="absolute inset-0 touch-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
        onDoubleClick={() => { view.current.zoom = 1; view.current.panX = 0; view.current.panY = 0; schedule(); }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="absolute top-2 right-2 flex flex-col items-end gap-1 text-[11px] text-slate-300">
        <div className="flex items-center gap-1">
          <button className={`${btn} ${drrMode === 0 ? 'bg-slate-200/20' : 'bg-black/50'}`} onClick={() => setDrrMode(0)} title="Standard DRR">DRR</button>
          <button className={`${btn} ${drrMode === 1 ? 'bg-slate-200/20' : 'bg-black/50'}`} onClick={() => setDrrMode(1)} title="Bone-only DRR for bony landmarks">Skeleton</button>
          <button className={`${btn} ${showStructs ? 'bg-slate-200/20' : 'bg-black/50'}`} onClick={() => setShowStructs((v) => !v)}>Contours</button>
          <label className="ml-1 flex items-center gap-1 text-[10px] text-slate-400">
            Contrast
            <input type="range" min={0.3} max={3} step={0.05} value={gain} onChange={(e) => setGain(+e.target.value)} className="w-20 accent-amber-400" />
          </label>
        </div>
        <div className="flex items-center gap-1" data-testid="bev-orient">
          <span className="mr-0.5 text-[10px] text-slate-500">View</span>
          {ORIENTS.map((o) => (
            <button key={String(o.value)} className={`${btn} ${orient === o.value ? 'bg-sky-400/30 text-sky-100' : 'bg-black/50'}`} onClick={() => setOrient(o.value)} title={o.title}>{o.label}</button>
          ))}
          <button className={`${btn} ${isCustom ? 'bg-sky-400/30 text-sky-100' : 'bg-black/50'}`} onClick={() => setOrient(normAngle(customAngle))} title="Reference DRR from any gantry angle">Angle</button>
          <input
            type="number"
            value={customAngle}
            onChange={(e) => { const v = +e.target.value; setCustomAngle(v); setOrient(normAngle(v)); }}
            className="h-5 w-12 rounded bg-black/60 px-1 text-right text-[10px] ring-1 ring-white/10 outline-none"
            title="Gantry angle for the reference view (°)"
          />
        </div>
        {orient !== 'beam' && (
          <button className={`${btn} bg-amber-400/20 text-amber-100 hover:bg-amber-400/30`} onClick={addFieldFromView} title="Create a field from this direction (conformed to the target)">
            + Add field from this view
          </button>
        )}
      </div>
    </div>
  );
}
