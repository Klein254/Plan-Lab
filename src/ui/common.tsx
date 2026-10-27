import { useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { X } from 'lucide-react';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'subtle'; size?: 'sm' | 'md' };
export function Button({ variant = 'subtle', size = 'md', className, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
        variant === 'primary' && 'bg-sky-500 text-white hover:bg-sky-400',
        variant === 'subtle' && 'bg-white/[0.06] text-slate-200 ring-1 ring-white/10 hover:bg-white/[0.11]',
        variant === 'ghost' && 'text-slate-300 hover:bg-white/[0.07]',
        variant === 'danger' && 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/30 hover:bg-rose-500/25',
        className,
      )}
    />
  );
}

/** Square toolbar button with icon and small caption, Plan W-style. */
export function ToolButton({ icon, label, active, onClick, title, disabled, accent }: {
  icon: ReactNode; label: string; active?: boolean; onClick?: () => void; title?: string; disabled?: boolean; accent?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={cx(
        'group flex h-[52px] w-[60px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg text-[10px] leading-none transition-colors disabled:opacity-35',
        active ? 'bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/50' : 'text-slate-300 hover:bg-white/[0.07]',
      )}
    >
      <span className={cx('grid h-6 w-6 place-items-center', accent)}>{icon}</span>
      <span className="max-w-full truncate px-0.5">{label}</span>
    </button>
  );
}

export function ToolGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-col border-r border-white/[0.06] px-1.5 last:border-r-0">
      <div className="flex items-center gap-0.5">{children}</div>
      <div className="mt-0.5 text-center text-[9px] tracking-wider text-slate-500 uppercase">{title}</div>
    </div>
  );
}

export function NumberField({ label, value, onChange, step = 1, min, max, unit, width = 'w-20', disabled, digits }: {
  label?: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; unit?: string; width?: string; disabled?: boolean; digits?: number;
}) {
  const [text, setText] = useState(fmt(value, digits));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(value, digits));
  }, [value, digits]);
  const commit = () => {
    const v = parseFloat(text);
    if (isNaN(v)) {
      setText(fmt(value, digits));
      return;
    }
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
    onChange(c);
    setText(fmt(c, digits));
  };
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-400">
      {label && <span className="shrink-0">{label}</span>}
      <span className="relative">
        <input
          type="text"
          inputMode="decimal"
          disabled={disabled}
          value={text}
          onFocus={() => (focused.current = true)}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const v = (parseFloat(text) || 0) + (e.key === 'ArrowUp' ? step : -step);
              const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, +v.toFixed(6)));
              setText(fmt(c, digits));
              onChange(c);
            }
          }}
          className={cx('h-7 rounded-md bg-black/40 px-2 text-right text-xs text-slate-100 tabular-nums ring-1 ring-white/10 outline-none focus:ring-sky-400/60 disabled:opacity-50', width, unit && 'pr-7')}
        />
        {unit && <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] text-slate-500">{unit}</span>}
      </span>
    </label>
  );
}

function fmt(v: number, digits?: number) {
  if (!isFinite(v)) return '';
  return digits !== undefined ? v.toFixed(digits) : String(Math.round(v * 1000) / 1000);
}

export function TextField({ label, value, onChange, placeholder, className, autoFocus }: {
  label?: string; value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean;
}) {
  return (
    <label className={cx('flex flex-col gap-1 text-xs text-slate-400', className)}>
      {label}
      <input
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md bg-black/40 px-3 text-sm text-slate-100 ring-1 ring-white/10 outline-none placeholder:text-slate-600 focus:ring-sky-400/60"
      />
    </label>
  );
}

