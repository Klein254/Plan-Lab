import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Eye } from 'lucide-react';
import { TARGET_TYPES } from '../../core/types.ts';
import { cx } from '../common.tsx';

export interface PickItem {
  id: string;
  name: string;
  color: string;
  type: string;
}

/**
 * Dropdown checklist of structures with quick groups (all / none / targets / organs at risk).
 * `shown` is the set of ticked ids; `onChange` receives the new set.
 */
export function StructurePicker({ items, shown, onChange, label = 'Contours', footer, align = 'left', testId }: {
  items: PickItem[]; shown: Set<string>; onChange: (next: Set<string>) => void; label?: string; footer?: ReactNode; align?: 'left' | 'right'; testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);
  const count = items.filter((x) => shown.has(x.id)).length;
  const isTarget = (t: string) => TARGET_TYPES.includes(t as never);
  const set = (pred: (x: PickItem) => boolean) => onChange(new Set(items.filter(pred).map((x) => x.id)));
  const quick = 'rounded px-1.5 py-0.5 text-[10px] text-slate-300 ring-1 ring-white/10 hover:bg-white/10';
  return (
    <div ref={ref} className="relative" data-testid={testId}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cx('flex h-7 items-center gap-1.5 rounded-md px-2 text-xs ring-1 ring-white/10', open ? 'bg-white/10 text-slate-100' : 'bg-[#0d1320] text-slate-300 hover:bg-white/[0.06]')}
        aria-expanded={open}
      >
        <Eye size={13} className="text-slate-400" />
        {label} <span className="text-slate-500 tabular-nums">{count}/{items.length}</span>
        <ChevronDown size={13} className="text-slate-500" />
      </button>
      {open && (
        <div className={cx('absolute top-8 z-40 w-72 rounded-lg bg-[#0e1422] p-2 shadow-2xl ring-1 ring-white/10', align === 'right' ? 'right-0' : 'left-0')}>
          <div className="mb-1.5 flex flex-wrap gap-1">
            <button className={quick} onClick={() => set(() => true)}>All</button>
            <button className={quick} onClick={() => set(() => false)}>None</button>
            <button className={quick} onClick={() => set((x) => isTarget(x.type))}>Targets</button>
            <button className={quick} onClick={() => set((x) => x.type === 'OAR')}>Organs at risk</button>
            <button className={quick} onClick={() => set((x) => x.type !== 'EXTERNAL' && x.type !== 'SUPPORT')}>All but Body</button>
          </div>
          <ul className="max-h-72 overflow-auto">
            {items.map((x) => (
              <li key={x.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-white/[0.05]">
                  <input
                    type="checkbox"
                    checked={shown.has(x.id)}
                    onChange={() => { const n = new Set(shown); if (n.has(x.id)) n.delete(x.id); else n.add(x.id); onChange(n); }}
                    className="accent-sky-400"
                  />
                  <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: x.color }} />
                  <span className="min-w-0 flex-1 truncate text-slate-200">{x.name}</span>
                  <span className="text-[10px] text-slate-500">{x.type}</span>
                </label>
              </li>
            ))}
            {!items.length && <li className="p-2 text-xs text-slate-500">No contoured structures.</li>}
          </ul>
          {footer && <div className="mt-2 border-t border-white/[0.07] pt-2">{footer}</div>}
        </div>
      )}
    </div>
  );
}
