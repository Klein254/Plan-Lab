import { useEffect, useState } from 'react';
import {
  MousePointer2, Circle, PenLine, Spline, Eraser, Wand2, Ruler, ArrowUpToLine, ArrowDownToLine, Square, PaintBucket, Waves, Sparkles,
  ScanSearch, ChevronsUp, ChevronsDown, Expand, Combine, Cpu, Undo2, Redo2, FileOutput, Layers3,
} from 'lucide-react';
import { useStore, editMask, toast, withBusy, undo, redo, type ToolName } from '../../state/store.ts';
import { ToolButton, ToolGroup, NumberField, Toggle, Select } from '../common.tsx';
import { SliceView } from '../views/SliceView.tsx';
import { View3D } from '../views/View3D.tsx';
import { ViewGrid } from '../views/ViewGrid.tsx';
import { StructurePanel } from '../panels/StructurePanel.tsx';
import { MarginDialog, BooleanDialog, AutoSegDialog, copySlice } from '../panels/ContourDialogs.tsx';
import { fillHoles, smoothMask, interpolateSlices, adaptSlice, propagate } from '../../core/maskOps.ts';
import { exportRtStruct } from '../../core/dicom/export.ts';
import { saveBytes, safeName } from '../files.ts';
import { WINDOW_PRESETS } from '../render.ts';

const TOOL_KEYS: Record<string, ToolName> = { n: 'navigate', b: 'pearl', p: 'pen', g: 'polygon', e: 'eraser', w: 'wand', m: 'measure' };

function selected() {
  const s = useStore.getState();
  const id = s.selectedStructureId;
  const m = id ? s.ss?.masks.get(id) : null;
  if (!id || !m) {
    toast('Select a structure first.', 'warn');
    return null;
  }
  return { id, m, k: Math.round(s.cursor[2]) };
}

