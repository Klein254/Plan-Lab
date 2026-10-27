import { useState, type ReactNode } from 'react';
import { cx } from '../common.tsx';

export interface GridItem {
  id: string;
  render: (onMaximize: () => void, maximized: boolean) => ReactNode;
}

/** 2×2 view layout; any view can be enlarged to fill the area and restored. */
export function ViewGrid({ items, main }: { items: GridItem[]; main?: 'left' }) {
  const [max, setMax] = useState<string | null>(null);
  if (max) {
    const it = items.find((i) => i.id === max);
    if (it) return <div className="h-full min-h-0 p-0">{it.render(() => setMax(null), true)}</div>;
  }
  return (
    <div className={cx('grid h-full min-h-0 gap-1.5', main === 'left' ? 'grid-cols-[1.6fr_1fr] grid-rows-3' : 'grid-cols-2 grid-rows-2')}>
      {items.map((it, n) => (
        <div key={it.id} className={cx('min-h-0 min-w-0', main === 'left' && n === 0 && 'row-span-3')}>
          {it.render(() => setMax(it.id), false)}
        </div>
      ))}
    </div>
  );
}
