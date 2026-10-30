import React from 'react';
import { useEffect, useState, useCallback, useMemo } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import ExtraHoursCell from '@/components/ExtraHoursCell';
import EarlyLateGracePanel from '@/components/EarlyLateGracePanel';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import {
  fetchTeamAttendance, fetchAllTenantAttendance, fetchAttendanceRangeWithPunches, saveManualAttendance, fetchAttendanceAuditLog,
} from '@/services/attendanceService';
import { listActiveEmployees, listLeaversSince } from '@/services/employeeService';
import { fetchHolidaysInRange } from '@/services/holidayService';
import {
  todayStr, dateStr, fmtTime12, fmtDuration, getInitials, getAvatarColor, fullName, scopedToOutlet, isTenantWeeklyOff,
  holidayForEmployee, isBeforeJoining, isShortDay, MONTHLY_LATE_HIGHLIGHT_LIMIT, isRaniwalaTenant, toTitleCase, isFullPaidDayStatus,
  comparePunches, fmtPunchTime12, earlyLateKindLabel,
} from '@/lib/helpers';

// The day's earliest punch counts as Clock In — used only by the Late
// Comers (date-range) tab below.
function getFirstIn(punches) {
  return (punches || [])
    .slice()
    .sort(comparePunches)[0]?.punch_time || null;
}

// Map pin linking to where an app/web punch was made (same Google Maps link
// as the Punch Approvals page). Renders nothing when no location was saved.
function PunchLocationLink({ loc, label }) {
  if (!loc) return null;
  return (
    <a href={`https://www.google.com/maps?q=${loc.lat},${loc.lng}`} target="_blank" rel="noreferrer" title={`${label} — open in Google Maps`} style={{ marginLeft: 6 }}>
      <i className="fas fa-location-dot" style={{ color: 'var(--success)' }} />
    </a>
  );
}

