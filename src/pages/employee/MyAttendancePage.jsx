import React from 'react';
import { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import {
  fetchMyMonthAttendance,
  submitRegularizeRequest,
  listMyRegularizeRequests,
} from '@/services/attendanceService';
import { listHolidays, getOutlet } from '@/services/tenantService';
import { todayStr, dateStr, fmtTime12, fmtDuration, monthLabel, isTenantWeeklyOff, regularizeMinDate, regularizeWindowLabel, earlyLateGraceNotice, earlyLateKindLabel } from '@/lib/helpers';
import RegularizeExtensionNotice from '@/components/RegularizeExtensionNotice';

const REQ_COLOR = { Approved: 'var(--success)', Rejected: 'var(--danger)', Pending: 'var(--warning)' };

export function AttendanceContent() {
  const { profile, tenant } = useAuth();
  const [attMonth, setAttMonth]       = useState(new Date().getMonth());
  const [attYear, setAttYear]         = useState(new Date().getFullYear());
  const [myRecords, setMyRecords]     = useState([]);
  const [holidays, setHolidays]       = useState([]);
  const [selectedDate, setSelectedDate] = useState(todayStr());
  // Own outlet — its weekly_off_days (e.g. Raniwala's Delhi outlet off Monday
  // instead of the tenant-wide Sunday) overrides the tenant default and must
  // be used for this employee's own "Weekend" marking, not the tenant alone.
  const [myOutlet, setMyOutlet] = useState(null);

  useEffect(() => {
    if (!profile?.outlet_id) { setMyOutlet(null); return; }
    let cancelled = false;
    getOutlet(profile.outlet_id).then(({ data }) => { if (!cancelled) setMyOutlet(data); });
    return () => { cancelled = true; };
  }, [profile?.outlet_id]);

  // Regularization request state
  const [showReqModal, setShowReqModal]       = useState(false);
  const [myRequests, setMyRequests]           = useState([]);
  const [reqForm, setReqForm]                 = useState({ clockInTime: '', clockOutTime: '', reason: '' });
  const [submittingReq, setSubmittingReq]     = useState(false);

  const fetchMyAttendance = useCallback(async () => {
    if (!profile || !tenant) return;
    const { data } = await fetchMyMonthAttendance(profile.id, attYear, attMonth);
    setMyRecords(data || []);
  }, [profile, tenant, attMonth, attYear]);

  useEffect(() => { fetchMyAttendance(); }, [fetchMyAttendance]);

  const fetchMyReqs = useCallback(async () => {
    if (!profile) return;
    const { data } = await listMyRegularizeRequests(profile.id);
    setMyRequests(data || []);
  }, [profile]);

  useEffect(() => { fetchMyReqs(); }, [fetchMyReqs]);

  // An approval (manager/HR, or the DB applying it) changes this employee's
  // punches/hours server-side -- pick it up when they come back to the tab
  // instead of polling.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') { fetchMyAttendance(); fetchMyReqs(); }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchMyAttendance, fetchMyReqs]);

  const fetchHolidayData = useCallback(async () => {
    if (!tenant) return;
    const { data, error } = await listHolidays(tenant.id, profile?.outlet_id);
    if (error) return showToast('Could not load holidays: ' + error.message, 'error');
    setHolidays(data);
  }, [tenant, profile]);

  useEffect(() => { fetchHolidayData(); }, [fetchHolidayData]);

  const getHolidayDate = (h) => h.holiday_date || h.date;

  const openReqModal = () => {
    const dayPunches = [...(myRecords.find((r) => r.date === selectedDate)?.punches || [])]
      .sort((a, b) => a.punch_time.localeCompare(b.punch_time));
    const firstIn = dayPunches.find((p) => p.punch_type === 'in')?.punch_time;
    const lastOut = [...dayPunches].reverse().find((p) => p.punch_type === 'out')?.punch_time;
    setReqForm({
      clockInTime:  (firstIn || tenant?.shift_start || '').slice(0, 5),
      clockOutTime: (lastOut || tenant?.shift_end   || '').slice(0, 5),
      reason: '',
    });
    setShowReqModal(true);
  };

  const handleSubmitReq = async () => {
    if (!reqForm.clockInTime || !reqForm.clockOutTime) return showToast('Please provide both clock-in and clock-out times', 'error');
    if (!reqForm.reason.trim()) return showToast('Reason is required', 'error');
    if (selectedDate < regularizeMinDate(tenant)) return showToast(`Regularization can only be requested for ${regularizeWindowLabel(tenant)}`, 'error');
    setSubmittingReq(true);
    try {
      const { error, tier } = await submitRegularizeRequest(tenant.id, profile.id, {
        date:         selectedDate,
        clockInTime:  reqForm.clockInTime,
        clockOutTime: reqForm.clockOutTime,
        reason:       reqForm.reason.trim(),
      });
      if (error) throw error;
      showToast(tier === 'self' ? 'Auto-approved! Attendance updated.'
        : tier === 'manager' ? 'Sent to your manager for approval — HR gets a copy'
        : 'Sent to HR for approval', tier === 'self' ? 'success' : 'info');
      setShowReqModal(false);
      fetchMyReqs();
      fetchMyAttendance(); // an auto-approved request is already applied to the day
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    } finally {
      setSubmittingReq(false);
    }
  };

  const changeMonth = (delta) => {
    let m = attMonth + delta, y = attYear;
    if (m > 11) { m = 0; y++; } if (m < 0) { m = 11; y--; }
    setAttMonth(m);
    setAttYear(y);
    // reset selected date to 1st of the new month
    const newMonthStr = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    setSelectedDate(newMonthStr);
  };

  const today = new Date();
  const todayDateStr = todayStr();

  // ── Calendar cells ──────────────────────────────────────────────────────────
  const firstDay    = new Date(attYear, attMonth, 1).getDay();
  const daysInMonth = new Date(attYear, attMonth + 1, 0).getDate();
  const calendarCells = [];
  // myRequests is newest-first, so the first one seen per date is the latest.
  const latestReqByDate = {};
  for (const r of myRequests) if (!latestReqByDate[r.date]) latestReqByDate[r.date] = r;

  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach((d) =>
    calendarCells.push(<div className="att-cal-header" key={'h-' + d}>{d}</div>)
  );
  for (let i = 0; i < firstDay; i++) {
    calendarCells.push(<div className="att-cal-day empty" key={'e-' + i} />);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date     = new Date(attYear, attMonth, d);
    const ds       = dateStr(date);
    const isToday  = ds === todayDateStr;
    const isFuture = date > today;
    const isWeekend = isTenantWeeklyOff(date, tenant, myOutlet);
    const rec      = myRecords.find((r) => r.date === ds);
    const holiday  = holidays.find((h) => getHolidayDate(h) === ds && h.status === 'Approved');
    const dayReq   = latestReqByDate[ds];

    let cls = '';
    let hoursStr = '';
    // A day with punches shows what was worked even on a holiday / weekly off
    // (that work earns comp off) — only an untouched off day shows as off.
    const worked   = rec && (Number(rec.total_hours) > 0 || rec.status === 'Pending Approval');
    if (isFuture)       { cls = 'future'; }
    else if (worked)    { cls = rec.status?.toLowerCase().replace(/\s/g, '-') || 'present'; hoursStr = fmtDuration(rec.total_hours); }
    else if (holiday)   { cls = 'holiday'; hoursStr = holiday.name; }
    else if (isWeekend) { cls = 'weekend'; }
    else if (rec)       { cls = rec.status?.toLowerCase().replace(/\s/g, '-') || 'present'; if (rec.total_hours) hoursStr = fmtDuration(rec.total_hours); }
    else                { cls = 'absent'; }
    if (isToday) cls += ' today';
    if (ds === selectedDate) cls += ' selected';

    calendarCells.push(
      <div
        key={ds}
        className={`att-cal-day ${cls}`}
        onClick={() => setSelectedDate(ds)}
        style={{ cursor: 'pointer', position: 'relative' }}
      >
        <div className="day-num">{d}</div>
        {hoursStr && <div className="day-hours">{hoursStr}</div>}
        {dayReq && (
          <div
            title={`Regularization ${dayReq.status}`}
            style={{ position: 'absolute', bottom: 3, right: 3, fontSize: 9, lineHeight: 1, color: REQ_COLOR[dayReq.status] }}
          >
            <i className={`fas ${dayReq.status === 'Approved' ? 'fa-check-circle' : dayReq.status === 'Rejected' ? 'fa-times-circle' : 'fa-hourglass-half'}`} />
          </div>
        )}
        {(rec?.early_late_flag || rec?.early_late_graced) && (
          <div
            title={tenant?.early_late_grace_minutes
              ? (rec.early_late_flag
                ? `${earlyLateKindLabel(rec.early_late_kind)}: marked Late (grace already used)`
                : `${earlyLateKindLabel(rec.early_late_kind)}: this month's grace used`)
              : (rec.early_late_flag ? 'Early Left / Late Arrival (counted)' : 'Early Left / Late Arrival (graced — first this month)')}
            style={{
              position: 'absolute', top: 3, right: 3, width: 7, height: 7, borderRadius: '50%',
              background: rec.early_late_flag ? 'var(--danger)' : 'var(--text-muted)',
            }}
          />
        )}
      </div>
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const summary = { present: 0, absent: 0, halfDay: 0, late: 0, leaves: 0, totalHours: 0, earlyLate: 0, earlyLateGraced: 0, mispunch: 0 };
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(attYear, attMonth, d);
    if (date > today || isTenantWeeklyOff(date, tenant, myOutlet)) continue;
    const ds = dateStr(date);
    if (holidays.find((h) => getHolidayDate(h) === ds && h.status === 'Approved')) continue;
    const rec = myRecords.find((r) => r.date === ds);
    if (!rec?.status) { if (date < today) summary.absent++; continue; }
    if (rec.status === 'Present')  summary.present++;
    else if (rec.status === 'Late')     { summary.late++; summary.present++; }
    else if (rec.status === 'Half Day') summary.halfDay++;
    else if (rec.status === 'Mispunch') summary.mispunch++;
    else if (rec.status === 'Leave')    summary.leaves++;
    else if (rec.status === 'Absent')   summary.absent++;
    summary.totalHours += rec.total_hours || 0;
    if (rec.early_late_flag) summary.earlyLate++;
    if (rec.early_late_graced) summary.earlyLateGraced++;
  }

  // ── Selected day data ────────────────────────────────────────────────────────
  const selectedRec  = myRecords.find((r) => r.date === selectedDate);
  const sortedPunches = selectedRec?.punches
    ? [...selectedRec.punches].sort((a, b) => a.punch_time.localeCompare(b.punch_time))
    : [];
  const selectedReqs = myRequests.filter((r) => r.date === selectedDate);
  const canRequest = selectedDate && selectedDate <= todayStr() && selectedDate >= regularizeMinDate(tenant)
    && !selectedReqs.some((r) => r.status === 'Pending' || r.status === 'Approved');
  const graceNotice = earlyLateGraceNotice(
    tenant, myRecords, attMonth === today.getMonth() && attYear === today.getFullYear(),
  );
  const selectedLabel = selectedDate
    ? new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : '';

  return (
    <>
      <div className="page-content">
        <RegularizeExtensionNotice tenant={tenant} />

        {/* Summary bar */}
        <div className="att-summary-bar">
          <div className="att-summary-item"><div className="att-s-val" style={{ color: 'var(--success)' }}>{summary.present}</div><div className="att-s-lbl">Present</div></div>
          <div className="att-summary-item"><div className="att-s-val" style={{ color: 'var(--danger)' }}>{summary.absent}</div><div className="att-s-lbl">Absent</div></div>
          <div className="att-summary-item"><div className="att-s-val" style={{ color: 'var(--warning)' }}>{summary.halfDay}</div><div className="att-s-lbl">Half Day</div></div>
          <div className="att-summary-item"><div className="att-s-val" style={{ color: 'var(--accent)' }}>{summary.late}</div><div className="att-s-lbl">Late</div></div>
          {summary.mispunch > 0 && (
            <div className="att-summary-item" title="Only one punch was recorded that day — raise a regularize request to fix it"><div className="att-s-val" style={{ color: 'var(--danger)' }}>{summary.mispunch}</div><div className="att-s-lbl">Mispunch</div></div>
          )}
          <div className="att-summary-item">
            <div className="att-s-val" style={{ color: 'var(--danger)' }}>{summary.earlyLate}</div>
            <div className="att-s-lbl">Early Left / Late Arrival</div>
          </div>
          <div className="att-summary-item"><div className="att-s-val" style={{ color: 'var(--purple)' }}>{summary.leaves}</div><div className="att-s-lbl">Leaves</div></div>
          <div className="att-summary-item"><div className="att-s-val" style={{ color: 'var(--primary)' }}>{fmtDuration(summary.totalHours)}</div><div className="att-s-lbl">Total Hours</div></div>
        </div>

        {graceNotice && (
          <div
            role="status"
            style={{
              display: 'flex', gap: 10, alignItems: 'flex-start',
              padding: '12px 14px', borderRadius: 10, marginBottom: 16,
              border: `1px solid ${graceNotice.used ? 'var(--warning)' : 'var(--border)'}`,
              borderLeft: `4px solid ${graceNotice.used ? 'var(--warning)' : 'var(--success)'}`,
              fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
            }}
          >
            <i className={`fas ${graceNotice.used ? 'fa-hourglass-end' : 'fa-hourglass-start'}`} style={{ color: graceNotice.used ? 'var(--warning)' : 'var(--success)', marginTop: 2 }} />
            <span>{graceNotice.text}</span>
          </div>
        )}

        <div className="grid-3-1">

          {/* Calendar */}
          <div className="card">
            <div className="card-header">
              <h3>Monthly Calendar</h3>
              <div className="month-selector">
                <button onClick={() => changeMonth(-1)}><i className="fas fa-chevron-left" /></button>
                <span>{monthLabel(attMonth, attYear)}</span>
                <button onClick={() => changeMonth(1)}><i className="fas fa-chevron-right" /></button>
              </div>
            </div>
            <div className="card-body">
              <div className="att-calendar">{calendarCells}</div>
            </div>
          </div>

          {/* Timeline panel */}
          <div className="card">
            <div className="card-header">
              <h3>Day Timeline</h3>
              {canRequest && (
                <button className="btn btn-outline btn-sm" onClick={openReqModal}>
                  <i className="fas fa-pen" /> Request Regularization
                </button>
              )}
            </div>
            <div className="card-body">
              {selectedDate && (
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--primary)', marginBottom: 12 }}>
                  {selectedLabel}
                </div>
              )}

              {sortedPunches.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  No punches recorded for this day.
                </p>
              ) : (
                <div className="att-timeline">
                  {sortedPunches.map((p, i) => (
                    <div
                      key={p.id || i}
                      className={`att-timeline-item ${p.punch_type === 'in' ? 'punch-in' : 'punch-out'}`}
                    >
                      <span className="att-timeline-time">{fmtTime12(p.punch_time)}</span>
                      <span className="att-timeline-label">
                        {p.punch_type === 'in' ? (i === 0 ? 'Clock In' : 'Resume') : 'Clock Out'}
                        {p.source === 'manual' && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)' }}>(Regularized)</span>}
                        {p.approval_status === 'pending' && <span className="badge badge-warning" style={{ marginLeft: 6 }} title="Punched from the app — counts once your manager approves">Awaiting approval</span>}
                        {p.approval_status === 'rejected' && <span className="badge badge-danger" style={{ marginLeft: 6 }} title="Your manager rejected this punch — it doesn't count">Rejected</span>}
                      </span>
                    </div>
                  ))}
                  {tenant?.early_late_grace_minutes && (selectedRec?.early_late_graced || selectedRec?.early_late_flag) && (
                    <div style={{ marginTop: 12, fontSize: 12, color: selectedRec.early_late_flag ? 'var(--danger)' : 'var(--warning)' }}>
                      <i className="fas fa-hourglass-end" style={{ marginRight: 6 }} />
                      {selectedRec.early_late_flag
                        ? `${earlyLateKindLabel(selectedRec.early_late_kind)} after this month's grace was used: marked Late.`
                        : `${earlyLateKindLabel(selectedRec.early_late_kind)}: this month's grace was used on this day, so it is marked Present. The next late arrival or early left is marked Late.`}
                    </div>
                  )}
                  {selectedRec?.total_hours > 0 && (
                    <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                      <i className="fas fa-clock" style={{ marginRight: 6 }} />
                      Total: <strong>{fmtDuration(selectedRec.total_hours)}</strong>
                    </div>
                  )}
                </div>
              )}

              {selectedReqs.length > 0 && (
                <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Regularization Requests</div>
                  {selectedReqs.map((r) => (
                    <div key={r.id} style={{ fontSize: 12, marginBottom: 8, padding: 8, borderRadius: 6, background: 'var(--bg)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <span>
                          <i className="fas fa-clock" style={{ marginRight: 6, color: 'var(--text-muted)' }} />
                          {fmtTime12(r.clock_in_time)} → {fmtTime12(r.clock_out_time)}
                        </span>
                        <span className={`badge ${r.status === 'Approved' ? 'badge-success' : r.status === 'Rejected' ? 'badge-danger' : 'badge-warning'}`}>
                          {r.status}{r.approval_level === 'self' ? ' (auto)' : ''}
                        </span>
                      </div>
                      {r.reason && <div style={{ marginTop: 4, color: 'var(--text-secondary)' }}>{r.reason}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

        </div>

        {/* My Regularization Requests */}
        {myRequests.length > 0 && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-header"><h3>My Regularization Requests</h3></div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Date</th><th>Requested Time</th><th>Reason</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {myRequests.map(req => (
                    <tr key={req.id}>
                      <td>{new Date(req.date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                      <td style={{ fontSize: 13 }}>
                        {req.clock_in_time ? fmtTime12(req.clock_in_time) : '—'} → {req.clock_out_time ? fmtTime12(req.clock_out_time) : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 200 }}>{req.reason}</td>
                      <td>
                        <span className={`badge ${
                          req.status === 'Approved' ? 'badge-success'
                            : req.status === 'Rejected' ? 'badge-danger'
                            : 'badge-warning'
                        }`}>{req.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Request Regularization Modal */}
      <Modal
        show={showReqModal}
        onClose={() => setShowReqModal(false)}
        title="Request Attendance Regularization"
        width="460px"
        footer={
          <>
            <button className="btn btn-outline" onClick={() => setShowReqModal(false)} disabled={submittingReq}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSubmitReq} disabled={submittingReq}>
              {submittingReq
                ? <><div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Submitting…</>
                : <><i className="fas fa-paper-plane" /> Submit Request</>}
            </button>
          </>
        }
      >
        <div className="form-group">
          <label className="form-label">Date</label>
          <input
            className="form-input"
            value={selectedDate ? new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : ''}
            readOnly
            style={{ background: 'var(--bg)', color: 'var(--text-muted)' }}
          />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Correct Clock-In Time *</label>
            <input type="time" className="form-input" value={reqForm.clockInTime}
              onChange={e => setReqForm({ ...reqForm, clockInTime: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Correct Clock-Out Time *</label>
            <input type="time" className="form-input" value={reqForm.clockOutTime}
              onChange={e => setReqForm({ ...reqForm, clockOutTime: e.target.value })} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Reason *</label>
          <textarea
            className="form-input"
            rows={3}
            style={{ resize: 'none', fontSize: 13 }}
            placeholder="e.g. Forgot to clock in, worked from client site…"
            value={reqForm.reason}
            onChange={e => setReqForm({ ...reqForm, reason: e.target.value })}
          />
        </div>
      </Modal>
    </>
  );
}

export default function MyAttendancePage() {
  return (
    <>
      <Header title="My Attendance" breadcrumb="Track your attendance" />
      <AttendanceContent />
    </>
  );
}
