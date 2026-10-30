import React, { useEffect, useState, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import Header from '@/components/Header';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { listActiveEmployees } from '@/services/employeeService';
import { fetchMyMonthAttendance, fetchEmployeeProfileInfo, fetchTeamAttendance, fetchAllTenantAttendance } from '@/services/attendanceService';
import { fetchHolidaysInRange } from '@/services/holidayService';
import { fetchTenantLeaveBalances } from '@/services/leaveLedgerService';
import {
  fmt, fmtTime12, fmtDuration, dateStr, monthLabel, fullName, scopedToOutlet, isTenantWeeklyOff,
  holidayForEmployee, isBeforeJoining, isShortDay, MONTHLY_LATE_HIGHLIGHT_LIMIT, toTitleCase, probationInfo, isRaniwalaTenant, raniwalaPayableOtHours,
  earlyLateKindLabel, earlyLateDayNote, comparePunches,
} from '@/lib/helpers';
import ExtraHoursCell from '@/components/ExtraHoursCell';
import { AttendanceContent } from '@/pages/employee/MyAttendancePage';

function getFirstIn(punches) {
  return (punches || [])
    .filter(p => p.punch_type === 'in')
    .sort(comparePunches)[0]?.punch_time || null;
}

function getLastOut(punches) {
  const outs = (punches || []).filter(p => p.punch_type === 'out').sort(comparePunches);
  return outs[outs.length - 1]?.punch_time || null;
}

// `source` ('app'/'device'/'manual') of the punch getFirstIn/getLastOut
// picked — used only to show HR the small "via App" indicator, so this stays
// separate from the two functions above rather than changing their (widely
// reused, export-facing) string-returning shape.
function getFirstInSource(punches) {
  return (punches || [])
    .filter(p => p.punch_type === 'in')
    .sort(comparePunches)[0]?.source || null;
}

function getLastOutSource(punches) {
  const outs = (punches || []).filter(p => p.punch_type === 'out').sort(comparePunches);
  return outs[outs.length - 1]?.source || null;
}

const STATUS_COLOR = {
  Present: 'var(--success)',
  Late: 'var(--accent)',
  'Half Day': 'var(--warning)',
  Mispunch: 'var(--danger)',
  Absent: 'var(--danger)',
  Leave: 'var(--purple)',
  Holiday: 'var(--info, #0ea5e9)',
  'Pending Approval': 'var(--warning)',
};

const now = new Date();

export default function EmployeeCalendarPage() {
  const { tenant } = useAuth();
  const { outlets, outletProfileIds } = useOutletView();
  // Outlet lookup for weekly-off resolution — an outlet's own weekly_off_days
  // (e.g. Raniwala's Delhi outlet off Monday) overrides the tenant-wide
  // default (Sunday), so "Weekend" must be resolved per employee, not off
  // the tenant alone.
  const outletById = Object.fromEntries(outlets.map((o) => [o.id, o]));
  const [viewMode, setViewMode] = useState('employee'); // 'employee' | 'date'
  // By-employee layout: 'table' (HR day list) or 'calendar' (the employee's
  // own My Attendance screen, exactly as they see it).
  const [empLayout, setEmpLayout] = useState('table');
  const [employees, setEmployees] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [records, setRecords] = useState([]);
  const [monthHolidays, setMonthHolidays] = useState([]);
  const [empProfile, setEmpProfile] = useState(null);
  const [earnedLeave, setEarnedLeave] = useState(null);
  const [loadingEmps, setLoadingEmps] = useState(true);
  const [loading, setLoading] = useState(false);

  // By-date mode: only absent/late employees for one selected date
  const [dateForList, setDateForList] = useState(dateStr(now));
  const [dateRecords, setDateRecords] = useState([]);
  const [dateHolidays, setDateHolidays] = useState([]);
  const [loadingDateList, setLoadingDateList] = useState(false);
  const [dateMonthAtt, setDateMonthAtt] = useState([]); // whole calendar month of dateForList, all employees — for the >3-late highlight
  const [viewMonth, setViewMonth] = useState(now.getMonth()); // 0-based
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [searchTerm, setSearchTerm] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const searchRef = useRef(null);

  // Keep the search box text in sync with the selected employee
  useEffect(() => {
    if (!selectedId) { setSearchTerm(''); return; }
    const emp = employees.find(e => e.id === selectedId);
    if (emp) setSearchTerm(fullName(emp));
  }, [selectedId, employees]);

  // Close the search dropdown when clicking outside it
  useEffect(() => {
    function handleClickOutside(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) setShowDropdown(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredEmployees = employees.filter((emp) => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return true;
    const name = fullName(emp).toLowerCase();
    const dept = (emp.department || '').toLowerCase();
    const code = `${emp.employee_id || ''} ${emp.essl_employee_code || ''}`.toLowerCase();
    return name.includes(q) || dept.includes(q) || code.includes(q);
  });

  useEffect(() => {
    if (!tenant) return;
    setLoadingEmps(true);
    listActiveEmployees(tenant.id).then(({ data }) => {
      const scoped = scopedToOutlet(data || [], outletProfileIds, 'id');
      setEmployees(scoped);
      setSelectedId((prev) => (prev && scoped.some((e) => e.id === prev) ? prev : ''));
      setLoadingEmps(false);
    });
  }, [tenant, outletProfileIds]);

  // When employee changes: fetch profile, reset to current month
  useEffect(() => {
    if (!selectedId) { setEmpProfile(null); setRecords([]); return; }
    setViewMonth(now.getMonth());
    setViewYear(now.getFullYear());
    fetchEmployeeProfileInfo(selectedId).then(({ profile }) => setEmpProfile(profile));
  }, [selectedId]);

  // Raniwala: the employee's Earned Leave balance today (same ledger as Leave
  // Balances and the app); Comp Off comes with the profile above.
  useEffect(() => {
    setEarnedLeave(null);
    if (!selectedId || !tenant || !isRaniwalaTenant(tenant)) return;
    let cancelled = false;
    fetchTenantLeaveBalances(tenant.id, [selectedId]).then(({ data, error }) => {
      if (cancelled) return;
      if (error) return showToast('Could not load leave balance: ' + error.message, 'error');
      const rows = data.filter((b) => b.leave_type && !b.leave_type.is_unlimited && /earned/i.test(b.leave_type.name));
      setEarnedLeave(rows.reduce((s, b) => s + Number(b.balance || 0), 0));
    });
    return () => { cancelled = true; };
  }, [selectedId, tenant]);

  // When employee or month/year changes: fetch that month's records
  useEffect(() => {
    if (!selectedId) return;
    setLoading(true);
    fetchMyMonthAttendance(selectedId, viewYear, viewMonth).then(({ data, error }) => {
      if (error) showToast(error.message, 'error');
      else setRecords(data || []);
    }).finally(() => setLoading(false));
  }, [selectedId, viewMonth, viewYear]);

  // The month's holidays — a holiday of the employee's outlet is not an absence.
  useEffect(() => {
    if (!tenant) return;
    fetchHolidaysInRange(tenant.id, dateStr(new Date(viewYear, viewMonth, 1)), dateStr(new Date(viewYear, viewMonth + 1, 0)))
      .then(({ data }) => setMonthHolidays(data || []));
  }, [tenant, viewMonth, viewYear]);

  // By-date mode: fetch every employee's attendance for the selected date and
  // keep only Absent/Late — the reverse of the by-employee view above (one
  // date, many employees, instead of one employee, many dates).
  useEffect(() => {
    if (!tenant || viewMode !== 'date' || !dateForList) return;
    setLoadingDateList(true);
    Promise.all([
      fetchTeamAttendance(tenant.id, dateForList),
      fetchHolidaysInRange(tenant.id, dateForList, dateForList),
    ]).then(([{ records: recs, error }, holRes]) => {
      if (error) showToast(error.message, 'error');
      else setDateRecords(scopedToOutlet(recs || [], outletProfileIds, 'profile_id'));
      setDateHolidays(holRes.data || []);
    }).finally(() => setLoadingDateList(false));
  }, [tenant, viewMode, dateForList, outletProfileIds]);

  // Whole calendar month containing dateForList, all employees — used only to
  // count each employee's Late days this month for the repeat-offender highlight.
  useEffect(() => {
    if (!tenant || viewMode !== 'date' || !dateForList) return;
    const d = new Date(dateForList);
    fetchAllTenantAttendance(tenant.id, d.getFullYear(), d.getMonth()).then(({ data }) => setDateMonthAtt(data || []));
  }, [tenant, viewMode, dateForList]);

  const dateMonthLateCountByProfile = (() => {
    const counts = {};
    dateMonthAtt.forEach((r) => {
      if (r.status !== 'Late') return;
      counts[r.profile_id] = (counts[r.profile_id] || 0) + 1;
    });
    return counts;
  })();

  const dateModeRows = (() => {
    const byProfile = Object.fromEntries(dateRecords.map((r) => [r.profile_id, r]));
    const listDay = new Date(dateForList);
    return employees
      .filter((emp) => !isBeforeJoining(emp, dateForList))
      .map((emp) => {
        const rec = byProfile[emp.id];
        // No punch on the employee's own effective weekly-off day (outlet
        // override, e.g. Raniwala's Delhi off Monday, falling back to the
        // tenant default) or on their outlet's holiday is not an absence.
        const isWeekend = !rec && isTenantWeeklyOff(listDay, tenant, outletById[emp.outlet_id], emp);
        const holiday = !rec && holidayForEmployee(dateHolidays, dateForList, emp, outletById[emp.outlet_id]);
        const status = rec?.status || (holiday ? 'Holiday' : isWeekend ? 'Weekend' : 'Absent');
        const lateThisMonth = dateMonthLateCountByProfile[emp.id] || 0;
        return {
          emp, status,
          clockIn: rec ? getFirstIn(rec.punches) : null,
          rawHours: rec?.total_hours || null,
          isRepeatLate: lateThisMonth > MONTHLY_LATE_HIGHLIGHT_LIMIT,
          lateThisMonth,
        };
      })
      .filter((r) => r.status === 'Absent' || r.status === 'Late')
      .sort((a, b) => fullName(a.emp).localeCompare(fullName(b.emp)));
  })();

  const downloadDateModeList = () => {
    if (!dateModeRows.length) return showToast('No absent/late employees for this date', 'warning');
    const headers = ['#', 'Employee Name', 'Department', 'Designation', 'Status', 'Clock In', 'Hours', 'Late This Month'];
    const rows = dateModeRows.map((r, i) => [
      i + 1, fullName(r.emp), r.emp.department || '', r.emp.designation || '',
      r.status, r.clockIn ? fmtTime12(r.clockIn) : '', r.rawHours ?? '', r.lateThisMonth,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = [{ wch: 5 }, { wch: 24 }, { wch: 18 }, { wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 14 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Absent & Late');
    XLSX.writeFile(wb, `absent_late_${dateForList}.xlsx`);
  };

  // Build month options from join date (or 12 months back) to current month, newest first
  const monthOptions = () => {
    const opts = [];
    let startY = now.getFullYear(), startM = now.getMonth() - 11; // default: 12 months back
    if (startM < 0) { startY--; startM += 12; }

    if (empProfile?.join_date) {
      const [jy, jm] = empProfile.join_date.split('-').map(Number);
      // Use whichever is earlier: join date or 12-months-back default
      const joinIsEarlier = jy < startY || (jy === startY && jm - 1 < startM);
      if (joinIsEarlier) { startY = jy; startM = jm - 1; }
    }

    let y = now.getFullYear(), m = now.getMonth();
    while (y > startY || (y === startY && m >= startM)) {
      opts.push({ year: y, month: m, label: monthLabel(m, y) });
      if (--m < 0) { m = 11; y--; }
    }
    return opts;
  };

  // Selected employee's own outlet — its weekly_off_days override (e.g.
  // Raniwala's Delhi outlet off Monday) takes precedence over the tenant
  // default (Sunday) for every weekend computation below.
  const selectedEmp = employees.find((e) => e.id === selectedId);
  const selectedOutlet = outletById[selectedEmp?.outlet_id];
  const raniwala = isRaniwalaTenant(tenant);

  // Build days for the selected month, latest first, skipping future dates
  // and the days before the employee joined.
  const buildDays = () => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const days = [];
    for (let d = daysInMonth; d >= 1; d--) {
      const cur = new Date(viewYear, viewMonth, d);
      if (cur > today) continue;
      const ds = dateStr(cur);
      if (isBeforeJoining(selectedEmp, ds)) continue;
      days.push({ date: ds, rec: records.find(r => r.date === ds) || null, dayObj: cur });
    }
    return days;
  };

  const days = buildDays();

  // A day with no attendance row: the employee's outlet holiday, their weekly
  // off, else an absence.
  const dayStatus = (rec, dayObj, date) => rec?.status
    || (holidayForEmployee(monthHolidays, date, selectedEmp, selectedOutlet) ? 'Holiday'
      : isTenantWeeklyOff(dayObj, tenant, selectedOutlet, selectedEmp) ? 'Weekend' : 'Absent');

  // Month summary stats. An untouched weekly off is skipped, but one the
  // employee actually punched on counts like any other worked day.
  const stats = { present: 0, absent: 0, halfDay: 0, late: 0, leave: 0, earlyLate: 0, mispunch: 0, otHours: 0, compOff: 0 };
  days.forEach(({ rec, dayObj, date }) => {
    if (rec) {
      if (selectedEmp?.overtime_applicable) {
        stats.otHours += raniwalaPayableOtHours(rec.total_hours, isTenantWeeklyOff(dayObj, tenant, selectedOutlet, selectedEmp));
      }
      stats.compOff += Number(rec.comp_off_credit) || 0;
    }
    if (!rec && dayStatus(rec, dayObj, date) !== 'Absent') return;
    const s = rec?.status;
    if (s === 'Present') stats.present++;
    else if (s === 'Late') { stats.present++; stats.late++; }
    else if (s === 'Half Day') stats.halfDay++;
    else if (s === 'Mispunch') stats.mispunch++;
    else if (s === 'Leave') stats.leave++;
    else stats.absent++;
    if (rec?.early_late_flag) stats.earlyLate++;
  });

  const exportToExcel = () => {
    if (!empProfile) return;
    const empName = tenant?.uppercase_user_data ? fullName(empProfile) : toTitleCase(fullName(empProfile));
    const wsData = [
      [`Employee: ${empName}`],
      [`Month: ${monthLabel(viewMonth, viewYear)}`],
      [`Generated: ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`],
      [],
      ['Date', 'Day', 'Status', 'Clock In', 'Clock Out', 'Hours', 'Early/Late'],
    ];
    days.forEach(({ date, rec, dayObj }) => {
      wsData.push([
        date,
        dayObj.toLocaleDateString('en-IN', { weekday: 'short' }),
        dayStatus(rec, dayObj, date),
        rec ? (getFirstIn(rec.punches) || '') : '',
        rec ? (getLastOut(rec.punches) || '') : '',
        rec?.total_hours ? fmtDuration(rec.total_hours) : '',
        rec?.early_late_flag || rec?.early_late_graced
          ? (tenant?.early_late_grace_minutes ? earlyLateDayNote(rec).badge : (rec.early_late_flag ? 'Counted' : 'Graced'))
          : '',
      ]);
    });
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 14 }, { wch: 6 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 32 }];
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 6 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 6 } },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    XLSX.writeFile(wb, `${empName.replace(/\s+/g, '_')}_${viewYear}_${String(viewMonth + 1).padStart(2, '0')}.xlsx`);
  };

  const options = monthOptions();

  return (
    <div className="page-container">
      <Header
        title="Employee Calendar"
        breadcrumb="Dashboard / Employee Calendar"
        actions={
          viewMode === 'employee' && selectedId && days.length > 0 ? (
            <button className="btn btn-outline" onClick={exportToExcel}>
              <i className="fas fa-file-excel" style={{ marginRight: 6 }} />
              Export to Excel
            </button>
          ) : viewMode === 'date' ? (
            <button className="btn btn-outline" onClick={downloadDateModeList} disabled={loadingDateList || dateModeRows.length === 0}>
              <i className="fas fa-download" style={{ marginRight: 6 }} />
              Download List
            </button>
          ) : null
        }
      />

      <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
        <button className={`btn ${viewMode === 'employee' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setViewMode('employee')}>
          By Employee
        </button>
        <button className={`btn ${viewMode === 'date' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setViewMode('date')}>
          By Date (Absent &amp; Late)
        </button>
      </div>

      {viewMode === 'date' && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Date:</span>
            <input
              type="date"
              className="form-select"
              style={{ maxWidth: 180 }}
              value={dateForList}
              max={dateStr(new Date())}
              onChange={(e) => setDateForList(e.target.value)}
            />
          </div>
          {loadingEmps || loadingDateList ? (
            <div style={{ textAlign: 'center', padding: 60 }}><div className="spinner" /></div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Department</th>
                    <th>Designation</th>
                    <th>Status</th>
                    <th>Clock In</th>
                    <th>Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {dateModeRows.length === 0 ? (
                    <tr><td colSpan="6" style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                      No absent or late employees on {dateForList}.
                    </td></tr>
                  ) : dateModeRows.map((r) => {
                    const isShort = isShortDay(r.rawHours);
                    return (
                    <tr key={r.emp.id} style={r.isRepeatLate ? { background: 'var(--danger-light, #fee2e2)' } : undefined}>
                      <td>{fullName(r.emp)}</td>
                      <td>{r.emp.department || ''}</td>
                      <td>{r.emp.designation || ''}</td>
                      <td>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                          background: r.status === 'Absent' ? 'var(--danger-light, #fee2e2)' : 'var(--accent-light, #fef3c7)',
                          color: r.status === 'Absent' ? 'var(--danger)' : 'var(--accent)',
                        }}>
                          {r.status}
                        </span>
                        {r.isRepeatLate && (
                          <i className="fas fa-exclamation-triangle" style={{ marginLeft: 6, color: 'var(--danger)' }} title={`Late ${r.lateThisMonth}x this month`} />
                        )}
                      </td>
                      <td style={{ fontFamily: 'monospace' }}>{r.clockIn ? fmtTime12(r.clockIn) : '—'}</td>
                      <td style={isShort ? { color: 'var(--danger)', fontWeight: 700 } : undefined} title={isShort ? 'Worked less than 8 hr 30 min' : undefined}>
                        {r.rawHours ? `${r.rawHours}h` : '—'}{isShort && <i className="fas fa-triangle-exclamation" style={{ marginLeft: 6 }} />}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {viewMode === 'employee' && (
      <div className="card" style={{ marginTop: 16 }}>
        {/* Controls row */}
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, whiteSpace: 'nowrap' }}>Select Employee</h3>

          <div ref={searchRef} style={{ flex: 1, minWidth: 200, maxWidth: 340, position: 'relative' }}>
            <div style={{ position: 'relative' }}>
              <i className="fas fa-search" style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                fontSize: 12, color: 'var(--text-muted)', pointerEvents: 'none',
              }} />
              <input
                type="text"
                className="form-select"
                style={{ paddingLeft: 28, width: '100%' }}
                placeholder={loadingEmps ? 'Loading employees…' : 'Search employee by name, EMP code or department…'}
                value={searchTerm}
                disabled={loadingEmps}
                onChange={e => {
                  setSearchTerm(e.target.value);
                  setShowDropdown(true);
                  if (!e.target.value) setSelectedId('');
                }}
                onFocus={() => setShowDropdown(true)}
              />
            </div>

            {showDropdown && !loadingEmps && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
                background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
                marginTop: 4, maxHeight: 260, overflowY: 'auto',
                boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
              }}>
                {filteredEmployees.length === 0 ? (
                  <div style={{ padding: '10px 14px', fontSize: 13, color: 'var(--text-muted)' }}>
                    No employees found.
                  </div>
                ) : filteredEmployees.map(emp => (
                  <div
                    key={emp.id}
                    onClick={() => {
                      setSelectedId(emp.id);
                      setSearchTerm(fullName(emp));
                      setShowDropdown(false);
                    }}
                    style={{
                      padding: '8px 14px', fontSize: 13, cursor: 'pointer',
                      background: emp.id === selectedId ? 'var(--primary-light, #ede9fe)' : 'transparent',
                    }}
                  >
                    {fullName(emp)}{emp.employee_id ? ` (${emp.employee_id})` : ''}{emp.department ? ` · ${emp.department}` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>

          {selectedId && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className={`btn btn-sm ${empLayout === 'table' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setEmpLayout('table')}>
                <i className="fas fa-table-list" style={{ marginRight: 6 }} />Table
              </button>
              <button className={`btn btn-sm ${empLayout === 'calendar' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setEmpLayout('calendar')} title="The employee's own My Attendance calendar, exactly as they see it">
                <i className="fas fa-calendar-days" style={{ marginRight: 6 }} />As Employee Sees
              </button>
            </div>
          )}

          {selectedId && empLayout === 'table' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Month:</span>
              <select
                className="form-select"
                value={`${viewYear}-${viewMonth}`}
                onChange={e => {
                  const [y, m] = e.target.value.split('-').map(Number);
                  setViewYear(y);
                  setViewMonth(m);
                }}
                style={{ minWidth: 150 }}
              >
                {options.map(o => (
                  <option key={`${o.year}-${o.month}`} value={`${o.year}-${o.month}`}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {empProfile?.join_date && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'var(--primary-light, #ede9fe)', color: 'var(--primary)',
              border: '1px solid var(--primary)', borderRadius: 20,
              padding: '3px 12px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
            }}>
              <i className="fas fa-calendar-check" />
              Date of Joining: {fmt.date(empProfile.join_date)}
            </span>
          )}
          {(() => {
            const prob = probationInfo(empProfile?.join_date, empProfile?.probation_months);
            if (!prob) return null;
            const done = prob.completed;
            return (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                background: done ? 'var(--success-light)' : 'var(--warning-light)', color: done ? 'var(--success)' : 'var(--warning)',
                border: `1px solid ${done ? 'var(--success)' : 'var(--warning)'}`, borderRadius: 20,
                padding: '3px 12px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
              }}>
                <i className={`fas ${done ? 'fa-check-circle' : 'fa-hourglass-half'}`} />
                Probation: {done ? 'Completed' : `completes ${fmt.date(prob.endsOn)}`}
              </span>
            );
          })()}
          {raniwala && selectedId && earnedLeave !== null && [
            ['fa-umbrella-beach', 'Earned Leave', earnedLeave],
            ['fa-business-time', 'Comp Off', Number(empProfile?.comp_off_balance || 0)],
          ].map(([icon, label, bal]) => {
            const tone = bal < 0 ? 'var(--danger)' : bal === 0 ? 'var(--text-muted)' : 'var(--purple)';
            return (
              <span key={label} title={`${label} balance today`} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                color: tone, border: `1px solid ${tone}`, borderRadius: 20,
                padding: '3px 12px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
              }}>
                <i className={`fas ${icon}`} />
                {label} balance: {Number.isInteger(bal) ? bal : bal.toFixed(1).replace(/\.0$/, '')}
              </span>
            );
          })}
        </div>

        {!selectedId && (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
            <i className="fas fa-user-clock" style={{ fontSize: 40, marginBottom: 12, display: 'block' }} />
            Select an employee to view their attendance.
          </div>
        )}

        {selectedId && empLayout === 'table' && loading && (
          <div style={{ textAlign: 'center', padding: 60 }}><div className="spinner" /></div>
        )}

        {selectedId && empLayout === 'calendar' && selectedEmp && (
          <div style={{ padding: '16px 4px 4px' }}>
            <AttendanceContent
              key={selectedId}
              employee={selectedEmp}
              readOnly
              initialMonth={viewMonth}
              initialYear={viewYear}
              onMonthChange={(m, y) => { setViewMonth(m); setViewYear(y); }}
            />
          </div>
        )}

        {selectedId && empLayout === 'table' && !loading && (
          <>
            {/* Stats bar */}
            <div style={{ display: 'flex', gap: 28, padding: '14px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              {[
                ['Present', stats.present, 'var(--success)', false],
                ['Absent', stats.absent, 'var(--danger)', false],
                ['Half Day', stats.halfDay, 'var(--warning)', false],
                ['Late', stats.late, 'var(--accent)', stats.late > MONTHLY_LATE_HIGHLIGHT_LIMIT],
                ['Mispunch', stats.mispunch, 'var(--danger)', false],
                ['Leave', stats.leave, 'var(--purple)', false],
                ['Early Left / Late Arrival', stats.earlyLate, 'var(--danger)', false],
                ...(raniwala ? [
                  ...(selectedEmp?.overtime_applicable ? [['OT Hours (payable)', stats.otHours, 'var(--success)', false]] : []),
                  ['Comp Off Earned', stats.compOff, 'var(--purple)', false],
                ] : []),
              ].map(([label, val, color, flagged]) => (
                <div key={label} style={{
                  textAlign: 'center', minWidth: 52,
                  ...(flagged ? { background: 'var(--danger-light, #fee2e2)', borderRadius: 8, padding: '4px 8px' } : {}),
                }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: flagged ? 'var(--danger)' : color }}>
                    {val}{flagged && <i className="fas fa-exclamation-triangle" style={{ marginLeft: 6, fontSize: 14 }} title={`More than ${MONTHLY_LATE_HIGHLIGHT_LIMIT} late days this month`} />}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
                </div>
              ))}
              <div style={{ marginLeft: 'auto', textAlign: 'right', alignSelf: 'center' }}>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {monthLabel(viewMonth, viewYear)} · {days.length} working day{days.length !== 1 ? 's' : ''} shown
                </div>
              </div>
            </div>

            {/* Table */}
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day</th>
                    <th>Status</th>
                    <th>Clock In</th>
                    <th>Clock Out</th>
                    <th>Hours</th>
                    {raniwala && <th>Extra Hours</th>}
                    <th>Early/Late</th>
                  </tr>
                </thead>
                <tbody>
                  {days.length === 0 ? (
                    <tr>
                      <td colSpan={raniwala ? 8 : 7} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                        No data for {monthLabel(viewMonth, viewYear)}.
                      </td>
                    </tr>
                  ) : days.map(({ date, rec, dayObj }) => {
                    const isWeekend = isTenantWeeklyOff(dayObj, tenant, selectedOutlet, selectedEmp);
                    const dayName = dayObj.toLocaleDateString('en-IN', { weekday: 'short' });
                    const clockIn = rec ? getFirstIn(rec.punches) : null;
                    const clockOut = rec ? getLastOut(rec.punches) : null;
                    const clockInSource = rec ? getFirstInSource(rec.punches) : null;
                    const clockOutSource = rec ? getLastOutSource(rec.punches) : null;
                    const status = dayStatus(rec, dayObj, date);
                    const color = STATUS_COLOR[status];

                    return (
                      <tr key={date} style={!rec && (status === 'Weekend' || status === 'Holiday') ? { opacity: 0.55 } : undefined}>
                        <td style={{ fontFamily: 'monospace', fontSize: 13 }}>{date}</td>
                        <td style={{ fontSize: 12, color: isWeekend ? 'var(--text-muted)' : undefined }}>{dayName}</td>
                        <td>
                          <span style={{
                            display: 'inline-block', padding: '2px 8px', borderRadius: 12,
                            fontSize: 11, fontWeight: 600,
                            background: color ? `${color}22` : 'var(--bg-card)',
                            color: color || 'var(--text-muted)',
                            border: `1px solid ${color || 'var(--border)'}`,
                          }}>
                            {status}
                          </span>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: 13, color: 'var(--success)' }}>
                          {clockIn ? fmtTime12(clockIn) : '—'}
                          {clockInSource === 'app' && (
                            <i className="fas fa-mobile-screen-button" style={{ marginLeft: 6, color: 'var(--primary)' }} title="Clocked in via App" />
                          )}
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: 13, color: 'var(--danger)' }}>
                          {clockOut ? fmtTime12(clockOut) : '—'}
                          {clockOutSource === 'app' && (
                            <i className="fas fa-mobile-screen-button" style={{ marginLeft: 6, color: 'var(--primary)' }} title="Clocked out via App" />
                          )}
                        </td>
                        <td
                          style={(!isWeekend && isShortDay(rec?.total_hours)) ? { fontSize: 12, color: 'var(--danger)', fontWeight: 700 } : { fontSize: 12, color: 'var(--text-muted)' }}
                          title={(!isWeekend && isShortDay(rec?.total_hours)) ? 'Worked less than 8 hr 30 min' : undefined}
                        >
                          {rec?.total_hours ? fmtDuration(rec.total_hours) : '—'}
                          {(!isWeekend && isShortDay(rec?.total_hours)) && <i className="fas fa-triangle-exclamation" style={{ marginLeft: 6 }} />}
                        </td>
                        {raniwala && (
                          <td style={{ fontSize: 12 }}>
                            <ExtraHoursCell totalHours={rec?.total_hours} overtime={selectedEmp?.overtime_applicable} compOffCredit={Number(rec?.comp_off_credit) || 0} offDay={isWeekend} />
                          </td>
                        )}
                        <td style={{ textAlign: 'center' }}>
                          {rec?.early_late_flag ? (
                            <span className="badge badge-danger" title={tenant?.early_late_grace_minutes ? earlyLateDayNote(rec).text : 'Counted — not this month\'s free breach'}>
                              {rec.early_late_kind ? earlyLateKindLabel(rec.early_late_kind) : 'Counted'}
                            </span>
                          ) : rec?.early_late_graced ? (
                            <span className="badge badge-secondary" title={tenant?.early_late_grace_minutes ? earlyLateDayNote(rec).text : 'Graced — first breach this month, not counted'}>
                              {tenant?.early_late_grace_minutes ? earlyLateDayNote(rec).badge : 'Graced'}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--text-muted)' }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}