export function ContourPage() {
  const tool = useStore((s) => s.tool);
  const ts = useStore((s) => s.toolSettings);
  const wl = useStore((s) => s.wl);
  const structFill = useStore((s) => s.structFill);
  const undoN = useStore((s) => s.undo.length);
  const redoN = useStore((s) => s.redo.length);
  const [dialog, setDialog] = useState<'margin' | 'boolean' | 'auto' | null>(null);
  const [propN, setPropN] = useState(10);
  const setTool = (t: ToolName) => useStore.setState({ tool: t });
  const setTs = (p: Partial<typeof ts>) => useStore.setState((s) => ({ toolSettings: { ...s.toolSettings, ...p } }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const tk = TOOL_KEYS[e.key.toLowerCase()];
      if (tk) setTool(tk);
      // Pearl size: ← / → (Shift for 5 mm steps), or [ ]
      const st = useStore.getState();
      const sizeStep = e.key === '[' || e.key === 'ArrowLeft' ? -1 : e.key === ']' || e.key === 'ArrowRight' ? 1 : 0;
      if (sizeStep && (st.tool === 'pearl' || st.tool === 'eraser' || e.key === '[' || e.key === ']')) {
        e.preventDefault();
        const r = st.toolSettings.pearlRadius + sizeStep * (e.shiftKey ? 5 : 1);
        setTs({ pearlRadius: Math.min(40, Math.max(1, Math.round(r))) });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearSlice = () => {
    const s = selected();
    if (s) editMask(s.id, [s.k], 'Clear slice', (m) => { m.slices[s.k] = null; });
  };
  const holes = () => {
    const s = selected();
    if (s) editMask(s.id, null, 'Fill holes', (m) => fillHoles(m));
  };
  const smooth = () => {
    const s = selected();
    if (s) editMask(s.id, null, 'Smooth', (m) => smoothMask(m, 1, 2));
  };
  const interpolate = () => {
    const s = selected();
    if (!s) return;
    const ct = useStore.getState().ct!;
    let filled: number[] = [];
    editMask(s.id, null, 'Interpolate', (m) => { filled = interpolateSlices(m, ct.meta.spacing); });
    toast(filled.length ? `Interpolated ${filled.length} slice${filled.length > 1 ? 's' : ''} between your contours.` : 'No gaps to fill: draw contours on two or more slices with empty slices between them.', filled.length ? 'success' : 'warn');
  };
  const adapt = (all: boolean) => {
    const s = selected();
    if (!s) return;
    const ct = useStore.getState().ct!;
    void withBusy(all ? 'Adapting all slices…' : 'Adapting contour…', async () => {
      let changed = 0;
      editMask(s.id, all ? null : [s.k], all ? 'Adapt all slices' : 'Adapt slice', (m) => {
        const ks = all ? [...Array(m.nz).keys()].filter((k) => m.hasSlice(k)) : [s.k];
        for (const k of ks) if (adaptSlice(ct.volume, m, k, 5, 2.2)) changed++;
      });
      toast(changed ? `Adapted ${changed} slice${changed > 1 ? 's' : ''} to the image edges.` : 'Contour already follows the edges.', changed ? 'success' : 'info');
    });
  };
  const prop = (dir: 1 | -1) => {
    const s = selected();
    if (!s) return;
    const ct = useStore.getState().ct!;
    if (!s.m.hasSlice(s.k)) {
      toast('Draw the structure on this slice first, then propagate.', 'warn');
      return;
    }
    let written: number[] = [];
    const range = [...Array(propN + 1).keys()].map((n) => s.k + dir * n).filter((k) => k >= 0 && k < s.m.nz);
    editMask(s.id, range, `Propagate ${dir > 0 ? 'up' : 'down'}`, (m) => { written = propagate(ct.volume, m, s.k, dir, propN, 5); });
    toast(written.length ? `Propagated to ${written.length} slice${written.length > 1 ? 's' : ''} ${dir > 0 ? 'superiorly' : 'inferiorly'} (stopped where the organ ends).` : 'Could not propagate: the organ seems to end here.', written.length ? 'success' : 'warn');
  };
  const exportRs = async () => {
    const s = useStore.getState();
    if (!s.ss || !s.patient || !s.ct) return;
    const bytes = exportRtStruct(s.patient.info, s.ct.meta, s.ss.meta.name, s.ss.meta.structures.filter((x) => !s.ss!.masks.get(x.id)!.isEmpty()).map((meta) => ({ meta, mask: s.ss!.masks.get(meta.id)! })));
    if (await saveBytes(`RS_${safeName(s.patient.info.name)}_${safeName(s.ss.meta.name)}.dcm`, bytes, { name: 'DICOM', extensions: ['dcm'] })) toast('RT Structure Set exported.', 'success');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="no-print flex shrink-0 items-stretch overflow-x-auto border-b border-white/[0.06] bg-[#0a0f19] px-1 py-1">
        <ToolGroup title="View">
          <ToolButton icon={<MousePointer2 size={18} />} label="Navigate" active={tool === 'navigate'} onClick={() => setTool('navigate')} title="Navigate (N): click/drag sets the crosshair · right-drag window/level · shift-drag pan · ctrl+wheel zoom" />
          <ToolButton icon={<Ruler size={18} />} label="Measure" active={tool === 'measure'} onClick={() => setTool('measure')} title="Measure distance (M)" />
        </ToolGroup>
        <ToolGroup title="Draw">
          <ToolButton icon={<Circle size={18} />} label="Pearl" active={tool === 'pearl'} onClick={() => setTool('pearl')} title="Pearl / ball brush (B). Start inside the structure to push it out, outside to push it in. ← → change the size (Shift: 5 mm steps)." />
          <ToolButton icon={<PenLine size={18} />} label="Pen" active={tool === 'pen'} onClick={() => setTool('pen')} title="Freehand pen (P): draw a closed outline; it's filled when you release. Alt erases. Draw again elsewhere on the slice for a separate part." />
          <ToolButton icon={<Spline size={18} />} label="Polygon" active={tool === 'polygon'} onClick={() => setTool('polygon')} title="Polygon (G): click points, double-click / Enter / click the first point to close" />
          <ToolButton icon={<Eraser size={18} />} label="Eraser" active={tool === 'eraser'} onClick={() => setTool('eraser')} title="Eraser (E). ← → change the size." />
          <ToolButton icon={<Wand2 size={18} />} label="Wand" active={tool === 'wand'} onClick={() => setTool('wand')} title="Magic wand (W): grows a region of similar HU from where you click" />
        </ToolGroup>
        <ToolGroup title="Slice">
          <ToolButton icon={<ArrowUpToLine size={18} />} label="Copy ↑" onClick={() => copySlice(1)} title="Copy this slice's contour to the next slice up" />
          <ToolButton icon={<ArrowDownToLine size={18} />} label="Copy ↓" onClick={() => copySlice(-1)} title="Copy to the next slice down" />
          <ToolButton icon={<Square size={18} />} label="Clear" onClick={clearSlice} title="Clear this structure on the current slice" />
          <ToolButton icon={<PaintBucket size={18} />} label="Fill holes" onClick={holes} />
          <ToolButton icon={<Waves size={18} />} label="Smooth" onClick={smooth} />
        </ToolGroup>
        <ToolGroup title="Smart (AI)">
          <ToolButton icon={<Layers3 size={18} />} label="Interpolate" onClick={interpolate} title="Fill empty slices between drawn slices (shape-based interpolation)" accent="text-violet-300" />
          <ToolButton icon={<Sparkles size={18} />} label="Adapt" onClick={() => adapt(false)} title="Snap the contour on this slice to the organ edges" accent="text-violet-300" />
          <ToolButton icon={<ScanSearch size={18} />} label="Adapt all" onClick={() => adapt(true)} title="Snap every slice of the structure to the edges" accent="text-violet-300" />
          <ToolButton icon={<ChevronsUp size={18} />} label="Propagate ↑" onClick={() => prop(1)} title="Auto-contour following slices superiorly (copy + adapt until the organ ends)" accent="text-violet-300" />
          <ToolButton icon={<ChevronsDown size={18} />} label="Propagate ↓" onClick={() => prop(-1)} title="Auto-contour inferiorly" accent="text-violet-300" />
        </ToolGroup>
        <ToolGroup title="Volumes">
          <ToolButton icon={<Expand size={18} />} label="Margin" onClick={() => setDialog('margin')} title="Expand / contract (GTV→CTV→PTV)" />
          <ToolButton icon={<Combine size={18} />} label="Boolean" onClick={() => setDialog('boolean')} title="Union, intersection, subtraction" />
          <ToolButton icon={<Cpu size={18} />} label="Auto-seg" onClick={() => setDialog('auto')} title="Automatic Body, lungs, bones, thresholds" />
        </ToolGroup>
        <ToolGroup title="Edit">
          <ToolButton icon={<Undo2 size={18} />} label="Undo" disabled={!undoN} onClick={undo} title="Undo (Ctrl+Z)" />
          <ToolButton icon={<Redo2 size={18} />} label="Redo" disabled={!redoN} onClick={redo} title="Redo (Ctrl+Y)" />
          <ToolButton icon={<FileOutput size={18} />} label="RTSTRUCT" onClick={exportRs} title="Export contours as DICOM RT Structure Set (opens in 3D Slicer etc.)" />
        </ToolGroup>
      </div>
      {/* Tool options */}
      <div className="no-print flex h-9 shrink-0 items-center gap-4 border-b border-white/[0.06] bg-[#0b1019] px-3 text-xs">
        <Select
          label="Window"
          value={WINDOW_PRESETS.find((p) => p.w === wl.w && p.l === wl.l)?.name ?? 'Custom'}
          onChange={(name) => { const p = WINDOW_PRESETS.find((x) => x.name === name); if (p) useStore.setState({ wl: { w: p.w, l: p.l } }); }}
          options={[...WINDOW_PRESETS.map((p) => ({ value: p.name, label: `${p.name} (${p.key})` })), { value: 'Custom', label: `Custom W${wl.w} L${wl.l}` }]}
          className="w-52"
        />
        {(tool === 'pearl' || tool === 'eraser') && (
          <>
            <label className="flex items-center gap-2 text-slate-400">
              Radius
              <input type="range" min={1} max={40} step={0.5} value={ts.pearlRadius} onChange={(e) => setTs({ pearlRadius: +e.target.value })} className="w-28 accent-sky-400" />
              <span className="w-12 text-slate-200 tabular-nums">{ts.pearlRadius} mm</span>
              <span className="text-[10px] text-slate-500">← →</span>
            </label>
            {tool === 'pearl' && (
              <Select<'auto' | 'add' | 'erase'> label="Mode" value={ts.pearlMode} onChange={(v) => setTs({ pearlMode: v })} options={[{ value: 'auto', label: 'Auto (push in/out)' }, { value: 'add', label: 'Add' }, { value: 'erase', label: 'Erase' }]} className="w-48" />
            )}
            <Toggle checked={ts.pearl3D} onChange={(v) => setTs({ pearl3D: v })} label="3D ball (neighbouring slices too)" />
          </>
        )}
        {(tool === 'pen' || tool === 'polygon') && (
          <Select<'add' | 'erase'> label="Mode" value={ts.penMode} onChange={(v) => setTs({ penMode: v })} options={[{ value: 'add', label: 'Add (new part or extend)' }, { value: 'erase', label: 'Cut out' }]} className="w-56" />
        )}
        {tool === 'wand' && (
          <>
            <NumberField label="Tolerance ±" unit="HU" value={ts.wandTolerance} onChange={(v) => setTs({ wandTolerance: v })} min={5} max={1000} width="w-24" />
            <NumberField label="Max radius" unit="mm" value={ts.wandRadius} onChange={(v) => setTs({ wandRadius: v })} min={5} max={300} width="w-24" />
            <Toggle checked={ts.wand3D} onChange={(v) => setTs({ wand3D: v })} label="3D" />
          </>
        )}
        <label className="ml-auto flex items-center gap-2 text-slate-500" title="Light colour fill inside each contour (0 = outlines only)">
          Fill
          <input type="range" min={0} max={0.6} step={0.05} value={structFill} onChange={(e) => useStore.setState({ structFill: +e.target.value })} className="w-20 accent-sky-400" />
          <span className="w-8 text-slate-300 tabular-nums">{Math.round(structFill * 100)}%</span>
        </label>
        <span className="flex items-center gap-2 text-slate-500">
          Propagate
          <NumberField value={propN} onChange={setPropN} min={1} max={100} width="w-14" />
          slices
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_340px] gap-2 p-2">
        <ViewGrid
          items={[
            { id: 'axial', render: (m, x) => <SliceView plane="axial" mode="contour" onMaximize={m} maximized={x} /> },
            { id: 'sagittal', render: (m, x) => <SliceView plane="sagittal" mode="contour" onMaximize={m} maximized={x} /> },
            { id: 'coronal', render: (m, x) => <SliceView plane="coronal" mode="contour" onMaximize={m} maximized={x} /> },
            { id: '3d', render: (m, x) => <View3D mode="contour" onMaximize={m} maximized={x} /> },
          ]}
        />
        <div className="min-h-0 overflow-hidden">
          <StructurePanel />
        </div>
      </div>
      {dialog === 'margin' && <MarginDialog onClose={() => setDialog(null)} />}
      {dialog === 'boolean' && <BooleanDialog onClose={() => setDialog(null)} />}
      {dialog === 'auto' && <AutoSegDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
