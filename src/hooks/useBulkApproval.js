import { useState } from 'react';
import { showToast } from '@/components/Toast';

/**
 * Row selection + "approve / reject selected" for the request-approval tables.
 * Pair with BulkApproveBar / BulkHeadCell / BulkRowCell.
 *
 * Decisions go through the same service call as the per-row buttons, one
 * after another (several of them read-then-write balances and counters, so
 * running them in parallel would race), and the list reloads once at the end.
 *
 * @param {object}   opts
 * @param {Array}    opts.rows        - Rows currently shown in the table
 * @param {Function} opts.canAct      - (row) => may the current user decide this row
 * @param {Function} [opts.decide]    - (row, approve) => Promise<{ error }>
 * @param {Function} [opts.decideMany]- (rows, approve) => Promise<{ error }>, when one call covers them all
 * @param {Function} opts.onDone      - Reload the list
 * @param {Function} [opts.getId]     - Row key (default row.id)
 * @param {string}   [opts.noun]      - Singular label for toasts/confirm (default 'request')
 * @param {Function} [opts.confirmNote] - (rows, approve) => extra line for the confirm dialog
 * @param {boolean}  [opts.loading]   - Hide selection while the list is loading
 */
export function useBulkApproval({
  rows, canAct, decide, decideMany, onDone,
  getId = (r) => r.id, noun = 'request', confirmNote, loading = false,
}) {
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const selectable = loading ? [] : rows.filter(canAct);
  // Derived from the rows on screen, so anything filtered out or already
  // reviewed by someone else simply drops out of the selection.
  const selectedRows = selectable.filter((r) => picked.has(getId(r)));
  const allSelected = selectable.length > 0 && selectedRows.length === selectable.length;

  const toggle = (row) => setPicked((prev) => {
    const next = new Set(prev);
    const id = getId(row);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleAll = () => setPicked(allSelected ? new Set() : new Set(selectable.map(getId)));

  const run = async (approve) => {
    const n = selectedRows.length;
    if (busy || n === 0) return;
    const label = `${n} ${noun}${n === 1 ? '' : 's'}`;
    const note = confirmNote?.(selectedRows, approve);
    if (!window.confirm(`${approve ? 'Approve' : 'Reject'} ${label}?${note ? `\n\n${note}` : ''}`)) return;

    setBusy(true);
    let failed = 0;
    let firstError = '';
    const fail = (err, count = 1) => { failed += count; firstError = firstError || err?.message || 'Unknown error'; };
    try {
      if (decideMany) {
        try {
          const { error } = (await decideMany(selectedRows, approve)) || {};
          if (error) fail(error, n);
        } catch (err) { fail(err, n); }
      } else {
        for (const row of selectedRows) {
          try {
            const { error } = (await decide(row, approve)) || {};
            if (error) fail(error);
          } catch (err) { fail(err); }
        }
      }
    } finally {
      setBusy(false);
      setPicked(new Set());
    }

    const done = approve ? 'approved' : 'rejected';
    if (failed === 0) showToast(`${label} ${done}`, approve ? 'success' : 'info');
    else showToast(`${n - failed} ${done}, ${failed} failed: ${firstError}`, 'error');
    onDone();
  };

  return {
    active: selectable.length > 0,
    total: selectable.length,
    count: selectedRows.length,
    allSelected,
    busy,
    canSelect: (row) => !loading && canAct(row),
    isSelected: (row) => picked.has(getId(row)),
    toggle,
    toggleAll,
    run,
  };
}
