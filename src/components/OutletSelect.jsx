import { useOutletView } from '@/context/OutletViewContext';

// The app-wide outlet picker, placed on a page so HR can switch e.g. Factory /
// Office right where they are. Only admins have outlets in the context, so it
// renders nothing for everyone else.
export default function OutletSelect({ style }) {
  const { outlets, selectedOutletId, selectOutlet } = useOutletView();
  if (!outlets?.length) return null;
  return (
    <select
      className="form-select"
      style={{ maxWidth: 200, ...style }}
      value={selectedOutletId || ''}
      onChange={(e) => selectOutlet(e.target.value || null)}
      title="Location (Outlet)"
    >
      <option value="">All Outlets (Combined)</option>
      {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}
