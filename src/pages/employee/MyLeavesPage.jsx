import React, { useEffect, useRef, useState } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import StatCard from '@/components/StatCard';
import CircularProgress from '@/components/CircularProgress';
import QuotaRings from '@/components/QuotaRings';
import LeaveTracker from '@/components/LeaveTracker';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { listMyLeaveRequests, requestLeave, checkProbationStatus, fetchMyHalfDayWindows } from '@/services/leaveService';
import { fetchMyCompOffBalance } from '@/services/compOffService';
import { fetchMyQuota, SELF_LIMIT } from '@/services/requestQuotaService';
import { fetchMyLeaveBalances, listLeaveTypes, fetchMyLeaveLedger, previewEarnedLeaveSplit } from '@/services/leaveLedgerService';
import { fetchMemberHalfDayWindows } from '@/services/l1Service';
import { fmt, todayStr, dateStr, fullName, HIGH_SALARY_THRESHOLD, isRaniwalaTenant } from '@/lib/helpers';
import { HALF_DAY_OPTIONS, halfDayLabel, requestHalfDayLabel, leaveDays, daysText, clock12 } from '@/lib/halfDayLeave';

// Small pill for a Raniwala dual-approval row's manager/HR sub-status — kept
// separate from the overall Status badge so both stages stay visible instead
// of collapsing into one flat "Pending". Mirrors LeavesPage's stagePill.
function stagePill(label, value) {
  if (!value || value === 'Not Required') return null;
  const cls = value === 'Approved' ? 'badge-success' : value === 'Rejected' ? 'badge-danger'
    : value === 'Skipped' ? 'badge-secondary' : 'badge-warning';
  return (
    <span key={label} className={`badge ${cls}`} style={{ fontSize: 9, marginRight: 4 }}>
      {label}: {value}
    </span>
  );
}

const EMPTY_REQUEST = {
  leave_type: '',
  start_date: todayStr(),
  end_date: todayStr(),
  // '' = full day(s); 'first_half' / 'second_half' = half of one date (Raniwala, 20261013_2).
  half_day: '',
  reason: '',
};

const STATUS_FILTERS = ['Pending', 'Approved', 'Rejected', 'All'];

const RANIWALA_LEAVE_TYPE = 'Earned Leave';
// Loss of Pay, no balance — Manager, HOD and HR all approve it (the DB routes
// it, 20261010_3_raniwala_unpaid_leave.sql).
const UNPAID_LEAVE_TYPE = 'Unpaid Leave';
const RANIWALA_LEAVE_TYPES = [RANIWALA_LEAVE_TYPE, UNPAID_LEAVE_TYPE];

/** 'YYYY-MM-DD' plus n days. */
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return dateStr(new Date(y, m - 1, d + n));
}

/**
 * Raniwala Earned Leave beyond the balance (20261011_2): the balance covers
 * the first days, the last `unpaid` days are Loss of Pay.
 */
function splitDates(start, end, unpaid) {
  const unpaidFrom = addDays(end, 1 - unpaid);
  return { paidTo: addDays(unpaidFrom, -1), unpaidFrom };
}
const paidPart = (r) => leaveDays(r) - (r.unpaid_days || 0);
const rangeText = (from, to) => (from === to ? fmt.date(from) : `${fmt.date(from)} – ${fmt.date(to)}`);

const fmtDays = (n) => {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
};

const TYPE_BADGES = ['badge-info', 'badge-purple', 'badge-teal', 'badge-warning', 'badge-pink', 'badge-secondary'];
function typeBadgeClass(name) {
  const hash = [...(name || '')].reduce((a, c) => a + c.charCodeAt(0), 0);
  return TYPE_BADGES[hash % TYPE_BADGES.length];
}

function diffDays(start, end) {
  const s = new Date(start);
  const e = new Date(end);
  return Math.ceil(Math.abs(e - s) / (1000 * 60 * 60 * 24)) + 1;
}

