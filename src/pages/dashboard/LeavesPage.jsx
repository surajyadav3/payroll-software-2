import React, { useEffect, useMemo, useState } from 'react';
import Header from '@/components/Header';
import OutletSelect from '@/components/OutletSelect';
import StatCard from '@/components/StatCard';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import {
  listAllLeaveRequests, updateLeaveStatus, decideLeaveStage, myLeaveStage,
} from '@/services/leaveService';
import { fmt, fullName, getInitials, getAvatarColor, scopedToOutlet, isRaniwalaTenant } from '@/lib/helpers';

const STATUS_FILTERS = ['Pending', 'Approved', 'Rejected', 'All'];

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

// Raniwala approval chain, in order. Each stage has its own status/decider
// columns; 'Not Required' stages are hidden.
const STAGES = [
  { key: 'manager',    label: 'Manager',    status: 'manager_status',    decider: 'manager_decider',    at: 'manager_decided_at',    assignee: 'stage_manager' },
  { key: 'hod',        label: 'HOD',        status: 'hod_status',        decider: 'hod_decider',        at: 'hod_decided_at',        assignee: 'stage_hod' },
  { key: 'hr',         label: 'HR',         status: 'hr_status',         decider: 'hr_decider',         at: 'hr_decided_at' },
  { key: 'management', label: 'Management', status: 'management_status', decider: 'management_decider', at: 'management_decided_at' },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((st) => [st.key, st.label]));

