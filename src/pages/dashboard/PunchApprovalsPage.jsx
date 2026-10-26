import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Header from '@/components/Header';
import OutletSelect from '@/components/OutletSelect';
import { showToast } from '@/components/Toast';
import { useOutletView } from '@/context/OutletViewContext';
import { listPunchApprovals, reviewPunches } from '@/services/punchApprovalService';
import { fmt, fmtTime12, getInitials, getAvatarColor, scopedToOutlet } from '@/lib/helpers';

const STATUS_FILTERS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
];

const STATUS_BADGE = { pending: 'badge-warning', approved: 'badge-success', rejected: 'badge-danger' };

// Punches made from the phone / website by staff whose outlet punches on the
// ESSL machine. Their hours only count once approved here. One row per
// employee per day, so a clock-in and clock-out are reviewed together.
export default function PunchApprovalsPage() {
  const { outletProfileIds } = useOutletView();
  const [status, setStatus] = useState('pending');
  const [punches, setPunches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null);

  const fetchPunches = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await listPunchApprovals(status);
      if (error) throw error;
      setPunches(scopedToOutlet(data, outletProfileIds));
    } catch (err) {
      showToast('Failed to load punches: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [status, outletProfileIds]);

  useEffect(() => { fetchPunches(); }, [fetchPunches]);

  const days = useMemo(() => {
    const byDay = new Map();
    punches.forEach((p) => {
      if (!byDay.has(p.attendance_id)) byDay.set(p.attendance_id, { ...p, punches: [] });
      byDay.get(p.attendance_id).punches.push(p);
    });
    return [...byDay.values()].map((d) => ({
      ...d,
      punches: d.punches.sort((a, b) => a.punch_time.localeCompare(b.punch_time)),
      pendingIds: d.punches.filter((p) => p.approval_status === 'pending').map((p) => p.punch_id),
    }));
  }, [punches]);

  const review = async (key, punchIds, approve) => {
    setActing(key);
    try {
      const { error } = await reviewPunches(punchIds, approve);
      if (error) throw error;
      showToast(approve ? 'Approved — hours now count in attendance and payroll' : 'Rejected — those punches won\'t count', approve ? 'success' : 'info');
      fetchPunches();
    } catch (err) {
      showToast((approve ? 'Approve' : 'Reject') + ' failed: ' + err.message, 'error');
    } finally {
      setActing(null);
    }
  };

  const pendingDays = status === 'pending' ? days.length : null;

  return (
    <>
      <Header
        title="Punch Approvals"
        breadcrumb={pendingDays == null ? 'App & web punches' : pendingDays ? `${pendingDays} day${pendingDays > 1 ? 's' : ''} waiting` : 'All caught up'}
      />
      <div className="page-content">
        <div className="filter-bar">
          <OutletSelect />
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.key}
              className={`btn btn-sm ${status === s.key ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setStatus(s.key)}
            >
              {s.label}
            </button>
          ))}
          <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
            <i className="fas fa-info-circle" style={{ marginRight: 6 }} />
            Punches made from the app or website. Hours count only after approval.
          </span>
        </div>

        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Date</th>
                  <th>Punches</th>
                  <th>Approver</th>
                  <th>Reviewed</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: 40 }}><div className="spinner" style={{ margin: '0 auto' }} /></td></tr>
                ) : days.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
                    No {status !== 'all' ? status : ''} punches.
                  </td></tr>
                ) : days.map((d) => {
                  const reviewed = d.punches.find((p) => p.reviewed_at);
                  return (
                    <tr key={d.attendance_id}>
                      <td>
                        <div className="emp-cell">
                          <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(d.profile_id)})` }}>
                            {getInitials(...(d.employee_name || '').split(' '))}
                          </div>
                          <div>
                            <div className="emp-name">{d.employee_name}</div>
                            <div className="emp-role">{[d.employee_code, d.department, d.outlet_name].filter(Boolean).join(' · ')}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmt.date(d.date)}</td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {d.punches.map((p) => (
                            <div key={p.punch_id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                              <span style={{ width: 28, color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: 11 }}>{p.punch_type}</span>
                              <strong style={{ fontFamily: 'monospace' }}>{fmtTime12(p.punch_time)}</strong>
                              <span className={`badge ${STATUS_BADGE[p.approval_status]}`}>{p.approval_status}</span>
                              {p.lat != null && p.lng != null && (
                                <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer" title="Where this punch was made">
                                  <i className="fas fa-map-marker-alt" />
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      </td>
                      <td style={{ fontSize: 13 }}>{d.approver_name || <span style={{ color: 'var(--text-muted)' }}>HR</span>}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {reviewed ? (
                          <>
                            <div style={{ color: 'var(--text)' }}>{reviewed.reviewed_by_name}</div>
                            {new Date(reviewed.reviewed_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })}
                          </>
                        ) : '—'}
                      </td>
                      <td>
                        {d.pendingIds.length > 0 && (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              className="btn btn-sm btn-success"
                              title={`Approve ${d.pendingIds.length > 1 ? 'both punches' : 'punch'}`}
                              disabled={acting === d.attendance_id}
                              onClick={() => review(d.attendance_id, d.pendingIds, true)}
                            >
                              <i className="fas fa-check" /> Approve
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              title="Reject"
                              disabled={acting === d.attendance_id}
                              onClick={() => review(d.attendance_id, d.pendingIds, false)}
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
