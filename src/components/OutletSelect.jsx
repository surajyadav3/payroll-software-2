import { useEffect, useRef, useState } from 'react';
import { useOutletView } from '@/context/OutletViewContext';

// The Requests pages' outlet picker: tick any mix of outlets (e.g. Factory +
// Office) and the page lists just their requests; at least one stays ticked.
// Shared by every Requests page (useRequestOutletScope), separate from the
// app-wide outlet. Only admins have outlets in the context, so it renders
// nothing for everyone else.
export default function OutletSelect({ style }) {
  const { outlets, requestOutletIds, selectRequestOutlets } = useOutletView();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!outlets?.length || !requestOutletIds) return null;

  const toggle = (id) => {
    const next = new Set(requestOutletIds);
    if (next.has(id)) {
      if (next.size === 1) return;
      next.delete(id);
    } else {
      next.add(id);
    }
    selectRequestOutlets(next);
  };
  const label = outlets.filter((o) => requestOutletIds.has(o.id)).map((o) => o.name).join(' + ') || 'Outlets';

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      <button
        type="button"
        className="form-select"
        style={{ minWidth: 180, maxWidth: 280, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        onClick={() => setOpen((o) => !o)}
        title={label}
      >
        {label}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30, minWidth: 220,
          border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px',
          background: 'var(--surface)', boxShadow: '0 6px 18px rgba(0,0,0,0.12)', fontSize: 13,
        }}>
          {outlets.map((o) => (
            <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={requestOutletIds.has(o.id)} onChange={() => toggle(o.id)} />
              {o.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
