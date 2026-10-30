import { useEffect, useState, useCallback, useMemo } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import StatCard from '@/components/StatCard';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { fetchTenantLeaveBalances, listLeaveTypes, allocateLeave, recordLeaveEncashment, fetchLeaveLedgerHistory, fetchLeavesTaken } from '@/services/leaveLedgerService';
import { listActiveEmployees } from '@/services/employeeService';
import { hrAdjustCompOff, fetchCompOffAdjustments, fetchCompOffEarned, fetchCompOffUsed } from '@/services/compOffService';
import { fmt, fullName, getInitials, getAvatarColor, scopedToOutlet, isRaniwalaTenant, monthKey, monthLabel, dateStr, fmtDuration } from '@/lib/helpers';

// Why HR is adjusting a balance — stored on the ledger note so the history
// explains every change. Marriage/Misfortune are no longer separate
// requestable leave types (employees only request Earned Leave and mention
// the occasion in the reason); HR grants those days here as extra balance.
const ADJUST_REASONS = {
  add: ['Marriage leave grant', 'Misfortune (bereavement) leave grant', 'Special grant', 'Correction'],
  remove: ['Correction', 'Leave taken (not applied in app)', 'Other'],
};

// Comp off is not a leave type — it's profiles.comp_off_balance, the counter
// the app's Home and Leaves screens read. Shown as one more column here.
const COMP_OFF = { id: 'comp_off', name: 'Comp Off', isCompOff: true };
const COMP_OFF_REASONS = {
  add: ['Worked a weekly off / holiday', 'Carried forward', 'Special grant', 'Correction'],
  remove: ['Correction', 'Comp off taken (not applied in app)', 'Expired', 'Other'],
};
const reasonsFor = (leaveType) => (leaveType.isCompOff ? COMP_OFF_REASONS : ADJUST_REASONS);

const fmtDays = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(1).replace(/\.0$/, ''));

// Leaves Taken month picker — this month and the 11 before it.
const TAKEN_MONTHS = Array.from({ length: 12 }, (_, i) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - i);
  const m = d.getMonth(), y = d.getFullYear();
  return { key: monthKey(m, y), label: monthLabel(m, y), from: dateStr(new Date(y, m, 1)), to: dateStr(new Date(y, m + 1, 0)) };
});

