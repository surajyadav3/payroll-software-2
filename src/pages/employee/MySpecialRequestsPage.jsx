import React, { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { listMySpecialRequests, submitSpecialRequest } from '@/services/specialRequestService';
import { fetchMyQuota, SELF_LIMIT } from '@/services/requestQuotaService';
import { fmt, todayStr, calcPayableOvertimeHours, calcOtPay } from '@/lib/helpers';

// Nothing to show once the company has turned auto-approval off entirely —
// every request just goes through the normal review chain, so a "self/manager
// quota" banner would be misleading noise rather than useful information.
function QuotaBanner({ quota, autoApprovalEnabled }) {
  if (!autoApprovalEnabled) return null;

  const { selfUsed, selfLimit, managerUsed, managerLimit } = quota;
  const selfLeft    = selfLimit    - selfUsed;
  const managerLeft = managerLimit - managerUsed;

  let color, icon, msg;
  if (selfLeft > 0) {
    color = 'var(--success)'; icon = 'fa-shield-alt';
    msg = `${selfLeft} self-approval${selfLeft !== 1 ? 's' : ''} remaining this month — your next request auto-approves instantly.`;
  } else if (managerLeft > 0) {
    color = 'var(--warning-dark, #92400e)'; icon = 'fa-user-check';
    msg = `Self-approvals used (${selfUsed}/${selfLimit}). Next request goes to Manager · ${managerLeft} manager approval${managerLeft !== 1 ? 's' : ''} available.`;
  } else {
    color = 'var(--danger)'; icon = 'fa-exclamation-circle';
    msg = `All quotas used this month (${selfUsed}/${selfLimit} self · ${managerUsed}/${managerLimit} manager). Next request goes to HR.`;
  }

  return (
    <div style={{
      background: selfLeft > 0 ? 'var(--success-light, #d1fae5)' : managerLeft > 0 ? 'var(--warning-light, #fffbeb)' : 'var(--danger-light, #fee2e2)',
      border: `1px solid ${color}`,
      borderRadius: 8, padding: '10px 16px', marginBottom: 8,
      fontSize: 13, color,
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <i className={`fas ${icon}`} />
      {msg}
    </div>
  );
}

const SALARY_OT_LIMIT = 30000;

const EMPTY_FORM = {
  request_type: 'Overtime',
  request_date: todayStr(),
  reason: '',
  late_hours: '0-10 min',
  ot_hours: 0,
  ot_minutes: 45,
};

const TYPE_BADGE = {
  Overtime: 'badge-info',
  'Salary Overtime': 'badge-purple',
  'Late Arrival': 'badge-warning',
};

function calcShiftHours(tenant) {
  if (!tenant?.shift_start || !tenant?.shift_end) return 8;
  const [sh, sm] = tenant.shift_start.split(':').map(Number);
  const [eh, em] = tenant.shift_end.split(':').map(Number);
  let from = sh * 60 + sm, to = eh * 60 + em;
  if (to <= from) to += 1440;
  return (to - from) / 60;
}

export default function MySpecialRequestsPage() {
  const { profile, tenant } = useAuth();
  // A salary-private tenant keeps the salary off the profile (employee_salaries),
  // so overtime follows the employee's own "Apply overtime" tick instead.
  const isOvertimeEligible = tenant?.salary_private
    ? !!profile?.overtime_applicable
    : (profile?.ctc || 0) > 0 && (profile?.ctc || 0) < SALARY_OT_LIMIT;
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('Pending');
  const [quota, setQuota] = useState(null);

  const autoApprovalEnabled = tenant?.special_auto_approval_enabled !== false;
  const autoApprovalLimit   = tenant?.special_auto_approval_limit ?? SELF_LIMIT;

  const fetchRequests = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    try {
      const { data, error } = await listMySpecialRequests(profile.id);
      if (error) showToast(error.message, 'error');
      else setRequests(data);
    } finally {
      setLoading(false);
    }
  }, [profile]);

  const loadQuota = useCallback(async () => {
    if (!profile || !tenant) return;
    const q = await fetchMyQuota(tenant.id, profile.id, autoApprovalEnabled ? autoApprovalLimit : 0);
    setQuota(q);
  }, [profile, tenant, autoApprovalEnabled, autoApprovalLimit]);

  useEffect(() => { fetchRequests(); loadQuota(); }, [fetchRequests, loadQuota]);

  const openModal = () => {
    setForm(EMPTY_FORM);
    setShowModal(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.reason.trim()) return showToast('Please provide a reason', 'error');
    if (!form.request_date) return showToast('Please select a date', 'error');

    setSaving(true);
    try {
      if (!tenant) throw new Error('You do not belong to any workspace. Please contact your administrator.');

      const totalOtMinutes = form.request_type === 'Salary Overtime'
        ? (parseInt(form.ot_hours, 10) || 0) * 60 + (parseInt(form.ot_minutes, 10) || 0)
        : null;
      const payableHours = totalOtMinutes != null ? calcPayableOvertimeHours(totalOtMinutes) : null;

      if (form.request_type === 'Salary Overtime' && payableHours === 0) {
        setSaving(false);
        return showToast('Minimum 45 minutes of overtime is required for this request', 'error');
      }

      const shiftHrs    = calcShiftHours(tenant);
      const storedOtPay = form.request_type === 'Salary Overtime'
        ? calcOtPay(profile?.ctc || 0, shiftHrs, payableHours)
        : null;

      const payload = {
        profile_id:       profile.id,
        tenant_id:        tenant.id,
        request_type:     form.request_type,
        request_date:     form.request_date,
        reason:           form.reason.trim(),
        status:           'Pending',
        late_hours:       form.request_type === 'Late Arrival'    ? form.late_hours : null,
        overtime_hours:   form.request_type === 'Salary Overtime' ? payableHours    : null,
        overtime_minutes: form.request_type === 'Salary Overtime' ? totalOtMinutes  : null,
        overtime_pay:     storedOtPay,
      };

      const { error, tier } = await submitSpecialRequest(payload, { autoApprovalEnabled, autoApprovalLimit });
      if (error) {
        showToast(error.message || 'Failed to submit request', 'error');
      } else {
        const msg = tier === 'self'
          ? 'Auto-approved! (self-approval used)'
          : tier === 'manager'
          ? 'Request sent to Manager for approval'
          : 'Request escalated to HR for approval';
        showToast(msg, tier === 'self' ? 'success' : 'info');
        setShowModal(false);
        setForm(EMPTY_FORM);
        fetchRequests();
        loadQuota();
      }
    } catch (err) {
      showToast(err.message || 'Something went wrong', 'error');
    } finally {
      setSaving(false);
    }
  };

  const filtered = filter === 'All'
    ? requests
    : requests.filter(r => r.request_type === filter || r.status === filter);

  return (
    <div className="page-container">
      <Header
        title="Special Requests"
        breadcrumb="My Space / Special Requests"
        actions={
          <button className="btn btn-primary" onClick={openModal}>
            <i className="fas fa-plus" /> New Request
          </button>
        }
      />

      {quota && <QuotaBanner quota={quota} autoApprovalEnabled={autoApprovalEnabled} />}

      <div className="card" style={{ marginTop: 8 }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>My Requests</h3>
          <div className="flex gap-1" style={{ flexWrap: 'wrap' }}>
            {['Pending', 'Approved', 'Rejected', 'All', 'Overtime', 'Salary Overtime', 'Late Arrival'].map(f => (
              <button
                key={f}
                className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Date</th>
                <th>Details</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Applied On</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="6" style={{ textAlign: 'center', padding: 40 }}><div className="spinner" /></td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan="6" style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No requests found.</td></tr>
              ) : filtered.map(req => (
                <tr key={req.id}>
                  <td>
                    <span className={`badge ${TYPE_BADGE[req.request_type] || 'badge-info'}`}>
                      {req.request_type}
                    </span>
                  </td>
                  <td>{fmt.date(req.request_date)}</td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {req.request_type === 'Late Arrival'
                      ? req.late_hours
                      : req.request_type === 'Salary Overtime'
                        ? (() => {
                            const m = req.overtime_minutes || 0;
                            const h = Math.floor(m / 60), min = m % 60;
                            const payable = req.overtime_hours || 0;
                            return `${h}h ${min}m worked → ${payable}h payable`;
                          })()
                        : 'Overtime day'}
                  </td>
                  <td style={{ maxWidth: 220, fontSize: 12 }}>{req.reason}</td>
                  <td>
                    <span className={`badge ${
                      req.status === 'Approved' ? 'badge-success'
                      : req.status === 'Rejected' ? 'badge-danger'
                      : 'badge-warning'
                    }`}>
                      {req.status}
                    </span>
                    {req.status === 'Approved' && req.request_type === 'Salary Overtime' && (
                      <div style={{ fontSize: 10, color: 'var(--primary)', marginTop: 2 }}>
                        {req.overtime_hours}h overtime pay approved
                      </div>
                    )}
                  </td>
                  <td>{fmt.date(req.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        show={showModal}
        onClose={() => setShowModal(false)}
        title="New Special Request"
        footer={
          <div className="flex gap-2" style={{ justifyContent: 'flex-end', width: '100%' }}>
            <button className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSubmit} disabled={saving}>
              {saving ? 'Submitting...' : 'Submit Request'}
            </button>
          </div>
        }
      >
        <div className="form-group">
          <label className="form-label">Request Type</label>
          <select
            className="form-select"
            value={form.request_type}
            onChange={e => setForm({ ...form, request_type: e.target.value })}
          >
            <option value="Overtime">Overtime</option>
            {isOvertimeEligible && (
              <option value="Salary Overtime">Salary Overtime (extra hours pay)</option>
            )}
            <option value="Late Arrival">Late Arrival</option>
          </select>
        </div>

        {form.request_type === 'Overtime' && (
          <div className="form-group">
            <label className="form-label">Date</label>
            <input type="date" className="form-input" value={form.request_date}
              onChange={e => setForm({ ...form, request_date: e.target.value })} />
          </div>
        )}

        {form.request_type === 'Salary Overtime' && (() => {
          const totalMin = (parseInt(form.ot_hours, 10) || 0) * 60 + (parseInt(form.ot_minutes, 10) || 0);
          const payable  = calcPayableOvertimeHours(totalMin);
          const shiftHrs = calcShiftHours(tenant);
          const otPay    = calcOtPay(profile?.ctc || 0, shiftHrs, payable);

          const shiftEndLabel = (() => {
            if (!tenant?.shift_end) return null;
            const [h, m] = tenant.shift_end.split(':').map(Number);
            const ap = h >= 12 ? 'PM' : 'AM';
            return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ap}`;
          })();

          return (
            <>
              {shiftEndLabel && (
                <div style={{
                  background: 'var(--primary-light, #eff6ff)',
                  border: '1px solid var(--primary)',
                  borderRadius: 8, padding: '9px 13px', fontSize: 12,
                  color: 'var(--primary)', marginBottom: 4,
                }}>
                  <i className="fas fa-info-circle" style={{ marginRight: 6 }} />
                  Overtime starts after your shift ends at <strong>{shiftEndLabel}</strong>.
                  Enter only the hours worked <em>after</em> that time.
                </div>
              )}
              <div className="form-group">
                <label className="form-label">Date of Overtime</label>
                <input type="date" className="form-input" value={form.request_date}
                  max={todayStr()}
                  onChange={e => setForm({ ...form, request_date: e.target.value })} />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Overtime Hours Worked</label>
                  <select className="form-select" value={form.ot_hours}
                    onChange={e => setForm({ ...form, ot_hours: e.target.value })}>
                    {[0,1,2,3,4,5,6,7,8].map(h => (
                      <option key={h} value={h}>{h} hr{h !== 1 ? 's' : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Extra Minutes</label>
                  <select className="form-select" value={form.ot_minutes}
                    onChange={e => setForm({ ...form, ot_minutes: e.target.value })}>
                    {[0,15,30,45].map(m => (
                      <option key={m} value={m}>{m} min</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{
                background: payable > 0 ? 'var(--success-light, #d1fae5)' : 'var(--bg)',
                border: `1px solid ${payable > 0 ? 'var(--success)' : 'var(--border)'}`,
                borderRadius: 8, padding: '12px 14px', fontSize: 13,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Actual time worked:</span>
                  <strong>{Math.floor(totalMin / 60)}h {totalMin % 60}m</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Payable hours (rounded):</span>
                  <strong style={{ color: payable > 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {payable} hr{payable !== 1 ? 's' : ''}
                  </strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 4 }}>
                  <span style={{ color: 'var(--text-muted)' }}>Estimated overtime pay:</span>
                  <strong style={{ color: 'var(--primary)', fontSize: 14 }}>
                    {payable > 0 ? fmt(otPay) : '—'}
                  </strong>
                </div>
                {payable === 0 && totalMin > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11, color: 'var(--danger)' }}>
                    <i className="fas fa-exclamation-triangle" style={{ marginRight: 4 }} />
                    Minimum 45 minutes required to count as 1 payable hour.
                  </div>
                )}
              </div>
            </>
          );
        })()}

        {form.request_type === 'Late Arrival' && (
          <>
            <div className="form-group">
              <label className="form-label">Date of Late Arrival</label>
              <input type="date" className="form-input" value={form.request_date}
                onChange={e => setForm({ ...form, request_date: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">How Late?</label>
              <select
                className="form-select"
                value={form.late_hours}
                onChange={e => setForm({ ...form, late_hours: e.target.value })}
              >
                <option value="0-10 min">0 – 10 minutes</option>
                <option value="10-30 min">10 – 30 minutes</option>
                <option value="30min-1hr">30 minutes – 1 hour</option>
                <option value="1+ hour">More than 1 hour</option>
              </select>
            </div>
            <div style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '10px 14px',
              fontSize: 12,
              color: 'var(--text-muted)',
            }}>
              <i className="fas fa-info-circle" style={{ marginRight: 6 }} />
              If approved, you will be paid for the full day with no deduction.
            </div>
          </>
        )}

        <div className="form-group" style={{ marginTop: 12 }}>
          <label className="form-label">Reason</label>
          <textarea
            className="form-input"
            rows="3"
            placeholder="Please provide a brief reason for your request..."
            value={form.reason}
            onChange={e => setForm({ ...form, reason: e.target.value })}
          />
        </div>
      </Modal>
    </div>
  );
}
