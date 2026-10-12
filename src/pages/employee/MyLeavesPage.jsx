import React, { useEffect, useState } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import StatCard from '@/components/StatCard';
import CircularProgress from '@/components/CircularProgress';
import QuotaRings from '@/components/QuotaRings';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { listMyLeaveRequests, requestLeave, checkProbationStatus } from '@/services/leaveService';
import { fetchMyQuota, SELF_LIMIT } from '@/services/requestQuotaService';
import { fetchMyLeaveBalances, listLeaveTypes } from '@/services/leaveLedgerService';
import { fetchMyCompOffBalance } from '@/services/compOffService';
import { fmt, todayStr, HIGH_SALARY_THRESHOLD, isRaniwalaTenant } from '@/lib/helpers';

// Small pill for a Raniwala dual-approval row's manager/HR sub-status — kept
// separate from the overall Status badge so both stages stay visible instead
// of collapsing into one flat "Pending". Mirrors LeavesPage's stagePill.
function stagePill(label, value) {
  if (!value || value === 'Not Required') return null;
  const cls = value === 'Approved' ? 'badge-success' : value === 'Rejected' ? 'badge-danger' : 'badge-warning';
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
  reason: '',
};

const STATUS_FILTERS = ['Pending', 'Approved', 'Rejected', 'All'];

const RANIWALA_LEAVE_TYPE = 'Earned Leave';

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

