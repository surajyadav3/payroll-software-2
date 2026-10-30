import React, { useState } from 'react';
import { fmt } from '@/lib/helpers';

const COMP_OFF = 'Comp Off';
const ROWS_SHOWN = 8;

const fmtDays = (n) => {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
};
const dayWord = (n) => `day${Number(n) === 1 ? '' : 's'}`;

function requestDays(req) {
  return Math.ceil(Math.abs(new Date(req.end_date) - new Date(req.start_date)) / (1000 * 60 * 60 * 24)) + 1;
}
const requestDates = (req) => (req.start_date === req.end_date
  ? fmt.date(req.start_date)
  : `${fmt.date(req.start_date)} – ${fmt.date(req.end_date)}`);

// HR records a leave that was never applied for in the app as a negative
// Allocation whose note starts "Leave taken" (see LeaveBalancesPage).
const isLeaveTaken = (e) => e.entry_type === 'Deduction' || (e.entry_type === 'Allocation' && Number(e.days) < 0 && /^leave taken/i.test(e.note || ''));

function entryLabel(e) {
  if (isLeaveTaken(e)) return 'Leave taken';
  if (e.entry_type === 'Accrual') return 'Leave credited';
  // HR gave back a leave day they came in on (20261024_6).
  if (e.entry_type === 'Allocation' && /^leave given back/i.test(e.note || '')) return 'Leave given back';
  if (e.entry_type === 'Allocation') return Number(e.days) >= 0 ? 'Added by HR' : 'Adjusted by HR';
  if (e.entry_type === 'Carry Forward') return 'Carried forward';
  if (e.entry_type === 'Encashment') return 'Encashed';
  if (e.entry_type === 'Expiry') return 'Lapsed';
  return e.entry_type;
}

/**
 * The statement behind one leave type: every credit and every leave taken, each
 * with the balance it left, then what the balance becomes once the requests
 * still awaiting approval go through. Types with no ledger (unlimited ones and
 * Comp Off, which is a plain counter) list the approved requests instead.
 */
function buildStatement(type, ledger, requests) {
  const reqById = new Map(requests.map((r) => [r.id, r]));
  const mine = requests.filter((r) => r.leave_type === type.name);
  const s = { credited: 0, taken: 0, adjusted: 0, balance: 0, pending: 0, rows: [] };

  if (type.hasLedger) {
    ledger.filter((e) => e.leave_type_id === type.id).forEach((e) => {
      const days = Number(e.days) || 0;
      const req = reqById.get(e.leave_request_id);
      s.balance += days;
      if (days >= 0) s.credited += days;
      else if (isLeaveTaken(e)) s.taken -= days;
      else s.adjusted -= days;
      s.rows.push({
        key: e.id,
        date: e.effective_date,
        label: entryLabel(e),
        detail: req ? [requestDates(req), req.reason].filter(Boolean).join(' · ') : e.note,
        days,
        balance: s.balance,
      });
    });
  } else {
    mine.filter((r) => r.status === 'Approved')
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
      .forEach((r) => {
        const days = requestDays(r);
        s.taken += days;
        s.rows.push({ key: r.id, date: r.start_date, label: 'Leave taken', detail: [requestDates(r), r.reason].filter(Boolean).join(' · '), days: -days, balance: null });
      });
    s.balance = type.balance ?? null;
  }

  let projected = s.balance;
  mine.filter((r) => r.status === 'Pending')
    .sort((a, b) => a.start_date.localeCompare(b.start_date))
    .forEach((r) => {
      const days = requestDays(r);
      s.pending += days;
      if (projected != null) projected -= days;
      s.rows.push({ key: r.id, date: r.start_date, label: 'Awaiting approval', detail: [requestDates(r), r.reason].filter(Boolean).join(' · '), days: -days, balance: projected, pending: true });
    });
  s.projected = projected;
  s.rows.reverse(); // newest first — pending requests on top
  return s;
}