// Every distinct "YYYY-MM" touched by [fromDate, toDate] — scales the
// repeat-offender highlight threshold: 3 per calendar month spanned by the
// range, so a 1-month view flags at >3 and a 3-month view flags at >9.
function monthsInRange(fromDate, toDate) {
  const months = new Set();
  const [fy, fm] = fromDate.split('-').map(Number);
  const [ty, tm] = toDate.split('-').map(Number);
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    months.add(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months.size;
}

function presetRangeDates(preset) {
  const today = new Date();
  const to = dateStr(today);
  const from = new Date(today);
  if (preset === 'week') from.setDate(from.getDate() - 6);
  else if (preset === 'month') from.setMonth(from.getMonth() - 1);
  else if (preset === '3months') from.setMonth(from.getMonth() - 3);
  return { from: dateStr(from), to };
}

export default function AttendancePage() {
  const { profile, tenant } = useAuth();
  const { outlets, selectedOutletId, selectedOutletName, outletProfileIds, selectOutlet } = useOutletView();
  const raniwala = isRaniwalaTenant(tenant);
  const [tab, setTab] = useState('team');

  // Outlet lookup for weekly-off resolution — an outlet's own weekly_off_days
  // (e.g. Raniwala's Delhi outlet off Monday) overrides the tenant-wide
  // default (Sunday), so "Weekend" must be computed per employee's outlet,
  // never off the tenant alone.
  const outletById = Object.fromEntries(outlets.map((o) => [o.id, o]));

  // Team view
  const [teamDate, setTeamDate] = useState(todayStr());
  const [teamDept, setTeamDept] = useState('');
  const [teamDivision, setTeamDivision] = useState('');
  const [teamData, setTeamData] = useState([]);
  // Staff who left in teamDate's month (Inactive now): shown in their own table.
  const [leaverData, setLeaverData] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [divisions, setDivisions] = useState([]);
  const [managerById, setManagerById] = useState({});

  // Monthly avg hours (for whichever month teamDate falls in)
  const [monthlyAtt, setMonthlyAtt] = useState([]);

  // Manual attendance modal
  const [showManual, setShowManual] = useState(false);
  const [manualForm, setManualForm] = useState({ profile_id: '', date: todayStr(), clockIn: '', clockOut: '', status: 'Present', reason: '' });
  const [employees, setEmployees] = useState([]);

  // Audit log
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // Late Comers (date range) — its own tab, kept in Attendance Log itself
  // (not just a Master Report download): a date-range view of only the
  // employees who were actually marked Late, with a repeat-offender summary.
  const [lcPreset, setLcPreset] = useState('month');
  const [lcFrom, setLcFrom] = useState(() => presetRangeDates('month').from);
  const [lcTo, setLcTo] = useState(() => presetRangeDates('month').to);
  const [lcDept, setLcDept] = useState('');
  const [lcDivision, setLcDivision] = useState('');
  const [lcEmployees, setLcEmployees] = useState([]);
  const [lcRecords, setLcRecords] = useState([]);
  const [lcLoading, setLcLoading] = useState(false);

  useEffect(() => {
    if (tab !== 'late' || !tenant) return;
    listActiveEmployees(tenant.id).then(({ data }) => {
      setLcEmployees(scopedToOutlet(data || [], outletProfileIds, 'id'));
    });
  }, [tab, tenant, outletProfileIds]);

  const fetchLcRange = useCallback(async () => {
    if (!tenant || !lcFrom || !lcTo) return;
    setLcLoading(true);
    try {
      const { data, error } = await fetchAttendanceRangeWithPunches(tenant.id, lcFrom, lcTo);
      if (error) throw error;
      setLcRecords(scopedToOutlet(data || [], outletProfileIds, 'profile_id'));
    } catch (err) {
      showToast('Failed to load attendance: ' + err.message, 'error');
    } finally {
      setLcLoading(false);
    }
  }, [tenant, lcFrom, lcTo, outletProfileIds]);

  useEffect(() => { if (tab === 'late') fetchLcRange(); }, [tab, fetchLcRange]);

  const applyLcPreset = (p) => {
    setLcPreset(p);
    if (p === 'custom') return;
    const { from, to } = presetRangeDates(p);
    setLcFrom(from);
    setLcTo(to);
  };

  const lcDivisions = useMemo(
    () => [...new Set(lcEmployees.map((e) => e.division).filter(Boolean))].sort(),
    [lcEmployees],
  );
  const lcDepartments = useMemo(
    () => [...new Set(
      lcEmployees.filter((e) => !lcDivision || e.division === lcDivision).map((e) => e.department).filter(Boolean)
    )].sort(),
    [lcEmployees, lcDivision],
  );
  const lcFilteredEmployees = useMemo(() => lcEmployees.filter((e) => {
    if (lcDept && e.department !== lcDept) return false;
    if (lcDivision && e.division !== lcDivision) return false;
    return true;
  }), [lcEmployees, lcDept, lcDivision]);
  const lcEmpById = useMemo(() => Object.fromEntries(lcFilteredEmployees.map((e) => [e.id, e])), [lcFilteredEmployees]);
  const lcThreshold = useMemo(() => 3 * monthsInRange(lcFrom, lcTo), [lcFrom, lcTo]);

  const { lcInstances, lcSummary } = useMemo(() => {
    const instances = lcRecords
      .filter((r) => r.status === 'Late')
      .map((r) => ({
        emp: lcEmpById[r.profile_id],
        date: r.date,
        clockIn: getFirstIn(r.punches),
        rawHours: r.total_hours || null,
      }))
      .filter((r) => r.emp)
      .sort((a, b) => a.date.localeCompare(b.date));

    const counts = {};
    instances.forEach((r) => { counts[r.emp.id] = (counts[r.emp.id] || 0) + 1; });

    const summaryRows = Object.entries(counts)
      .map(([empId, count]) => ({ emp: lcEmpById[empId], count, exceeds: count > lcThreshold }))
      .filter((r) => r.emp)
      .sort((a, b) => b.count - a.count);

    return { lcInstances: instances, lcSummary: summaryRows };
  }, [lcRecords, lcEmpById, lcThreshold]);

  const lcExceedingIds = useMemo(() => new Set(lcSummary.filter((s) => s.exceeds).map((s) => s.emp.id)), [lcSummary]);

  const downloadLateComers = async () => {
    if (!lcInstances.length) return showToast('No late arrivals in this range', 'warning');
    const cap = (s) => (raniwala ? (s || '') : toTitleCase(s));
    const code = (s) => (s || '').toString().toUpperCase();

    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();

    const wsDetail = wb.addWorksheet('Late Instances');
    wsDetail.columns = raniwala
      ? [
          { header: 'EMP CODE', key: 'code', width: 10 },
          { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
          { header: 'DESIGNATION', key: 'designation', width: 18 },
          { header: 'DIVISION', key: 'division', width: 16 },
          { header: 'DEPARTMENT', key: 'department', width: 16 },
          { header: 'DATE', key: 'date', width: 12 },
          { header: 'CLOCK IN', key: 'clockIn', width: 12 },
          { header: 'HOURS', key: 'hours', width: 12 },
        ]
      : [
          { header: 'Employee Name', key: 'name', width: 24 },
          { header: 'Department', key: 'department', width: 18 },
          { header: 'Date', key: 'date', width: 12 },
          { header: 'Clock In', key: 'clockIn', width: 12 },
          { header: 'Hours', key: 'hours', width: 12 },
        ];
    wsDetail.getRow(1).font = { bold: true };
    lcInstances.forEach(({ emp, date, clockIn, rawHours }) => {
      wsDetail.addRow(raniwala
        ? {
            code: code(emp.employee_id || emp.essl_employee_code), name: cap(fullName(emp)), designation: cap(emp.designation),
            division: cap(emp.division), department: cap(emp.department),
            date, clockIn: clockIn ? fmtTime12(clockIn) : '', hours: rawHours != null ? fmtDuration(rawHours) : '',
          }
        : {
            name: cap(fullName(emp)), department: cap(emp.department),
            date, clockIn: clockIn ? fmtTime12(clockIn) : '', hours: rawHours != null ? fmtDuration(rawHours) : '',
          });
    });

    const wsSummary = wb.addWorksheet('Repeat Offenders');
    wsSummary.columns = raniwala
      ? [
          { header: 'EMP CODE', key: 'code', width: 10 },
          { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
          { header: 'DIVISION', key: 'division', width: 16 },
          { header: 'DEPARTMENT', key: 'department', width: 16 },
          { header: `TOTAL LATE (${lcFrom} to ${lcTo})`, key: 'count', width: 22 },
          { header: `EXCEEDS THRESHOLD (>${lcThreshold})`, key: 'exceeds', width: 22 },
        ]
      : [
          { header: 'Employee Name', key: 'name', width: 24 },
          { header: 'Department', key: 'department', width: 18 },
          { header: `Total Late (${lcFrom} to ${lcTo})`, key: 'count', width: 20 },
          { header: `Exceeds Threshold (>${lcThreshold})`, key: 'exceeds', width: 20 },
        ];
    wsSummary.getRow(1).font = { bold: true };
    lcSummary.forEach(({ emp, count, exceeds }) => {
      wsSummary.addRow(raniwala
        ? { code: code(emp.employee_id || emp.essl_employee_code), name: cap(fullName(emp)), division: cap(emp.division), department: cap(emp.department), count, exceeds: exceeds ? 'Yes' : 'No' }
        : { name: cap(fullName(emp)), department: cap(emp.department), count, exceeds: exceeds ? 'Yes' : 'No' });
    });

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `late_comers_${lcFrom}_to_${lcTo}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const fetchMonthlyAvg = useCallback(async () => {
    if (!tenant) return;
    const d = new Date(teamDate);
    const { data } = await fetchAllTenantAttendance(tenant.id, d.getFullYear(), d.getMonth());
    setMonthlyAtt(data);
  }, [tenant, teamDate]);

  useEffect(() => { if (tab === 'team') fetchMonthlyAvg(); }, [tab, fetchMonthlyAvg]);

  const fetchTeamData = useCallback(async () => {
    if (!tenant) return;
    const [y, m] = teamDate.split('-').map(Number);
    const monthEnd = dateStr(new Date(y, m, 0));
    const [{ employees: allEmps, records: attRecords }, leaversRes, holidaysRes] = await Promise.all([
      fetchTeamAttendance(tenant.id, teamDate),
      listLeaversSince(tenant.id, `${teamDate.slice(0, 7)}-01`),
      fetchHolidaysInRange(tenant.id, teamDate, teamDate),
    ]);
    const emps = scopedToOutlet(allEmps, outletProfileIds, 'id');
    let leavers = scopedToOutlet(leaversRes.data.filter((e) => e.exit_date <= monthEnd), outletProfileIds, 'id');
    setEmployees(emps);
    // Outlet -> Division -> Department cascade: divisions are scoped to the
    // currently-selected outlet, and departments further narrow to whichever
    // division is also selected — never the tenant-wide master list, so
    // picking Delhi only ever offers divisions/departments that actually
    // exist at Delhi.
    const nextDivisions = [...new Set(emps.map((e) => e.division).filter(Boolean))].sort();
    setDivisions(nextDivisions);
    const nextDepartments = [...new Set(
      emps.filter((e) => !teamDivision || e.division === teamDivision).map((e) => e.department).filter(Boolean)
    )].sort();
    setDepartments(nextDepartments);
    // Outlet/division changed and the current selection no longer applies —
    // clear it back to "All" instead of silently filtering to zero rows.
    if (teamDivision && !nextDivisions.includes(teamDivision)) setTeamDivision('');
    if (teamDept && !nextDepartments.includes(teamDept)) setTeamDept('');
    // Managers may sit outside the currently-selected outlet, so resolve
    // manager_id -> name from the full tenant roster, not the scoped list.
    setManagerById(Object.fromEntries(allEmps.map((e) => [e.id, fullName(e)])));

    let filtered = emps;
    if (teamDept) filtered = filtered.filter((e) => e.department === teamDept);
    if (teamDivision) filtered = filtered.filter((e) => e.division === teamDivision);
    if (teamDept) leavers = leavers.filter((e) => e.department === teamDept);
    if (teamDivision) leavers = leavers.filter((e) => e.division === teamDivision);

    const records = {};
    attRecords.forEach((r) => { records[r.profile_id] = r; });

    const rows = [...filtered, ...leavers].map((emp) => {
      const rec = records[emp.id];
      let clockInT = '—', clockOutT = '—', hours = '—', rawHours = null, status = 'Absent', badgeCls = 'badge-danger';
      let extraPunches = false, punchTimes = [], clockInSource = null, clockOutSource = null;
      // Keyed on the row existing at all, not on having punches — a manually
      // marked day (Leave, Comp Off, Travel, Show Visit, or a status set
      // without clock times) still has a real attendance row and must not
      // fall through to the Absent/Weekend default below.
      if (rec) {
        if (rec.punches?.length) {
          const sorted = [...rec.punches].sort(comparePunches);
          // Clock In = the day's first punch, Clock Out = its last punch, of
          // EITHER type — matches the fixed first-punch/last-punch rule
          // (see trg_recompute_attendance_from_punches): a device
          // double-punch or a mistaken re-scan after leaving is still
          // recorded (surfaced below via extraPunches) but no longer hides
          // the true first/last scan just because a later punch's type tag
          // doesn't happen to be 'in'/'out'.
          clockInT = fmtTime12(sorted[0].punch_time);
          clockInSource = sorted[0].source;
          if (sorted.length > 1) {
            clockOutT = fmtPunchTime12(sorted[sorted.length - 1]);
            clockOutSource = sorted[sorted.length - 1].source;
          }
          // More than one in + one out — flag it so HR can glance at the
          // raw punch list rather than silently trust whichever ended up last.
          extraPunches = sorted.length > 2;
          punchTimes = sorted.map((p) => `${fmtPunchTime12(p)} (${p.punch_type})`);
        }
        rawHours = rec.total_hours || null;
        hours = rec.total_hours ? fmtDuration(rec.total_hours) : '—';
        status = rec.status || 'Present';
        if (status === 'Present' || status === 'Late' || status === 'Travel' || status === 'Show Visit') badgeCls = 'badge-success';
        else if (status === 'Half Day' || status === 'Pending Approval') badgeCls = 'badge-warning';
        else if (status === 'Mispunch') badgeCls = 'badge-danger';
        else if (status === 'Leave' || status === 'Comp Off') badgeCls = 'badge-purple';
      } else if (isBeforeJoining(emp, teamDate)) {
        // Not joined yet: the calendar starts on the joining date.
        status = 'Not Joined'; badgeCls = 'badge-secondary';
      } else {
        const d = new Date(teamDate);
        // A holiday of the employee's own outlet (or a company-wide one, unless
        // the outlet has holidays off) is not an absence.
        const holiday = holidayForEmployee(holidaysRes.data, teamDate, emp, outletById[emp.outlet_id]);
        if (holiday) { status = 'Holiday'; badgeCls = 'badge-info'; }
        else if (isTenantWeeklyOff(d, tenant, outletById[emp.outlet_id], emp)) { status = 'Weekend'; badgeCls = 'badge-info'; }
      }
      // Where the app/web clock-in and the latest clock-out were made (device
      // punches carry no location). Only the day's first clock-in and last
      // clock-out are stored, on the attendance row itself.
      const inLoc = rec?.punch_in_lat != null && rec?.punch_in_lng != null ? { lat: rec.punch_in_lat, lng: rec.punch_in_lng } : null;
      const outLoc = rec?.punch_out_lat != null && rec?.punch_out_lng != null ? { lat: rec.punch_out_lat, lng: rec.punch_out_lng } : null;
      const offDay = isTenantWeeklyOff(new Date(teamDate), tenant, outletById[emp.outlet_id], emp);
      // Shift picked from the day's first punch, for companies on that rule.
      const dayShift = rec?.day_shift ? `${fmtTime12(rec.day_shift.start_time)} – ${fmtTime12(rec.day_shift.end_time)}` : null;
      return { ...emp, offDay, clockInT, clockOutT, hours, rawHours, status, badgeCls, extraPunches, punchTimes, clockInSource, clockOutSource, inLoc, outLoc, outOfGeofence: rec?.out_of_geofence || false, compOffCredit: Number(rec?.comp_off_credit) || 0, dayShift, dayShiftName: rec?.day_shift?.name || '', elGraced: !!rec?.early_late_graced, elKind: rec?.early_late_kind || null };
    });

    setTeamData(rows.filter((r) => !r.inactive));
    // After their last day a leaver is no longer due at work: "Left", not Absent.
    setLeaverData(rows.filter((r) => r.inactive).map((r) => (teamDate > r.exit_date && (r.status === 'Absent' || r.status === 'Weekend' || r.status === 'Holiday')
      ? { ...r, status: 'Left', badgeCls: 'badge-secondary' }
      : r)));
  }, [tenant, teamDate, teamDept, teamDivision, outletProfileIds, outlets]);

  useEffect(() => { if (tab === 'team') fetchTeamData(); }, [tab, fetchTeamData]);

  const fetchAuditLogs = useCallback(async () => {
    if (!tenant) return;
    setAuditLoading(true);
    try {
      const { data } = await fetchAttendanceAuditLog(tenant.id);
      setAuditLogs(data);
    } catch (err) {
      console.error(err);
    } finally {
      setAuditLoading(false);
    }
  }, [tenant]);

  useEffect(() => { if (tab === 'audit') fetchAuditLogs(); }, [tab, fetchAuditLogs]);

  const handleSaveManual = async () => {
    if (!manualForm.profile_id || !manualForm.date) return showToast('Employee and date required', 'error');
    if (!manualForm.reason.trim()) return showToast('Reason is required for manual attendance changes', 'error');
    try {
      await saveManualAttendance(tenant.id, {
        profile_id: manualForm.profile_id,
        date: manualForm.date,
        clockIn: manualForm.clockIn,
        clockOut: manualForm.clockOut,
        status: manualForm.status,
        reason: manualForm.reason,
      }, profile.id);
      showToast('Attendance marked & audit logged', 'success');
      setShowManual(false);
      fetchTeamData();
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    }
  };

  // Team summary
  const teamPresent = teamData.filter((r) => isFullPaidDayStatus(r.status) || r.status === 'Half Day').length;
  const teamAbsent = teamData.filter((r) => r.status === 'Absent').length;
  const teamLate = teamData.filter((r) => r.status === 'Late').length;

  // Per-employee avg daily hours + days-with-hours, for the month teamDate falls in
  const monthlyStatsByProfile = useMemo(() => {
    const sums = {};
    monthlyAtt.forEach((r) => {
      if (!r.total_hours) return;
      if (!sums[r.profile_id]) sums[r.profile_id] = { total: 0, days: 0 };
      sums[r.profile_id].total += r.total_hours;
      sums[r.profile_id].days += 1;
    });
    return sums;
  }, [monthlyAtt]);

  // Late-day count per employee for the month teamDate falls in — flags repeat
  // late-comers (>MONTHLY_LATE_HIGHLIGHT_LIMIT) wherever their row shows up.
  const monthlyLateCountByProfile = useMemo(() => {
    const counts = {};
    monthlyAtt.forEach((r) => {
      if (r.status !== 'Late') return;
      counts[r.profile_id] = (counts[r.profile_id] || 0) + 1;
    });
    return counts;
  }, [monthlyAtt]);

  // Team-wide avg daily hours this month — weighted across every recorded day,
  // so an employee who logged more days doesn't get diluted to the same weight
  // as one who logged one.
  const teamAvgHours = useMemo(() => {
    let total = 0, days = 0;
    Object.values(monthlyStatsByProfile).forEach((s) => { total += s.total; days += s.days; });
    return days > 0 ? total / days : 0;
  }, [monthlyStatsByProfile]);

  // Each leaver's days in teamDate's month, up to their last day — Present
  // and other full paid days count 1, Half Day 0.5.
  const leaverMonthDays = useMemo(() => {
    const exitById = Object.fromEntries(leaverData.map((r) => [r.id, r.exit_date]));
    const out = {};
    monthlyAtt.forEach((a) => {
      const exit = exitById[a.profile_id];
      if (!exit || a.date > exit) return;
      const s = (out[a.profile_id] ||= { present: 0, absent: 0 });
      if (isFullPaidDayStatus(a.status)) s.present += 1;
      else if (a.status === 'Half Day') s.present += 0.5;
      else if (a.status === 'Absent') s.absent += 1;
    });
    return out;
  }, [leaverData, monthlyAtt]);

  const monthLabelForTeamDate = new Date(teamDate).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  // Raniwala Jewellers' downloads follow the exact column order requested:
  // EMP CODE, EMPLOYEE NAME, DESIGNATION, DIVISION, DEPARTMENT, STATUS (Late/Absent/
  // Present), MANAGER, CLOCK IN; other tenants keep the original simpler
  // layout. Free-text fields are title-cased and codes upper-cased, matching
  // MasterReportPage's exports. Always reads teamData fresh from the
  // just-fetched attendance state, so re-downloading after a new punch (e.g.
  // someone clocking in at 12 after an earlier 11 o'clock download) reflects
  // that punch — there's no separate cached snapshot to go stale.
  // Uses ExcelJS (not the xlsx lib) because only ExcelJS can write real cell
  // fill colors — needed to highlight late arrivals in the downloaded file.
  //
  // `filterFn`/`fileTag` let the Present/Absent/Late summary tiles below
  // reuse this exact same export for a one-click "download just these
  // employees" — filterFn mirrors whichever predicate produced the number on
  // that tile (see teamPresent/teamAbsent/teamLate above) so the row count in
  // the downloaded file always matches the number the admin clicked on.
  const downloadDailyAttendance = async (filterFn = null, fileTag = '') => {
    const rows = filterFn ? teamData.filter(filterFn) : teamData;
    if (!rows.length) return showToast(`No ${fileTag ? fileTag.toLowerCase() + ' ' : ''}employees to download`, 'warning');
    const raniwala = isRaniwalaTenant(tenant);
    // Raniwala's employee master (name/department/division) is maintained in
    // ALL CAPS on purpose (matches their HR system) — don't title-case it away.
    const cap = (s) => (raniwala ? (s || '') : toTitleCase(s));
    const code = (s) => (s || '').toString().toUpperCase();

    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Attendance');
    ws.columns = raniwala
      ? [
          { header: 'EMP CODE', key: 'code', width: 10 },
          { header: 'EMPLOYEE NAME', key: 'name', width: 26 },
          { header: 'DESIGNATION', key: 'designation', width: 18 },
          { header: 'DIVISION', key: 'division', width: 16 },
          { header: 'DEPARTMENT', key: 'department', width: 16 },
          { header: 'STATUS', key: 'status', width: 12 },
          { header: 'MANAGER', key: 'manager', width: 20 },
          { header: 'CLOCK IN', key: 'clockIn', width: 12 },
        ]
      : [
          { header: 'Employee Name', key: 'name', width: 26 },
          { header: 'Department', key: 'department', width: 18 },
          { header: 'Clock In', key: 'clockIn', width: 12 },
          { header: 'Clock Out', key: 'clockOut', width: 12 },
          { header: 'Status', key: 'status', width: 12 },
        ];
    ws.getRow(1).font = { bold: true };

    const lateFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
    const lateFont = { color: { argb: 'FF9C0006' } };

    rows.forEach((r) => {
      const row = ws.addRow(raniwala
        ? {
            code: code(r.employee_id || r.essl_employee_code),
            name: cap(fullName(r)),
            designation: cap(r.designation),
            division: cap(r.division),
            department: cap(r.department),
            status: r.status || '',
            manager: cap(managerById[r.manager_id]),
            clockIn: r.clockInT === '—' ? '' : r.clockInT,
          }
        : {
            name: cap(fullName(r)),
            department: cap(r.department),
            clockIn: r.clockInT === '—' ? '' : r.clockInT,
            clockOut: r.clockOutT === '—' ? '' : r.clockOutT,
            status: r.status || '',
          });
      if (r.status === 'Late') {
        row.eachCell((cell) => { cell.fill = lateFill; cell.font = lateFont; });
      }
    });

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const outletPart = selectedOutletName ? `_${selectedOutletName.replace(/\s+/g, '_')}` : '';
    const tagPart = fileTag ? `_${fileTag}` : '';
    a.download = `attendance${outletPart}${tagPart}_${teamDate}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <Header title="Attendance" breadcrumb="Team attendance & working hours" />
      <div className="page-content">
        {/* Tabs */}
        <div className="tabs">
          {['team', 'late', 'audit'].map((t) => (
            <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'team' ? 'Team View' : t === 'late' ? 'Late Comers' : 'Audit Log'}
            </button>
          ))}
        </div>

        {/* TEAM VIEW TAB */}
        {tab === 'team' && (
          <>
            <div className="filter-bar">
              {outlets.length > 0 && (
                <select
                  className="form-select"
                  value={selectedOutletId || ''}
                  onChange={(e) => selectOutlet(e.target.value || null)}
                  title="Location (Outlet)"
                >
                  <option value="">All Outlets (Combined)</option>
                  {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
              {raniwala && divisions.length > 0 && (
                <select className="form-select" value={teamDivision} onChange={(e) => setTeamDivision(e.target.value)}>
                  <option value="">All Divisions</option>
                  {divisions.map((d) => <option key={d}>{d}</option>)}
                </select>
              )}
              <select className="form-select" value={teamDept} onChange={(e) => setTeamDept(e.target.value)}>
                <option value="">All Departments</option>
                {departments.map((d) => <option key={d}>{d}</option>)}
              </select>
              <input className="form-input" type="date" value={teamDate} onChange={(e) => setTeamDate(e.target.value)} style={{ width: 'auto' }} />
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button className="btn btn-outline" onClick={() => downloadDailyAttendance()} disabled={teamData.length === 0}>
                  <i className="fas fa-download" /> Download
                </button>
                <button className="btn btn-primary" onClick={() => { setManualForm({ profile_id: '', date: teamDate, clockIn: tenant?.shift_start || '', clockOut: tenant?.shift_end || '', status: 'Present', reason: '' }); setShowManual(true); }}>
                  <i className="fas fa-plus" /> Mark Attendance
                </button>
              </div>
            </div>

            <div className="att-summary-bar">
              <button type="button" className="att-summary-item att-summary-item-clickable" onClick={() => downloadDailyAttendance((r) => isFullPaidDayStatus(r.status) || r.status === 'Half Day', 'Present')} title="Download Present employees for this outlet">
                <div className="att-s-val" style={{ color: 'var(--success)' }}>{teamPresent}</div><div className="att-s-lbl">Present</div>
              </button>
              <button type="button" className="att-summary-item att-summary-item-clickable" onClick={() => downloadDailyAttendance((r) => r.status === 'Absent', 'Absent')} title="Download Absent employees for this outlet">
                <div className="att-s-val" style={{ color: 'var(--danger)' }}>{teamAbsent}</div><div className="att-s-lbl">Absent</div>
              </button>
              <button type="button" className="att-summary-item att-summary-item-clickable" onClick={() => downloadDailyAttendance((r) => r.status === 'Late', 'Late')} title="Download Late employees for this outlet">
                <div className="att-s-val" style={{ color: 'var(--accent)' }}>{teamLate}</div><div className="att-s-lbl">Late</div>
              </button>
              <div className="att-summary-item"><div className="att-s-val" style={{ color: 'var(--primary)' }}>{teamData.length}</div><div className="att-s-lbl">Total Staff</div></div>
              <div className="att-summary-item"><div className="att-s-val" style={{ color: 'var(--success)' }}>{teamData.length > 0 ? Math.round(teamPresent / teamData.length * 100) : 0}%</div><div className="att-s-lbl">Attendance %</div></div>
              <div className="att-summary-item"><div className="att-s-val" style={{ color: 'var(--purple)' }}>{teamData.filter((r) => r.status === 'Leave').length}</div><div className="att-s-lbl">On Leave</div></div>
              {!raniwala && (
                <div className="att-summary-item"><div className="att-s-val" style={{ color: 'var(--primary)' }}>{fmtDuration(teamAvgHours)}</div><div className="att-s-lbl">Team Avg Hours/Day ({monthLabelForTeamDate})</div></div>
              )}
            </div>

            <div className="card">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Employee</th>{raniwala && <th>Division</th>}<th>Department</th><th>Clock In</th><th>Clock Out</th><th>Working Hours</th>{raniwala && <th title="Time beyond the 8h 30m day, and what it earns">Extra Hours</th>}<th>Status</th>{!raniwala && <th>Avg Hours/Day ({monthLabelForTeamDate})</th>}<th>Actions</th></tr>
                  </thead>
                  <tbody>
                    {teamData.length === 0 ? (
                      <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No employees found</td></tr>
                    ) : teamData.map((r) => {
                      const monthStat = monthlyStatsByProfile[r.id];
                      const avgHoursThisMonth = monthStat ? monthStat.total / monthStat.days : 0;
                      const lateThisMonth = monthlyLateCountByProfile[r.id] || 0;
                      const isRepeatLate = lateThisMonth > MONTHLY_LATE_HIGHLIGHT_LIMIT;
                      const isShort = !r.offDay && isShortDay(r.rawHours);
                      return (
                      <tr key={r.id} style={isRepeatLate ? { background: 'var(--danger-light, #fee2e2)' } : undefined}>
                        <td>
                          <div className="emp-cell">
                            <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(r.id)})` }}>{getInitials(r.first_name, r.last_name)}</div>
                            <div><div className="emp-name">{fullName(r)}</div><div className="emp-role">{r.essl_employee_code ? `ESSL: ${r.essl_employee_code}` : '—'}</div></div>
                          </div>
                        </td>
                        {raniwala && <td>{r.division || '—'}</td>}
                        <td>{r.department || '—'}</td>
                        <td>
                          {r.clockInT}
                          {r.clockInSource === 'app' && (
                            <i className="fas fa-mobile-screen-button" style={{ marginLeft: 6, color: 'var(--primary)' }} title="Clocked in via App" />
                          )}
                          <PunchLocationLink loc={r.inLoc} label="Clock-in location" />
                        </td>
                        <td>
                          {r.clockOutT}
                          {r.clockOutSource === 'app' && (
                            <i className="fas fa-mobile-screen-button" style={{ marginLeft: 6, color: 'var(--primary)' }} title="Clocked out via App" />
                          )}
                          <PunchLocationLink loc={r.outLoc} label="Clock-out location" />
                          {r.extraPunches && (
                            <i
                              className="fas fa-clock-rotate-left"
                              style={{ marginLeft: 6, color: 'var(--warning)' }}
                              title={`${r.punchTimes.length} punches today — showing first→last:\n${r.punchTimes.join('\n')}`}
                            />
                          )}
                        </td>
                        <td style={isShort ? { color: 'var(--danger)', fontWeight: 700 } : undefined} title={isShort ? 'Worked less than 8 hr 30 min' : undefined}>
                          {r.hours}{isShort && <i className="fas fa-triangle-exclamation" style={{ marginLeft: 6 }} />}
                        </td>
                        {raniwala && <td><ExtraHoursCell totalHours={r.rawHours} overtime={r.overtime_applicable} compOffCredit={r.compOffCredit} offDay={r.offDay} /></td>}
                        <td>
                          <span className={`badge ${r.badgeCls}`}>{r.status}</span>
                          {r.outOfGeofence && (
                            <i className="fas fa-map-marker-alt" style={{ marginLeft: 6, color: 'var(--warning)' }} title="Punch was outside the configured geofence" />
                          )}
                          {isRepeatLate && (
                            <i className="fas fa-exclamation-triangle" style={{ marginLeft: 6, color: 'var(--danger)' }} title={`Late ${lateThisMonth}x this month`} />
                          )}
                          {r.elGraced && (
                            <div style={{ fontSize: 11, color: 'var(--success)', marginTop: 3 }} title="This month's late arrival / early left grace is on this day">
                              <i className="fas fa-shield-halved" style={{ marginRight: 4 }} />{earlyLateKindLabel(r.elKind)} · Graced
                            </div>
                          )}
                          {r.dayShift && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }} title={`Shift picked from the punch-in time: ${r.dayShiftName}`}>
                              <i className="fas fa-clock" style={{ marginRight: 4 }} />{r.dayShift}
                            </div>
                          )}
                        </td>
                        {!raniwala && <td>{monthStat ? fmtDuration(avgHoursThisMonth) : '—'}</td>}
                        <td>
                          <button className="btn btn-outline btn-sm" onClick={() => { setManualForm({ profile_id: r.id, date: teamDate, clockIn: tenant?.shift_start || '', clockOut: tenant?.shift_end || '', status: 'Present', reason: '' }); setShowManual(true); }}>
                            <i className="fas fa-edit" />
                          </button>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {leaverData.length > 0 && (
              <div className="card" style={{ marginTop: 24, borderColor: 'var(--danger)' }}>
                <div className="card-header">
                  <div>
                    <h3 style={{ margin: 0 }}>Inactive employees · {monthLabelForTeamDate}</h3>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                      Left this month. Not counted in the staff totals above. Days are counted up to each one&apos;s last day.
                    </div>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Employee</th>{raniwala && <th>Division</th>}<th>Department</th><th>Last Day</th><th>Clock In</th><th>Clock Out</th><th>Working Hours</th><th>Status</th><th>Present Days ({monthLabelForTeamDate})</th><th>Absent Days</th></tr>
                    </thead>
                    <tbody>
                      {leaverData.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <div className="emp-cell">
                              <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(r.id)})` }}>{getInitials(r.first_name, r.last_name)}</div>
                              <div><div className="emp-name">{fullName(r)}</div><div className="emp-role">{[r.employee_id, r.essl_employee_code ? `ESSL: ${r.essl_employee_code}` : ''].filter(Boolean).join(' · ') || '—'}</div></div>
                            </div>
                          </td>
                          {raniwala && <td>{r.division || '—'}</td>}
                          <td>{r.department || '—'}</td>
                          <td title={r.exit_from_attendance ? 'Set Inactive without an offboarding: last attendance day' : 'Exit date from offboarding'}>
                            {new Date(`${r.exit_date}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                            {r.exit_from_attendance && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>last attendance</div>}
                          </td>
                          <td>{r.clockInT}</td>
                          <td>{r.clockOutT}</td>
                          <td>{r.hours}</td>
                          <td><span className={`badge ${r.badgeCls}`}>{r.status}</span></td>
                          <td>{leaverMonthDays[r.id]?.present ?? 0}</td>
                          <td>{leaverMonthDays[r.id]?.absent ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {/* LATE COMERS TAB — date-range view of only Late-status employees,
            kept here in Attendance Log itself (not just a Master Report
            download). */}
        {tab === 'late' && (
          <>
            <div className="filter-bar">
              {outlets.length > 0 && (
                <select
                  className="form-select"
                  value={selectedOutletId || ''}
                  onChange={(e) => selectOutlet(e.target.value || null)}
                  title="Location (Outlet)"
                >
                  <option value="">All Outlets (Combined)</option>
                  {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
              {raniwala && lcDivisions.length > 0 && (
                <select className="form-select" value={lcDivision} onChange={(e) => setLcDivision(e.target.value)}>
                  <option value="">All Divisions</option>
                  {lcDivisions.map((d) => <option key={d}>{d}</option>)}
                </select>
              )}
              {lcDepartments.length > 0 && (
                <select className="form-select" value={lcDept} onChange={(e) => setLcDept(e.target.value)}>
                  <option value="">All Departments</option>
                  {lcDepartments.map((d) => <option key={d}>{d}</option>)}
                </select>
              )}
            </div>

            <div className="filter-bar">
              {[
                ['week', 'Last Week'],
                ['month', 'Last Month'],
                ['3months', 'Last 3 Months'],
                ['custom', 'Custom'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={`btn btn-sm ${lcPreset === key ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => applyLcPreset(key)}
                >
                  {label}
                </button>
              ))}
              {lcPreset === 'custom' && (
                <>
                  <input type="date" className="form-input" value={lcFrom} max={lcTo} onChange={(e) => setLcFrom(e.target.value)} style={{ width: 'auto' }} />
                  <span style={{ color: 'var(--text-muted)' }}>to</span>
                  <input type="date" className="form-input" value={lcTo} min={lcFrom} max={dateStr(new Date())} onChange={(e) => setLcTo(e.target.value)} style={{ width: 'auto' }} />
                </>
              )}
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {lcFrom} to {lcTo} · highlight if late count &gt; {lcThreshold}
              </span>
              <div style={{ marginLeft: 'auto' }}>
                <button className="btn btn-outline" onClick={downloadLateComers} disabled={lcLoading || lcInstances.length === 0}>
                  <i className="fas fa-download" /> Download
                </button>
              </div>
            </div>

            {lcLoading ? (
              <div style={{ textAlign: 'center', padding: 60 }}><div className="spinner" /></div>
            ) : (
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ flex: '2 1 480px', minWidth: 320 }} className="card">
                  <div className="card-header"><h3 style={{ margin: 0 }}>Late Instances ({lcInstances.length})</h3></div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Employee</th>
                          {raniwala && <th>Division</th>}
                          <th>Department</th>
                          <th>Date</th>
                          <th>Clock In</th>
                          <th>Hours</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lcInstances.length === 0 ? (
                          <tr><td colSpan={raniwala ? 6 : 5} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No late arrivals in this range.</td></tr>
                        ) : lcInstances.map((r, i) => {
                          const isShort = !r.offDay && isShortDay(r.rawHours);
                          return (
                            <tr key={i} style={lcExceedingIds.has(r.emp.id) ? { background: 'var(--danger-light, #fee2e2)' } : undefined}>
                              <td>
                                <div className="emp-cell">
                                  <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(r.emp.id)})` }}>{getInitials(r.emp.first_name, r.emp.last_name)}</div>
                                  <div>{fullName(r.emp)}</div>
                                </div>
                              </td>
                              {raniwala && <td>{r.emp.division || '—'}</td>}
                              <td>{r.emp.department || '—'}</td>
                              <td style={{ fontFamily: 'monospace' }}>{r.date}</td>
                              <td style={{ fontFamily: 'monospace' }}>{r.clockIn ? fmtTime12(r.clockIn) : '—'}</td>
                              <td style={isShort ? { color: 'var(--danger)', fontWeight: 700 } : undefined} title={isShort ? 'Worked less than 8 hr 30 min' : undefined}>
                                {r.rawHours ? fmtDuration(r.rawHours) : '—'}{isShort && <i className="fas fa-triangle-exclamation" style={{ marginLeft: 6 }} />}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div style={{ flex: '1 1 280px', minWidth: 260 }} className="card">
                  <div className="card-header"><h3 style={{ margin: 0 }}>Repeat Offenders</h3></div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Employee</th>{raniwala && <th>Division</th>}<th>Total Late</th></tr>
                      </thead>
                      <tbody>
                        {lcSummary.length === 0 ? (
                          <tr><td colSpan={raniwala ? 3 : 2} style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>—</td></tr>
                        ) : lcSummary.map((r) => (
                          <tr key={r.emp.id} style={r.exceeds ? { background: 'var(--danger-light, #fee2e2)', fontWeight: 600 } : undefined}>
                            <td>{fullName(r.emp)}</td>
                            {raniwala && <td>{r.emp.division || '—'}</td>}
                            <td>{r.count}{r.exceeds && <i className="fas fa-exclamation-triangle" style={{ marginLeft: 6, color: 'var(--danger)' }} />}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* AUDIT LOG TAB */}
        {tab === 'audit' && (
          <>
            <div className="card">
              <div className="card-header">
                <h3><i className="fas fa-history" style={{ marginRight: 8 }} />Attendance Change History</h3>
                <button className="btn btn-outline btn-sm" onClick={fetchAuditLogs}><i className="fas fa-sync" /> Refresh</button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Employee</th>
                      <th>Action</th>
                      <th>Old Status</th>
                      <th>New Status</th>
                      <th>Hours</th>
                      <th>Changed By</th>
                      <th>Reason</th>
                      <th>Timestamp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLoading ? (
                      <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 12px' }} />Loading audit log...</td></tr>
                    ) : auditLogs.length === 0 ? (
                      <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No manual attendance changes recorded yet.</td></tr>
                    ) : auditLogs.map((log) => (
                      <tr key={log.id}>
                        <td>{log.date}</td>
                        <td>
                          <div className="emp-cell">
                            <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(log.profile_id)})`, width: 28, height: 28, fontSize: 10 }}>
                              {getInitials(log.target_profile?.first_name, log.target_profile?.last_name)}
                            </div>
                            <span className="emp-name" style={{ fontSize: 12 }}>{fullName(log.target_profile)}</span>
                          </div>
                        </td>
                        <td><span className={`badge ${log.action === 'create' ? 'badge-success' : 'badge-warning'}`}>{log.action === 'create' ? 'Created' : 'Updated'}</span></td>
                        <td style={{ color: 'var(--text-muted)' }}>{log.old_status || '—'}</td>
                        <td><strong>{log.new_status}</strong></td>
                        <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{log.old_hours != null ? `${log.old_hours}h` : '—'} → {log.new_hours != null ? `${log.new_hours}h` : '—'}</td>
                        <td style={{ fontSize: 12 }}>{fullName(log.changed_by_profile)}</td>
                        <td style={{ fontSize: 11, maxWidth: 200, whiteSpace: 'normal' }}>{log.reason || '—'}</td>
                        <td style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{new Date(log.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Manual Attendance Modal */}
      <Modal show={showManual} onClose={() => setShowManual(false)} title="Mark Attendance" width="480px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setShowManual(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSaveManual}><i className="fas fa-check" /> Save</button>
        </>}
      >
        <div className="form-group">
          <label className="form-label">Employee *</label>
          <select className="form-select" value={manualForm.profile_id} onChange={(e) => setManualForm({ ...manualForm, profile_id: e.target.value })}>
            <option value="">Select</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{fullName(e)}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Date *</label>
          <input className="form-input" type="date" value={manualForm.date} onChange={(e) => setManualForm({ ...manualForm, date: e.target.value })} />
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Clock In</label><input className="form-input" type="time" value={manualForm.clockIn} onChange={(e) => setManualForm({ ...manualForm, clockIn: e.target.value })} /></div>
          <div className="form-group"><label className="form-label">Clock Out</label><input className="form-input" type="time" value={manualForm.clockOut} onChange={(e) => setManualForm({ ...manualForm, clockOut: e.target.value })} /></div>
        </div>
        <div className="form-group">
          <label className="form-label">Status</label>
          <select className="form-select" value={manualForm.status} onChange={(e) => setManualForm({ ...manualForm, status: e.target.value })}>
            <option>Present</option><option>Absent</option><option>Half Day</option><option>Mispunch</option><option>Leave</option>
            <option>Travel</option><option>Show Visit</option><option>Comp Off</option>
          </select>
          {manualForm.status === 'Comp Off' && (
            <div className="form-hint">Spends 1 day from this employee's comp-off balance (min 0 — refunded automatically if you change this entry away from Comp Off later).</div>
          )}
        </div>
        <div className="form-group">
          <label className="form-label">Reason *</label>
          <textarea className="form-input" rows={2} placeholder="e.g. Forgot to clock in, Admin override, late arrival correction..." value={manualForm.reason} onChange={(e) => setManualForm({ ...manualForm, reason: e.target.value })} style={{ resize: 'vertical' }} />
        </div>
        {/* Raniwala HR: mark / remove / move the month's late arrival / early left grace (20261028_1). */}
        {showManual && tenant?.early_late_grace_minutes && ['admin', 'superadmin'].includes(profile?.role) && (
          <EarlyLateGracePanel profileId={manualForm.profile_id} date={manualForm.date} onChanged={fetchTeamData} />
        )}
      </Modal>
    </>
  );
}
