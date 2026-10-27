import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore, machineById } from '../../state/store.ts';
import { downsampleField, maskField, surfaceNets, type MeshData } from '../../core/mesh.ts';
import { beamAxes } from '../../core/geometry.ts';
import type { Vec3 } from '../../core/types.ts';

interface Props {
  mode: 'contour' | 'plan' | 'eval';
  onMaximize?: () => void;
  maximized?: boolean;
}

// Meshes are cached by structure id + mask version, bone by image set id
const meshCache = new Map<string, MeshData | null>();

function toGeometry(m: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeVertexNormals();
  return g;
}

export function View3D({ mode, onMaximize, maximized }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const three = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; groups: Record<string, THREE.Group> } | null>(null);
  const [showBones, setShowBones] = useState(true);
  const [showSkin, setShowSkin] = useState(true);
  const [showIso, setShowIso] = useState(true);
  const [building, setBuilding] = useState(false);
  const ssVersion = useStore((s) => s.ssVersion);
  const planVersion = useStore((s) => s.planVersion);
  const doseVersion = useStore((s) => s.doseVersion);
  const ctId = useStore((s) => s.ct?.meta.id);
  const selectedBeamId = useStore((s) => s.selectedBeamId);
  const [error, setError] = useState<string | null>(null);

  // Scene setup
  useEffect(() => {
    const wrap = wrapRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    } catch {
      setError('3D view needs WebGL, which is unavailable on this computer.');
      return;
    }
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setClearColor(0x05070c);
    wrap.appendChild(renderer.domElement);
    renderer.domElement.style.position = 'absolute';
    renderer.domElement.style.inset = '0';
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
    camera.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(-400, -900, 600);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(600, 800, -200);
    scene.add(fill);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const groups: Record<string, THREE.Group> = {};
    for (const name of ['structures', 'bones', 'skin', 'beams', 'dose']) {
      groups[name] = new THREE.Group();
      scene.add(groups[name]);
    }
    three.current = { renderer, scene, camera, controls, groups };
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      renderer.setSize(Math.max(10, r.width), Math.max(10, r.height), false);
      renderer.domElement.style.width = `${r.width}px`;
      renderer.domElement.style.height = `${r.height}px`;
      camera.aspect = r.width / Math.max(1, r.height);
      camera.updateProjectionMatrix();
    });
    ro.observe(wrap);
    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      wrap.removeChild(renderer.domElement);
      three.current = null;
    };
  }, []);

  // Camera framing when the image set changes
  useEffect(() => {
    const t = three.current;
    const ct = useStore.getState().ct;
    if (!t || !ct) return;
    const { dims, spacing, origin } = ct.meta;
    const c = new THREE.Vector3(origin[0] + ((dims[0] - 1) * spacing[0]) / 2, origin[1] + ((dims[1] - 1) * spacing[1]) / 2, origin[2] + ((dims[2] - 1) * spacing[2]) / 2);
    const size = Math.max(dims[0] * spacing[0], dims[1] * spacing[1], dims[2] * spacing[2]);
    t.controls.target.copy(c);
    t.camera.position.set(c.x + size * 0.6, c.y - size * 1.9, c.z + size * 0.5);
    t.camera.near = size / 100;
    t.camera.far = size * 20;
    t.camera.updateProjectionMatrix();
  }, [ctId]);

  // Structures
  useEffect(() => {
    const t = three.current;
    const s = useStore.getState();
    if (!t || !s.ct) return;
    const g = t.groups.structures;
    g.clear();
    const ss = s.ss;
    if (!ss) return;
    const { spacing, origin } = s.ct.meta;
    for (const st of ss.meta.structures) {
      if (!st.visible || st.type === 'EXTERNAL') continue;
      const m = ss.masks.get(st.id);
      if (!m) continue;
      const key = `${st.id}:${m.version}`;
      if (!meshCache.has(key)) {
        const field = maskField(m, spacing, origin, 160);
        meshCache.set(key, field ? surfaceNets(field, 0.5, 2) : null);
      }
      const md = meshCache.get(key);
      if (!md) continue;
      const target = ['GTV', 'CTV', 'ITV', 'PTV'].includes(st.type);
      const mat = new THREE.MeshStandardMaterial({
        color: st.color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide,
        transparent: st.type === 'PTV' || st.type === 'CTV', opacity: st.type === 'PTV' ? 0.45 : st.type === 'CTV' ? 0.6 : 1,
        depthWrite: !(st.type === 'PTV' || st.type === 'CTV'),
      });
      const mesh = new THREE.Mesh(toGeometry(md), mat);
      mesh.renderOrder = target ? 2 : 1;
      g.add(mesh);
    }
  }, [ssVersion, ctId]);

  // Skin (from the Body structure)
  useEffect(() => {
    const t = three.current;
    const s = useStore.getState();
    if (!t || !s.ct) return;
    const g = t.groups.skin;
    g.clear();
    const body = s.ss?.meta.structures.find((x) => x.type === 'EXTERNAL');
    if (!showSkin || !body || !body.visible) return;
    const m = s.ss!.masks.get(body.id)!;
    const key = `${body.id}:${m.version}`;
    if (!meshCache.has(key)) {
      const { spacing, origin } = s.ct.meta;
      const field = maskField(m, spacing, origin, 110);
      meshCache.set(key, field ? surfaceNets(field, 0.5, 3) : null);
    }
    const md = meshCache.get(key);
    if (!md) return;
    const mesh = new THREE.Mesh(toGeometry(md), new THREE.MeshStandardMaterial({ color: '#e8c4a8', transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
    mesh.renderOrder = 5;
    g.add(mesh);
  }, [ssVersion, ctId, showSkin]);

  // Bones from the CT (HU threshold)
  useEffect(() => {
    const t = three.current;
    const s = useStore.getState();
    if (!t || !s.ct) return;
    const g = t.groups.bones;
    g.clear();
    if (!showBones) return;
    const key = `bones:${s.ct.meta.id}`;
    const build = () => {
      if (!meshCache.has(key)) {
        const { dims, spacing, origin } = s.ct!.meta;
        const d = s.ct!.volume.data;
        const nx = dims[0], ny = dims[1];
        // Exclude the couch: bone must sit within the body when a Body exists
        const bodyMeta = s.ss?.meta.structures.find((x) => x.type === 'EXTERNAL');
        const body = bodyMeta ? s.ss!.masks.get(bodyMeta.id) : null;
        const useBody = body && !body.isEmpty();
        meshCache.set(key, surfaceNets(downsampleField(dims, spacing, origin, (i, j, k) => (d[i + nx * (j + ny * k)] > 220 && (!useBody || body!.get(i, j, k)) ? 1 : 0), 150), 0.35, 1));
      }
      const md = meshCache.get(key);
      if (md) g.add(new THREE.Mesh(toGeometry(md), new THREE.MeshStandardMaterial({ color: '#f1ece2', roughness: 0.7, side: THREE.DoubleSide })));
      setBuilding(false);
    };
    if (meshCache.has(key)) build();
    else {
      setBuilding(true);
      setTimeout(build, 20);
    }
  }, [ctId, showBones]);

  // Beams
  useEffect(() => {
    const t = three.current;
    const s = useStore.getState();
    if (!t) return;
    const g = t.groups.beams;
    g.clear();
    if (mode === 'contour' || !s.plan) return;
    const colors = ['#facc15', '#38bdf8', '#f472b6', '#4ade80', '#fb923c', '#a78bfa'];
    s.plan.meta.beams.forEach((b, n) => {
      const machine = machineById(b.machineId);
      const ax = beamAxes(b, machine.sad);
      const j = b.jaws;
      const reach = 1.25;
      const corner = (x: number, y: number): THREE.Vector3 => {
        const d: Vec3 = [ax.dir[0] * ax.sad + ax.u[0] * x + ax.v[0] * y, ax.dir[1] * ax.sad + ax.u[1] * x + ax.v[1] * y, ax.dir[2] * ax.sad + ax.u[2] * x + ax.v[2] * y];
        return new THREE.Vector3(ax.source[0] + d[0] * reach, ax.source[1] + d[1] * reach, ax.source[2] + d[2] * reach);
      };
      // Start the drawn beam 30 cm before the isocentre so it doesn't fill the view
      const start = 0.7;
      const near = (x: number, y: number) => {
        const d: Vec3 = [ax.dir[0] * ax.sad + ax.u[0] * x + ax.v[0] * y, ax.dir[1] * ax.sad + ax.u[1] * x + ax.v[1] * y, ax.dir[2] * ax.sad + ax.u[2] * x + ax.v[2] * y];
        return new THREE.Vector3(ax.source[0] + d[0] * start, ax.source[1] + d[1] * start, ax.source[2] + d[2] * start);
      };
      const cs = [[j.x1, j.y1], [j.x2, j.y1], [j.x2, j.y2], [j.x1, j.y2]];
      const pts: THREE.Vector3[] = [];
      for (let q = 0; q < 4; q++) {
        const [x, y] = cs[q], [x2, y2] = cs[(q + 1) % 4];
        pts.push(near(x, y), corner(x, y), near(x, y), near(x2, y2), corner(x, y), corner(x2, y2));
      }
      const col = colors[n % colors.length];
      const sel = b.id === s.selectedBeamId;
      g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: sel ? 1 : 0.6 })));
      // Translucent beam volume
      const geo = new THREE.BufferGeometry().setFromPoints([
        near(j.x1, j.y1), near(j.x2, j.y1), near(j.x2, j.y2), near(j.x1, j.y2),
        corner(j.x1, j.y1), corner(j.x2, j.y1), corner(j.x2, j.y2), corner(j.x1, j.y2),
      ]);
      geo.setIndex([0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
      g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: sel ? 0.16 : 0.07, depthWrite: false, side: THREE.DoubleSide })));
      const iso = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 12), new THREE.MeshBasicMaterial({ color: '#f43f5e' }));
      iso.position.set(...b.iso);
      g.add(iso);
    });
  }, [planVersion, selectedBeamId, mode]);

  // Prescription isodose surface
  useEffect(() => {
    const t = three.current;
    const s = useStore.getState();
    if (!t) return;
    const g = t.groups.dose;
    g.clear();
    if (mode === 'contour' || !showIso || !s.dose?.total || !s.plan) return;
    const rx = s.plan.meta.prescription.totalDose;
    const { grid, total } = s.dose;
    const md = surfaceNets({ data: total.map((d) => d / rx), dims: grid.dims, spacing: grid.spacing, origin: grid.origin }, 0.95, 1);
    if (!md) return;
    g.add(new THREE.Mesh(toGeometry(md), new THREE.MeshStandardMaterial({ color: '#ffd60a', transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide })));
  }, [doseVersion, showIso, mode]);

  const btn = 'rounded px-1.5 py-0.5 text-[10px] ring-1 ring-white/10';
  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden rounded-lg bg-[#05070c] ring-1 ring-white/5" data-view="3d">
      {error && <div className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-slate-400">{error}</div>}
      <div className="absolute top-2 left-2 z-10 flex items-center gap-1 text-[11px] text-slate-300">
        <span className="mr-1 font-medium">3D</span>
        <button className={`${btn} ${showBones ? 'bg-slate-200/15' : 'bg-black/40 text-slate-500'}`} onClick={() => setShowBones((v) => !v)}>Bones</button>
        <button className={`${btn} ${showSkin ? 'bg-slate-200/15' : 'bg-black/40 text-slate-500'}`} onClick={() => setShowSkin((v) => !v)}>Skin</button>
        {mode !== 'contour' && <button className={`${btn} ${showIso ? 'bg-slate-200/15' : 'bg-black/40 text-slate-500'}`} onClick={() => setShowIso((v) => !v)}>95% isodose</button>}
        {building && <span className="ml-1 text-slate-500">building…</span>}
      </div>
      {onMaximize && (
        <button className="absolute right-2 bottom-2 z-10 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-black/80" onClick={onMaximize}>
          {maximized ? '4-up' : 'Enlarge'}
        </button>
      )}
    </div>
  );
}
