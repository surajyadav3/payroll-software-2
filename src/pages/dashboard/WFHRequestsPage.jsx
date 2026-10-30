import React, { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import OutletSelect from '@/components/OutletSelect';
import { showToast } from '@/components/Toast';
import BulkApproveBar, { BulkHeadCell, BulkRowCell } from '@/components/BulkApproveBar';
import { useBulkApproval } from '@/hooks/useBulkApproval';
import { useAuth } from '@/context/AuthContext';
import { useRequestOutletScope } from '@/context/OutletViewContext';
import { listAllWfhRequests, approveWfhRequest, rejectWfhRequest } from '@/services/wfhService';
import { fmt, getInitials, getAvatarColor, fullName, scopedToOutlet, matchesSearch } from '@/lib/helpers';
import { exportRequestSheet, fmtExportDateTime } from '@/lib/requestExport';

export default function WFHRequestsPage() {
  const { profile, tenant } = useAuth();
  const outletProfileIds = useRequestOutletScope();

  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('Pending');
  const [search, setSearch] = useState('');
  const [acting, setActing] = useState(null);

  const fetchRequests = useCallback(async () => {
    if (!tenant || outletProfileIds === undefined) return;
    setLoading(true);
    try {
      const { data, error } = await listAllWfhRequests(tenant.id);
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
      const { error } = await approveWfhRequest(req.id, profile.id);
      if (error) throw error;
      showToast('WFH request approved — geofencing will be bypassed for those dates', 'success');
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
      const { error } = await rejectWfhRequest(req.id, profile.id);
      if (error) throw error;
      showToast('Request rejected', 'info');
      fetchRequests();
    } catch (err) {
      showToast('Reject failed: ' + err.message, 'error');
    } finally {
      setActing(null);
    }
  };

  const filtered = requests.filter((r) =>
    (statusFilter === 'All' || r.status === statusFilter)
    && matchesSearch(search, fullName(r.profile), r.profile?.employee_id, r.profile?.department, r.profile?.designation));
  const pendingCount = requests.filter((r) => r.status === 'Pending').length;

  const bulk = useBulkApproval({
    rows: filtered,
    loading,
    canAct: (req) => req.status === 'Pending',
    noun: 'WFH request',
    onDone: fetchRequests,
    decide: (req, approve) => (approve ? approveWfhRequest : rejectWfhRequest)(req.id, profile.id),
  });

  const fmtDateTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
      + ', ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  };

  const reviewerLabel = (reviewer) => {
    if (!reviewer) return null;
    const name = fullName(reviewer);
    const role = reviewer.role === 'admin' ? 'Admin' : reviewer.role === 'manager' ? 'Manager' : reviewer.role;
    return { name, role };
  };

  const exportList = () => {
    exportRequestSheet(filtered.map((req) => {
      const rev = reviewerLabel(req.reviewer);
      return {
        'Emp Code': req.profile?.employee_id || '',
        Employee: fullName(req.profile),
        Department: req.profile?.department || '',
        Designation: req.profile?.designation || '',
        From: fmt.date(req.from_date),
        To: fmt.date(req.to_date),
        Reason: req.reason || '',
        Status: req.status,
        'Submitted On': fmtExportDateTime(req.created_at),
        'Reviewed By': rev ? `${rev.name} (${rev.role})` : '',
        'Reviewed On': fmtExportDateTime(req.reviewed_at),
      };
    }), {
      sheet: `${statusFilter} WFH`,
      file: `${statusFilter} wfh requests`,
      widths: [10, 24, 18, 18, 13, 13, 40, 10, 22, 28, 22],
    });
  };

  return (
    <>
      <Header
        title="Work From Home Requests"
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
                  <th>Date Range</th>
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
                    <td colSpan={8} style={{ textAlign: 'center', padding: 40 }}>
                      <div className="spinner" style={{ margin: '0 auto' }} />
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
                      No {statusFilter !== 'All' ? statusFilter.toLowerCase() : ''} requests found{search.trim() ? ` for "${search.trim()}"` : ''}.
                    </td>
                  </tr>
                ) : filtered.map((req) => {
                  const rev = reviewerLabel(req.reviewer);
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

                      <td style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {fmtDateTime(req.created_at)}
                      </td>

                      <td style={{ whiteSpace: 'nowrap', fontSize: 13 }}>
                        <strong>{fmt.date(req.from_date)}</strong>
                        <span style={{ margin: '0 5px', color: 'var(--text-muted)' }}>→</span>
                        <strong>{fmt.date(req.to_date)}</strong>
                      </td>

                      <td style={{ maxWidth: 220, fontSize: 12, color: 'var(--text-secondary)' }} title={req.reason}>
                        {req.reason}
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
