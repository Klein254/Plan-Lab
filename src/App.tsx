import { useEffect } from 'react';
import { Users, PenTool, Target, BarChart3, Library as LibraryIcon, Save, Loader2, X, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import {
  useStore, loadLibrary, refreshPatients, saveStructureSet, savePlan, undo, redo, cancelCalculation, setDiscardPrompt, toast, type Module,
} from './state/store.ts';
import { cx, DialogHost, confirmDialog } from './ui/common.tsx';
import { BottomDock } from './ui/BottomDock.tsx';
import { PatientsPage } from './ui/pages/PatientsPage.tsx';
import { ContourPage } from './ui/pages/ContourPage.tsx';
import { PlanPage } from './ui/pages/PlanPage.tsx';
import { EvalPage } from './ui/pages/EvalPage.tsx';
import { LibraryPage } from './ui/pages/LibraryPage.tsx';
import { WINDOW_PRESETS } from './ui/render.ts';

const MODULES: { id: Module; label: string; icon: typeof Users; needs?: 'ct' | 'plan' }[] = [
  { id: 'patients', label: 'Patients', icon: Users },
  { id: 'contour', label: 'Anatomical Model', icon: PenTool, needs: 'ct' },
  { id: 'plan', label: 'Planning', icon: Target, needs: 'ct' },
  { id: 'eval', label: 'Evaluation', icon: BarChart3, needs: 'ct' },
  { id: 'library', label: 'Library', icon: LibraryIcon },
];

export async function saveAll() {
  const s = useStore.getState();
  if (s.ss?.dirty) await saveStructureSet();
  if (s.plan?.dirty) await savePlan();
  toast('Saved.', 'success');
}

export function App() {
  const module = useStore((s) => s.module);
  const patient = useStore((s) => s.patient);
  const ct = useStore((s) => s.ct);
  const ss = useStore((s) => s.ss);
  const plan = useStore((s) => s.plan);
  const busy = useStore((s) => s.busy);
  const calc = useStore((s) => s.calc);
  const toasts = useStore((s) => s.toasts);
  const userName = useStore((s) => s.lib.userName);

  useEffect(() => {
    loadLibrary().then(refreshPatients);
    setDiscardPrompt((what) => confirmDialog('Unsaved changes', `Discard unsaved changes to ${what}?`, 'Discard', true));
  }, []);

  // Global shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveAll();
        return;
      }
      if (typing) return;
      // Contour undo/redo only where contours are edited, so it never silently changes a plan's anatomy
      const contouring = useStore.getState().module === 'contour';
      if (contouring && mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (contouring && mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
      if (!mod && !e.altKey) {
        const preset = WINDOW_PRESETS.find((p) => p.key === e.key);
        if (preset && useStore.getState().ct) useStore.setState({ wl: { w: preset.w, l: preset.l } });
      }
    };
    window.addEventListener('keydown', onKey);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      const s = useStore.getState();
      if (s.ss?.dirty || s.plan?.dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  const dirty = !!(ss?.dirty || plan?.dirty);

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="no-print flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-[#0a0f19] px-3">
        <div className="flex items-center gap-2 pr-2">
          <img src="/icon.svg" alt="" className="h-7 w-7" />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight text-slate-100">PlanLab</div>
            <div className="text-[9px] tracking-wider text-slate-500 uppercase">Training TPS</div>
          </div>
        </div>
        <nav className="flex items-center gap-0.5">
          {MODULES.map((m) => {
            const disabled = m.needs === 'ct' && !ct;
            const Icon = m.icon;
            return (
              <button
                key={m.id}
                disabled={disabled}
                onClick={() => useStore.setState({ module: m.id })}
                className={cx(
                  'flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] transition-colors disabled:opacity-30',
                  module === m.id ? 'bg-white/[0.09] text-white' : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200',
                )}
              >
                <Icon size={15} />
                {m.label}
              </button>
            );
          })}
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          {patient && (
            <div className="min-w-0 text-right leading-tight">
              <div className="truncate text-[13px] font-medium text-slate-100">
                {patient.info.name} <span className="font-normal text-slate-500">({patient.info.patientId})</span>
              </div>
              <div className="truncate text-[11px] text-slate-500">
                {ct ? `${ct.meta.name} · ${ct.meta.patientPosition}` : 'No images'}
                {ss && ` · ${ss.meta.name}`}
                {plan && ` · ${plan.meta.name} – ${plan.meta.prescription.totalDose} Gy/${plan.meta.prescription.fractions}# – ${plan.meta.status}`}
              </div>
            </div>
          )}
          {patient && (
            <button
              onClick={() => void saveAll()}
              title="Save contours and plan (Ctrl+S)"
              className={cx(
                'flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium',
                dirty ? 'bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/40 hover:bg-amber-500/30' : 'text-slate-500 ring-1 ring-white/10',
              )}
            >
              <Save size={14} />
              {dirty ? 'Save changes' : 'Saved'}
            </button>
          )}
          <div className="hidden h-8 items-center rounded-md bg-white/[0.04] px-2.5 text-[11px] text-slate-400 lg:flex" title="Planner name (change in Library)">
            {userName}
          </div>
        </div>
      </header>

      {/* Module */}
      <main className="min-h-0 flex-1">
        {module === 'patients' && <PatientsPage />}
        {module === 'contour' && ct && <ContourPage />}
        {module === 'plan' && ct && <PlanPage />}
        {module === 'eval' && ct && <EvalPage />}
        {module === 'library' && <LibraryPage />}
      </main>

      {patient && module !== 'library' && <BottomDock />}

      {/* Busy / calculation overlay */}
      {(busy || calc) && (
        <div className="no-print fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-[#111a2b] px-4 py-3 text-sm text-slate-200 shadow-2xl ring-1 ring-white/10">
          <Loader2 size={16} className="animate-spin text-sky-400" />
          <div className="min-w-56">
            <div>{calc?.label ?? busy?.label}</div>
            {(calc || busy?.progress !== undefined) && (
              <div className="mt-1.5 h-1 overflow-hidden rounded bg-white/10">
                <div className="h-full bg-sky-400 transition-all" style={{ width: `${Math.round(100 * (calc?.progress ?? busy?.progress ?? 0))}%` }} />
              </div>
            )}
          </div>
          {calc && (
            <button onClick={cancelCalculation} className="rounded p-1 text-slate-400 hover:bg-white/10" title="Cancel">
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {/* Toasts */}
      <div className="no-print pointer-events-none fixed top-14 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto flex items-start gap-2 rounded-lg px-3 py-2.5 text-[13px] shadow-xl ring-1',
              t.kind === 'error' && 'bg-rose-950/95 text-rose-100 ring-rose-500/40',
              t.kind === 'success' && 'bg-emerald-950/95 text-emerald-100 ring-emerald-500/30',
              t.kind === 'warn' && 'bg-amber-950/95 text-amber-100 ring-amber-500/30',
              t.kind === 'info' && 'bg-[#121b2c]/95 text-slate-200 ring-white/10',
            )}
          >
            {t.kind === 'success' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : t.kind === 'info' ? <Info size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
      <DialogHost />
    </div>
  );
}