export function Select<T extends string>({ label, value, onChange, options, className }: {
  label?: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string;
}) {
  return (
    <label className={cx('flex items-center gap-1.5 text-xs text-slate-400', className)}>
      {label && <span className="shrink-0">{label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-7 min-w-0 flex-1 rounded-md bg-[#0d1320] px-2 text-xs text-slate-100 ring-1 ring-white/10 outline-none focus:ring-sky-400/60"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300 select-none">
      <span
        onClick={(e) => {
          e.preventDefault();
          onChange(!checked);
        }}
        className={cx('relative h-4 w-7 rounded-full transition-colors', checked ? 'bg-sky-500' : 'bg-white/15')}
      >
        <span className={cx('absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all', checked ? 'left-3.5' : 'left-0.5')} />
      </span>
      {label && <span onClick={() => onChange(!checked)}>{label}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, footer, width = 'max-w-lg' }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: string;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('flex max-h-[90vh] w-full flex-col overflow-hidden rounded-xl bg-[#0e1422] shadow-2xl ring-1 ring-white/10', width)}>
        <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-white/[0.07] px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('flex min-h-0 flex-col rounded-xl bg-[#0c111c] ring-1 ring-white/[0.06]', className)}>
      {(title || actions) && (
        <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3">
          <h3 className="truncate text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{title}</h3>
          <div className="flex items-center gap-1">{actions}</div>
        </header>
      )}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

export function IconBtn({ children, title, onClick, active, disabled, danger }: {
  children: ReactNode; title: string; onClick?: () => void; active?: boolean; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'grid h-7 w-7 place-items-center rounded-md transition-colors disabled:opacity-30',
        active ? 'bg-sky-500/20 text-sky-200' : danger ? 'text-rose-300 hover:bg-rose-500/15' : 'text-slate-400 hover:bg-white/10 hover:text-slate-100',
      )}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'green' | 'amber' | 'rose' | 'sky' }) {
  const tones = {
    slate: 'bg-white/[0.07] text-slate-300',
    green: 'bg-emerald-500/15 text-emerald-300',
    amber: 'bg-amber-500/15 text-amber-300',
    rose: 'bg-rose-500/15 text-rose-300',
    sky: 'bg-sky-500/15 text-sky-300',
  };
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium', tones[tone])}>{children}</span>;
}

/** Promise-based confirm / prompt dialogs rendered by <DialogHost/>. */
type DialogReq =
  | { kind: 'confirm'; title: string; text: string; ok: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; text: string; value: string; ok: string; resolve: (v: string | null) => void };
let pushDialog: ((d: DialogReq) => void) | null = null;

export function confirmDialog(title: string, text: string, ok = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => (pushDialog ? pushDialog({ kind: 'confirm', title, text, ok, danger, resolve }) : resolve(window.confirm(text))));
}
export function promptDialog(title: string, text: string, value: string, ok = 'OK'): Promise<string | null> {
  return new Promise((resolve) => (pushDialog ? pushDialog({ kind: 'prompt', title, text, value, ok, resolve }) : resolve(window.prompt(text, value))));
}

export function DialogHost() {
  const [d, setD] = useState<DialogReq | null>(null);
  const [val, setVal] = useState('');
  useEffect(() => {
    pushDialog = (req) => {
      setD(req);
      if (req.kind === 'prompt') setVal(req.value);
    };
    return () => {
      pushDialog = null;
    };
  }, []);
  if (!d) return null;
  const close = (ok: boolean) => {
    if (d.kind === 'confirm') d.resolve(ok);
    else d.resolve(ok ? val.trim() || null : null);
    setD(null);
  };
  return (
    <Modal
      title={d.title}
      onClose={() => close(false)}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
          <Button variant={d.kind === 'confirm' && d.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{d.ok}</Button>
        </>
      }
    >
      <p className="text-sm text-slate-300">{d.text}</p>
      {d.kind === 'prompt' && (
        <input
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && close(true)}
          className="mt-3 h-9 w-full rounded-md bg-black/40 px-3 text-sm text-slate-100 ring-1 ring-white/10 outline-none focus:ring-sky-400/60"
        />
      )}
    </Modal>
  );
}