export function LeaveContent() {
  const { profile, tenant } = useAuth();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_REQUEST);
  const [saving, setSaving] = useState(false);
  const [quota, setQuota] = useState(null);
  const [probation, setProbation] = useState(null);
  const [leaveBalances, setLeaveBalances] = useState([]);
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [freshCompOff, setFreshCompOff] = useState(null);
  const [filter, setFilter] = useState('Pending');

  // Comp-off is normally reserved for high-CTC staff (they don't get paid
  // overtime, so comp-off is their equivalent) — Raniwala wants every
  // employee eligible regardless of CTC, since factory/lower-paid staff earn
  // comp-off just by punching in on their weekly off.
  const raniwala = isRaniwalaTenant(tenant);
  const compOffEligible = raniwala || (profile?.ctc || 0) >= HIGH_SALARY_THRESHOLD;
  const compOffHave = freshCompOff ?? Number(profile?.comp_off_balance || 0);

  useEffect(() => {
    fetchRequests();
    loadQuota();
    loadProbation();
    loadLeaveBalances();
    loadLeaveTypes();
    loadCompOff();
  }, [profile]);

  const loadLeaveBalances = async () => {
    if (!profile) return;
    const { data } = await fetchMyLeaveBalances(profile.id);
    setLeaveBalances(data); // show every configured type, including a fresh 0 balance — not just the ones with activity
  };

  const loadLeaveTypes = async () => {
    if (!tenant) return;
    const { data } = await listLeaveTypes(tenant.id);
    // Raniwala: employees only ever request Earned Leave (or Comp Off, added
    // separately below) — marriage/bereavement are mentioned in the reason
    // and HR grants the extra days from Leave Balances.
    const active = data.filter((t) => t.is_active && (!raniwala || t.name === RANIWALA_LEAVE_TYPE));
    setLeaveTypes(active);
    setForm((f) => (f.leave_type ? f : { ...f, leave_type: active[0]?.name || '' }));
  };

  const autoApprovalEnabled = tenant?.leave_auto_approval_enabled !== false;
  const autoApprovalLimit   = tenant?.leave_auto_approval_limit ?? SELF_LIMIT;

  const loadQuota = async () => {
    if (!profile || !tenant) return;
    const q = await fetchMyQuota(tenant.id, profile.id, autoApprovalEnabled ? autoApprovalLimit : 0);
    setQuota(q);
  };

  const loadProbation = async () => {
    if (!profile) return;
    const p = await checkProbationStatus(profile.id);
    setProbation(p);
  };

  const loadCompOff = async () => {
    if (!profile) return;
    const { balance } = await fetchMyCompOffBalance(profile.id);
    if (balance != null) setFreshCompOff(balance);
  };

  const fetchRequests = async () => {
    if (!profile) return;
    setLoading(true);
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
      if (probation?.inProbation && form.leave_type !== 'Earned (Probation)') {
        setSaving(false);
        return showToast(`You are in probation until ${new Date(probation.endsOn + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}. Only earned probation leaves can be used.`, 'error');
      }
      if (probation?.inProbation && form.leave_type === 'Earned (Probation)' && (probation.earnedLeaves || 0) <= 0) {
        setSaving(false);
        return showToast('You have no earned probation leaves yet. Work all days in a month to earn one.', 'error');
      }

      if (form.leave_type === 'Comp Off') {
        const want = diffDays(form.start_date, form.end_date);
        const have = compOffHave;
        if (want > have) {
          setSaving(false);
          return showToast(`You have ${fmtDays(have)} comp off day${have === 1 ? '' : 's'} — this request needs ${want}.`, 'error');
        }
      }

      const payload = {
        ...form,
        profile_id: profile.id,
        tenant_id: tenant.id,
        status: 'Pending',
      };
      const { error, tier } = await requestLeave(payload, { autoApprovalEnabled, autoApprovalLimit });

      if (error) {
        showToast(error.message || 'Failed to submit leave request', 'error');
      } else {
        const msg = raniwala
          ? 'Leave request sent for approval'
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
    .reduce((sum, r) => sum + diffDays(r.start_date, r.end_date), 0);

  return (
    <div className="page-content">
      {raniwala ? (
        <div className="stats-row">
          <StatCard
            icon="fa-umbrella-beach" iconColor="green"
            value={`${earnedBalance} day${earnedBalance === '1' ? '' : 's'}`}
            label={<>Earned Leave Balance<br /><span style={{ color: 'var(--text-muted)' }}>+1.5 days carry forward every month</span></>}
          />
          <StatCard icon="fa-gift" iconColor="purple" value={`${compOffBalance} day${compOffBalance === '1' ? '' : 's'}`} label="Comp Off Balance" />
          <StatCard icon="fa-hourglass-half" iconColor="orange" value={pendingCount} label="Pending Requests" />
          <StatCard icon="fa-plane-departure" iconColor="blue" value={usedThisYear} label="Days Taken This Year" />
        </div>
      ) : (
        <div className="stats-row">
          <StatCard icon="fa-hourglass-half" iconColor="orange" value={pendingCount} label="Pending" />
          <StatCard icon="fa-circle-check" iconColor="green" value={approvedCount} label="Approved" />
          <StatCard icon="fa-circle-xmark" iconColor="red" value={rejectedCount} label="Rejected" />
          <StatCard icon="fa-plane-departure" iconColor="purple" value={usedThisYear} label="Days Taken This Year" />
        </div>
      )}

      {probation?.inProbation && (
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

                return (
                  <tr key={req.id}>
                    <td><span className={`badge ${typeBadgeClass(req.leave_type)}`}>{req.leave_type}</span></td>
                    <td style={{ fontSize: 12.5 }}>{fmt.date(req.start_date)} – {fmt.date(req.end_date)}</td>
                    <td>
                      <span style={{ fontWeight: 700 }}>{days}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> day{days !== 1 ? 's' : ''}</span>
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
        title="Request Leave"
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
            {probation?.inProbation ? (
              <option value="Earned (Probation)">Earned Leave (Probation) — {probation.earnedLeaves} available</option>
            ) : (
              <>
                {leaveTypes.map((lt) => {
                  const bal = leaveBalances.find((b) => b.leave_type_id === lt.id);
                  const suffix = lt.is_unlimited ? ' — Unlimited' : ` — ${fmtDays(bal?.balance)} available`;
                  return <option key={lt.id} value={lt.name}>{lt.name}{suffix}</option>;
                })}
                {compOffEligible && (
                  <option value="Comp Off">Comp Off — {fmtDays(compOffHave)} available</option>
                )}
              </>
            )}
          </select>
          {form.leave_type === 'Comp Off' && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--primary)' }}>
              <i className="fas fa-info-circle" style={{ marginRight: 4 }} />
              Balance: <strong>{fmtDays(compOffHave)}</strong> comp off{compOffHave !== 1 ? 's' : ''} available.
            </div>
          )}
        </div>
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
          {raniwala && form.leave_type !== 'Comp Off' && (
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
