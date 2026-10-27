import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useStore, machineById, updateBeam } from '../../state/store.ts';
import { beamAxes, collToDisplay, displayToColl, type BeamAxes } from '../../core/geometry.ts';
import { projectStructure } from '../../core/bev.ts';
import { isoSegments } from '../../core/contour2d.ts';
import type { Beam, Volume } from '../../core/types.ts';

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
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | null;

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
  const settings = useRef({ drrMode, gain, showStructs });
  settings.current = { drrMode, gain, showStructs };
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

  const currentBeam = (): { beam: Beam; ax: BeamAxes } | null => {
    const s = useStore.getState();
    const beam = s.plan?.meta.beams.find((b) => b.id === s.selectedBeamId) ?? s.plan?.meta.beams[0];
    if (!beam) return null;
    return { beam, ax: beamAxes(beam, machineById(beam.machineId).sad) };
  };

  const render = () => {
    raf.current = 0;
    const s = useStore.getState();
    const g = glRef.current;
    const cur = currentBeam();
    const { w, h } = view.current;
    // DRR
    if (g && s.ct && cur) {
      const vt = volumeTexture(s.ct.meta.id, s.ct.volume);
      const u = g.mat.uniforms;
      u.uVol.value = vt.tex;
      u.uBoxMin.value.copy(vt.boxMin);
      u.uBoxMax.value.copy(vt.boxMax);
      u.uSource.value.set(...cur.ax.source);
      u.uIso.value.set(...cur.ax.iso);
      u.uU.value.set(...cur.ax.u0);
      u.uV.value.set(...cur.ax.v0);
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
    if (!cur || !s.ct) {
      ctx.fillStyle = '#64748b';
      ctx.font = '13px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(s.plan ? 'Add a beam to see its beam’s-eye view' : 'Open or create a plan', w / 2, h / 2);
      ctx.textAlign = 'left';
      return;
    }
    const { beam, ax } = cur;
    const machine = machineById(beam.machineId);
    const sc = scale();
    // Projected structures
    if (settings.current.showStructs && s.ss) {
      for (const st of s.ss.meta.structures) {
        if (!st.visible || st.type === 'EXTERNAL' || st.type === 'SUPPORT') continue;
        const m = s.ss.masks.get(st.id)!;
        const key = `${st.id}:${m.version}:${beam.gantry}:${beam.couch}:${beam.iso.join(',')}`;
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
    // Graticule with 1 cm ticks along the central axes
    ctx.strokeStyle = 'rgba(248,113,113,0.95)';
    ctx.lineWidth = 1;
    const ext = 200;
    poly([[-ext, 0], [ext, 0]], false);
    ctx.stroke();
    poly([[0, -ext], [0, ext]], false);
    ctx.stroke();
    for (let t = -ext; t <= ext; t += 10) {
      if (!t) continue;
      const big = t % 50 === 0 ? 6 : 3;
      poly([[t, -big], [t, big]], false);
      ctx.stroke();
      poly([[-big, t], [big, t]], false);
      ctx.stroke();
    }
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
    ctx.fillText(drrMode === 1 ? 'DRR: skeleton' : 'DRR: standard', 10, h - 10);
    // Patient orientation hints in the display frame (head is +v0 for gantry 0)
    ctx.fillStyle = 'rgba(226,232,240,0.7)';
    ctx.textAlign = 'center';
    ctx.fillText(beam.couch === 0 ? 'Head' : '', w / 2, 14);
    ctx.textAlign = 'left';
    void sc;
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
    return () => {
      unsub();
      ro.disconnect();
      if (raf.current) cancelAnimationFrame(raf.current);
      if (glRef.current) {
        glRef.current.renderer.dispose();
        glRef.current.renderer.domElement.remove();
        glRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(schedule, [drrMode, gain, showStructs]);

  // ---------------------------------------------------------------- interaction
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

  const onDown = (e: React.PointerEvent) => {
    const r = overlayRef.current!.getBoundingClientRect();
    const X = e.clientX - r.left, Y = e.clientY - r.top;
    (e.target as Element).setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || e.shiftKey) {
      drag.current = { kind: 'pan', sx: X, sy: Y, px: view.current.panX, py: view.current.panY };
      return;
    }
    drag.current = hitTest(X, Y);
  };

  const onMove = (e: React.PointerEvent) => {
    const r = overlayRef.current!.getBoundingClientRect();
    const X = e.clientX - r.left, Y = e.clientY - r.top;
    const d = drag.current;
    if (!d) {
      const hit = hitTest(X, Y);
      const changed = JSON.stringify(hit) !== JSON.stringify(hoverHit.current);
      hoverHit.current = hit;
      overlayRef.current!.style.cursor = hit ? (hit.kind === 'jaw' && (hit.edge === 'y1' || hit.edge === 'y2') ? 'ns-resize' : 'ew-resize') : 'default';
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
    }
  };

  const onUp = () => {
    drag.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    view.current.zoom = Math.min(8, Math.max(0.4, view.current.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    schedule();
  };

  const btn = 'rounded px-1.5 py-0.5 text-[10px] ring-1 ring-white/10';
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
      <div className="absolute top-2 right-2 flex items-center gap-1 text-[11px] text-slate-300">
        <button className={`${btn} ${drrMode === 0 ? 'bg-slate-200/20' : 'bg-black/50'}`} onClick={() => setDrrMode(0)} title="Standard DRR">DRR</button>
        <button className={`${btn} ${drrMode === 1 ? 'bg-slate-200/20' : 'bg-black/50'}`} onClick={() => setDrrMode(1)} title="Bone-only DRR for bony landmarks">Skeleton</button>
        <button className={`${btn} ${showStructs ? 'bg-slate-200/20' : 'bg-black/50'}`} onClick={() => setShowStructs((v) => !v)}>Contours</button>
        <label className="ml-1 flex items-center gap-1 text-[10px] text-slate-400">
          Contrast
          <input type="range" min={0.3} max={3} step={0.05} value={gain} onChange={(e) => setGain(+e.target.value)} className="w-20 accent-amber-400" />
        </label>
      </div>
    </div>
  );
}
