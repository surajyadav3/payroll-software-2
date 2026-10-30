import React, { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import OutletSelect from '@/components/OutletSelect';
import { showToast } from '@/components/Toast';
import BulkApproveBar, { BulkHeadCell, BulkRowCell } from '@/components/BulkApproveBar';
import { useBulkApproval } from '@/hooks/useBulkApproval';
import { useAuth } from '@/context/AuthContext';
import { useRequestOutletScope } from '@/context/OutletViewContext';
import { listAllVerificationRequests, approveVerificationRequest, rejectVerificationRequest } from '@/services/verificationRequestService';
import { getInitials, getAvatarColor, fullName, scopedToOutlet, isRaniwalaTenant, fmt } from '@/lib/helpers';
import { exportRequestSheet, fmtExportDateTime } from '@/lib/requestExport';

const FIELD_GROUP_LABEL = { bank: 'Bank Details', pan: 'PAN', aadhar: 'Aadhar', dob: 'Date of Birth' };
const FIELD_LABEL = { bank_acc: 'Account No.', bank_name: 'Bank Name', ifsc_code: 'IFSC', pan: 'PAN', aadhar: 'Aadhar', date_of_birth: 'DOB' };
const showValue = (f, v) => (v && f === 'date_of_birth' ? fmt.date(v) : v);

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
    + ', ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

// Side-by-side old → new diff per field in the group, so HR can visually
// match the change before approving rather than trusting the raw values.
function ValueDiff({ request }) {
  const fields = Object.keys(request.new_value || {});
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {fields.map((f) => {
        const oldV = request.old_value?.[f];
        const newV = request.new_value?.[f];
        const changed = oldV !== newV;
        return (
          <div key={f} style={{ fontSize: 12 }}>
            <span style={{ color: 'var(--text-muted)' }}>{FIELD_LABEL[f] || f}: </span>
            <span style={{ textDecoration: changed && oldV ? 'line-through' : 'none', color: 'var(--text-muted)' }}>
              {showValue(f, oldV) || '—'}
            </span>
            {changed && (
              <>
                <span style={{ margin: '0 4px' }}>→</span>
                <strong style={{ color: 'var(--success)' }}>{showValue(f, newV) || '—'}</strong>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function VerificationRequestsPage() {
  const { profile, tenant } = useAuth();
  const outletProfileIds = useRequestOutletScope();

  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  // Raniwala employees verify their own details (20261024_3) — this page is
  // HR's record of what they filled, so it opens on everything.
  const selfVerify = isRaniwalaTenant(tenant);
  const [statusFilter, setStatusFilter] = useState(selfVerify ? 'All' : 'Pending');
  const [acting, setActing] = useState(null);

  const fetchRequests = useCallback(async () => {
    if (!tenant || outletProfileIds === undefined) return;
    setLoading(true);
    try {
      const { data, error } = await listAllVerificationRequests(tenant.id);
      if (error) showToast(error.message, 'error');
      else setRequests(scopedToOutlet(data, outletProfileIds));
    } finally {
      setLoading(false);
    }
  }, [tenant, outletProfileIds]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const handleApprove = async (req) => {
    setActing(req.id);
    try {
      const { error } = await approveVerificationRequest(req, profile.id);
      if (error) throw error;
      showToast(`${FIELD_GROUP_LABEL[req.field_group]} approved and marked verified`, 'success');
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
      const { error } = await rejectVerificationRequest(req, profile.id);
      if (error) throw error;
      showToast('Request rejected', 'info');
      fetchRequests();
    } catch (err) {
      showToast('Reject failed: ' + err.message, 'error');
    } finally {
      setActing(null);
    }
  };

  const filtered = statusFilter === 'All' ? requests : requests.filter((r) => r.status === statusFilter);
  const pendingCount = requests.filter((r) => r.status === 'Pending').length;

  const bulk = useBulkApproval({
    rows: filtered,
    loading,
    canAct: (req) => req.status === 'Pending',
    noun: 'verification request',
    onDone: fetchRequests,
    decide: (req, approve) => (approve ? approveVerificationRequest : rejectVerificationRequest)(req, profile.id),
    confirmNote: (rows, approve) => (approve
      ? 'Approving marks these bank / PAN / Aadhar details as verified. Make sure each Old → New change has been checked.'
      : ''),
  });

  const reviewerLabel = (reviewer, req) => {
    if (req.reviewed_by && req.reviewed_by === req.profile_id) return { name: 'Self-verified', role: 'By the employee' };
    if (!reviewer) return null;
    const name = fullName(reviewer);
    const role = reviewer.role === 'admin' ? 'Admin' : reviewer.role === 'manager' ? 'Manager' : reviewer.role;
    return { name, role };
  };

  const exportList = () => {
    const values = (req, side) => Object.keys(req.new_value || {})
      .map((f) => `${FIELD_LABEL[f] || f}: ${showValue(f, req[side]?.[f]) || '—'}`).join('; ');
    exportRequestSheet(filtered.map((req) => {
      const rev = reviewerLabel(req.reviewer, req);
      return {
        'Emp Code': req.profile?.employee_id || '',
        Employee: fullName(req.profile),
        Department: req.profile?.department || '',
        Field: FIELD_GROUP_LABEL[req.field_group] || req.field_group,
        Old: values(req, 'old_value'),
        New: values(req, 'new_value'),
        Status: req.status,
        'Submitted On': fmtExportDateTime(req.created_at),
        'Reviewed By': rev ? `${rev.name} (${rev.role})` : '',
        'Reviewed On': fmtExportDateTime(req.reviewed_at),
      };
    }), {
      sheet: `${statusFilter} Verification`,
      file: `${statusFilter} verification requests`,
      widths: [10, 24, 18, 14, 40, 40, 10, 22, 28, 22],
    });
  };

  return (
    <>
      <Header
        title={selfVerify ? 'Verified Details' : 'Verification Requests'}
        breadcrumb={pendingCount > 0 ? `${pendingCount} pending` : 'All caught up'}
      />
      <div className="page-content">
        <div className="filter-bar">
          <OutletSelect />
          {['Pending', 'Approved', 'Rejected', 'All'].map((s) => (
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
          <button
            className="btn btn-sm btn-outline"
            style={{ marginLeft: 'auto' }}
            onClick={exportList}
            disabled={loading || filtered.length === 0}
          >
            <i className="fas fa-file-excel" style={{ marginRight: 6 }} />Export
          </button>
        </div>

        <div className="card">
          <BulkApproveBar bulk={bulk} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <BulkHeadCell bulk={bulk} />
                  <th>Employee</th>
                  <th>Field</th>
                  <th>Submitted On</th>
                  <th>Old → New</th>
                  <th>Status</th>
                  <th>Reviewed By</th>
                  <th>Reviewed On</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'center', padding: 40 }}>
                      <div className="spinner" style={{ margin: '0 auto' }} />
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
                      No {statusFilter !== 'All' ? statusFilter.toLowerCase() : ''} requests found.
                    </td>
                  </tr>
                ) : filtered.map((req) => {
                  const rev = reviewerLabel(req.reviewer, req);
                  return (
                    <tr key={req.id}>
                      <BulkRowCell bulk={bulk} row={req} />
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

                      <td><span className="badge badge-info">{FIELD_GROUP_LABEL[req.field_group] || req.field_group}</span></td>

                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {fmtDateTime(req.created_at)}
                      </td>

                      <td style={{ minWidth: 200 }}>
                        <ValueDiff request={req} />
                      </td>

                      <td>
                        <span className={`badge ${
                          req.status === 'Approved' ? 'badge-success'
                            : req.status === 'Rejected' ? 'badge-danger'
                            : 'badge-warning'
                        }`}>
                          {req.status}
                        </span>
                      </td>

                      <td>
                        {rev ? (
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 500 }}>{rev.name}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{rev.role}</div>
                          </div>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>
                        )}
                      </td>

                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {fmtDateTime(req.reviewed_at)}
                      </td>

                      <td>
                        {req.status === 'Pending' && (
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
                          </div>
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
    </>
  );
}
