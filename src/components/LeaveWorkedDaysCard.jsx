import React, { useEffect, useState } from 'react';
import { showToast } from '@/components/Toast';
import { fmt, todayStr } from '@/lib/helpers';
import { listLeaveWorkedDays, decideLeaveWorkedDay } from '@/services/leaveWorkedDayService';

const VIEWS = [
  { key: 'pending', label: 'To decide' },
  { key: 'all', label: 'All' },
];

// Statuses HR can't give the day back for — the DB refuses them too.
const NOT_WORKED = ['Absent', 'Mispunch', 'Pending Approval', 'Leave'];

const HALF_LABEL = { first_half: 'Half day · first half', second_half: 'Half day · second half' };

const hoursText = (h) => `${Number(h || 0).toFixed(2).replace(/\.?0+$/, '')} h`;

function DecisionBadge({ row }) {
  if (row.status === 'pending') return <span className="badge badge-warning">Waiting for HR</span>;
  if (row.status === 'rejected') return <span className="badge badge-danger">Kept as leave</span>;
  return (
    <span className="badge badge-success">
      {Number(row.refund_days) > 0 ? `${Number(row.refund_days)} day back` : 'Counted as worked'}
    </span>
  );
}

/**
 * HR card on Leave Management: employees who punched on a day of their own
 * approved full-day leave. The day already shows as punched (Present, Late,
 * Half Day …); "Give leave back" returns the deducted day (half for a Half
 * Day), "Keep as leave" puts the day back to Leave. A half-day leave is listed
 * when they worked a full day's hours: half a day back.
 */
export default function LeaveWorkedDaysCard() {
  const [view, setView] = useState('pending');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await listLeaveWorkedDays(view);
    if (error) showToast(error.message, 'error');
    setRows(data);
    setLoading(false);
  };

  useEffect(() => { load(); }, [view]);

  const decide = async (row, approve) => {
    if (acting) return;
    setActing(row.id);
    const { data, error } = await decideLeaveWorkedDay(row.id, approve);
    setActing(null);
    if (error) { showToast(error.message, 'error'); return; }
    showToast(approve
      ? (Number(data?.refund_days) > 0 ? `${data.refund_days} day of leave given back to ${row.name}` : `${row.name}: counted as a working day`)
      : `${row.name}: kept as leave`, 'success');
    load();
  };

  const pendingCount = view === 'pending' ? rows.length : rows.filter((r) => r.status === 'pending').length;
  // Nothing waiting and nothing to look back on: stay out of the way.
  if (!loading && view === 'pending' && rows.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h3 style={{ margin: 0 }}>
            <i className="fas fa-person-walking-arrow-right" style={{ marginRight: 8, color: 'var(--warning)' }} />
            Came in on a leave day
            {pendingCount > 0 && <span className="badge badge-danger" style={{ marginLeft: 8, padding: '1px 6px' }}>{pendingCount}</span>}
          </h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            They punched during their approved leave, so the day counts as worked. Give the leave day back, or keep it as leave.
          </div>
        </div>
        <div className="flex gap-1">
          {VIEWS.map((v) => (
            <button key={v.key} className={`btn btn-sm ${view === v.key ? 'btn-primary' : 'btn-outline'}`} onClick={() => setView(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Day</th>
              <th>Leave</th>
              <th>Punches</th>
              <th>Attendance</th>
              <th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="6" style={{ textAlign: 'center', padding: 30 }}><div className="spinner" /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan="6" style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>Nothing here.</td></tr>
            ) : rows.map((row) => {
              // A half-day leave counts only when they worked a full day (Present / Late).
              const worked = row.half_day
                ? ['Present', 'Late'].includes(row.attendance_status)
                : !NOT_WORKED.includes(row.attendance_status);
              const today = row.date >= todayStr();
              return (
                <tr key={row.id}>
                  <td>
                    <div className="emp-name">{row.name}</div>
                    <div className="emp-role">{[row.employee_id && `EMP ${row.employee_id}`, row.department].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td style={{ fontSize: 12.5 }}>{fmt.date(row.date)}</td>
                  <td style={{ fontSize: 12.5 }}>
                    <div>{row.leave_type || 'Leave'}</div>
                    {row.half_day && <div style={{ fontSize: 11, fontWeight: 600 }}>{HALF_LABEL[row.half_day]}</div>}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {fmt.date(row.start_date)}{row.end_date !== row.start_date && <> – {fmt.date(row.end_date)}</>}
                    </div>
                  </td>
                  <td style={{ fontSize: 12.5 }}>{row.punches || '—'}</td>
                  <td>
                    <span className={`badge ${worked ? 'badge-success' : 'badge-warning'}`}>{row.attendance_status || '—'}</span>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{hoursText(row.total_hours)}</div>
                  </td>
                  <td>
                    {row.status === 'pending' ? (
                      <div className="flex gap-1" style={{ flexWrap: 'wrap' }}>
                        <button
                          className="btn btn-sm btn-success"
                          disabled={!!acting || !worked || today}
                          title={today ? 'The day is not over yet' : !worked ? 'Not a working day — fix the punches first, or keep it as leave' : 'Give the deducted leave day back'}
                          onClick={() => decide(row, true)}
                        >
                          Give leave back
                        </button>
                        <button className="btn btn-sm btn-outline" disabled={!!acting} onClick={() => decide(row, false)}>
                          Keep as leave
                        </button>
                      </div>
                    ) : (
                      <>
                        <DecisionBadge row={row} />
                        {row.decided_by_name && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>By: {row.decided_by_name}</div>}
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
  );
}