export default function LeaveBalancesPage() {
  const { tenant } = useAuth();
  const { outletProfileIds } = useOutletView();
  const [balances, setBalances]   = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch] = useState('');
  const [adjustFor, setAdjustFor] = useState(null); // { emp, leaveType, dir: 'add' | 'remove' }
  const [adjustDays, setAdjustDays] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [adjustNote, setAdjustNote] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [encashFor, setEncashFor] = useState(null);
  const [encashDays, setEncashDays] = useState('');
  const [encashAmount, setEncashAmount] = useState('');
  const [historyFor, setHistoryFor] = useState(null);
  const [history, setHistory] = useState([]);
  // Raniwala HR: who took leave, on which dates, for how many days.
  const showTaken = isRaniwalaTenant(tenant);
  const [tab, setTab] = useState('balances');
  const [takenMonth, setTakenMonth] = useState(TAKEN_MONTHS[0].key);
  const [taken, setTaken] = useState([]);
  const [takenLoading, setTakenLoading] = useState(false);

  const fetchData = useCallback(async () => {
    if (!tenant) return;
    setLoading(true);
    try {
      const [balRes, typesRes, empRes] = await Promise.all([
        fetchTenantLeaveBalances(tenant.id),
        listLeaveTypes(tenant.id),
        listActiveEmployees(tenant.id),
      ]);
      if (balRes.error) showToast('Could not load leave balances: ' + balRes.error.message, 'error');
      setBalances(scopedToOutlet(balRes.data, outletProfileIds));
      setLeaveTypes(typesRes.data);
      setEmployees(scopedToOutlet(empRes.data, outletProfileIds, 'id'));
    } finally {
      setLoading(false);
    }
  }, [tenant, outletProfileIds]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Loaded only once the tab is opened, one month at a time.
  useEffect(() => {
    if (!tenant || tab !== 'taken') return;
    const month = TAKEN_MONTHS.find((m) => m.key === takenMonth);
    let cancelled = false;
    setTakenLoading(true);
    fetchLeavesTaken(tenant.id, month.from, month.to).then(({ data, error }) => {
      if (cancelled) return;
      if (error) showToast('Could not load leaves taken: ' + error.message, 'error');
      setTaken(data);
      setTakenLoading(false);
    });
    return () => { cancelled = true; };
  }, [tenant, tab, takenMonth]);

  // Earned Leave only — it's the one balance employees spend (the app's Home
  // and Leaves screens read this same ledger). Marriage/bereavement etc. are
  // granted here as extra Earned Leave days. Tenants without an Earned Leave
  // type fall back to every balance-tracked type.
  const activeTypes = useMemo(() => {
    const tracked = leaveTypes.filter((lt) => lt.is_active && !lt.is_unlimited);
    const earned = tracked.filter((lt) => /earned/i.test(lt.name));
    return earned.length ? earned : tracked;
  }, [leaveTypes]);

  const balanceOf = useCallback(
    (empId, leaveTypeId) => Number(balances.find((b) => b.profile_id === empId && b.leave_type_id === leaveTypeId)?.balance || 0),
    [balances]
  );

  const compOffOf = (emp) => Number(emp.comp_off_balance || 0);
  const balanceFor = (emp, lt) => (lt.isCompOff ? compOffOf(emp) : balanceOf(emp.id, lt.id));

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) =>
      fullName(e).toLowerCase().includes(q)
      || (e.department || '').toLowerCase().includes(q)
      || (e.employee_id || '').toLowerCase().includes(q)
    );
  }, [employees, search]);

  // Joined to the (outlet-scoped, searched) employee list, so both tabs
  // always cover the same people.
  const takenRows = useMemo(() => {
    const empById = new Map(filteredEmployees.map((e) => [e.id, e]));
    const typeById = new Map(leaveTypes.map((lt) => [lt.id, lt.name]));
    return taken
      .filter((r) => empById.has(r.profile_id))
      .map((r) => ({ ...r, emp: empById.get(r.profile_id), typeName: typeById.get(r.leave_type_id) || 'Leave', taken: Math.abs(Number(r.days)) }));
  }, [taken, filteredEmployees, leaveTypes]);

  const takenTotal = useMemo(() => takenRows.reduce((s, r) => s + r.taken, 0), [takenRows]);

  const negativeBalanceCount = useMemo(
    () => employees.filter((e) => activeTypes.some((lt) => balanceOf(e.id, lt.id) < 0)).length,
    [employees, activeTypes, balanceOf]
  );

  const totalBalance = useMemo(
    () => employees.reduce((s, e) => s + activeTypes.reduce((t, lt) => t + balanceOf(e.id, lt.id), 0), 0),
    [employees, activeTypes, balanceOf]
  );

  const openAdjust = (emp, leaveType, dir) => {
    setAdjustFor({ emp, leaveType, dir });
    setAdjustDays('');
    setAdjustReason(reasonsFor(leaveType)[dir][0]);
    setAdjustNote('');
  };

  const doAdjust = async () => {
    const days = parseFloat(adjustDays);
    if (!days || days <= 0) return showToast('Enter the number of days', 'error');
    const { emp, leaveType, dir } = adjustFor;
    const signed = dir === 'add' ? days : -days;
    if (leaveType.isCompOff && compOffOf(emp) + signed < 0) {
      return showToast(`${fullName(emp)} has only ${fmtDays(compOffOf(emp))} comp off`, 'error');
    }
    const note = [adjustReason, adjustNote.trim()].filter(Boolean).join(' — ');
    setAdjusting(true);
    try {
      if (leaveType.isCompOff) {
        const { balance, error } = await hrAdjustCompOff(emp.id, signed, note);
        if (error) return showToast('Failed: ' + error.message, 'error');
        // Only this employee's counter changed — patch it in place, no reload.
        setEmployees((list) => list.map((e) => (e.id === emp.id ? { ...e, comp_off_balance: balance } : e)));
      } else {
        const { error } = await allocateLeave(emp.id, leaveType.id, signed, note);
        if (error) return showToast('Failed: ' + error.message, 'error');
        fetchData();
      }
      showToast(`${dir === 'add' ? 'Added' : 'Removed'} ${fmtDays(days)} ${leaveType.isCompOff ? 'comp off ' : ''}day${days === 1 ? '' : 's'} ${dir === 'add' ? 'to' : 'from'} ${fullName(emp)}`, 'success');
      setAdjustFor(null);
    } finally {
      setAdjusting(false);
    }
  };

  const doEncash = async () => {
    if (!encashDays || !encashAmount) return showToast('Enter days and amount', 'error');
    const now = new Date();
    const { error } = await recordLeaveEncashment(encashFor.emp.id, encashFor.leaveType.id, parseFloat(encashDays), parseFloat(encashAmount), now.getMonth() + 1, now.getFullYear());
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast('Encashed — added to this month\'s one-off pay items', 'success');
    setEncashFor(null);
    setEncashDays('');
    setEncashAmount('');
    fetchData();
  };

  const openHistory = async (emp, leaveType) => {
    setHistoryFor({ emp, leaveType });
    setHistory([]);
    if (leaveType.isCompOff) {
      // Everything that moved the balance: days earned from attendance (the
      // date worked), Comp Off leave taken, and HR's own changes.
      const [adj, earned, used] = await Promise.all([
        fetchCompOffAdjustments(emp.id), fetchCompOffEarned(emp.id), fetchCompOffUsed(emp.id),
      ]);
      const error = adj.error || earned.error || used.error;
      if (error) showToast('Could not load comp off history: ' + error.message, 'error');
      const spanDays = (from, to) => Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000) + 1;
      setHistory([
        ...earned.data.map((a) => ({
          id: `e-${a.id}`, effective_date: a.date, tone: 'success', days: Number(a.comp_off_credit),
          entry_type: a.comp_off_granted ? 'Earned · weekly off / holiday' : 'Earned · extra hours',
          note: `Worked ${fmtDuration(Number(a.total_hours) || 0)}${a.comp_off_granted ? ' on a weekly off / holiday' : ' (past the shift)'}`,
        })),
        ...used.data.map((l) => ({
          id: `u-${l.id}`, effective_date: l.start_date, tone: 'warning', days: -spanDays(l.start_date, l.end_date),
          entry_type: 'Used · Comp Off leave',
          note: `${l.start_date === l.end_date ? l.start_date : `${l.start_date} to ${l.end_date}`}${l.reason ? ` — ${l.reason}` : ''}`,
        })),
        ...adj.data.map((h) => ({
          id: h.id, effective_date: dateStr(new Date(h.created_at)), tone: 'info', days: h.days, note: h.note,
          entry_type: h.days > 0 ? 'Added by HR' : 'Removed by HR',
        })),
      ].sort((a, b) => b.effective_date.localeCompare(a.effective_date)));
      return;
    }
    const { data } = await fetchLeaveLedgerHistory(emp.id, leaveType.id);
    setHistory(data);
  };

  const balanceTone = (bal) => (bal < 0 ? 'var(--danger)' : bal === 0 ? 'var(--text-muted)' : 'var(--success)');

  const renderCell = (emp, lt, bal, { canEncash, hasHistory }) => (
    <td key={lt.id} style={{ textAlign: 'center' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <button className="btn btn-outline btn-icon btn-sm" title={`Decrease ${lt.name}`} onClick={() => openAdjust(emp, lt, 'remove')}>
          <i className="fas fa-minus" />
        </button>
        <strong style={{ color: balanceTone(bal), minWidth: 36, fontSize: 16 }}>{fmtDays(bal)}</strong>
        <button className="btn btn-outline btn-icon btn-sm" title={`Increase ${lt.name}`} onClick={() => openAdjust(emp, lt, 'add')}>
          <i className="fas fa-plus" />
        </button>
        {hasHistory && (
          <button className="btn btn-outline btn-icon btn-sm" title={`${lt.name} history`} onClick={() => openHistory(emp, lt)}>
            <i className="fas fa-history" />
          </button>
        )}
        {canEncash && (
          <button className="btn btn-outline btn-icon btn-sm" title={`Encash ${lt.name}`} onClick={() => setEncashFor({ emp, leaveType: lt })} disabled={bal <= 0}>
            <i className="fas fa-money-bill" />
          </button>
        )}
      </div>
    </td>
  );

  const colCount = 2 + activeTypes.length;

  return (
    <>
      <Header title="Leave Balances" breadcrumb="People / Leave Balances — current Earned Leave and Comp Off of every employee; changes show on their app" />
      {showTaken && (
        <div className="tab-bar-wrap">
          <div className="tabs">
            <button className={`tab-btn ${tab === 'balances' ? 'active' : ''}`} onClick={() => setTab('balances')}>Balances</button>
            <button className={`tab-btn ${tab === 'taken' ? 'active' : ''}`} onClick={() => setTab('taken')}>Leaves Taken</button>
          </div>
        </div>
      )}
      <div className="page-content" style={showTaken ? { paddingTop: 8 } : undefined}>
        {tab === 'balances' && !loading && employees.length > 0 && (
          <div className="stats-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <StatCard icon="fa-users" iconColor="blue" value={employees.length} label="Employees" />
            <StatCard icon="fa-umbrella-beach" iconColor="purple" value={fmtDays(totalBalance)} label="Total Days Outstanding" />
            <StatCard icon="fa-triangle-exclamation" iconColor={negativeBalanceCount > 0 ? 'red' : 'green'} value={negativeBalanceCount} label="With a Negative Balance" />
          </div>
        )}

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>
        ) : leaveTypes.length === 0 ? (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
            No leave types configured yet — set them up on the Leave Types page first.
          </div>
        ) : tab === 'taken' ? (
          <div className="card">
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="form-select" value={takenMonth} onChange={(e) => setTakenMonth(e.target.value)} style={{ maxWidth: 200 }}>
                {TAKEN_MONTHS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
              <input
                className="form-input"
                placeholder="🔍 Search name, EMP code or department…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ maxWidth: 320 }}
              />
              {!takenLoading && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {takenRows.length} leave{takenRows.length === 1 ? '' : 's'} · {fmtDays(takenTotal)} day{takenTotal === 1 ? '' : 's'} deducted
                </span>
              )}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Employee</th><th>Leave Type</th><th>Leave Date</th><th>Days</th><th>Reason</th></tr>
                </thead>
                <tbody>
                  {takenLoading ? (
                    <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}><div className="spinner" style={{ margin: '0 auto 12px' }} />Loading…</td></tr>
                  ) : takenRows.length === 0 ? (
                    <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>
                      No leave taken in {TAKEN_MONTHS.find((m) => m.key === takenMonth).label}{search.trim() ? ` matching "${search}"` : ''}
                    </td></tr>
                  ) : takenRows.map((r) => {
                    const req = r.leave_request;
                    return (
                      <tr key={r.id}>
                        <td>
                          <div className="emp-cell">
                            <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(r.emp.id)})` }}>{getInitials(r.emp.first_name, r.emp.last_name)}</div>
                            <div>
                              <div className="emp-name">{fullName(r.emp)}</div>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {[r.emp.employee_id, r.emp.department].filter(Boolean).join(' · ')}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td><span className="badge badge-info">{r.typeName}</span></td>
                        <td style={{ fontSize: 12.5 }}>
                          {req ? (
                            <>{fmt.date(req.start_date)}{req.start_date !== req.end_date && <> – {fmt.date(req.end_date)}</>}</>
                          ) : (
                            <>
                              {fmt.date(r.effective_date)}
                              {r.entry_type !== 'Deduction' && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Recorded by HR on this date</div>}
                            </>
                          )}
                        </td>
                        <td>
                          <span style={{ fontWeight: 700 }}>{fmtDays(r.taken)}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> day{r.taken === 1 ? '' : 's'}</span>
                        </td>
                        <td style={{ maxWidth: 260, fontSize: 12.5, color: 'var(--text-secondary)' }}>
                          {req?.reason || r.note || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="card">
            <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                className="form-input"
                placeholder="🔍 Search name, EMP code or department…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ maxWidth: 320 }}
              />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Use <i className="fas fa-plus" /> to grant extra days (e.g. marriage, bereavement or comp off) and <i className="fas fa-minus" /> to correct downward.
              </span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    {activeTypes.map((lt) => <th key={lt.id} style={{ textAlign: 'center' }}>{lt.name}</th>)}
                    <th style={{ textAlign: 'center' }}>{COMP_OFF.name}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEmployees.length === 0 ? (
                    <tr><td colSpan={colCount} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>No employees match "{search}"</td></tr>
                  ) : filteredEmployees.map((emp) => (
                    <tr key={emp.id}>
                      <td>
                        <div className="emp-cell">
                          <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(emp.id)})` }}>{getInitials(emp.first_name, emp.last_name)}</div>
                          <div>
                            <div className="emp-name">{fullName(emp)}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                              {[emp.employee_id, emp.department].filter(Boolean).join(' · ')}
                            </div>
                          </div>
                        </div>
                      </td>
                      {activeTypes.map((lt) => renderCell(emp, lt, balanceOf(emp.id, lt.id), { canEncash: lt.encashable, hasHistory: true }))}
                      {renderCell(emp, COMP_OFF, compOffOf(emp), { canEncash: false, hasHistory: true })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Modal show={!!adjustFor} onClose={() => setAdjustFor(null)}
        title={adjustFor ? `${adjustFor.dir === 'add' ? 'Increase' : 'Decrease'} ${adjustFor.leaveType.name}` : ''} width="400px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setAdjustFor(null)}>Cancel</button>
          <button className={`btn ${adjustFor?.dir === 'remove' ? 'btn-danger' : 'btn-primary'}`} onClick={doAdjust} disabled={adjusting}>
            {adjusting ? 'Saving…' : adjustFor?.dir === 'add' ? 'Add Days' : 'Remove Days'}
          </button>
        </>}
      >
        {adjustFor && (
          <>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 }}>
              {fullName(adjustFor.emp)} — current balance{' '}
              <strong>
                {fmtDays(balanceFor(adjustFor.emp, adjustFor.leaveType))}
              </strong>
            </div>
            <div className="form-group">
              <label className="form-label">Days to {adjustFor.dir === 'add' ? 'add' : 'remove'}</label>
              <input className="form-input" type="number" min="0.5" step="0.5" value={adjustDays} onChange={(e) => setAdjustDays(e.target.value)} autoFocus />
            </div>
            <>
                <div className="form-group">
                  <label className="form-label">Reason</label>
                  <select className="form-select" value={adjustReason} onChange={(e) => setAdjustReason(e.target.value)}>
                    {reasonsFor(adjustFor.leaveType)[adjustFor.dir].map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Note (optional)</label>
                  <input className="form-input" value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder={adjustFor.leaveType.isCompOff ? 'e.g. worked Sunday 5 Oct' : 'e.g. own marriage on 12 Oct'} />
                </div>
            </>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              <i className="fas fa-mobile-screen" style={{ marginRight: 4 }} />
              The new balance shows on the employee's app straight away.
            </div>
          </>
        )}
      </Modal>

      <Modal show={!!encashFor} onClose={() => setEncashFor(null)} title={`Encash — ${encashFor?.leaveType.name}`} width="360px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setEncashFor(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={doEncash}>Encash</button>
        </>}
      >
        <div className="form-group">
          <label className="form-label">Days to encash</label>
          <input className="form-input" type="number" value={encashDays} onChange={(e) => setEncashDays(e.target.value)} autoFocus />
        </div>
        <div className="form-group">
          <label className="form-label">Payout Amount (₹)</label>
          <input className="form-input" type="number" value={encashAmount} onChange={(e) => setEncashAmount(e.target.value)} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Applied to this month's One-Off Pay Items — flows into the next payroll run.</div>
      </Modal>

      <Modal show={!!historyFor} onClose={() => setHistoryFor(null)}
        title={historyFor ? `History — ${historyFor.leaveType.name} · ${fullName(historyFor.emp)}` : ''} width="560px"
        footer={<button className="btn btn-outline" onClick={() => setHistoryFor(null)}>Close</button>}
      >
        {historyFor?.leaveType.isCompOff && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            Comp off earned on the day it was worked (a weekly off / holiday, or 4h+ past the shift), Comp Off leave taken, and HR's changes on this page. Shows the latest 100 of each.
          </div>
        )}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Change</th><th>Reason / Note</th></tr></thead>
            <tbody>
              {history.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16 }}>No history yet</td></tr>
              ) : history.map((h) => (
                <tr key={h.id}>
                  <td>{h.effective_date}</td>
                  <td><span className={`badge badge-${h.tone || 'info'}`}>{h.entry_type}</span></td>
                  <td style={{ color: h.days >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 600 }}>{h.days > 0 ? '+' : ''}{fmtDays(Number(h.days))}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{h.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    </>
  );
}