function Figure({ label, value, sign = '', tone, strong }) {
  return (
    <div style={{ flex: '1 1 120px', minWidth: 110 }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: strong ? 24 : 18, color: tone || 'var(--text)', marginTop: 2 }}>
        {sign}{fmtDays(value)}
        <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}> {dayWord(value)}</span>
      </div>
    </div>
  );
}

/**
 * Employee's Leave Tracker — pick a leave type, see how the balance was reached.
 * `leaveTypes` are the tenant's active types; `compOffBalance` (a number) adds
 * the Comp Off tab, or pass null to leave it out.
 */
export default function LeaveTracker({ leaveTypes, ledger, requests, compOffBalance = null }) {
  const types = [
    ...leaveTypes.map((t) => ({ id: t.id, name: t.name, hasLedger: !t.is_unlimited, paid: t.is_paid })),
    ...(compOffBalance != null ? [{ id: COMP_OFF, name: COMP_OFF, hasLedger: false, balance: Number(compOffBalance) || 0, paid: true }] : []),
  ];
  const [activeId, setActiveId] = useState(null);
  const [showAll, setShowAll] = useState(false);
  if (types.length === 0) return null;

  const type = types.find((t) => t.id === activeId) || types[0];
  const s = buildStatement(type, ledger, requests);
  const hasBalance = s.balance != null;
  const rows = showAll ? s.rows : s.rows.slice(0, ROWS_SHOWN);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0 }}>Leave Tracker</h3>
        <div className="flex gap-1" style={{ flexWrap: 'wrap' }}>
          {types.map((t) => (
            <button
              key={t.id}
              className={`btn btn-sm ${t.id === type.id ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => { setActiveId(t.id); setShowAll(false); }}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: 20, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {type.hasLedger && <Figure label="Total credited" value={s.credited} sign="+" tone="var(--success)" />}
        <Figure label="Leave taken" value={s.taken} sign={s.taken ? '−' : ''} tone={s.taken ? 'var(--danger)' : undefined} />
        {s.adjusted > 0 && <Figure label="Other deductions" value={s.adjusted} sign="−" tone="var(--danger)" />}
        {hasBalance && <Figure label="Balance now" value={s.balance} strong={!s.pending} tone={s.balance < 0 ? 'var(--danger)' : 'var(--success)'} />}
        {s.pending > 0 && <Figure label="Awaiting approval" value={s.pending} tone="var(--warning)" />}
        {hasBalance && s.pending > 0 && (
          <Figure label="Balance if approved" value={s.projected} strong tone={s.projected < 0 ? 'var(--danger)' : 'var(--success)'} />
        )}
        {!hasBalance && (
          <div style={{ flex: '1 1 200px', fontSize: 12, color: 'var(--text-muted)' }}>
            {type.paid ? 'No balance is kept for this leave type.' : 'Loss of Pay — no balance is kept, these days are not paid.'}
          </div>
        )}
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Details</th>
              <th style={{ textAlign: 'right' }}>Days</th>
              <th style={{ textAlign: 'right' }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan="4" style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>Nothing recorded for {type.name} yet.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.key}>
                <td style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{fmt.date(r.date)}</td>
                <td>
                  <span className={`badge ${r.pending ? 'badge-warning' : r.days >= 0 ? 'badge-success' : 'badge-secondary'}`}>{r.label}</span>
                  {r.detail && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, maxWidth: 420 }}>{r.detail}</div>}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap', color: r.pending ? 'var(--warning)' : r.days >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                  {r.days > 0 ? '+' : r.days < 0 ? '−' : ''}{fmtDays(Math.abs(r.days))}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600, color: r.pending ? 'var(--text-muted)' : r.balance < 0 ? 'var(--danger)' : undefined }}>
                  {r.balance == null ? '—' : fmtDays(r.balance)}
                  {r.pending && r.balance != null && <div style={{ fontSize: 10, fontWeight: 500 }}>if approved</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.rows.length > ROWS_SHOWN && (
        <div style={{ padding: '10px 20px', textAlign: 'center' }}>
          <button className="btn btn-sm btn-outline" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show less' : `Show all ${s.rows.length} entries`}
          </button>
        </div>
      )}
    </div>
  );
}
