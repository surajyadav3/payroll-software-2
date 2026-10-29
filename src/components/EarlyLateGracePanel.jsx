import React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { showToast } from '@/components/Toast';
import { fetchEarlyLateGraceDay, setEarlyLateGrace } from '@/services/attendanceService';
import { earlyLateKindLabel } from '@/lib/helpers';

const fmtDay = (ds) => new Date(ds + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const fmtMonth = (ds) => new Date(ds + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long' });

// Raniwala HR: mark a day's late arrival / early left as graced, take the
// grace off, or move the month's one grace here from the day holding it
// (20261028_1). Its own buttons, apart from the modal's Save: the punches
// stay, only the grace changes.
export default function EarlyLateGracePanel({ profileId, date, onChanged }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState('late_arrival');
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    if (!profileId || !date) { setInfo(null); return; }
    setLoading(true);
    const res = await fetchEarlyLateGraceDay(profileId, date);
    setLoading(false);
    // 20261028_1 not on this DB yet: no panel instead of an error on every edit.
    if (res.error && ['PGRST205', '42P01'].includes(res.error.code)) { setMissing(true); return; }
    if (res.error) { showToast('Could not load the grace: ' + res.error.message, 'error'); return; }
    setInfo(res);
    setKind(res.day?.early_late_kind || 'late_arrival');
    setReason('');
  }, [profileId, date]);

  useEffect(() => { load(); }, [load]);

  if (!profileId || !date || missing) return null;

  const run = async (action, move = false) => {
    if (action !== 'auto' && !reason.trim()) return showToast('Reason is required', 'error');
    setBusy(true);
    try {
      const res = await setEarlyLateGrace(info.day.id, action, { kind: action === 'grant' ? kind : null, reason: reason.trim(), move });
      if (action === 'grant') {
        showToast(res?.moved_from ? `Grace moved here from ${fmtDay(res.moved_from)}` : 'Day marked as graced (Present)', 'success');
      } else if (action === 'remove') {
        showToast(res?.grace_on ? `Grace removed. This month's grace now covers ${fmtDay(res.grace_on)}` : `Grace removed. The day is ${res?.status}`, 'success');
      } else {
        showToast('Back to the automatic rule', 'success');
      }
      await load();
      onChanged?.();
    } catch (err) {
      const used = /GRACE_USED:(\d{4}-\d{2}-\d{2})/.exec(err.message || '');
      showToast(used ? `This month's grace is already used on ${fmtDay(used[1])}` : 'Failed: ' + err.message, 'error');
      if (used) load();
    } finally {
      setBusy(false);
    }
  };

  const day = info?.day;
  const hr = info?.hr;
  const holder = info?.holder;
  const handEdited = day && (['Office (Manual)', 'Office (Regularized)'].includes(day.location)
    || (day.punches || []).some((p) => p.source === 'manual'));
  const pending = day && (day.punches || []).some((p) => p.approval_status !== 'approved');
  const hasPunches = day && (day.punches || []).length > 0;
  const canGrant = day && !day.early_late_graced && hasPunches && ['Late', 'Half Day', 'Absent'].includes(day.status);

  const reasonBox = (
    <textarea className="form-input" rows={2} style={{ resize: 'vertical', marginTop: 8 }}
      placeholder="Reason (e.g. 10 min delay, personal reason approved by HOD)"
      value={reason} onChange={(e) => setReason(e.target.value)} />
  );

  let body;
  if (loading || !info) {
    body = <div className="form-hint">Loading…</div>;
  } else if (!day) {
    body = <div className="form-hint">No attendance on this day yet.</div>;
  } else if (handEdited) {
    body = <div className="form-hint">This day was edited by hand, so its status stands and it takes no grace. Change it with the fields above.</div>;
  } else if (pending) {
    body = <div className="form-hint">This day has punches waiting for approval. Approve or reject them first.</div>;
  } else if (day.early_late_graced) {
    body = (
      <>
        <div>
          <span className="badge badge-success">{earlyLateKindLabel(day.early_late_kind)} · Graced</span>
          <span className="form-hint" style={{ marginLeft: 8 }}>
            {hr?.action === 'granted' ? `Marked by HR${hr.reason ? `: ${hr.reason}` : ''}` : 'Given automatically'} · day is {day.status}
          </span>
        </div>
        <div className="form-hint" style={{ marginTop: 6 }}>
          Removing it makes the day go by its hours ({Number(day.total_hours || 0).toFixed(2)} h), and {fmtMonth(date)}'s grace is free again: the next late arrival / early left within the limits takes it, or mark another day here.
        </div>
        {reasonBox}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => run('remove')}><i className="fas fa-xmark" /> Remove grace</button>
          {hr && <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => run('auto')}><i className="fas fa-rotate-left" /> Back to automatic</button>}
        </div>
      </>
    );
  } else if (canGrant) {
    body = (
      <>
        <div className="form-hint">
          Day is <strong>{day.status}</strong>{day.early_late_flag ? ` (${earlyLateKindLabel(day.early_late_kind)}, no grace)` : ''}{hr?.action === 'removed' ? ' · grace removed by HR' : ''}. Marking it graced makes it Present and uses {fmtMonth(date)}'s one grace.
        </div>
        {holder && (
          <div className="form-hint" style={{ color: 'var(--warning)', marginTop: 6 }}>
            <i className="fas fa-triangle-exclamation" /> {fmtMonth(date)}'s grace is already used on {fmtDay(holder.date)} ({earlyLateKindLabel(holder.early_late_kind)}). Moving it here makes {fmtDay(holder.date)} go by its hours.
          </div>
        )}
        <select className="form-select" style={{ marginTop: 8 }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="late_arrival">Late Arrival</option>
          <option value="early_left">Early Left</option>
          <option value="both">Late Arrival + Early Left</option>
        </select>
        {reasonBox}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run('grant', !!holder)}>
            <i className="fas fa-check" /> {holder ? `Move grace here from ${fmtDay(holder.date)}` : 'Mark as graced'}
          </button>
          {hr && <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => run('auto')}><i className="fas fa-rotate-left" /> Back to automatic</button>}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="form-hint">Day is {day.status}: {hasPunches ? 'no grace needed.' : 'no punches to grace.'}</div>
        {hr && <button className="btn btn-outline btn-sm" style={{ marginTop: 8 }} disabled={busy} onClick={() => run('auto')}><i className="fas fa-rotate-left" /> Back to automatic</button>}
      </>
    );
  }

  return (
    <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
      <label className="form-label">Late arrival / early left grace</label>
      <div className="form-hint" style={{ marginBottom: 6 }}>Separate from Save: the punches stay, only the grace changes.</div>
      {body}
    </div>
  );
}
