import React from 'react';

// Select-all checkbox, shown half-ticked while only some rows are picked.
function SelectAllBox({ bulk }) {
  return (
    <input
      type="checkbox"
      title="Select all"
      checked={bulk.allSelected}
      disabled={bulk.busy}
      ref={(el) => { if (el) el.indeterminate = bulk.count > 0 && !bulk.allSelected; }}
      onChange={bulk.toggleAll}
    />
  );
}

/** Leading <th> for a table driven by useBulkApproval. Renders nothing when no row can be acted on. */
export function BulkHeadCell({ bulk }) {
  if (!bulk.active) return null;
  return <th style={{ width: 36 }}><SelectAllBox bulk={bulk} /></th>;
}

/** Leading <td> for a row — a checkbox only on rows the current user may decide. */
export function BulkRowCell({ bulk, row }) {
  if (!bulk.active) return null;
  return (
    <td style={{ width: 36 }}>
      {bulk.canSelect(row) && (
        <input type="checkbox" checked={bulk.isSelected(row)} disabled={bulk.busy} onChange={() => bulk.toggle(row)} />
      )}
    </td>
  );
}

/**
 * "Select all (N)" strip that sits above a requests table, with Approve /
 * Reject for whatever is ticked. Hidden when nothing on screen needs the
 * current user's decision.
 */
export default function BulkApproveBar({ bulk }) {
  if (!bulk.active) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: '10px 16px', fontSize: 13,
      borderBottom: '1px solid var(--border-light)',
      background: bulk.count > 0 ? 'var(--primary-light)' : 'transparent',
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
        <SelectAllBox bulk={bulk} />
        Select all ({bulk.total})
      </label>
      {bulk.count > 0 && (
        <>
          <span style={{ color: 'var(--text-secondary)' }}>{bulk.count} selected</span>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button className="btn btn-sm btn-success" disabled={bulk.busy} onClick={() => bulk.run(true)}>
              {bulk.busy
                ? <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                : <i className="fas fa-check" />}
              {' '}Approve selected
            </button>
            <button className="btn btn-sm btn-danger" disabled={bulk.busy} onClick={() => bulk.run(false)}>
              <i className="fas fa-times" /> Reject selected
            </button>
          </div>
        </>
      )}
    </div>
  );
}
