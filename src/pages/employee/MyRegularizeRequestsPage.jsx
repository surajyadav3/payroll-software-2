import React, { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import QuotaRings from '@/components/QuotaRings';
import RegularizeExtensionNotice from '@/components/RegularizeExtensionNotice';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { submitRegularizeRequest, listMyRegularizeRequests } from '@/services/attendanceService';
import { fetchMyQuota, SELF_LIMIT } from '@/services/requestQuotaService';
import { todayStr, fmtTime12, fullName, regularizeMinDate, regularizeWindowLabel, isRaniwalaTenant } from '@/lib/helpers';

const STATUS_BADGE = {
  Pending:  'badge-warning',
  Approved: 'badge-success',
  Rejected: 'badge-danger',
};

// `member`: an L1 filing for one of their people (l1Service, a row of
// my_l1_members) — the list and the request are that employee's. `openFor`
// ({ date, clockInTime, clockOutTime }) opens the form for that day.
export function RegularizeContent({ member = null, openFor = null } = {}) {
  const { profile: me, tenant } = useAuth();
  const profile = member || me;
  const [requests,  setRequests]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [filter,    setFilter]    = useState('Pending');
  const [showModal, setShowModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [quota, setQuota] = useState(null);
  const [form, setForm] = useState({
    date: todayStr(), clockInTime: '', clockOutTime: '', reason: '',
  });

  const fetchRequests = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    try {
      const { data, error } = await listMyRegularizeRequests(profile.id);
      if (error) showToast(error.message, 'error');
      else setRequests(data);
    } finally {
      setLoading(false);
    }
  }, [profile]);

  const autoApprovalEnabled = tenant?.regularize_auto_approval_enabled !== false;
  const autoApprovalLimit   = tenant?.regularize_auto_approval_limit ?? SELF_LIMIT;

  const loadQuota = useCallback(async () => {
    if (!profile || !tenant || member) return; // an L1 can't read the employee's quota
    const q = await fetchMyQuota(tenant.id, profile.id, autoApprovalEnabled ? autoApprovalLimit : 0);
    setQuota(q);
  }, [profile, tenant, member, autoApprovalEnabled, autoApprovalLimit]);

  useEffect(() => { fetchRequests(); loadQuota(); }, [fetchRequests, loadQuota]);

  const openModal = () => {
    setForm({
      date: todayStr(),
      clockInTime:  tenant?.shift_start || '',
      clockOutTime: tenant?.shift_end   || '',
      reason: '',
    });
    setShowModal(true);
  };

  useEffect(() => {
    if (!openFor) return;
    setForm({
      date: openFor.date,
      clockInTime:  openFor.clockInTime  || tenant?.shift_start || '',
      clockOutTime: openFor.clockOutTime || tenant?.shift_end   || '',
      reason: '',
    });
    setShowModal(true);
  }, [openFor, tenant]);

  const handleSubmit = async () => {
    if (!form.date) return showToast('Please select the date', 'error');
    if (form.date > todayStr()) return showToast('Cannot request regularization for a future date', 'error');
    if (form.date < regularizeMinDate(tenant)) return showToast(`Regularization can only be requested for ${regularizeWindowLabel(tenant)}`, 'error');
    if (!form.clockInTime) return showToast('Clock-in time is required', 'error');
    if (!form.clockOutTime) return showToast('Clock-out time is required', 'error');
    if (form.clockInTime >= form.clockOutTime) return showToast('Clock-out must be after clock-in', 'error');
    if (!form.reason.trim()) return showToast('Reason is required', 'error');

    setSubmitting(true);
    try {
      const { error, tier } = await submitRegularizeRequest(tenant.id, profile.id, {
        date:         form.date,
        clockInTime:  form.clockInTime,
        clockOutTime: form.clockOutTime,
        reason:       form.reason.trim(),
      }, { autoApprovalEnabled, autoApprovalLimit, asL1: !!member });
      if (error) throw error;
      const msg = member
        ? `Sent for approval${member.manager_name ? ` to ${member.manager_name}` : ''}, as if ${member.first_name} sent it`
        : tier === 'self'
        ? 'Auto-approved! Attendance updated instantly.'
        : tier === 'manager'
        ? 'Sent to your manager for approval — HR gets a copy'
        : 'Sent to HR for approval';
      showToast(msg, tier === 'self' ? 'success' : 'info');
      setShowModal(false);
      fetchRequests();
      loadQuota();
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const filtered = filter === 'All' ? requests : requests.filter(r => r.status === filter);

  return (
    <>
      <div className={member ? '' : 'page-content'}>
        <RegularizeExtensionNotice tenant={tenant} />

        {/* Raniwala regularizations always go to the reporting manager — no self-approval quota to show. */}
        {quota && !isRaniwalaTenant(tenant) && <QuotaRings quota={quota} autoApprovalEnabled={autoApprovalEnabled} title="Regularization Approval Quota" actionLabel="regularization request" />}

      <div className="filter-bar" style={{ marginTop: 16 }}>
          {['Pending', 'Approved', 'Rejected', 'All'].map(s => (
            <button
              key={s}
              className={`btn btn-sm ${filter === s ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setFilter(s)}
            >
              {s}
            </button>
          ))}
          <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={openModal}>
            <i className="fas fa-plus" /> New Request
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="card">
            <div className="card-body">
              <div className="empty-state">
                <i className="fas fa-calendar-check empty-icon" />
                <h3>No requests yet</h3>
                <p>
                  {requests.length === 0
                    ? 'Click "New Request" to ask your manager to correct your attendance for a missed punch.'
                    : `No ${filter.toLowerCase()} requests found.`}
                </p>
                {requests.length === 0 && (
                  <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={openModal}>
                    <i className="fas fa-plus" /> New Request
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Requested Time</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(req => (
                    <tr key={req.id}>
                      <td>
                        <strong>
                          {new Date(req.date + 'T00:00:00').toLocaleDateString('en-IN', {
                            weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
                          })}
                        </strong>
                      </td>
                      <td>
                        <div style={{ fontSize: 13 }}>
                          <span style={{ color: 'var(--success)', fontWeight: 500 }}>
                            <i className="fas fa-sign-in-alt" style={{ marginRight: 4, fontSize: 11 }} />
                            {fmtTime12(req.clock_in_time)}
                          </span>
                          <span style={{ margin: '0 6px', color: 'var(--text-muted)' }}>→</span>
                          <span style={{ color: 'var(--danger)', fontWeight: 500 }}>
                            <i className="fas fa-sign-out-alt" style={{ marginRight: 4, fontSize: 11 }} />
                            {fmtTime12(req.clock_out_time)}
                          </span>
                        </div>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 260 }}>
                        {req.reason}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[req.status] || 'badge-secondary'}`}>
                          {req.status}
                        </span>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {new Date(req.created_at).toLocaleDateString('en-IN', {
                          day: '2-digit', month: 'short', year: 'numeric',
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Modal
        show={showModal}
        onClose={() => setShowModal(false)}
        title={member ? `Regularize for ${fullName(member)}` : 'Request Attendance Regularization'}
        width="460px"
        footer={
          <>
            <button className="btn btn-outline" onClick={() => setShowModal(false)} disabled={submitting}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
              {submitting
                ? <><div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Submitting…</>
                : <><i className="fas fa-paper-plane" /> Submit Request</>}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label className="form-label">Date *</label>
          <input type="date" className="form-input" min={regularizeMinDate(tenant)} max={todayStr()} value={form.date}
            onChange={e => setForm({ ...form, date: e.target.value })} />
          <div className="form-hint">
            You can request a correction for {regularizeWindowLabel(tenant)} only. It goes to {member ? `${member.first_name}'s` : 'your'} manager
            for approval, and HR gets a copy (either can approve).
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Correct Clock-In *</label>
            <input type="time" className="form-input" value={form.clockInTime}
              onChange={e => setForm({ ...form, clockInTime: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Correct Clock-Out *</label>
            <input type="time" className="form-input" value={form.clockOutTime}
              onChange={e => setForm({ ...form, clockOutTime: e.target.value })} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Reason *</label>
          <textarea
            className="form-input"
            rows={3}
            style={{ resize: 'none', fontSize: 13 }}
            placeholder="e.g. Forgot to clock in, device issue, worked from client site…"
            value={form.reason}
            onChange={e => setForm({ ...form, reason: e.target.value })}
          />
        </div>
      </Modal>
    </>
  );
}

export default function MyRegularizeRequestsPage() {
  return (
    <>
      <Header title="Regularize Attendance" breadcrumb="Request attendance corrections" />
      <RegularizeContent />
    </>
  );
}