// `member`: an L1 applying for one of their people (l1Service, a row of
// my_l1_members) — everything below then works on that employee, and a bump
// of `openKey` opens the request form.
export function LeaveContent({ member = null, openKey = 0 } = {}) {
  const { profile: me, tenant } = useAuth();
  const profile = member || me;
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_REQUEST);
  const [saving, setSaving] = useState(false);
  const [quota, setQuota] = useState(null);
  const [probation, setProbation] = useState(null);
  const [leaveBalances, setLeaveBalances] = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [freshCompOff, setFreshCompOff] = useState(null);
  // Raniwala Earned Leave preview: { paid_days, unpaid_days, available, ... }
  const [split, setSplit] = useState(null);
  const [splitAck, setSplitAck] = useState(false);
  // The employee's shift split in two, for the half-day choice.
  const [halfWindows, setHalfWindows] = useState(null);
  const lastLoadedAt = useRef(0);
  const [filter, setFilter] = useState('Pending');

  // Comp-off is normally reserved for high-CTC staff (they don't get paid
  // overtime, so comp-off is their equivalent) — Raniwala wants every
  // employee eligible regardless of CTC, since factory/lower-paid staff earn
  // comp-off just by punching in on their weekly off.
  const raniwala = isRaniwalaTenant(tenant);
  // Raniwala: probation never blocks leave — Earned Leave and Comp Off are
  // used from the real balance (HR, 2026-10-23).
  const inProbation = !raniwala && !!probation?.inProbation;
  const compOffEligible = raniwala || (profile?.ctc || 0) >= HIGH_SALARY_THRESHOLD;
  const compOffHave = freshCompOff ?? Number(profile?.comp_off_balance || 0);

  useEffect(() => {
    fetchRequests();
    loadQuota();
    loadProbation();
    loadLeaveBalances();
    loadLeaveTypes();
    loadLedger();
    loadCompOff();
  }, [profile]);

  // Keeps the tracker current without polling: when the employee comes back to
  // this tab (say, after their manager approved a request), reload what can
  // have changed — at most once a minute.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastLoadedAt.current < 60000) return;
      fetchRequests({ silent: true });
      loadLeaveBalances();
      loadLedger();
      loadCompOff();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [profile]);

  // What the chosen dates do to the Earned Leave balance — the DB decides the
  // same split when the request is submitted.
  useEffect(() => {
    setSplit(null);
    setSplitAck(false);
    const start = form.start_date;
    const end = form.end_date;
    if (!showModal || !raniwala || form.leave_type !== RANIWALA_LEAVE_TYPE || form.half_day || !profile || !start || !end || end < start) return undefined;
    let live = true;
    previewEarnedLeaveSplit(profile.id, start, end).then(({ data }) => { if (live) setSplit(data || null); });
    return () => { live = false; };
  }, [showModal, raniwala, profile, form.leave_type, form.half_day, form.start_date, form.end_date]);

  useEffect(() => {
    if (!showModal || !raniwala || halfWindows) return;
    (member ? fetchMemberHalfDayWindows(member.id) : fetchMyHalfDayWindows()).then(({ data }) => setHalfWindows(data));
  }, [showModal, raniwala, halfWindows, member]);

  useEffect(() => { if (openKey) setShowModal(true); }, [openKey]);

  const loadLeaveBalances = async () => {
    if (!profile) return;
    const { data } = await fetchMyLeaveBalances(profile.id);
    setLeaveBalances(data); // show every configured type, including a fresh 0 balance — not just the ones with activity
  };

  const loadLeaveTypes = async () => {
    if (!tenant) return;
    const { data } = await listLeaveTypes(tenant.id);
    // Raniwala: employees request Earned Leave or Unpaid Leave (or Comp Off,
    // added separately below) — marriage/bereavement are mentioned in the
    // reason and HR grants the extra days from Leave Balances.
    const active = data.filter((t) => t.is_active && (!raniwala || RANIWALA_LEAVE_TYPES.includes(t.name)));
    setLeaveTypes(active);
    setForm((f) => (f.leave_type ? f : { ...f, leave_type: active[0]?.name || '' }));
  };

  const loadLedger = async () => {
    if (!profile) return;
    lastLoadedAt.current = Date.now();
    if (raniwala) return; // Raniwala shows balances only — no Leave Tracker
    const { data } = await fetchMyLeaveLedger(profile.id);
    setLedger(data);
  };

  const autoApprovalEnabled = tenant?.leave_auto_approval_enabled !== false;
  const autoApprovalLimit   = tenant?.leave_auto_approval_limit ?? SELF_LIMIT;

  // For an L1's member the quota, profile row and comp-off counter aren't
  // readable; my_l1_members already carries the comp-off balance.
  const loadQuota = async () => {
    if (!profile || !tenant || member) return;
    const q = await fetchMyQuota(tenant.id, profile.id, autoApprovalEnabled ? autoApprovalLimit : 0);
    setQuota(q);
  };

  const loadProbation = async () => {
    if (!profile || member) return;
    const p = await checkProbationStatus(profile.id);
    setProbation(p);
  };

  const loadCompOff = async () => {
    if (!profile || member) return;
    const { balance } = await fetchMyCompOffBalance(profile.id);
    if (balance != null) setFreshCompOff(balance);
  };

  const fetchRequests = async ({ silent = false } = {}) => {
    if (!profile) return;
    if (!silent) setLoading(true);
    try {
      const { data, error } = await listMyLeaveRequests(profile.id);
      if (error) showToast(error.message, 'error');
      else setRequests(data);
    } finally {
      setLoading(false);
    }
  };

  const handleRequest = async (e) => {
    e.preventDefault();
    if (!form.reason.trim()) return showToast('Please provide a reason', 'error');
    if (!form.start_date || !form.end_date) return showToast('Please select start and end dates', 'error');
    if (form.end_date < form.start_date) return showToast('End date cannot be before start date', 'error');

    setSaving(true);
    try {
      if (!tenant) {
        throw new Error('You do not belong to any workspace. Please contact your administrator.');
      }

      // Block leave during probation unless they have earned leaves and it's a probation-earned type
      if (inProbation && form.leave_type !== 'Earned (Probation)') {
        setSaving(false);
        return showToast(`You are in probation until ${new Date(probation.endsOn + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}. Only earned probation leaves can be used.`, 'error');
      }
      if (inProbation && form.leave_type === 'Earned (Probation)' && (probation.earnedLeaves || 0) <= 0) {
        setSaving(false);
        return showToast('You have no earned probation leaves yet. Work all days in a month to earn one.', 'error');
      }

      if (form.leave_type === 'Comp Off') {
        const want = leaveDays(form);
        const have = compOffHave;
        if (want > have) {
          setSaving(false);
          return showToast(`You have ${fmtDays(have)} comp off day${have === 1 ? '' : 's'} — this request needs ${fmtDays(want)}.`, 'error');
        }
      }

      const unpaidAhead = raniwala && form.leave_type === RANIWALA_LEAVE_TYPE ? split?.unpaid_days || 0 : 0;
      if (unpaidAhead > 0 && !splitAck) {
        setSaving(false);
        return showToast(`Tick the box to confirm you know ${unpaidAhead} day${unpaidAhead === 1 ? '' : 's'} will be unpaid`, 'error');
      }

      const payload = {
        ...form,
        // A half day is one date; the DB stamps its times from the shift.
        end_date: form.half_day ? form.start_date : form.end_date,
        half_day: form.half_day || null,
        profile_id: profile.id,
        tenant_id: tenant.id,
        status: 'Pending',
      };
      const { error, tier } = await requestLeave(payload, { autoApprovalEnabled, autoApprovalLimit, asL1: !!member });

      if (error) {
        showToast(error.message || 'Failed to submit leave request', 'error');
      } else {
        const msg = raniwala
          ? (unpaidAhead > 0
            ? `Leave request sent for approval — ${unpaidAhead} day${unpaidAhead === 1 ? '' : 's'} will be unpaid (Loss of Pay)`
            : 'Leave request sent for approval')
          : member
          ? `Leave request sent for approval${member.manager_name ? ` to ${member.manager_name}` : ''}`
          : tier === 'self'
          ? 'Auto-approved! (self-approval used)'
          : tier === 'manager'
          ? 'Request sent to Manager for approval'
          : 'Request escalated to HR for approval';
        showToast(msg, tier === 'self' ? 'success' : 'info');
        setShowModal(false);
        setForm(EMPTY_REQUEST);
        fetchRequests();
        loadQuota();
        // A self-approved request is deducted straight away.
        loadLeaveBalances();
        loadLedger();
      }
    } catch (err) {
      showToast(err.message || 'Something went wrong', 'error');
    } finally {
      setSaving(false);
    }
  };

  const filteredRequests = requests.filter(r => filter === 'All' || r.status === filter);

  const pendingCount  = requests.filter(r => r.status === 'Pending').length;
  const approvedCount = requests.filter(r => r.status === 'Approved').length;
  const rejectedCount = requests.filter(r => r.status === 'Rejected').length;
  const earnedBalance = fmtDays(leaveBalances.find((b) => b.leave_type?.name === RANIWALA_LEAVE_TYPE)?.balance);
  const compOffBalance = fmtDays(compOffHave);
  const countByFilter = { Pending: pendingCount, Approved: approvedCount, Rejected: rejectedCount, All: requests.length };
  const usedThisYear = requests
    .filter(r => r.status === 'Approved' && new Date(r.start_date).getFullYear() === new Date().getFullYear())
    .reduce((sum, r) => sum + leaveDays(r), 0);
  // Earned Leave days beyond the balance (unpaid_days) are not paid from it.
  const requestDays = (type, status) => requests
    .filter((r) => r.leave_type === type && r.status === status)
    .reduce((sum, r) => sum + paidPart(r), 0);
  // Live preview in the request form: what the chosen dates do to the balance.
  const formType = leaveTypes.find((t) => t.name === form.leave_type);
  const formBalance = form.leave_type === 'Comp Off'
    ? compOffHave
    : formType && !formType.is_unlimited
    ? Number(leaveBalances.find((b) => b.leave_type_id === formType.id)?.balance || 0)
    : null;
  const formDays = form.half_day
    ? (form.start_date ? 0.5 : 0)
    : form.start_date && form.end_date && form.end_date >= form.start_date ? diffDays(form.start_date, form.end_date) : 0;
  const formPendingDays = requestDays(form.leave_type, 'Pending');
  const formBalanceAfter = formBalance == null ? null : formBalance - formPendingDays - formDays;

  return (
    <div className={member ? '' : 'page-content'}>
      {member ? null : raniwala ? (
        <div className="stats-row">
          <StatCard
            icon="fa-umbrella-beach" iconColor="green"
            value={`${earnedBalance} day${earnedBalance === '1' ? '' : 's'}`}
            label={<>Earned Leave Balance<br /><span style={{ color: 'var(--text-muted)' }}>+1.5 days carry forward every month</span></>}
          />
          <StatCard icon="fa-gift" iconColor="purple" value={`${compOffBalance} day${compOffBalance === '1' ? '' : 's'}`} label="Comp Off Balance" />
          <StatCard icon="fa-hourglass-half" iconColor="orange" value={pendingCount} label="Pending Requests" />
          <StatCard icon="fa-plane-departure" iconColor="blue" value={fmtDays(usedThisYear)} label="Days Taken This Year" />
        </div>
      ) : (
        <div className="stats-row">
          <StatCard icon="fa-hourglass-half" iconColor="orange" value={pendingCount} label="Pending" />
          <StatCard icon="fa-circle-check" iconColor="green" value={approvedCount} label="Approved" />
          <StatCard icon="fa-circle-xmark" iconColor="red" value={rejectedCount} label="Rejected" />
          <StatCard icon="fa-plane-departure" iconColor="purple" value={fmtDays(usedThisYear)} label="Days Taken This Year" />
        </div>
      )}

      {inProbation && (
        <div style={{
          background: 'var(--warning-light, #fffbeb)',
          border: '1px solid var(--warning)',
          borderRadius: 8, padding: '10px 16px', marginBottom: 16,
          fontSize: 13, color: 'var(--warning-dark, #92400e)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <i className="fas fa-hourglass-half" />
          <span>
            <strong>Probation period</strong> — ends{' '}
            {new Date(probation.endsOn + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}.
            {' '}Regular leaves are blocked. You have <strong>{probation.earnedLeaves}</strong> earned leave{probation.earnedLeaves !== 1 ? 's' : ''} available
            (earned by working every day in a month during probation).
          </span>
        </div>
      )}

      {!raniwala && compOffEligible && compOffHave > 0 && (
        <div style={{
          background: 'var(--primary-light, #eff6ff)',
          border: '1px solid var(--primary)',
          borderRadius: 8, padding: '10px 16px', marginBottom: 16,
          fontSize: 13, color: 'var(--primary)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <i className="fas fa-gift" />
          You have <strong>{fmtDays(compOffHave)}</strong> Comp Off{compOffHave > 1 ? 's' : ''} available.
          Select <em>Comp Off</em> as the leave type to use them.
        </div>
      )}

      {/* Raniwala leave requests no longer route through the self/manager
          quota system (reporting manager, then HR for >3 days, approves
          instead) — this widget would just be misleading there. */}
      {quota && !raniwala && <QuotaRings quota={quota} autoApprovalEnabled={autoApprovalEnabled} title="Leave Approval Quota" actionLabel="leave request" />}

      {!raniwala && leaveBalances.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header"><h3 style={{ margin: 0 }}>My Leave Balance</h3></div>
          <div style={{ padding: 20, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {leaveBalances.map((b) => {
              const lt = b.leave_type || {};
              return (
                <div key={b.leave_type_id} style={{ width: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                  <CircularProgress
                    used={b.used || 0}
                    total={b.allocated || 0}
                    unlimited={!!lt.is_unlimited}
                    size={110}
                    strokeWidth={10}
                    label={lt.name || 'Leave'}
                    emptyText="not allocated"
                  />
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <span className={`badge ${lt.is_paid ? 'badge-success' : 'badge-secondary'}`}>
                      {lt.is_paid ? 'Paid' : 'Unpaid / LOP'}
                    </span>
                    {lt.is_unlimited && <span className="badge badge-purple">Unlimited</span>}
                    {lt.encashable && <span className="badge badge-teal">Encashable</span>}
                  </div>
                  {!lt.is_unlimited && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 10px', fontSize: 12, width: '100%', borderTop: '1px solid var(--border-light)', paddingTop: 10 }}>
                      <div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 }}>Annual Quota</div>
                        <div style={{ fontWeight: 600 }}>{lt.annual_quota ?? 0}</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 }}>Accrual</div>
                        <div style={{ fontWeight: 600 }}>{lt.accrual_frequency === 'none' || !lt.accrual_frequency ? '—' : `${lt.accrual_days}/${lt.accrual_frequency === 'monthly' ? 'mo' : 'yr'}`}</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 }}>Carry Forward</div>
                        <div style={{ fontWeight: 600 }}>{lt.carry_forward ? `Up to ${lt.max_carry_forward_days} days` : '—'}</div>
                      </div>
                      <div>
                        <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.3 }}>Max Continuous</div>
                        <div style={{ fontWeight: 600 }}>{lt.max_continuous_days || '—'}</div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!raniwala && (
        <LeaveTracker
          leaveTypes={leaveTypes}
          ledger={ledger}
          requests={requests}
          compOffBalance={compOffEligible ? compOffHave : null}
        />
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>Leave History</h3>
          <div className="flex gap-1" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            {STATUS_FILTERS.map(s => (
              <button
                key={s}
                className={`btn btn-sm ${filter === s ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setFilter(s)}
              >
                {s}
                <span style={{ marginLeft: 6, opacity: 0.7, fontWeight: 700 }}>{countByFilter[s]}</span>
              </button>
            ))}
            <button className="btn btn-sm btn-primary" style={{ marginLeft: 8 }} onClick={() => setShowModal(true)}>
              <i className="fas fa-plus" /> New Request
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Dates</th>
                <th>Days</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Applied On</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="6" style={{ textAlign: 'center', padding: 40 }}><div className="spinner" /></td></tr>
              ) : filteredRequests.length === 0 ? (
                <tr><td colSpan="6" style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
                  <i className="fas fa-calendar-check" style={{ fontSize: 28, display: 'block', marginBottom: 10, opacity: 0.5 }} />
                  {requests.length === 0 ? 'No leave requests found.' : `No ${filter.toLowerCase()} requests found.`}
                </td></tr>
              ) : filteredRequests.map(req => {
                const days = diffDays(req.start_date, req.end_date);
                const half = requestHalfDayLabel(req);

                return (
                  <tr key={req.id}>
                    <td><span className={`badge ${typeBadgeClass(req.leave_type)}`}>{req.leave_type}</span></td>
                    <td style={{ fontSize: 12.5 }}>
                      {half ? fmt.date(req.start_date) : <>{fmt.date(req.start_date)} – {fmt.date(req.end_date)}</>}
                      {half && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{half}</div>}
                    </td>
                    <td>
                      <span style={{ fontWeight: 700 }}>{half ? daysText(0.5) : days}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> {half ? 'day' : `day${days !== 1 ? 's' : ''}`}</span>
                      {req.unpaid_days > 0 && (
                        <div style={{ fontSize: 11, marginTop: 2 }} title={`Unpaid: ${rangeText(splitDates(req.start_date, req.end_date, req.unpaid_days).unpaidFrom, req.end_date)}`}>
                          {days - req.unpaid_days > 0 && <span style={{ color: 'var(--success)' }}>{days - req.unpaid_days} paid · </span>}
                          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>{req.unpaid_days} unpaid</span>
                        </div>
                      )}
                    </td>
                    <td style={{ maxWidth: 250, fontSize: 13 }}>{req.reason || <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                    <td>
                      <span className={`badge ${
                        req.status === 'Approved' ? 'badge-success' :
                        req.status === 'Rejected' ? 'badge-danger' : 'badge-warning'
                      }`}>
                        {req.status}
                      </span>
                      {raniwala && req.manager_status != null && (
                        <div style={{ marginTop: 4 }}>
                          {stagePill('Manager', req.manager_status)}
                          {stagePill('HOD', req.hod_status)}
                          {stagePill('HR', req.hr_status)}
                          {stagePill('Management', req.management_status)}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{fmt.date(req.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        show={showModal}
        onClose={() => setShowModal(false)}
        title={member ? `Request Leave for ${fullName(member)}` : 'Request Leave'}
        footer={
          <div className="flex gap-2" style={{ justifyContent: 'flex-end', width: '100%' }}>
            <button className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleRequest} disabled={saving}>
              {saving ? 'Submitting...' : 'Submit Request'}
            </button>
          </div>
        }
      >
        <div className="form-group">
          <label className="form-label">Leave Type</label>
          <select className="form-select" value={form.leave_type} onChange={e => setForm({...form, leave_type: e.target.value})}>
            {inProbation ? (
              <option value="Earned (Probation)">Earned Leave (Probation) — {probation.earnedLeaves} available</option>
            ) : (
              <>
                {leaveTypes.map((lt) => {
                  const bal = leaveBalances.find((b) => b.leave_type_id === lt.id);
                  const suffix = lt.is_unlimited
                    ? (raniwala ? ' — no balance needed' : ' — Unlimited')
                    : ` — ${fmtDays(bal?.balance)} available`;
                  return <option key={lt.id} value={lt.name}>{lt.name}{suffix}</option>;
                })}
                {compOffEligible && (
                  <option value="Comp Off">Comp Off — {fmtDays(compOffHave)} available</option>
                )}
              </>
            )}
          </select>
          {raniwala && form.leave_type === UNPAID_LEAVE_TYPE && (
            <div className="form-hint">
              <i className="fas fa-info-circle" style={{ marginRight: 4 }} />
              Unpaid leave is Loss of Pay — these days are not paid and {member ? `${member.first_name}'s` : 'your'} Earned Leave balance is not touched.
              It needs approval from {member ? 'their' : 'your'} Manager, HOD and HR.
            </div>
          )}
          {form.leave_type === 'Comp Off' && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--primary)' }}>
              <i className="fas fa-info-circle" style={{ marginRight: 4 }} />
              Balance: <strong>{fmtDays(compOffHave)}</strong> comp off{compOffHave !== 1 ? 's' : ''} available.
            </div>
          )}
        </div>
        {raniwala && !inProbation && (
          <div className="form-group">
            <label className="form-label">Duration</label>
            <div className="flex gap-1" style={{ flexWrap: 'wrap' }}>
              {HALF_DAY_OPTIONS.map((o) => {
                const w = o.value ? halfWindows?.[o.value] : null;
                return (
                  <button
                    key={o.value || 'full'}
                    type="button"
                    className={`btn btn-sm ${form.half_day === o.value ? 'btn-primary' : 'btn-outline'}`}
                    onClick={() => setForm({ ...form, half_day: o.value, end_date: o.value ? form.start_date : form.end_date })}
                  >
                    {o.value ? halfDayLabel(o.value, w?.from, w?.to) : o.label}
                  </button>
                );
              })}
            </div>
            {form.half_day && (
              <div className="form-hint">
                <i className="fas fa-info-circle" style={{ marginRight: 4 }} />
                Half a day of leave (0.5 day).
                {halfWindows?.shift_start && ` ${member ? `${member.first_name}'s` : 'Your'} shift: ${clock12(halfWindows.shift_start)} – ${clock12(halfWindows.shift_end)}${halfWindows.shift_name ? ` (${halfWindows.shift_name})` : ''}.`}
                {' '}Work the other half as usual.
              </div>
            )}
          </div>
        )}
        {form.half_day ? (
          <div className="form-group">
            <label className="form-label">Date</label>
            <input type="date" className="form-input" value={form.start_date} onChange={e => setForm({...form, start_date: e.target.value, end_date: e.target.value})} />
          </div>
        ) : (
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Start Date</label>
              <input type="date" className="form-input" value={form.start_date} onChange={e => setForm({...form, start_date: e.target.value})} />
            </div>
            <div className="form-group">
              <label className="form-label">End Date</label>
              <input type="date" className="form-input" value={form.end_date} onChange={e => setForm({...form, end_date: e.target.value})} />
            </div>
          </div>
        )}
        {split && formDays > 0 && !form.half_day && !inProbation && (() => {
          const { paidTo, unpaidFrom } = splitDates(form.start_date, form.end_date, split.unpaid_days);
          const short = split.unpaid_days > 0;
          const s = (n) => (n === 1 ? '' : 's');
          return (
            <div style={{
              marginBottom: 16, padding: '10px 14px', borderRadius: 8, fontSize: 12.5,
              border: `1px solid ${short ? 'var(--danger)' : 'var(--border-light)'}`,
              background: short ? 'var(--danger-light)' : 'var(--surface-hover)',
            }}>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <span>Earned Leave available: <strong>{fmtDays(Math.max(0, split.available))}</strong></span>
                {Number(split.held) > 0 && <span style={{ color: 'var(--text-muted)' }}>(after {fmtDays(split.held)} day{s(Number(split.held))} awaiting approval)</span>}
                <span>This request: <strong>{split.requested}</strong> day{s(split.requested)}</span>
              </div>
              {short ? (
                <>
                  <div style={{ marginTop: 8, color: 'var(--danger)', fontWeight: 600 }}>
                    <i className="fas fa-exclamation-triangle" style={{ marginRight: 6 }} />
                    {split.paid_days > 0
                      ? <>Only {split.paid_days} day{s(split.paid_days)} ({rangeText(form.start_date, paidTo)}) will be paid from your Earned Leave. The other {split.unpaid_days} day{s(split.unpaid_days)} ({rangeText(unpaidFrom, form.end_date)}) will be <u>Unpaid Leave</u> — Loss of Pay, cut from your salary.</>
                      : <>You have no Earned Leave balance for these dates, so all {split.unpaid_days} day{s(split.unpaid_days)} will be <u>Unpaid Leave</u> — Loss of Pay, cut from your salary.</>}
                  </div>
                  <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>Because some days are unpaid, your HOD and HR also approve this request.</div>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 8, cursor: 'pointer', fontWeight: 600 }}>
                    <input type="checkbox" checked={splitAck} onChange={(e) => setSplitAck(e.target.checked)} style={{ marginTop: 2 }} />
                    I understand {split.unpaid_days} day{s(split.unpaid_days)} of this leave will be unpaid.
                  </label>
                </>
              ) : (
                <div style={{ marginTop: 6, color: 'var(--success)' }}>
                  All {split.requested} day{s(split.requested)} are paid from your Earned Leave.
                </div>
              )}
            </div>
          );
        })()}
        {formBalance != null && formDays > 0 && !inProbation && !(raniwala && form.leave_type === RANIWALA_LEAVE_TYPE && !form.half_day) && (
          <div style={{
            display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16, padding: '10px 14px', borderRadius: 8,
            border: `1px solid ${formBalanceAfter < 0 ? 'var(--danger)' : 'var(--border-light)'}`,
            background: formBalanceAfter < 0 ? 'var(--danger-light)' : 'var(--surface-hover)', fontSize: 12.5,
          }}>
            <span>Balance now: <strong>{fmtDays(formBalance)}</strong></span>
            {formPendingDays > 0 && <span>Awaiting approval: <strong>−{fmtDays(formPendingDays)}</strong></span>}
            <span>This request: <strong>−{fmtDays(formDays)}</strong> day{formDays <= 1 ? '' : 's'}</span>
            <span style={{ color: formBalanceAfter < 0 ? 'var(--danger)' : 'var(--success)' }}>
              Balance after approval: <strong>{fmtDays(formBalanceAfter)}</strong>
            </span>
          </div>
        )}
        <div className="form-group">
          <label className="form-label">Reason / Remark</label>
          <textarea
            className="form-input"
            rows="3"
            placeholder={raniwala
              ? 'e.g. Own marriage on 12 Oct / death in family / personal work…'
              : 'Please provide a brief reason for your leave...'}
            value={form.reason}
            onChange={e => setForm({...form, reason: e.target.value})}
          />
          {raniwala && form.leave_type === RANIWALA_LEAVE_TYPE && (
            <div className="form-hint">
              <i className="fas fa-info-circle" style={{ marginRight: 4 }} />
              Marriage or bereavement? Mention it here — your manager and HR will grant the extra days.
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

export default function MyLeavesPage() {
  return (
    <>
      <Header title="My Leaves" breadcrumb="My Space / Leaves" />
      <LeaveContent />
    </>
  );
}
