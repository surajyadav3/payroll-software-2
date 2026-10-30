import { X } from 'lucide-react';
import { useState } from 'react';
import { useDismiss } from '@/crew/lib/use-dismiss';
import { useColleagues } from '@/crew/lib/work';
import { Avatar, cx, Input } from '../ui';
/** Choose one or more colleagues (directory search). */
export function PeoplePicker({ value, onChange, placeholder = 'Add people…', max = 50, exclude = [] }) {
    const [q, setQ] = useState('');
    const [open, setOpen] = useState(false);
    const list = useColleagues(q);
    const taken = new Set([...value.map((v) => v.id), ...exclude]);
    const rows = (list.data ?? []).filter((c) => !taken.has(c.id));
    // Listens only while the list is on screen (so Escape still closes the drawer behind an empty picker).
    const ref = useDismiss(open && rows.length > 0, () => setOpen(false));
    return (<div ref={ref} className="relative">
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface px-2 py-1.5 focus-within:border-brand focus-within:ring-2 focus-within:ring-focus-ring/30">
        {value.map((p) => (<span key={p.id} className="flex items-center gap-1 rounded-full bg-brand-surface py-0.5 pl-0.5 pr-1.5 text-xs text-brand-text">
            <Avatar name={p.name} size="sm"/>
            {p.name}
            <button type="button" onClick={() => onChange(value.filter((x) => x.id !== p.id))} className="rounded-full p-0.5 hover:bg-iris-100" aria-label={`Remove ${p.name}`}><X className="size-3"/></button>
          </span>))}
        {value.length < max && (<Input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder={value.length ? '' : placeholder} className="h-7 min-w-32 flex-1 border-0 px-1 shadow-none focus:ring-0"/>)}
      </div>
      {open && rows.length > 0 && (<div className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-3 scroll-quiet">
          {rows.map((c) => (<button type="button" key={c.id} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange([...value, { id: c.id, name: c.fullName }]); setQ(''); if (value.length + 1 >= max)
                setOpen(false); }} className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-bg-subtle')}>
              <Avatar name={c.fullName} size="sm"/>
              <span className="min-w-0 flex-1"><span className="block truncate text-fg">{c.fullName}</span><span className="block truncate text-xs text-fg-muted">{[c.designation?.name, c.department?.name].filter(Boolean).join(' · ')}</span></span>
            </button>))}
        </div>)}
    </div>);
}
