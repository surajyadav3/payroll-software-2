import React, { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import OutletSelect from '@/components/OutletSelect';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import BulkApproveBar, { BulkHeadCell, BulkRowCell } from '@/components/BulkApproveBar';
import { useBulkApproval } from '@/hooks/useBulkApproval';
import { useAuth } from '@/context/AuthContext';
import { useRequestOutletScope } from '@/context/OutletViewContext';
import {
  listRegularizeRequests, approveRegularizeRequest, rejectRegularizeRequest,
  regularizeAttendance, updateRegularizeRequestTimes,
} from '@/services/attendanceService';
import { listActiveEmployees } from '@/services/employeeService';
import { fmt, getInitials, getAvatarColor, todayStr, fullName, scopedToOutlet, matchesSearch } from '@/lib/helpers';
import { exportRequestSheet, fmtExportDateTime, approverRoleLabel } from '@/lib/requestExport';

export default function RegularizeAttendancePage() {
  const { profile, tenant } = useAuth();
  const outletProfileIds = useRequestOutletScope();
  const isAdmin   = profile?.role === 'admin' || profile?.role === 'superadmin';

  const [requests,   setRequests]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [statusFilter, setStatusFilter] = useState('Pending');
  const [search,     setSearch]     = useState('');
  const [acting,    setActing]     = useState(null); // request id being approved/rejected

  // Bulk regularize (admin only)
  const [showBulk,   setShowBulk]   = useState(false);
  const [employees,  setEmployees]  = useState([]);
  const [selectedEmps, setSelectedEmps] = useState([]);
  const [bulkForm,   setBulkForm]   = useState({
    fromDate: todayStr(), toDate: todayStr(),
    status: 'Present', clockInTime: '', clockOutTime: '', reason: '',
  });

  // Pre-fill shift times when bulk modal opens
  const openBulk = () => {
    setBulkForm(f => ({
      ...f,
      clockInTime:  tenant?.shift_start || f.clockInTime,
      clockOutTime: tenant?.shift_end   || f.clockOutTime,
    }));
    setShowBulk(true);
  };
  const [submitting, setSubmitting] = useState(false);

  const isManager = profile?.role === 'manager';

  const fetchRequests = useCallback(async () => {
    if (!tenant || outletProfileIds === undefined) return;
    setLoading(true);
    try {
      // Everyone sees every regularize request tenant-wide (any status, any
      // approval tier) so managers stay aware of auto-approved / admin-approved
      // requests too -- only the ability to act on one is role-gated below.
      const { data, error } = await listRegularizeRequests(tenant.id);
      if (error) showToast(error.message, 'error');
      else setRequests(scopedToOutlet(data, outletProfileIds));
    } finally {
      setLoading(false);
    }
  }, [tenant, isManager, outletProfileIds]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  useEffect(() => {
    if (!showBulk || !tenant) return;
    listActiveEmployees(tenant.id).then(({ data }) => setEmployees(scopedToOutlet(data, outletProfileIds, 'id')));
  }, [showBulk, tenant, outletProfileIds]);

  const handleApprove = async (req) => {
    setActing(req.id);
    try {
      const { error } = await approveRegularizeRequest(req, profile.id, profile.role);
      if (error) throw error;
      showToast('Request approved and attendance updated', 'success');
      fetchRequests();
    } catch (err) {
      showToast('Approve failed: ' + err.message, 'error');
    } finally {
      setActing(null);
    }
  };

  const handleReject = async (req) => {
    setActing(req.id);
    try {
      const { error } = await rejectRegularizeRequest(req.id, profile.id);
      if (error) throw error;
      showToast('Request rejected', 'info');
      fetchRequests();
    } catch (err) {
      showToast('Reject failed: ' + err.message, 'error');
    } finally {
      setActing(null);
    }
  };

  // HR edits a pending request's times (e.g. an AM / PM slip) before approving.
  const [editReq, setEditReq]   = useState(null);
  const [editForm, setEditForm] = useState({ clockInTime: '', clockOutTime: '' });
  const [savingEdit, setSavingEdit] = useState(false);

  const openEdit = (req) => {
    setEditForm({
      clockInTime:  (req.clock_in_time  || '').slice(0, 5),
      clockOutTime: (req.clock_out_time || '').slice(0, 5),
    });
    setEditReq(req);
  };

  const handleSaveEdit = async () => {
    const { clockInTime, clockOutTime } = editForm;
    if (!clockInTime || !clockOutTime) return showToast('Enter both Clock In and Clock Out', 'error');
    if (clockOutTime <= clockInTime) return showToast('Clock Out must be later than Clock In. Please check AM / PM.', 'error');
    setSavingEdit(true);
    try {
      const { error } = await updateRegularizeRequestTimes(editReq.id, clockInTime, clockOutTime);
      if (error) throw error;
      showToast('Times updated. Approve the request to apply them.', 'success');
      setEditReq(null);
      fetchRequests();
    } catch (err) {
      showToast('Could not update times: ' + err.message, 'error');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleBulkRegularize = async () => {
    if (!bulkForm.fromDate || !bulkForm.toDate) return showToast('Select a date range', 'error');
    if (selectedEmps.length === 0) return showToast('Select at least one employee', 'error');
    if (!bulkForm.reason.trim()) return showToast('Reason is required', 'error');
    setSubmitting(true);
    try {
      const result = await regularizeAttendance(tenant.id, {
        fromDate: bulkForm.fromDate, toDate: bulkForm.toDate,
        employeeIds: selectedEmps, status: bulkForm.status,
        clockInTime: bulkForm.clockInTime || null,
        clockOutTime: bulkForm.clockOutTime || null,
        reason: bulkForm.reason, changedBy: profile.id,
      });
      showToast(`Regularized ${result.recordsUpdated} record(s)`, 'success');
      setShowBulk(false);
      setSelectedEmps([]);
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const filtered = requests.filter(r =>
    (statusFilter === 'All' || r.status === statusFilter)
    && matchesSearch(search, fullName(r.profile), r.profile?.employee_id, r.profile?.department, r.profile?.designation));

  const pendingCount = requests.filter(r => r.status === 'Pending').length;

  const bulk = useBulkApproval({
    rows: filtered,
    loading,
    // Same gate as the per-row buttons below.
    canAct: (req) => req.status === 'Pending' && (!isManager || req.required_approver_role === 'manager'),
    onDone: fetchRequests,
    decide: (req, approve) => (approve
      ? approveRegularizeRequest(req, profile.id, profile.role)
      : rejectRegularizeRequest(req.id, profile.id)),
  });

  const fmtTime12 = (t) => {
    if (!t) return '—';
    const [h, m] = t.split(':');
    const ap = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${m} ${ap}`;
  };

  const fmtDateTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      + ', ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  };

  const reviewerLabel = (reviewer) => {
    if (!reviewer) return null;
    const name = fullName(reviewer);
    const role = reviewer.role === 'admin' ? 'HR' : reviewer.role === 'manager' ? 'Manager'
      : reviewer.role === 'hod' ? 'HOD' : reviewer.role;
    return { name, role };
  };

  const exportList = () => {
    const pending = statusFilter === 'Pending';
    exportRequestSheet(filtered.map((req) => {
      const rev = reviewerLabel(req.reviewer);
      return {
        'Emp Code': req.profile?.employee_id || '',
        Employee: fullName(req.profile),
        Department: req.profile?.department || '',
        Designation: req.profile?.designation || '',
        'Attendance Date': fmt.date(req.date),
        'Clock In': req.clock_in_time ? fmtTime12(req.clock_in_time) : '',
        'Clock Out': req.clock_out_time ? fmtTime12(req.clock_out_time) : '',
        Reason: req.reason || '',
        Status: req.status,
        'Submitted On': fmtExportDateTime(req.created_at),
        ...(pending
          ? { 'Waiting On': approverRoleLabel(req.required_approver_role) }
          : {
            'Reviewed By': req.approval_level === 'self' ? 'Auto-approved' : rev ? `${rev.name} (${rev.role})` : '',
            'Reviewed On': fmtExportDateTime(req.reviewed_at),
          }),
      };
    }), {
      sheet: `${statusFilter} Regularize`,
      file: `${statusFilter} regularize requests`,
      widths: [10, 24, 18, 18, 14, 10, 10, 40, 10, 22, ...(pending ? [14] : [28, 22])],
    });
  };

  return (
    <>
      <Header
        title="Regularization Requests"
        breadcrumb={pendingCount > 0 ? `${pendingCount} pending` : 'All caught up'}
      />
      <div className="page-content">
        <div className="filter-bar">
          <OutletSelect />
          {['Pending', 'Approved', 'Rejected', 'All'].map(s => (
            <button
              key={s}
              className={`btn btn-sm ${statusFilter === s ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setStatusFilter(s)}
            >
              {s}
              {s === 'Pending' && pendingCount > 0 && (
                <span style={{
                  marginLeft: 6, background: 'var(--danger)', color: '#fff',
                  borderRadius: 10, padding: '1px 6px', fontSize: 11,
                }}>
                  {pendingCount}
                </span>
              )}
            </button>
          ))}
          <input
            className="form-input"
            style={{ maxWidth: 220 }}
            placeholder="Search employee, EMP code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className="btn btn-sm btn-outline"
            style={{ marginLeft: 'auto' }}
            onClick={exportList}
            disabled={loading || filtered.length === 0}
          >
            <i className="fas fa-file-excel" style={{ marginRight: 6 }} />Export
          </button>
          {isAdmin && (
            <button className="btn btn-outline" onClick={openBulk}>
              <i className="fas fa-edit" /> Bulk Regularize
            </button>
          )}
        </div>

        <div className="card">
          <BulkApproveBar bulk={bulk} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <BulkHeadCell bulk={bulk} />
                  <th>Employee</th>
                  <th>Submitted On</th>
                  <th>Attendance Date</th>
                  <th>Requested Times</th>
                  <th>Reason</th>
                  <th>Status</th>
                  <th>Reviewed By</th>
                  <th>Reviewed On</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', padding: 40 }}>
                      <div className="spinner" style={{ margin: '0 auto' }} />
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
                      No {statusFilter !== 'All' ? statusFilter.toLowerCase() : ''} requests found{search.trim() ? ` for "${search.trim()}"` : ''}.
                    </td>
                  </tr>
                ) : filtered.map(req => {
                  const rev = reviewerLabel(req.reviewer);
                  return (
                    <tr key={req.id}>
                      <BulkRowCell bulk={bulk} row={req} />
                      {/* Employee */}
                      <td>
                        <div className="emp-cell">
                          <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(req.profile_id)})` }}>
                            {getInitials(req.profile?.first_name, req.profile?.last_name)}
                          </div>
                          <div>
                            <div className="emp-name">{fullName(req.profile)}</div>
                            <div className="emp-role">{req.profile?.department}</div>
                          </div>
                        </div>
                      </td>

                      {/* Submitted on (created_at) */}
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {fmtDateTime(req.created_at)}
                      </td>

                      {/* Attendance date */}
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <strong style={{ fontSize: 13 }}>
                          {new Date(req.date + 'T00:00:00').toLocaleDateString('en-IN', {
                            day: '2-digit', month: 'short', year: 'numeric',
                          })}
                        </strong>
                      </td>

                      {/* Requested clock-in → clock-out */}
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span style={{ fontSize: 13, color: 'var(--success)', fontWeight: 500 }}>
                          <i className="fas fa-sign-in-alt" style={{ marginRight: 4, fontSize: 11 }} />
                          {fmtTime12(req.clock_in_time)}
                        </span>
                        <span style={{ margin: '0 5px', color: 'var(--text-muted)' }}>→</span>
                        <span style={{ fontSize: 13, color: 'var(--danger)', fontWeight: 500 }}>
                          <i className="fas fa-sign-out-alt" style={{ marginRight: 4, fontSize: 11 }} />
                          {fmtTime12(req.clock_out_time)}
                        </span>
                        {req.clock_in_time && req.clock_out_time && req.clock_out_time <= req.clock_in_time && (
                          <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 2 }}>
                            <i className="fas fa-exclamation-triangle" style={{ marginRight: 4 }} />
                            Clock Out before Clock In - check AM / PM
                          </div>
                        )}
                      </td>

                      {/* Reason */}
                      <td style={{ maxWidth: 200, fontSize: 12, color: 'var(--text-secondary)' }} title={req.reason}>
                        {req.reason}
                      </td>

                      {/* Status */}
                      <td>
                        <span className={`badge ${
                          req.status === 'Approved' ? 'badge-success'
                            : req.status === 'Rejected' ? 'badge-danger'
                            : 'badge-warning'
                        }`}>
                          {req.status}
                        </span>
                      </td>

                      {/* Reviewed by — name + role tag */}
                      <td>
                        {req.approval_level === 'self' ? (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Auto-approved</span>
                        ) : rev ? (
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 500 }}>{rev.name}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{rev.role}</div>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                        )}
                      </td>

                      {/* Reviewed on (reviewed_at) */}
                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {fmtDateTime(req.reviewed_at)}
                      </td>

                      {/* Actions */}
                      <td>
                        {req.status === 'Pending' && (!isManager || req.required_approver_role === 'manager') && (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              className="btn btn-sm btn-success"
                              title="Approve"
                              disabled={acting === req.id || bulk.busy}
                              onClick={() => handleApprove(req)}
                            >
                              {acting === req.id
                                ? <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                                : <i className="fas fa-check" />}
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              title="Reject"
                              disabled={acting === req.id || bulk.busy}
                              onClick={() => handleReject(req)}
                            >
                              <i className="fas fa-times" />
                            </button>
                            {isAdmin && (
                              <button
                                className="btn btn-sm btn-outline"
                                title="Edit times"
                                disabled={acting === req.id || bulk.busy}
                                onClick={() => openEdit(req)}
                              >
                                <i className="fas fa-pen" />
                              </button>
                            )}
                          </div>
                        )}
                        {req.status === 'Pending' && isManager && req.required_approver_role !== 'manager' && (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            Awaiting {req.required_approver_role === 'admin' ? 'HR' : req.required_approver_role}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Edit a pending request's times — admin only */}
      {isAdmin && (
        <Modal
          show={!!editReq}
          onClose={() => setEditReq(null)}
          title="Edit Request Times"
          width="440px"
          footer={
            <>
              <button className="btn btn-outline" onClick={() => setEditReq(null)} disabled={savingEdit}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSaveEdit} disabled={savingEdit}>
                {savingEdit
                  ? <><div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Saving…</>
                  : <><i className="fas fa-save" /> Save times</>}
              </button>
            </>
          }
        >
          {editReq && (
            <>
              <div style={{ fontSize: 13, marginBottom: 12 }}>
                <strong>{fullName(editReq.profile)}</strong>
                {editReq.profile?.employee_id ? ` (${editReq.profile.employee_id})` : ''} ·{' '}
                {new Date(editReq.date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
                  Requested {fmtTime12(editReq.clock_in_time)} → {fmtTime12(editReq.clock_out_time)}
                </div>
                {editReq.reason && (
                  <div style={{ color: 'var(--text-secondary)', marginTop: 4 }}>Reason: {editReq.reason}</div>
                )}
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Clock In *</label>
                  <input type="time" className="form-input" value={editForm.clockInTime}
                    onChange={e => setEditForm({ ...editForm, clockInTime: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Clock Out *</label>
                  <input type="time" className="form-input" value={editForm.clockOutTime}
                    onChange={e => setEditForm({ ...editForm, clockOutTime: e.target.value })} />
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Saving only changes the times. Approve the request afterwards to apply them to the day.
              </div>
            </>
          )}
        </Modal>
      )}

      {/* Bulk Regularize Modal — admin only */}
      {isAdmin && (
        <Modal
          show={showBulk}
          onClose={() => setShowBulk(false)}
          title="Bulk Regularize Attendance"
          width="620px"
          footer={
            <>
              <button className="btn btn-outline" onClick={() => setShowBulk(false)} disabled={submitting}>Cancel</button>
              <button className="btn btn-primary" onClick={handleBulkRegularize} disabled={submitting}>
                {submitting
                  ? <><div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Applying…</>
                  : <><i className="fas fa-check" /> Regularize ({selectedEmps.length})</>}
              </button>
            </>
          }
        >
          <div style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 8 }}>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">From Date *</label>
                <input type="date" className="form-input" max={todayStr()} value={bulkForm.fromDate}
                  onChange={e => setBulkForm({ ...bulkForm, fromDate: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">To Date *</label>
                <input type="date" className="form-input" max={todayStr()} value={bulkForm.toDate}
                  onChange={e => setBulkForm({ ...bulkForm, toDate: e.target.value })} />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Status *</label>
              <select className="form-select" value={bulkForm.status}
                onChange={e => setBulkForm({ ...bulkForm, status: e.target.value })}>
                {['Present', 'Late', 'Half Day', 'Absent', 'Leave'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Clock In</label>
                <input type="time" className="form-input" value={bulkForm.clockInTime}
                  onChange={e => setBulkForm({ ...bulkForm, clockInTime: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">Clock Out</label>
                <input type="time" className="form-input" value={bulkForm.clockOutTime}
                  onChange={e => setBulkForm({ ...bulkForm, clockOutTime: e.target.value })} />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Reason *</label>
              <textarea className="form-input" rows={2} style={{ resize: 'none', fontSize: 13 }}
                value={bulkForm.reason} onChange={e => setBulkForm({ ...bulkForm, reason: e.target.value })}
                placeholder="e.g. Work from home, site visit…" />
            </div>

            <div className="form-group">
              <label className="form-label">Select Employees</label>
              <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 10 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
                  <input type="checkbox"
                    checked={selectedEmps.length === employees.length && employees.length > 0}
                    onChange={() => setSelectedEmps(
                      selectedEmps.length === employees.length ? [] : employees.map(e => e.id)
                    )}
                  />
                  <strong style={{ fontSize: 12 }}>Select All</strong>
                </label>
                {employees.map(emp => (
                  <label key={emp.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer' }}>
                    <input type="checkbox"
                      checked={selectedEmps.includes(emp.id)}
                      onChange={() => setSelectedEmps(prev =>
                        prev.includes(emp.id) ? prev.filter(id => id !== emp.id) : [...prev, emp.id]
                      )}
                    />
                    <div className="emp-avatar" style={{ width: 24, height: 24, fontSize: 10, background: `linear-gradient(135deg, ${getAvatarColor(emp.id)})` }}>
                      {getInitials(emp.first_name, emp.last_name)}
                    </div>
                    <span style={{ fontSize: 13 }}>{fullName(emp)}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{emp.department}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