// One line per required stage: who decides (or decided), the decision, and
// when — so HR/HOD see the full trail, not just the final status.
function StageTrail({ req }) {
  return (
    <div style={{ marginTop: 4, display: 'grid', gap: 2 }}>
      {STAGES.map((st) => {
        const value = req[st.status];
        if (!value || value === 'Not Required') return null;
        const cls = value === 'Approved' ? 'badge-success' : value === 'Rejected' ? 'badge-danger' : 'badge-warning';
        const who = req[st.decider] ? fullName(req[st.decider]) : st.assignee && req[st.assignee] ? fullName(req[st.assignee]) : null;
        return (
          <div key={st.key} style={{ fontSize: 10, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
            <span className={`badge ${cls}`} style={{ fontSize: 9, marginRight: 4 }}>{st.label}: {value}</span>
            {who}{req[st.at] && <span style={{ color: 'var(--text-muted)' }}> · {fmt.date(req[st.at])}</span>}
          </div>
        );
      })}
    </div>
  );
}

function ApproveRejectButtons({ onApprove, onReject, disabled }) {
  return (
    <div className="flex gap-1">
      <button className="btn btn-sm btn-success" title="Approve" disabled={disabled} onClick={onApprove}>
        <i className="fas fa-check" />
      </button>
      <button className="btn btn-sm btn-danger" title="Reject" disabled={disabled} onClick={onReject}>
        <i className="fas fa-times" />
      </button>
    </div>
  );
}

export default function LeavesPage() {
  const { tenant, profile } = useAuth();
  const { outletProfileIds } = useOutletView();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('Pending'); // Pending, Approved, Rejected, All
  const [deptFilter, setDeptFilter] = useState('');
  const [acting, setActing] = useState(null); // id of the request currently being approved/rejected

  const isManager = profile?.role === 'manager';
  const raniwala  = isRaniwalaTenant(tenant);
  // A Raniwala multi-stage row (manager_status is only ever set by the DB
  // trigger for those tenants/rows) — every other row, tenant or not, keeps
  // the original single-stage rendering untouched below.
  const isDualApproval = (req) => raniwala && req.manager_status != null;
  const [stageFilter, setStageFilter] = useState(''); // '' | 'mine' — Raniwala "Needs my approval"

  useEffect(() => {
    fetchRequests();
  }, [tenant, profile, outletProfileIds]);

  const fetchRequests = async () => {
    if (!tenant || !profile) return;
    setLoading(true);
    try {
      if (raniwala && profile.role !== 'admin') {
        // Raniwala managers/HODs: RLS already limits this to their own team.
        const { data, error } = await listAllLeaveRequests(tenant.id);
        if (error) showToast(error.message, 'error');
        else setRequests(data);
      } else {
        // Everyone else sees every leave request tenant-wide (any status,
        // any approval tier) so HR/managers stay aware of already-decided
        // leaves too — only the ability to act on a request is gated below.
        const { data, error } = await listAllLeaveRequests(tenant.id);
        if (error) showToast(error.message, 'error');
        else setRequests(scopedToOutlet(data, outletProfileIds));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleStatusChange = async (id, status) => {
    if (acting) return;
    setActing(id);
    try {
      const { error } = await updateLeaveStatus(id, status, profile.id, profile.role);
      if (error) showToast(error.message, 'error');
      else {
        showToast(`Leave ${status.toLowerCase()} successfully`, 'success');
        fetchRequests();
      }
    } finally {
      setActing(null);
    }
  };

  const handleStageDecision = async (id, stage, decision) => {
    if (acting) return;
    setActing(id);
    try {
      const { error } = await decideLeaveStage(id, stage, decision, profile.id);
      if (error) showToast(error.message, 'error');
      else {
        showToast(`Leave ${decision.toLowerCase()}`, 'success');
        fetchRequests();
      }
    } finally {
      setActing(null);
    }
  };

  const departments = useMemo(
    () => [...new Set(requests.map((r) => r.profile?.department).filter(Boolean))].sort(),
    [requests],
  );

  const filteredRequests = requests.filter(r =>
    (filter === 'All' || r.status === filter) && (!deptFilter || r.profile?.department === deptFilter)
    && (stageFilter !== 'mine' || myLeaveStage(r, profile))
  );
  const needsMeCount = raniwala ? requests.filter((r) => myLeaveStage(r, profile)).length : 0;

  const pendingCount  = requests.filter(r => r.status === 'Pending').length;
  const approvedCount = requests.filter(r => r.status === 'Approved').length;
  const rejectedCount = requests.filter(r => r.status === 'Rejected').length;

  return (
    <>
      <Header
        title="Leave Management"
        breadcrumb={isManager ? "Review and approve your team's leave requests" : 'Review and approve employee leave requests'}
      />

      <div className="page-content">
        {!loading && (
          <div className="stats-row">
            <StatCard icon="fa-hourglass-half" iconColor="orange" value={pendingCount} label="Pending Approval" />
            <StatCard icon="fa-circle-check" iconColor="green" value={approvedCount} label="Approved" />
            <StatCard icon="fa-circle-xmark" iconColor="red" value={rejectedCount} label="Rejected" />
            <StatCard icon="fa-calendar-days" iconColor="blue" value={requests.length} label="Total Requests" />
          </div>
        )}

        <div className="card">
          <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
            <h3 style={{ margin: 0 }}>
              Requests
              {filteredRequests.length > 0 && (
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', marginLeft: 8 }}>
                  ({filteredRequests.length})
                </span>
              )}
            </h3>
            <div className="flex gap-1" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <OutletSelect style={{ marginRight: 8 }} />
              {departments.length > 0 && (
                <select
                  className="form-select"
                  value={deptFilter}
                  onChange={(e) => setDeptFilter(e.target.value)}
                  style={{ maxWidth: 180, marginRight: 8 }}
                >
                  <option value="">All Departments</option>
                  {departments.map((d) => <option key={d}>{d}</option>)}
                </select>
              )}
              {raniwala && (
                <button
                  className={`btn btn-sm ${stageFilter === 'mine' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setStageFilter(stageFilter === 'mine' ? '' : 'mine')}
                  style={{ marginRight: 8 }}
                >
                  Needs my approval
                  {needsMeCount > 0 && <span className="badge badge-danger" style={{ marginLeft: 6, padding: '1px 6px' }}>{needsMeCount}</span>}
                </button>
              )}
              {STATUS_FILTERS.map(s => (
                <button
                  key={s}
                  className={`btn btn-sm ${filter === s ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setFilter(s)}
                >
                  {s}
                  {s === 'Pending' && pendingCount > 0 && (
                    <span
                      className="badge badge-danger"
                      style={{ marginLeft: 6, padding: '1px 6px' }}
                    >
                      {pendingCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Leave Type</th>
                  <th>Dates</th>
                  <th>Days</th>
                  <th>Reason</th>
                  <th>Applied On</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan="8" style={{ textAlign: 'center', padding: 40 }}><div className="spinner" /></td></tr>
                ) : filteredRequests.length === 0 ? (
                  <tr>
                    <td colSpan="8" style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
                      <i className="fas fa-calendar-check" style={{ fontSize: 28, display: 'block', marginBottom: 10, opacity: 0.5 }} />
                      No {filter !== 'All' ? filter.toLowerCase() : ''} leave requests found.
                    </td>
                  </tr>
                ) : filteredRequests.map(req => {
                  const days = diffDays(req.start_date, req.end_date);
                  const dual = isDualApproval(req);
                  const mine = dual ? myLeaveStage(req, profile) : null;
                  // Over-5-day leave applied < 15 days ahead: still approvable, just flagged.
                  const shortNotice = dual && req.short_notice;

                  return (
                    <tr key={req.id} style={shortNotice ? { background: 'var(--warning-light)' } : undefined}>
                      <td>
                        <div className="emp-cell">
                          <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(req.profile_id)})` }}>
                            {getInitials(req.profile?.first_name, req.profile?.last_name)}
                          </div>
                          <div>
                            <div className="emp-name">{fullName(req.profile)}</div>
                            {req.profile?.department && <div className="emp-role">{req.profile.department}</div>}
                          </div>
                        </div>
                      </td>
                      <td><span className={`badge ${typeBadgeClass(req.leave_type)}`}>{req.leave_type}</span></td>
                      <td style={{ fontSize: 12.5 }}>
                        {fmt.date(req.start_date)}
                        {req.start_date !== req.end_date && <><br />– {fmt.date(req.end_date)}</>}
                      </td>
                      <td>
                        <span style={{ fontWeight: 700 }}>{days}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}> day{days !== 1 ? 's' : ''}</span>
                        {shortNotice && (
                          <div className="badge badge-warning" style={{ fontSize: 9, marginTop: 4 }} title="Leave over 5 days should be applied at least 15 days in advance">
                            <i className="fas fa-triangle-exclamation" style={{ marginRight: 3 }} />Short notice
                          </div>
                        )}
                      </td>
                      <td style={{ maxWidth: 200, fontSize: 12.5, color: 'var(--text-secondary)' }} title={req.reason}>
                        {req.reason || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{fmt.date(req.created_at)}</td>
                      <td>
                        <span className={`badge ${
                          req.status === 'Approved' ? 'badge-success' :
                          req.status === 'Rejected' ? 'badge-danger' : 'badge-warning'
                        }`}>
                          {req.status}
                        </span>
                        {dual && <StageTrail req={req} />}
                      </td>
                      <td>
                        {dual ? (
                          <>
                            {mine && (
                              <ApproveRejectButtons
                                disabled={acting === req.id}
                                onApprove={() => handleStageDecision(req.id, mine, 'Approved')}
                                onReject={() => handleStageDecision(req.id, mine, 'Rejected')}
                              />
                            )}
                            {!mine && req.status === 'Pending' && req.current_stage && (
                              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                Waiting on {STAGE_LABEL[req.current_stage]}
                                {req.current_stage === 'manager' && req.stage_manager && <> ({fullName(req.stage_manager)})</>}
                                {req.current_stage === 'hod' && req.stage_hod && <> ({fullName(req.stage_hod)})</>}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {req.status === 'Pending' && (!isManager || req.required_approver_role === 'manager') && (
                              <ApproveRejectButtons
                                disabled={acting === req.id}
                                onApprove={() => handleStatusChange(req.id, 'Approved')}
                                onReject={() => handleStatusChange(req.id, 'Rejected')}
                              />
                            )}
                            {req.status === 'Pending' && isManager && req.required_approver_role !== 'manager' && (
                              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                Awaiting {req.required_approver_role === 'admin' ? 'HR' : req.required_approver_role}
                              </div>
                            )}
                            {req.status !== 'Pending' && req.approval_level === 'self' && (
                              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                <i className="fas fa-bolt" style={{ marginRight: 3 }} />Auto-approved
                              </div>
                            )}
                            {req.status !== 'Pending' && req.approval_level !== 'self' && req.approver && (
                              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                By: {req.approver.first_name}
                              </div>
                            )}
                          </>
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
