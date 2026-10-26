import React, { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import OutletSelect from '@/components/OutletSelect';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { listAllSpecialRequests, updateSpecialRequestStatus } from '@/services/specialRequestService';
import { fmt, fullName, scopedToOutlet } from '@/lib/helpers';

const TYPE_BADGE = {
  Overtime: 'badge-info',
  'Salary Overtime': 'badge-purple',
  'Late Arrival': 'badge-warning',
};

function getOtPay(req) {
  if (req.overtime_pay > 0) return Number(req.overtime_pay);
  const payable = req.overtime_hours || 0;
  const ctc     = req.profile?.ctc   || 0;
  if (!payable || !ctc) return 0;
  return Math.round((ctc * 0.5) / 30 / 8 * payable);
}

export default function SpecialRequestsPage() {
  const { tenant, profile } = useAuth();
  const { outletProfileIds } = useOutletView();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('Pending');
  const [typeFilter, setTypeFilter] = useState('All');
  const [acting, setActing] = useState(null); // id of the request currently being approved/rejected

  const isManager = profile?.role === 'manager';

  const fetchRequests = useCallback(async () => {
    if (!tenant) return;
    setLoading(true);
    try {
      // Everyone sees every special request tenant-wide (any status, any
      // approval tier) so managers stay aware of auto-approved / admin-approved
      // requests too -- only the ability to act on one is role-gated below.
      const { data, error } = await listAllSpecialRequests(tenant.id);
      if (error) showToast(error.message, 'error');
      else setRequests(scopedToOutlet(data, outletProfileIds));
    } finally {
      setLoading(false);
    }
  }, [tenant, isManager, outletProfileIds]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const handleStatusChange = async (id, status) => {
    if (acting) return;
    setActing(id);
    try {
      const { error } = await updateSpecialRequestStatus(id, status, profile.id, profile.role);
      if (error) showToast(error.message, 'error');
      else {
        showToast(`Request ${status.toLowerCase()} successfully`, 'success');
        fetchRequests();
      }
    } finally {
      setActing(null);
    }
  };

  const filtered = requests.filter(r => {
    const matchStatus = statusFilter === 'All' || r.status === statusFilter;
    const matchType   = typeFilter   === 'All' || r.request_type === typeFilter;
    return matchStatus && matchType;
  });

  const pending = requests.filter(r => r.status === 'Pending').length;

  return (
    <div className="page-container">
      <Header title="Special Requests" breadcrumb="Dashboard / Special Requests" />

      {pending > 0 && (
        <div style={{
          background: 'var(--warning-light, #fffbeb)',
          border: '1px solid var(--warning)',
          borderRadius: 8,
          padding: '10px 16px',
          marginTop: 16,
          fontSize: 13,
          color: 'var(--warning-dark, #92400e)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <i className="fas fa-clock" />
          {pending} pending request{pending !== 1 ? 's' : ''} awaiting your approval.
          {' '}Late Arrival → full-day pay. Salary Overtime → overtime pay added to payroll.
        </div>
      )}

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0 }}>
            Requests
            {filtered.length > 0 && <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>({filtered.length})</span>}
          </h3>
          <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
            <OutletSelect />
            <div className="flex gap-1">
              {['Pending', 'Approved', 'Rejected', 'All'].map(s => (
                <button
                  key={s}
                  className={`btn btn-sm ${statusFilter === s ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setStatusFilter(s)}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex gap-1" style={{ borderLeft: '1px solid var(--border)', paddingLeft: 8 }}>
              {['All', 'Overtime', 'Salary Overtime', 'Late Arrival'].map(t => (
                <button
                  key={t}
                  className={`btn btn-sm ${typeFilter === t ? 'btn-secondary' : 'btn-outline'}`}
                  onClick={() => setTypeFilter(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Type</th>
                <th>Date</th>
                <th>Details</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="7" style={{ textAlign: 'center', padding: 40 }}><div className="spinner" /></td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan="7" style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No requests found.</td></tr>
              ) : filtered.map(req => (
                <tr key={req.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {fullName(req.profile)}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{req.profile?.department}</div>
                  </td>
                  <td>
                    <span className={`badge ${TYPE_BADGE[req.request_type] || 'badge-info'}`}>
                      {req.request_type}
                    </span>
                  </td>
                  <td>{fmt.date(req.request_date)}</td>
                  <td style={{ fontSize: 12 }}>
                    {req.request_type === 'Late Arrival' ? (
                      <span><i className="fas fa-clock" style={{ marginRight: 4 }} />{req.late_hours}</span>
                    ) : req.request_type === 'Salary Overtime' ? (() => {
                      const m       = req.overtime_minutes || 0;
                      const h       = Math.floor(m / 60), min = m % 60;
                      const payable = req.overtime_hours || 0;
                      const otPay   = getOtPay(req);
                      return (
                        <span>
                          <i className="fas fa-business-time" style={{ marginRight: 4 }} />
                          {h}h {min}m worked → {payable}h payable
                          {otPay > 0 && (
                            <span style={{ display: 'block', color: 'var(--primary)', fontWeight: 600, marginTop: 2 }}>
                              Est. {fmt(otPay)}
                            </span>
                          )}
                        </span>
                      );
                    })() : (
                      <span><i className="fas fa-business-time" style={{ marginRight: 4 }} />Overtime day</span>
                    )}
                  </td>
                  <td style={{ maxWidth: 200, fontSize: 12 }} title={req.reason}>{req.reason}</td>
                  <td>
                    <span className={`badge ${
                      req.status === 'Approved' ? 'badge-success'
                      : req.status === 'Rejected' ? 'badge-danger'
                      : 'badge-warning'
                    }`}>
                      {req.status}
                    </span>
                    {req.status !== 'Pending' && req.approval_level === 'self' && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                        Auto-approved
                      </div>
                    )}
                    {req.status !== 'Pending' && req.approval_level !== 'self' && req.approver && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                        By: {req.approver.first_name}
                      </div>
                    )}
                    {req.status === 'Approved' && req.request_type === 'Salary Overtime' && (
                      <div style={{ fontSize: 10, color: 'var(--primary)', marginTop: 2 }}>
                        {fmt(getOtPay(req))} added to payroll
                      </div>
                    )}
                  </td>
                  <td>
                    {req.status === 'Pending' && (!isManager || req.required_approver_role === 'manager') && (
                      <div className="flex gap-1">
                        <button
                          className="btn btn-sm btn-success"
                          title={
                            req.request_type === 'Salary Overtime'
                              ? `Approve — ${req.overtime_hours || 0}h overtime pay (est. ${fmt(getOtPay(req))})`
                              : req.request_type === 'Late Arrival'
                                ? 'Approve — full day, no deduction'
                                : 'Approve'
                          }
                          disabled={acting === req.id}
                          onClick={() => handleStatusChange(req.id, 'Approved')}
                        >
                          <i className="fas fa-check" />
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          title="Reject"
                          disabled={acting === req.id}
                          onClick={() => handleStatusChange(req.id, 'Rejected')}
                        >
                          <i className="fas fa-times" />
                        </button>
                      </div>
                    )}
                    {req.status === 'Pending' && isManager && req.required_approver_role !== 'manager' && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                        Awaiting {req.required_approver_role === 'admin' ? 'HR' : req.required_approver_role}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
