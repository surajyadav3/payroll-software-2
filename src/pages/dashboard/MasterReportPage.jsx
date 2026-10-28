import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import Header from '@/components/Header';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { useFeatures } from '@/context/FeatureContext';
import { listActiveEmployees, fetchEmployeeMasterExtras } from '@/services/employeeService';
import { withSalaries } from '@/services/employeeSalaryService';
import { fetchAllAttendanceWithPunches, fetchAttendanceRangeWithPunches } from '@/services/attendanceService';
import { fetchAllPayslipsForReport } from '@/services/payrollService';
import { listAllLeaveRequests } from '@/services/leaveService';
import { fetchTenantLeaveBalances } from '@/services/leaveLedgerService';
import { listShifts } from '@/services/tenantService';
import { fetchTurnoverTrend } from '@/services/offboardingService';
import { fetchHolidaysInRange } from '@/services/holidayService';
import { fmtTime12, fmtDuration, dateStr, todayStr, fullName, isRaniwalaTenant, isHrSupport, toTitleCase, isFullPaidDayStatus, raniwalaExtraHours, raniwalaPayableOtHours, compOffShiftHours, RANIWALA_DAY_HOURS, weeklyOffLabel, comparePunches } from '@/lib/helpers';
import { buildDayRows, buildAbsenteeGrid, isAbsenteeDay, buildRegister, dayTypeFor } from '@/lib/attendanceRegister';
import ColumnPicker from '@/components/ColumnPicker';

function getFirstIn(punches) {
  return (punches || [])
    .filter(p => p.punch_type === 'in')
    .sort(comparePunches)[0]?.punch_time || null;
}

function getLastOut(punches) {
  const outs = (punches || [])
    .filter(p => p.punch_type === 'out')
    .sort(comparePunches);
  return outs[outs.length - 1]?.punch_time || null;
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

// Fill/font used to flag a Late day's row — same red used by AttendancePage's
// daily download for a single Late day, so the color means the same thing
// everywhere in the app.
const FLAG_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
const FLAG_FONT = { color: { argb: 'FF9C0006' }, bold: true };

// Attendance Register colours per cell code [fill, font] — Late keeps the
// FLAG red above; the rest follow HR's own register sheet (yellow weekly off,
// pink leave …).
const REGISTER_STYLE = {
  Late: ['FFFFC7CE', 'FF9C0006'],
  HF:   ['FFFFEB9C', 'FF9C5700'],
  SF:   ['FFFFEB9C', 'FF9C5700'],
  MP:   ['FFE4DFEC', 'FF5B3F86'],
  L:    ['FFF8CBAD', 'FF843C0C'],
  A:    ['FFFF9999', 'FF7F0000'],
  CO:   ['FFE2EFDA', 'FF375623'],
  WO:   ['FFFFF2CC', 'FFB7950B'],
  HOL:  ['FFDDEBF7', 'FF1F4E79'],
};
const REGISTER_LEGEND = 'P = Present · Late · HF = Half Day · SF = Short Fall · MP = Mispunch · L = Leave · A = Absent · CO = Comp Off · WO = Weekly Off · HOL = Holiday';
const REGISTER_HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F6E4A' } };
const REGISTER_BORDER = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const REGISTER_BOX = { top: REGISTER_BORDER, left: REGISTER_BORDER, bottom: REGISTER_BORDER, right: REGISTER_BORDER };
// The sub-columns repeated under every date (column-picker keys).
const REGISTER_DAY_PARTS = [
  { key: 'dayStatus', sub: 'STATUS', width: 6 },
  { key: 'dayIn', sub: 'IN', width: 9 },
  { key: 'dayOut', sub: 'OUT', width: 9 },
];
// 2026-09-01 -> 01-Sep-26 (the register's date headers).
const shortDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
// 2026-09-01 -> 01/09/2026 (DOJ).
const dmy = (d) => (d ? d.split('-').reverse().join('/') : '');
// Absentees grid: a leave day (lighter than an absence) and a weekly off / holiday.
const LEAVE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4D6' } };
const OFF_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEB9C' } };

// '2026-09-01' -> '01-Sep-26', the date header style of Raniwala's own sheet.
function gridDateHeader(date) {
  const [y, , d] = date.split('-');
  const mon = new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { month: 'short' });
  return `${d}-${mon}-${y.slice(-2)}`;
}

function applySheetChrome(ws, colCount) {
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colCount } };
}

const REPORT_CONFIGS = [
  {
    id: 'employee_details',
    label: 'Employee Details',
    icon: 'fa-id-card',
    desc: 'Full employee profiles — personal details (father\'s name, gender, date of birth, blood group, addresses, emergency contact), phone and email, department, designation, manager / HOD, join date, PAN / Aadhaar, bank details, gross / CTC, PF/ESIC numbers and compliance, and leave allocation.',
    hrSupportDesc: 'Full employee profiles — personal details (father\'s name, gender, date of birth, blood group, addresses, emergency contact), phone and email, department, designation, manager / HOD, join date, PAN / Aadhaar and leave allocation.',
    sheetName: 'Employee Details',
    filename: 'employee_details',
    iconBg: 'var(--primary-light)',
    iconFg: 'var(--primary)',
  },
  {
    id: 'attendance_log',
    label: 'Attendance Log',
    icon: 'fa-calendar-check',
    desc: 'Daily attendance for the selected date range. Only the specific dates an employee was Late are highlighted — the rest of their rows are unmarked.',
    raniwalaDesc: 'Daily attendance for the selected date range, including Absent and Leave days. Status shows Late, Half Day, Short Fall (clocked in and out but under the half-day hours) and Mispunch (single punch). Late days are highlighted.',
    sheetName: 'Attendance Log',
    filename: 'attendance_log',
    iconBg: 'var(--success-light)',
    iconFg: 'var(--success)',
  },
  {
    id: 'attendance_register',
    label: 'Attendance Register',
    icon: 'fa-table-cells',
    desc: 'One row per employee for the selected date range — Emp Code, Name, Division, Department, DOJ (Raniwala: outlet and the weekly off of each employee) and working days in the period, then every date with its status and clock in / clock out time, colour-coded (Late, Half Day, Leave, Weekly Off, Holiday), with totals at the end — Total Present counts every day the employee came in (Present, Late, Half Day, Short Fall, Mispunch), not Absent / Leave (for Raniwala, Working Days sits beside it at the end and Total Present adds the weekly offs and holidays — the days paid for). Raniwala: covers the outlets ticked at the top (e.g. Office + Delhi), with an Outlet column.',
    sheetName: 'Attendance Register',
    filename: 'attendance_register',
    iconBg: 'var(--primary-light)',
    iconFg: 'var(--primary)',
  },
  {
    id: 'monthly_payroll',
    label: 'Monthly Payroll',
    payroll: true,
    icon: 'fa-file-invoice',
    desc: 'Month-wise net pay breakdown per employee, sorted newest month first.',
    sheetName: 'Monthly Payroll',
    filename: 'monthly_payroll',
    iconBg: '#ede9fe',
    iconFg: '#7c3aed',
  },
  {
    id: 'leave_summary',
    label: 'Leave Summary',
    icon: 'fa-umbrella-beach',
    desc: 'Leave allocation vs. approved / pending / rejected counts for the current calendar year.',
    sheetName: 'Leave Summary',
    filename: 'leave_summary',
    iconBg: 'var(--warning-light)',
    iconFg: 'var(--warning)',
  },
  {
    id: 'late_comers',
    label: 'Late Comers Report',
    icon: 'fa-clock',
    desc: 'Every Late instance in the selected date range (Clock In/Out included), plus a Repeat Offenders summary sheet.',
    sheetName: 'Late Instances',
    filename: 'late_comers',
    iconBg: 'var(--danger-light)',
    iconFg: 'var(--danger)',
    featureKey: 'late_comers_report',
  },
  {
    id: 'absentees',
    label: 'Absentees',
    icon: 'fa-user-slash',
    desc: 'One row per absent employee: code, name, department, the number of days absent in the selected date range, then a column per date — A (absent, no clock in or out), L (on leave), WO / HOL (weekly off / holiday, not counted) and the day\'s status otherwise. A second sheet lists each absent day with its leave type and dates.',
    sheetName: 'Absentees',
    filename: 'absentees',
    iconBg: 'var(--danger-light)',
    iconFg: 'var(--danger)',
    raniwalaOnly: true,
  },
  {
    id: 'overtime',
    label: 'Overtime Report',
    icon: 'fa-business-time',
    desc: 'OT employees only: every day in the selected date range that pays overtime — the weekly off of each person and the day type (weekly off = that of the employee outlet, so Delhi is off Monday and a Delhi Sunday is a working day; at Gurugram each employee has their own weekly off), hours worked, time past 8h 30m (on a weekly off every hour counts, no shift) and the OT hours it pays (the same slabs Run Payroll uses) — plus a summary of how many times each person did overtime and their total OT hours.',
    sheetName: 'Overtime Days',
    filename: 'overtime',
    iconBg: 'var(--success-light)',
    iconFg: 'var(--success)',
    raniwalaOnly: true,
  },
  {
    id: 'comp_off',
    label: 'Comp Off Earned',
    icon: 'fa-calendar-plus',
    desc: 'Every comp off earned in the selected date range — the day, why (weekly off / holiday worked, or 4h+ past the shift on a working day) and how much. The weekly off is that of the employee outlet: Delhi is off Monday, so a Delhi Sunday only earns for time past the shift; at Gurugram it is the own weekly off of each employee, shown in its own column — plus a date-wise sheet (how many employees earned it each day and how much) and a total per employee. The last sheet lists every employee\'s comp off balance today (zero balances left out) with a total.',
    sheetName: 'Comp Off Earned',
    filename: 'comp_off_earned',
    iconBg: '#ede9fe',
    iconFg: '#7c3aed',
    raniwalaOnly: true,
  },
  {
    id: 'new_joiners',
    label: 'New Joiners',
    icon: 'fa-user-plus',
    desc: 'Everyone who joined in the selected months (by join date), with the full details filled for them — the Employee Details columns plus ESSL code, weekly off, default shift, probation, passport and their Earned Leave and Comp Off balance today. Two sheets: Factory, and Office with every other outlet (Office, B2B Sales, Delhi, Gurugram). Follows the Division / Department filters, not the outlet ticks.',
    sheetName: 'New Joiners',
    filename: 'new_joiners',
    iconBg: 'var(--success-light)',
    iconFg: 'var(--success)',
    raniwalaOnly: true,
  },
];

// Raniwala's outlet pick: the id standing for employees with no outlet.
const NO_OUTLET = 'none';

// Dropdown of outlet tick boxes with an "All" row; at least one stays ticked.
function OutletChecklist({ options, picked, onChange, label, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const allChecked = options.every((o) => picked.has(o.id));
  const toggle = (id) => {
    const next = new Set(picked);
    if (next.has(id)) {
      if (next.size === 1) return;
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(next);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="form-select"
        style={{ minWidth: 200, maxWidth: 320, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={label}
      >
        {label}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30, minWidth: 240,
          border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px',
          background: 'var(--surface)', boxShadow: '0 6px 18px rgba(0,0,0,0.12)', fontSize: 13,
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontWeight: 600, cursor: 'pointer' }}>
            <input type="checkbox" checked={allChecked} onChange={() => !allChecked && onChange(new Set(options.map((o) => o.id)))} />
            All Outlets (Combined)
          </label>
          {options.map((o) => (
            <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={picked.has(o.id)} onChange={() => toggle(o.id)} />
              {o.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MasterReportPage() {
  const { tenant, profile } = useAuth();
  // HR Support (no payroll): no Monthly Payroll report, no CTC/PF/ESIC columns.
  const hrSupport = isHrSupport(profile);
  const { outlets, selectedOutletId, selectedOutletName, outletProfileIds, selectOutlet } = useOutletView();
  const { isEnabled } = useFeatures();
  const raniwala = isRaniwalaTenant(tenant);
  // Late Comers Report keeps its own feature-toggle key (unchanged by the
  // move from its old standalone page into this one) — everything else here
  // is already gated at the route level by "master_report".
  const visibleConfigs = REPORT_CONFIGS.filter((c) => (!c.featureKey || isEnabled(c.featureKey)) && (!c.raniwalaOnly || raniwala) && !(c.payroll && hrSupport));
  // Raniwala's employee master (name/department/division) is maintained in
  // ALL CAPS on purpose (matches their HR system) — don't title-case it away.
  const cap = (s) => (raniwala ? (s || '') : toTitleCase(s));
  // The whole tenant roster + its year summary, unscoped; the outlet pick
  // below narrows both in memory, so changing outlets never refetches.
  const [allEmployees, setAllEmployees] = useState([]);
  const [managerById, setManagerById] = useState({});
  const [loading,   setLoading]   = useState(true);
  const [exporting, setExporting] = useState(null); // null | 'all' | reportId
  const [allSummary, setAllSummary] = useState([]);

  // Raniwala: tick any mix of outlets (Factory, Office, Delhi, Gurugram,
  // B2B Sales) and every report covers just those employees. Local to this
  // page; starts from the app-wide outlet (Office there meant every
  // non-factory outlet, so it starts as that). NO_OUTLET = employees with no
  // outlet assigned. Other tenants keep the single app-wide outlet select.
  const hasNoOutlet = useMemo(() => allEmployees.some((e) => !e.outlet_id), [allEmployees]);
  const outletOptions = useMemo(() => [
    ...outlets.map((o) => ({ id: o.id, name: o.name })),
    ...(hasNoOutlet ? [{ id: NO_OUTLET, name: 'No outlet' }] : []),
  ], [outlets, hasNoOutlet]);
  const [pickedOutlets, setPickedOutlets] = useState(null); // Set of outlet ids
  useEffect(() => {
    if (!raniwala || pickedOutlets || !outlets.length) return;
    const isFactory = (o) => /factory/i.test(o?.name || '');
    const selected = outlets.find((o) => o.id === selectedOutletId);
    const ids = [...outlets.map((o) => o.id), NO_OUTLET];
    if (!selected) setPickedOutlets(new Set(ids));
    else if (isFactory(selected)) setPickedOutlets(new Set([selected.id]));
    else if (/office/i.test(selected.name || '')) setPickedOutlets(new Set(ids.filter((id) => !isFactory(outlets.find((o) => o.id === id)))));
    else setPickedOutlets(new Set([selected.id]));
  }, [raniwala, pickedOutlets, outlets, selectedOutletId]);
  const allOutletsPicked = !pickedOutlets || outletOptions.every((o) => pickedOutlets.has(o.id));
  const inScope = useCallback((emp) => {
    if (raniwala) return !pickedOutlets || pickedOutlets.has(emp.outlet_id || NO_OUTLET);
    return !outletProfileIds || outletProfileIds.has(emp.id);
  }, [raniwala, pickedOutlets, outletProfileIds]);
  const employees = useMemo(() => allEmployees.filter(inScope), [allEmployees, inScope]);
  const summary   = useMemo(() => allSummary.filter((r) => inScope(r.emp)), [allSummary, inScope]);
  // Names of the ticked outlets for the sheet heading and file names; empty
  // when everything is ticked (= Combined).
  const scopeLabel = raniwala
    ? (allOutletsPicked ? '' : outletOptions.filter((o) => pickedOutlets.has(o.id)).map((o) => o.name).join(' + '))
    : selectedOutletName;
  const [year,      setYear]      = useState(new Date().getFullYear());

  // Department/Division refine the outlet-scoped roster further — applied on
  // top of whatever outlet is selected above, so a report can be downloaded
  // for e.g. "Jaipur outlet, Sales department" in one go.
  const [deptFilter,     setDeptFilter]     = useState('');
  const [divisionFilter, setDivisionFilter] = useState('');

  // Attendance Log has its own date range instead of following `year` —
  // it's the one report people repeatedly need for an arbitrary window
  // (a pay-cycle, a specific fortnight) rather than a full calendar year.
  const [attFrom, setAttFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return dateStr(d);
  });
  const [attTo, setAttTo] = useState(() => dateStr(new Date()));
  const [attRangeMap, setAttRangeMap] = useState({}); // { [profileId]: { [date]: record } }
  const [attRangeLoading, setAttRangeLoading] = useState(false);
  // Raniwala's Absent/Leave days: leave requests come from the leave list
  // fetchData already loads; holidays are fetched with the attendance range
  // (for every tenant — the Attendance Register marks them HOL).
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [rangeHolidays, setRangeHolidays] = useState([]);
  // New Joiners: a month range on join date ('YYYY-MM'), this month by default.
  const thisMonth = todayStr().slice(0, 7);
  const [joinFrom, setJoinFrom] = useState(thisMonth);
  const [joinTo, setJoinTo] = useState(thisMonth);

  const fetchData = useCallback(async () => {
    if (!tenant) return;
    setLoading(true);
    try {
      const [empsRes, attRes, payRes, leaveRes] = await Promise.all([
        // Salary (CTC column) comes from employee_salaries for a salary-private tenant.
        hrSupport ? listActiveEmployees(tenant.id) : listActiveEmployees(tenant.id).then((res) => withSalaries(tenant, res)),
        fetchAllAttendanceWithPunches(tenant.id, year),
        hrSupport ? { data: [] } : fetchAllPayslipsForReport(tenant.id, year),
        listAllLeaveRequests(tenant.id),
      ]);

      // Managers may sit outside the currently-selected outlet, so resolve
      // manager_id -> name from the full tenant roster, not the scoped list.
      setManagerById(Object.fromEntries((empsRes.data || []).map((e) => [e.id, fullName(e)])));
      const emps     = empsRes.data || [];
      const attAll   = attRes.data   || [];
      const payrolls = payRes.data   || [];
      const leaves   = leaveRes.data || [];

      const attMap = {};
      attAll.forEach(r => {
        if (!attMap[r.profile_id]) attMap[r.profile_id] = {};
        attMap[r.profile_id][r.date] = r;
      });

      const payMap = {};
      payrolls.forEach(pr => {
        (pr.payslips || []).forEach(ps => {
          const key = `${pr.year}-${pr.month}`;
          if (!payMap[ps.profile_id]) payMap[ps.profile_id] = {};
          payMap[ps.profile_id][key] = ps.net_pay;
        });
      });

      const leaveUsed  = {};
      const leaveStats = {};

      leaves.forEach(lr => {
        const yr = lr.start_date ? parseInt(lr.start_date.split('-')[0], 10) : 0;
        if (yr !== year) return;
        const days   = lr.days_count || lr.days || 1;
        const empId  = lr.profile_id;
        const status = (lr.status || '').toLowerCase();
        if (!leaveStats[empId]) leaveStats[empId] = { approved: 0, pending: 0, rejected: 0 };
        if (status === 'approved') {
          if (!leaveUsed[empId]) leaveUsed[empId] = 0;
          leaveUsed[empId] += days;
          leaveStats[empId].approved += days;
        } else if (status === 'pending') {
          leaveStats[empId].pending += days;
        } else if (status === 'rejected') {
          leaveStats[empId].rejected += days;
        }
      });

      const rows = emps.map(emp => {
        const empAtt      = attMap[emp.id] || {};
        const attRecords  = Object.values(empAtt);
        const presentDays = attRecords.filter(r => isFullPaidDayStatus(r.status)).length;
        const lateDays    = attRecords.filter(r => r.status === 'Late').length;
        const halfDays    = attRecords.filter(r => r.status === 'Half Day').length;
        const leaveDays   = attRecords.filter(r => r.status === 'Leave').length;
        const empPayMap   = payMap[emp.id] || {};
        const payValues   = Object.values(empPayMap);
        const totalNetPaid = payValues.reduce((s, v) => s + (v || 0), 0);
        const sortedKeys   = Object.keys(empPayMap).sort((a, b) => b.localeCompare(a));
        const lastPay      = sortedKeys.length ? empPayMap[sortedKeys[0]] : null;
        const usedThisYear = leaveUsed[emp.id] || 0;
        const leavesRemaining = Math.max(0, (emp.leave_allocation || 0) - usedThisYear);
        const ls = leaveStats[emp.id] || { approved: 0, pending: 0, rejected: 0 };

        return {
          emp,
          presentDays, lateDays, halfDays, leaveDays,
          totalNetPaid, lastPay,
          usedThisYear, leavesRemaining,
          leaveApproved: ls.approved,
          leavePending:  ls.pending,
          leaveRejected: ls.rejected,
          payMap: empPayMap,
        };
      });

      setAllEmployees(emps);
      setAllSummary(rows);
      setLeaveRequests(leaves);
    } catch (err) {
      showToast('Failed to load data: ' + err.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [tenant, year, hrSupport]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const [turnover, setTurnover] = useState([]);
  // Raniwala: the ticked outlets' employee ids (null = all ticked).
  const turnoverIds = useMemo(() => {
    if (!raniwala) return outletProfileIds;
    if (allOutletsPicked) return null;
    return new Set(employees.map((e) => e.id));
  }, [raniwala, outletProfileIds, allOutletsPicked, employees]);
  useEffect(() => {
    if (!tenant || (raniwala && (!pickedOutlets || loading))) return;
    let cancelled = false;
    fetchTurnoverTrend(tenant.id, 6, turnoverIds).then(({ data }) => { if (!cancelled) setTurnover(data || []); });
    return () => { cancelled = true; };
  }, [tenant, raniwala, pickedOutlets, loading, turnoverIds]);

  const fetchAttendanceRange = useCallback(async () => {
    if (!tenant || !attFrom || !attTo) return;
    setAttRangeLoading(true);
    try {
      const [{ data, error }, holRes] = await Promise.all([
        fetchAttendanceRangeWithPunches(tenant.id, attFrom, attTo),
        fetchHolidaysInRange(tenant.id, attFrom, attTo),
      ]);
      if (error) throw error;
      if (holRes.error) throw holRes.error;
      // Kept for every outlet: each report reads it by employee id from its
      // own (outlet-scoped) employee list, and the Office register needs the
      // other outlets' days too.
      const map = {};
      (data || []).forEach(r => {
        if (!map[r.profile_id]) map[r.profile_id] = {};
        map[r.profile_id][r.date] = r;
      });
      setAttRangeMap(map);
      setRangeHolidays(holRes.data || []);
    } catch (err) {
      showToast('Failed to load attendance range: ' + err.message, 'error');
    } finally {
      setAttRangeLoading(false);
    }
  }, [tenant, attFrom, attTo]);

  useEffect(() => { fetchAttendanceRange(); }, [fetchAttendanceRange]);

  const divisions = useMemo(
    () => [...new Set(employees.map((e) => e.division).filter(Boolean))].sort(),
    [employees],
  );
  // Outlet -> Division -> Department cascade: department options narrow to
  // whichever division is also selected, not just the outlet-scoped roster,
  // so picking a division only ever offers departments that exist within it.
  const departments = useMemo(
    () => [...new Set(
      employees.filter((e) => !divisionFilter || e.division === divisionFilter).map((e) => e.department).filter(Boolean)
    )].sort(),
    [employees, divisionFilter],
  );

  // Outlet/division changed and the current selection no longer applies —
  // clear it back to "All" instead of silently filtering to zero rows.
  useEffect(() => {
    if (divisionFilter && !divisions.includes(divisionFilter)) setDivisionFilter('');
  }, [divisions, divisionFilter]);
  useEffect(() => {
    if (deptFilter && !departments.includes(deptFilter)) setDeptFilter('');
  }, [departments, deptFilter]);

  const matchesDeptDivision = useCallback((emp) => {
    if (deptFilter && emp.department !== deptFilter) return false;
    if (divisionFilter && emp.division !== divisionFilter) return false;
    return true;
  }, [deptFilter, divisionFilter]);

  // Every sheet builder + the row-count preview reads these instead of the
  // raw outlet-scoped `employees`/`summary` state, so the Department/Division
  // filters above apply to every report in one pass.
  const filteredEmployees = useMemo(() => employees.filter(matchesDeptDivision), [employees, matchesDeptDivision]);
  const filteredSummary   = useMemo(() => summary.filter((r) => matchesDeptDivision(r.emp)), [summary, matchesDeptDivision]);

  // One entry per employee with their day rows in the attFrom/attTo range —
  // the single source for the Attendance Log and Absentees sheets.
  // For Raniwala this adds the Absent/Leave days that have no attendance row
  // and rewords under-hours days as Short Fall (rules in lib/attendanceRegister).
  const dayRowsByEmployee = useMemo(() => buildDayRows({
    raniwala, tenant, outlets, employees: filteredEmployees, attByProfile: attRangeMap,
    fromDate: attFrom, toDate: attTo, today: todayStr(), leaves: leaveRequests, holidays: rangeHolidays,
  }), [raniwala, tenant, outlets, filteredEmployees, attRangeMap, attFrom, attTo, leaveRequests, rangeHolidays]);

  // The Attendance Register card: the same day rows laid out one employee per
  // row, one cell per date, plus working days in the range.
  const register = useMemo(() => buildRegister({
    entries: dayRowsByEmployee,
    tenant, outlets, fromDate: attFrom, toDate: attTo, today: todayStr(), holidays: rangeHolidays,
  }), [dayRowsByEmployee, tenant, outlets, attFrom, attTo, rangeHolidays]);

  // The Absentees card: date-wise, everyone with no clock in and no clock
  // out that day — plain absent or on leave. A day with any punch (Short
  // Fall, Mispunch, or someone who punched while on leave) is not listed.
  const absenteeRows = useMemo(() => (
    dayRowsByEmployee
      .flatMap(({ emp, rows }) => rows
        .filter(isAbsenteeDay)
        .map((r) => ({ emp, ...r })))
      .sort((a, b) => a.date.localeCompare(b.date))
  ), [dayRowsByEmployee]);

  // The same absences as a grid: a row per employee absent at least once,
  // a column per date (lib/attendanceRegister), most days absent first.
  const absenteeGrid = useMemo(() => {
    const grid = buildAbsenteeGrid({
      entries: dayRowsByEmployee, tenant, outlets, holidays: rangeHolidays,
      fromDate: attFrom, toDate: attTo, today: todayStr(),
    });
    grid.rows.sort((a, b) => b.absentDays - a.absentDays);
    return grid;
  }, [dayRowsByEmployee, tenant, outlets, rangeHolidays, attFrom, attTo]);

  // Overtime: OT-ticked employees' days that pay OT in the range — the same
  // per-day slabs Run Payroll adds to pay (raniwalaPayableOtHours). The day
  // type uses the employee's own outlet's weekly off (Delhi: Monday); on a
  // weekly off every hour worked counts, there is no shift.
  const overtimeRows = useMemo(() => {
    if (!raniwala) return [];
    const outletById = Object.fromEntries((outlets || []).map((o) => [o.id, o]));
    return filteredEmployees.filter((e) => e.overtime_applicable).flatMap((emp) => (
      Object.values(attRangeMap[emp.id] || {})
        .map((rec) => {
          const dayType = dayTypeFor({ emp, outlet: outletById[emp.outlet_id], tenant, holidays: rangeHolidays, date: rec.date });
          const offDay = dayType === 'Weekly off';
          return {
            emp, date: rec.date, rec, dayType,
            extra: raniwalaExtraHours(rec.total_hours, offDay), ot: raniwalaPayableOtHours(rec.total_hours, offDay),
          };
        })
        .filter((r) => r.ot > 0)
    )).sort((a, b) => a.date.localeCompare(b.date));
  }, [raniwala, filteredEmployees, attRangeMap, outlets, tenant, rangeHolidays]);

  // Comp off: every day the DB credited (attendance.comp_off_credit) in the
  // range. comp_off_granted = a weekly off / holiday worked; otherwise it was
  // time past the employee's shift on a normal day (20261012_4). The weekly
  // off is the employee's own outlet's (Delhi: Monday — 20261014_2).
  const compOffRows = useMemo(() => {
    if (!raniwala) return [];
    const outletById = Object.fromEntries((outlets || []).map((o) => [o.id, o]));
    return filteredEmployees.flatMap((emp) => {
      const outlet = outletById[emp.outlet_id];
      const shift = compOffShiftHours(outlet, tenant);
      return Object.values(attRangeMap[emp.id] || {})
        .filter((rec) => Number(rec.comp_off_credit) > 0)
        .map((rec) => ({
          emp, date: rec.date, rec, credit: Number(rec.comp_off_credit),
          offDay: !!rec.comp_off_granted, shift,
          dayType: dayTypeFor({ emp, outlet, tenant, holidays: rangeHolidays, date: rec.date }),
          extra: rec.comp_off_granted ? null : Math.max(0, (Number(rec.total_hours) || 0) - shift),
        }));
    }).sort((a, b) => a.date.localeCompare(b.date));
  }, [raniwala, filteredEmployees, attRangeMap, outlets, tenant, rangeHolidays]);

  // Comp Off Balance sheet: everyone with a non-zero balance, highest first.
  const compOffBalanceRows = useMemo(() => (
    raniwala
      ? filteredEmployees
        .filter((e) => Number(e.comp_off_balance || 0) !== 0)
        .sort((a, b) => Number(b.comp_off_balance) - Number(a.comp_off_balance))
      : []
  ), [raniwala, filteredEmployees]);

  // New Joiners: the whole roster (not the outlet ticks — the report splits
  // Factory / Office itself) joined within the month range, Division /
  // Department filters applied, oldest joiner first.
  const newJoiners = useMemo(() => {
    if (!raniwala) return { factory: [], office: [] };
    const [ty, tm] = joinTo.split('-').map(Number);
    const from = `${joinFrom}-01`;
    const to = dateStr(new Date(ty, tm, 0));
    const factoryIds = new Set((outlets || []).filter((o) => /factory/i.test(o.name || '')).map((o) => o.id));
    const list = allEmployees
      .filter((e) => e.join_date && e.join_date >= from && e.join_date <= to && matchesDeptDivision(e))
      .sort((a, b) => a.join_date.localeCompare(b.join_date) || fullName(a).localeCompare(fullName(b)));
    return {
      factory: list.filter((e) => factoryIds.has(e.outlet_id)),
      office: list.filter((e) => !factoryIds.has(e.outlet_id)),
    };
  }, [raniwala, allEmployees, outlets, joinFrom, joinTo, matchesDeptDivision]);

  const yearOptions = Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i);

  // Leads every sheet's rows with the employee's own code instead of a
  // row-number serial — a serial renumbers itself whenever rows are
  // sorted/filtered in Excel, while the employee code stays a stable
  // per-employee identifier.
  const empCode = (emp) => ((emp.employee_id || emp.essl_employee_code || '')).toString().toUpperCase();

  // Single source of truth for each report's full column set — read by both
  // the sheet builders below (filtered down to whatever's ticked) and the
  // ColumnPicker UI (so the checklist always matches what actually gets
  // written). Raniwala-only columns (Division, extra Attendance Log/Late
  // Comers fields) only appear here when `raniwala` is true, exactly as they
  // did when hardcoded per-builder.
  function columnsFor(reportId) {
    switch (reportId) {
      case 'employee_details':
        return [
          { header: 'Employee Code', key: 'code', width: 12 },
          { header: 'Employee Name', key: 'name', width: 24 },
          { header: "Father's Name", key: 'fatherName', width: 22 },
          { header: 'Gender', key: 'gender', width: 9 },
          { header: 'Date of Birth', key: 'dob', width: 12 },
          { header: 'Marital Status', key: 'maritalStatus', width: 13 },
          { header: 'Blood Group', key: 'bloodGroup', width: 10 },
          { header: 'Nationality', key: 'nationality', width: 11 },
          { header: 'Phone', key: 'phone', width: 14 },
          { header: 'Email', key: 'email', width: 28 },
          { header: 'Personal Email', key: 'personalEmail', width: 28 },
          { header: 'Alternate Phone', key: 'altPhone', width: 16 },
          { header: 'Department', key: 'department', width: 18 },
          { header: 'Designation', key: 'designation', width: 20 },
          ...(raniwala ? [{ header: 'Division', key: 'division', width: 16 }] : []),
          { header: 'Outlet / Location', key: 'location', width: 16 },
          { header: 'Manager', key: 'manager', width: 22 },
          { header: 'HOD', key: 'hod', width: 22 },
          { header: 'Join Date', key: 'joinDate', width: 12 },
          { header: 'Current Address', key: 'currentAddress', width: 40 },
          { header: 'Permanent Address', key: 'permanentAddress', width: 40 },
          { header: 'Emergency Contact', key: 'emergencyContact', width: 32 },
          { header: 'PAN', key: 'pan', width: 12 },
          { header: 'Aadhaar', key: 'aadhar', width: 15 },
          ...(hrSupport ? [] : [
            { header: 'Bank Name', key: 'bankName', width: 20 },
            { header: 'Bank A/c No.', key: 'bankAcc', width: 20 },
            { header: 'IFSC', key: 'ifsc', width: 13 },
            // A salary-private tenant (Raniwala) keeps gross / CTC / actual
            // gross apart in employee_salaries; emp.ctc there is the gross.
            ...(tenant?.salary_private ? [
              { header: 'Monthly Gross (₹)', key: 'ctc', width: 16 },
              { header: 'CTC (₹)', key: 'salaryCtc', width: 14 },
              { header: 'Actual Gross (₹)', key: 'actualGross', width: 16 },
              { header: 'Gross Advance (₹)', key: 'grossAdvance', width: 16 },
            ] : [{ header: 'CTC (₹)', key: 'ctc', width: 14 }]),
            { header: 'PF Enabled', key: 'pfEnabled', width: 12 },
            { header: 'PF / UAN No.', key: 'pfNumber', width: 16 },
            { header: 'PF Amount (₹)', key: 'pfAmount', width: 15 },
            { header: 'ESIC Enabled', key: 'esicEnabled', width: 14 },
            { header: 'ESIC No.', key: 'esicNumber', width: 16 },
            { header: 'ESIC Amount (₹)', key: 'esicAmount', width: 16 },
          ]),
          ...(raniwala ? [
            { header: 'OT Applicable', key: 'otApplicable', width: 13 },
            { header: 'Comp Off Eligible', key: 'compOffEligible', width: 16 },
          ] : []),
          { header: 'Leave Allocation', key: 'leaveAllocation', width: 16 },
        ];
      // Employee Details plus the rest of the joining form and the balances today.
      case 'new_joiners':
        return [
          ...columnsFor('employee_details'),
          { header: 'ESSL Code', key: 'esslCode', width: 11 },
          { header: 'Weekly Off', key: 'weeklyOff', width: 12 },
          { header: 'Default Shift', key: 'shift', width: 24 },
          { header: 'Probation (Months)', key: 'probation', width: 12 },
          { header: 'Passport No.', key: 'passport', width: 14 },
          { header: 'Earned Leave Balance', key: 'earnedLeave', width: 14 },
          { header: 'Comp Off Balance', key: 'compOffBalance', width: 13 },
        ];
      case 'attendance_log':
        return raniwala
          ? [
              { header: 'EMP CODE', key: 'code', width: 10 },
              { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
              { header: 'DESIGNATION', key: 'designation', width: 18 },
              { header: 'DIVISION', key: 'division', width: 16 },
              { header: 'DEPARTMENT', key: 'department', width: 16 },
              { header: 'WEEKLY OFF', key: 'weeklyOff', width: 12 },
              { header: 'STATUS', key: 'status', width: 12 },
              { header: 'MANAGER', key: 'manager', width: 20 },
              { header: 'CLOCK IN', key: 'clockIn', width: 12 },
              { header: 'DATE', key: 'date', width: 12 },
              { header: 'DAY', key: 'day', width: 6 },
              { header: 'CLOCK OUT', key: 'clockOut', width: 12 },
              { header: 'HOURS WORKED', key: 'hoursWorked', width: 16 },
            ]
          : [
              { header: 'ESSL Employee Code', key: 'code', width: 16 },
              { header: 'Employee Name', key: 'name', width: 24 },
              { header: 'Department', key: 'department', width: 18 },
              { header: 'Designation', key: 'designation', width: 20 },
              { header: 'Date', key: 'date', width: 12 },
              { header: 'Day', key: 'day', width: 6 },
              { header: 'Status', key: 'status', width: 12 },
              { header: 'Clock In', key: 'clockIn', width: 12 },
              { header: 'Clock Out', key: 'clockOut', width: 12 },
              { header: 'Hours Worked', key: 'hoursWorked', width: 16 },
            ];
      case 'attendance_register':
        // dayStatus/dayIn/dayOut stand for the sub-columns repeated under
        // every date; everything else is a single column.
        return [
          { header: 'EMP CODE', key: 'code', width: 10 },
          { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
          ...(raniwala ? [{ header: 'DIVISION', key: 'division', width: 14 }] : []),
          { header: 'DEPARTMENT', key: 'department', width: 16 },
          // Several outlets can be ticked at once.
          ...(raniwala ? [{ header: 'OUTLET', key: 'outlet', width: 18 }] : []),
          // Each employee's own weekly off (Gurgaon: per employee).
          ...(raniwala ? [{ header: 'WEEKLY OFF', key: 'weeklyOff', width: 12 }] : []),
          { header: 'DOJ', key: 'doj', width: 11 },
          // Raniwala has it at the end, beside TOTAL PRESENT.
          ...(raniwala ? [] : [{ header: 'WORKING DAYS', key: 'workingDays', width: 10 }]),
          { header: 'Daily Status (every date)', key: 'dayStatus' },
          { header: 'Daily Clock In (every date)', key: 'dayIn' },
          { header: 'Daily Clock Out (every date)', key: 'dayOut' },
          { header: 'PRESENT', key: 'P', width: 9 },
          { header: 'LATE', key: 'Late', width: 7 },
          { header: 'HALF DAY', key: 'HF', width: 9 },
          ...(raniwala ? [
            { header: 'SHORT FALL', key: 'SF', width: 9 },
            { header: 'MISPUNCH', key: 'MP', width: 10 },
          ] : []),
          { header: 'LEAVE', key: 'L', width: 7 },
          { header: 'ABSENT', key: 'A', width: 8 },
          { header: 'COMP OFF', key: 'CO', width: 9 },
          { header: 'WEEKLY OFF', key: 'WO', width: 9 },
          { header: 'HOLIDAY', key: 'HOL', width: 9 },
          ...(raniwala ? [{ header: 'WORKING DAYS', key: 'workingDays', width: 10 }] : []),
          { header: 'TOTAL PRESENT', key: 'presentDays', width: 10 },
        ];
      case 'monthly_payroll':
        return [
          { header: 'Employee Code', key: 'code', width: 12 },
          { header: 'Employee Name', key: 'name', width: 24 },
          { header: 'Department', key: 'department', width: 18 },
          { header: 'Designation', key: 'designation', width: 20 },
          ...(raniwala ? [{ header: 'Division', key: 'division', width: 16 }] : []),
          { header: 'Month', key: 'month', width: 14 },
          { header: 'Year', key: 'year', width: 8 },
          { header: 'Net Pay (₹)', key: 'netPay', width: 16 },
        ];
      case 'leave_summary':
        return [
          { header: 'Employee Code', key: 'code', width: 12 },
          { header: 'Employee Name', key: 'name', width: 24 },
          { header: 'Department', key: 'department', width: 18 },
          ...(raniwala ? [{ header: 'Division', key: 'division', width: 16 }] : []),
          { header: 'Leave Allocation', key: 'leaveAllocation', width: 17 },
          { header: 'Approved (This Year)', key: 'approved', width: 22 },
          { header: 'Pending', key: 'pending', width: 12 },
          { header: 'Rejected', key: 'rejected', width: 12 },
          { header: 'Leaves Remaining', key: 'remaining', width: 18 },
        ];
      case 'late_comers':
        return raniwala
          ? [
              { header: 'EMP CODE', key: 'code', width: 10 },
              { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
              { header: 'DESIGNATION', key: 'designation', width: 18 },
              { header: 'DIVISION', key: 'division', width: 16 },
              { header: 'DEPARTMENT', key: 'department', width: 16 },
              { header: 'MANAGER', key: 'manager', width: 20 },
              { header: 'LOCATION', key: 'location', width: 14 },
              { header: 'DATE', key: 'date', width: 12 },
              { header: 'CLOCK IN', key: 'clockIn', width: 12 },
              { header: 'CLOCK OUT', key: 'clockOut', width: 12 },
              { header: 'HOURS', key: 'hours', width: 12 },
            ]
          : [
              { header: 'Employee Name', key: 'name', width: 24 },
              { header: 'Department', key: 'department', width: 18 },
              { header: 'Date', key: 'date', width: 12 },
              { header: 'Clock In', key: 'clockIn', width: 12 },
              { header: 'Clock Out', key: 'clockOut', width: 12 },
              { header: 'Hours', key: 'hours', width: 12 },
            ];
      // The grid's lead columns; one column per date always follows them.
      case 'absentees':
        return [
          { header: 'EMP CODE', key: 'code', width: 10 },
          { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
          { header: 'DEPARTMENT', key: 'department', width: 16 },
          { header: 'NO. OF DAYS ABSENT', key: 'absentDays', width: 12 },
        ];
      case 'overtime':
        return [
          { header: 'EMP CODE', key: 'code', width: 10 },
          { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
          { header: 'DESIGNATION', key: 'designation', width: 18 },
          { header: 'DEPARTMENT', key: 'department', width: 16 },
          { header: 'LOCATION', key: 'location', width: 14 },
          { header: 'WEEKLY OFF', key: 'weeklyOff', width: 12 },
          { header: 'DATE', key: 'date', width: 12 },
          { header: 'DAY', key: 'day', width: 6 },
          { header: 'DAY TYPE', key: 'dayType', width: 12 },
          { header: 'CLOCK IN', key: 'clockIn', width: 12 },
          { header: 'CLOCK OUT', key: 'clockOut', width: 12 },
          { header: 'HOURS WORKED', key: 'hoursWorked', width: 14 },
          { header: `EXTRA (PAST ${fmtDuration(RANIWALA_DAY_HOURS).toUpperCase()}; WEEKLY OFF: ALL)`, key: 'extra', width: 26 },
          { header: 'OT HOURS', key: 'ot', width: 10 },
        ];
      case 'comp_off':
        return [
          { header: 'EMP CODE', key: 'code', width: 10 },
          { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
          { header: 'DESIGNATION', key: 'designation', width: 18 },
          { header: 'DEPARTMENT', key: 'department', width: 16 },
          { header: 'LOCATION', key: 'location', width: 14 },
          { header: 'WEEKLY OFF', key: 'weeklyOff', width: 12 },
          { header: 'DATE', key: 'date', width: 12 },
          { header: 'DAY', key: 'day', width: 6 },
          { header: 'DAY TYPE', key: 'dayType', width: 12 },
          { header: 'REASON', key: 'reason', width: 26 },
          { header: 'CLOCK IN', key: 'clockIn', width: 12 },
          { header: 'CLOCK OUT', key: 'clockOut', width: 12 },
          { header: 'HOURS WORKED', key: 'hoursWorked', width: 14 },
          { header: 'SHIFT', key: 'shift', width: 10 },
          { header: 'EXTRA', key: 'extra', width: 10 },
          { header: 'COMP OFF EARNED (DAYS)', key: 'credit', width: 22 },
        ];
      default:
        return [];
    }
  }

  const [selectedColumns, setSelectedColumns] = useState({});
  const getSelectedKeys = (reportId) =>
    selectedColumns[reportId] || new Set(columnsFor(reportId).map((c) => c.key));
  const setSelectedKeys = (reportId, next) =>
    setSelectedColumns((s) => ({ ...s, [reportId]: next }));

  // `extras` = fetchEmployeeMasterExtras() — loaded by the download handlers.
  function addEmployeeDetailsSheet(wb, selectedKeys, extras = {}) {
    fillEmployeeDetails(wb.addWorksheet('Employee Details'), filteredSummary.map((r) => r.emp), selectedKeys, extras);
  }

  // New Joiners: the same columns, Factory on one sheet, every other outlet
  // (Office, B2B Sales, Delhi, Gurugram) on the Office sheet.
  function addNewJoinersSheet(wb, selectedKeys, extras = {}) {
    fillEmployeeDetails(wb.addWorksheet('New Joiners - Factory'), newJoiners.factory, selectedKeys, extras, 'new_joiners');
    fillEmployeeDetails(wb.addWorksheet('New Joiners - Office'), newJoiners.office, selectedKeys, extras, 'new_joiners');
  }

  function fillEmployeeDetails(ws, emps, selectedKeys, extras, reportId = 'employee_details') {
    ws.columns = columnsFor(reportId).filter((c) => selectedKeys.has(c.key));
    const address = (a) => ['line1', 'line2', 'city', 'state', 'pincode', 'country']
      .map((k) => (a?.[k] || '').toString().trim()).filter(Boolean).join(', ');
    const contacts = (list) => (Array.isArray(list) ? list : [])
      .map((c) => [c.name, c.relation && `(${c.relation})`, c.phone].filter(Boolean).join(' ')).filter(Boolean).join('; ');
    // Phone-only logins carry a placeholder address, not a real email.
    const realEmail = (e) => (/crewcore\.internal$/i.test(e || '') ? '' : (e || ''));
    emps.forEach((emp) => {
      const x = extras[emp.id] || {};
      const d = x.details || {};
      ws.addRow({
        code: empCode(emp),
        name: cap(fullName(emp)),
        fatherName: cap(x.father_name),
        gender: d.gender || '',
        dob: x.date_of_birth || d.date_of_birth || '',
        maritalStatus: d.marital_status || '',
        bloodGroup: d.blood_group || '',
        nationality: d.nationality || '',
        phone: x.phone || '',
        email: realEmail(x.email),
        personalEmail: d.personal_email || '',
        altPhone: d.work_number || d.residence_number || '',
        department: cap(emp.department),
        designation: cap(emp.designation),
        ...(raniwala ? { division: cap(emp.division) } : {}),
        location: cap(emp.outlet_location),
        manager: cap(managerById[emp.manager_id] || x.manager_display_name),
        hod: cap(managerById[x.hod_id] || x.hod_display_name),
        joinDate: emp.join_date || '',
        currentAddress: address(d.current_address),
        permanentAddress: address(d.permanent_address),
        emergencyContact: contacts(d.emergency_contacts),
        pan: x.pan || '',
        aadhar: x.aadhar || '',
        bankName: emp.bank_name || '',
        bankAcc: emp.bank_acc || '',
        ifsc: emp.ifsc_code || '',
        ctc: emp.ctc || 0,
        salaryCtc: emp.salary_ctc || 0,
        actualGross: emp.actual_gross || 0,
        grossAdvance: emp.gross_advance || 0,
        pfEnabled: emp.pf_enabled ? 'Yes' : 'No',
        pfNumber: emp.pf_number || '',
        pfAmount: emp.pf_amount || 0,
        esicEnabled: emp.esic_enabled ? 'Yes' : 'No',
        esicNumber: x.esic_number || '',
        esicAmount: emp.esic_amount || 0,
        otApplicable: emp.overtime_applicable ? 'Yes' : 'No',
        compOffEligible: emp.comp_off_eligible ? 'Yes' : 'No',
        leaveAllocation: emp.leave_allocation || 0,
        esslCode: emp.essl_employee_code || '',
        weeklyOff: weeklyOffOf(emp),
        shift: x.shift_label || 'Company Default',
        probation: emp.probation_months ?? '',
        passport: x.passport_number || '',
        earnedLeave: x.earned_leave_balance || 0,
        compOffBalance: Number(emp.comp_off_balance || 0),
      });
    });
    applySheetChrome(ws, ws.columns.length);
  }

  // Raniwala Jewellers' downloads follow the same column order as the
  // Attendance page's daily download: EMP CODE, EMPLOYEE NAME, DESIGNATION,
  // DIVISION, DEPARTMENT, STATUS, MANAGER, CLOCK IN — with DATE/DAY/CLOCK OUT/HOURS
  // WORKED appended since this report spans a date range instead of a single
  // day; other tenants keep the original layout. Only the row for a date an
  // employee was actually marked Late gets highlighted — an employee with,
  // say, 15 days of data in range has just their late day(s) flagged, not
  // every row.
  function addAttendanceLogSheet(wb, selectedKeys) {
    const ws = wb.addWorksheet('Attendance Log');
    ws.columns = columnsFor('attendance_log').filter((c) => selectedKeys.has(c.key));

    dayRowsByEmployee.forEach(({ emp, rows }) => {
      const name = fullName(emp);
      // rec is null on a Raniwala Absent/Leave day that has no attendance row.
      rows.forEach(({ date: dt, rec, status }) => {
        const dayName     = new Date(dt + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' });
        const clockIn     = getFirstIn(rec?.punches);
        const clockOut    = getLastOut(rec?.punches);
        const hoursWorked = rec?.total_hours != null ? fmtDuration(rec.total_hours) : '';
        const row = ws.addRow(raniwala
          ? {
              code: empCode(emp), name: cap(name), designation: cap(emp.designation), division: cap(emp.division), department: cap(emp.department),
              weeklyOff: weeklyOffOf(emp), status, manager: cap(managerById[emp.manager_id]),
              clockIn: clockIn ? fmtTime12(clockIn) : '',
              date: dt, day: dayName,
              clockOut: clockOut ? fmtTime12(clockOut) : '',
              hoursWorked,
            }
          : {
              code: empCode(emp), name: cap(name), department: cap(emp.department), designation: cap(emp.designation),
              date: dt, day: dayName, status,
              clockIn: clockIn ? fmtTime12(clockIn) : '',
              clockOut: clockOut ? fmtTime12(clockOut) : '',
              hoursWorked,
            });
        if (status === 'Late') {
          row.eachCell((cell) => {
            cell.fill = FLAG_FILL;
            cell.font = FLAG_FONT;
          });
        }
      });
    });
    applySheetChrome(ws, ws.columns.length);
  }

  // HR's register layout: title, filters and legend, then a two-row header —
  // the employee columns, each date over its STATUS / IN / OUT sub-columns,
  // and the totals — one row per employee, each date coloured by its status.
  function addAttendanceRegisterSheet(wb, selectedKeys) {
    const ws = wb.addWorksheet('Attendance Register');
    const cols = columnsFor('attendance_register');
    const firstPart = cols.findIndex((c) => c.key === REGISTER_DAY_PARTS[0].key);
    const lead = cols.slice(0, firstPart).filter((c) => selectedKeys.has(c.key));
    const totals = cols.slice(firstPart + REGISTER_DAY_PARTS.length).filter((c) => selectedKeys.has(c.key));
    const parts = REGISTER_DAY_PARTS.filter((p) => selectedKeys.has(p.key));
    const { dates, rows } = register;
    const colCount = lead.length + dates.length * parts.length + totals.length;
    const HEAD = 4;

    const filters = [scopeLabel, divisionFilter, deptFilter].filter(Boolean).join(' · ');
    const outletName = Object.fromEntries((outlets || []).map((o) => [o.id, o.name]));
    const note = (row, value, font) => Object.assign(ws.getCell(row, 1), { value, font });
    note(1, `ATTENDANCE REGISTER — ${shortDate(attFrom)} to ${shortDate(attTo)} (${dates.length} days)`, { bold: true, size: 13 });
    note(2, [tenant?.company_name, filters].filter(Boolean).join(' · '), { bold: true, color: { argb: 'FF595959' } });
    note(3, REGISTER_LEGEND, { italic: true, size: 9, color: { argb: 'FF595959' } });

    const head = (r, c, value) => Object.assign(ws.getCell(r, c), {
      value,
      fill: REGISTER_HEAD_FILL,
      font: { bold: true, color: { argb: 'FFFFFFFF' } },
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
      border: REGISTER_BOX,
    });
    // A single column spanning both header rows.
    const tallHead = (c, col) => {
      head(HEAD, c, col.header);
      head(HEAD + 1, c, col.header);
      ws.mergeCells(HEAD, c, HEAD + 1, c);
      ws.getColumn(c).width = col.width;
    };
    let c = 1;
    lead.forEach((col) => tallHead(c++, col));
    dates.forEach(({ date }) => {
      parts.forEach((p, i) => {
        head(HEAD, c + i, `${shortDate(date)} ${dayName(date)}`);
        head(HEAD + 1, c + i, p.sub);
        ws.getColumn(c + i).width = p.width;
      });
      if (parts.length > 1) ws.mergeCells(HEAD, c, HEAD, c + parts.length - 1);
      c += parts.length;
    });
    totals.forEach((col) => tallHead(c++, col));
    ws.getRow(HEAD).height = 30;

    rows.forEach(({ emp, workingDays, presentDays, counts, cells }, i) => {
      const r = HEAD + 2 + i;
      let col = 1;
      const put = (value, style, align = 'center') => {
        const cell = Object.assign(ws.getCell(r, col++), { value, border: REGISTER_BOX, alignment: { horizontal: align } });
        if (style) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style[0] } };
          cell.font = { color: { argb: style[1] } };
        }
      };
      const leadValues = {
        code: empCode(emp), name: cap(fullName(emp)), division: cap(emp.division),
        department: cap(emp.department), outlet: outletName[emp.outlet_id] || '', doj: dmy(emp.join_date), workingDays,
        weeklyOff: weeklyOffOf(emp),
      };
      lead.forEach((l) => put(leadValues[l.key], null, l.key === 'name' ? 'left' : 'center'));
      cells.forEach((day) => {
        const style = REGISTER_STYLE[day.code];
        parts.forEach((p) => put(
          p.key === 'dayStatus' ? day.code
            : p.key === 'dayIn' ? (day.in ? fmtTime12(day.in) : '')
              : (day.out ? fmtTime12(day.out) : ''),
          style,
        ));
      });
      // Raniwala's TOTAL PRESENT is the days paid for: days present plus
      // weekly offs and holidays (a sandwiched, unpaid weekly off is already 'A').
      const totalPresent = raniwala ? presentDays + (counts.WO || 0) + (counts.HOL || 0) : presentDays;
      totals.forEach((t) => put(
        t.key === 'presentDays' ? totalPresent : t.key === 'workingDays' ? workingDays : (counts[t.key] || 0),
      ));
    });

    ws.views = [{ state: 'frozen', xSplit: Math.min(2, lead.length), ySplit: HEAD + 1 }];
    ws.autoFilter = { from: { row: HEAD + 1, column: 1 }, to: { row: HEAD + 1, column: colCount } };
  }

  function addMonthlyPayrollSheet(wb, selectedKeys) {
    const ws = wb.addWorksheet('Monthly Payroll');
    ws.columns = columnsFor('monthly_payroll').filter((c) => selectedKeys.has(c.key));
    filteredSummary.forEach(({ emp, payMap: pm }) => {
      const name = fullName(emp);
      Object.keys(pm).sort((a, b) => b.localeCompare(a)).forEach(key => {
        const [y, m] = key.split('-').map(Number);
        ws.addRow({
          code: empCode(emp),
          name: cap(name),
          department: cap(emp.department),
          designation: cap(emp.designation),
          ...(raniwala ? { division: cap(emp.division) } : {}),
          month: new Date(y, m - 1).toLocaleDateString('en-IN', { month: 'long' }),
          year: y,
          netPay: pm[key] ?? 0,
        });
      });
    });
    applySheetChrome(ws, ws.columns.length);
  }

  function addLeaveSummarySheet(wb, selectedKeys) {
    const ws = wb.addWorksheet('Leave Summary');
    ws.columns = columnsFor('leave_summary').filter((c) => selectedKeys.has(c.key));
    filteredSummary.forEach(({ emp, leavesRemaining, leaveApproved, leavePending, leaveRejected }) => {
      ws.addRow({
        code: empCode(emp),
        name: cap(fullName(emp)),
        department: cap(emp.department),
        ...(raniwala ? { division: cap(emp.division) } : {}),
        leaveAllocation: emp.leave_allocation || 0,
        approved: leaveApproved,
        pending: leavePending,
        rejected: leaveRejected,
        remaining: leavesRemaining,
      });
    });
    applySheetChrome(ws, ws.columns.length);
  }

  // Late instances (status === 'Late') within the shared attFrom/attTo range —
  // reads the exact same attRangeMap the Attendance Log card already fetches,
  // so "Late Comers" is just a filtered view of the same range, not a second
  // date picker or a second fetch.
  function lateInstancesInRange() {
    const instances = [];
    filteredEmployees.forEach((emp) => {
      const am = attRangeMap[emp.id] || {};
      Object.keys(am).sort().forEach((dt) => {
        const rec = am[dt];
        if (rec.status !== 'Late') return;
        instances.push({ emp, date: dt, rec });
      });
    });
    return instances;
  }

  function addLateComersSheet(wb, selectedKeys) {
    const instances = lateInstancesInRange();

    const ws = wb.addWorksheet('Late Instances');
    ws.columns = columnsFor('late_comers').filter((c) => selectedKeys.has(c.key));
    instances.forEach(({ emp, date, rec }) => {
      const clockIn  = getFirstIn(rec.punches);
      const clockOut = getLastOut(rec.punches);
      const hours    = rec.total_hours != null ? fmtDuration(rec.total_hours) : '';
      ws.addRow(raniwala
        ? {
            code: empCode(emp), name: cap(fullName(emp)), designation: cap(emp.designation),
            division: cap(emp.division), department: cap(emp.department),
            manager: cap(managerById[emp.manager_id]), location: cap(emp.outlet_location),
            date, clockIn: clockIn ? fmtTime12(clockIn) : '', clockOut: clockOut ? fmtTime12(clockOut) : '', hours,
          }
        : {
            name: cap(fullName(emp)), department: cap(emp.department),
            date, clockIn: clockIn ? fmtTime12(clockIn) : '', clockOut: clockOut ? fmtTime12(clockOut) : '', hours,
          });
    });
    applySheetChrome(ws, ws.columns.length);

    // Repeat Offenders summary — a fixed small sheet, not part of the column
    // picker (same as how every other report here is a single configurable
    // sheet plus this one extra always-on summary).
    const counts = {};
    instances.forEach((r) => { counts[r.emp.id] = (counts[r.emp.id] || 0) + 1; });
    const threshold = 3 * monthsInRange(attFrom, attTo);
    const wsSummary = wb.addWorksheet('Repeat Offenders');
    wsSummary.columns = [
      { header: 'Employee Code', key: 'code', width: 12 },
      { header: 'Employee Name', key: 'name', width: 24 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Total Late', key: 'count', width: 12 },
      { header: `Exceeds Threshold (>${threshold})`, key: 'exceeds', width: 24 },
    ];
    Object.entries(counts)
      .map(([empId, count]) => ({ emp: filteredEmployees.find((e) => e.id === empId), count }))
      .filter((r) => r.emp)
      .sort((a, b) => b.count - a.count)
      .forEach(({ emp, count }) => {
        wsSummary.addRow({
          code: empCode(emp), name: cap(fullName(emp)), department: cap(emp.department),
          count, exceeds: count > threshold ? 'Yes' : 'No',
        });
      });
    applySheetChrome(wsSummary, wsSummary.columns.length);
  }

  // Raniwala only (see REPORT_CONFIGS). Laid out like Raniwala's own
  // attendance sheet: EMP CODE, EMPLOYEE NAME, DEPARTMENT, NO. OF DAYS ABSENT,
  // then one column per date. A / L cells carry a note with the leave behind
  // them (approved, or applied and still pending).
  function addAbsenteesSheet(wb, selectedKeys) {
    const ws = wb.addWorksheet('Absentees');
    const lead = columnsFor('absentees').filter((c) => selectedKeys.has(c.key));
    ws.columns = [
      ...lead,
      ...absenteeGrid.dates.map((date) => ({ header: gridDateHeader(date), key: date, width: 10 })),
    ];
    absenteeGrid.rows.forEach(({ emp, absentDays, cells }) => {
      const row = ws.addRow({
        code: empCode(emp), name: cap(fullName(emp)), department: cap(emp.department), absentDays,
        ...Object.fromEntries(absenteeGrid.dates.map((date) => [date, cells[date]?.code || ''])),
      });
      absenteeGrid.dates.forEach((date) => {
        const c = cells[date];
        const cell = row.getCell(date);
        cell.alignment = { horizontal: 'center' };
        if (!c) return;
        if (c.code === 'A') { cell.fill = FLAG_FILL; cell.font = FLAG_FONT; }
        else if (c.code === 'L') cell.fill = LEAVE_FILL;
        else if (c.code === 'WO' || c.code === 'HOL') cell.fill = OFF_FILL;
        if (c.absent && c.leave) {
          const lv = c.leave;
          const what = c.status === 'Leave' ? 'Leave' : 'Leave applied (pending)';
          cell.note = `${what}: ${lv.leave_type ? `${lv.leave_type} ` : ''}${lv.start_date} to ${lv.end_date}`;
        }
      });
      if (selectedKeys.has('absentDays')) row.getCell('absentDays').alignment = { horizontal: 'center' };
    });
    applySheetChrome(ws, ws.columns.length);
    ws.views = [{ state: 'frozen', xSplit: lead.length, ySplit: 1 }];

    // Day-by-day list behind the grid: why each absent day had no punch —
    // Took Leave (approved), Leave Applied (Pending) or plain Absent — with
    // that leave request's own type and dates.
    const wsList = wb.addWorksheet('Absentee Details');
    wsList.columns = [
      { header: 'EMP CODE', key: 'code', width: 10 },
      { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
      { header: 'DESIGNATION', key: 'designation', width: 18 },
      { header: 'DIVISION', key: 'division', width: 16 },
      { header: 'DEPARTMENT', key: 'department', width: 16 },
      { header: 'MANAGER', key: 'manager', width: 20 },
      { header: 'LOCATION', key: 'location', width: 14 },
      { header: 'DATE', key: 'date', width: 12 },
      { header: 'DAY', key: 'day', width: 6 },
      { header: 'STATUS', key: 'status', width: 24 },
      { header: 'LEAVE TYPE', key: 'leaveType', width: 18 },
      { header: 'LEAVE FROM', key: 'leaveFrom', width: 12 },
      { header: 'LEAVE TO', key: 'leaveTo', width: 12 },
    ];
    absenteeRows.forEach(({ emp, date, status, leave }) => {
      wsList.addRow({
        code: empCode(emp), name: cap(fullName(emp)), designation: cap(emp.designation),
        division: cap(emp.division), department: cap(emp.department),
        manager: cap(managerById[emp.manager_id]), location: cap(emp.outlet_location),
        date, day: dayName(date),
        status: status === 'Leave' ? 'Took Leave' : leave ? 'Leave Applied (Pending)' : 'Absent',
        leaveType: leave?.leave_type || '',
        leaveFrom: leave?.start_date || '',
        leaveTo: leave?.end_date || '',
      });
    });
    applySheetChrome(wsList, wsList.columns.length);
  }

  const dayName = (date) => new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' });
  const weeklyOffOf = (emp) => weeklyOffLabel(tenant, (outlets || []).find((o) => o.id === emp.outlet_id), emp);

  function addOvertimeSheet(wb, selectedKeys) {
    const ws = wb.addWorksheet('Overtime Days');
    ws.columns = columnsFor('overtime').filter((c) => selectedKeys.has(c.key));
    overtimeRows.forEach(({ emp, date, rec, extra, ot, dayType }) => {
      const clockIn = getFirstIn(rec.punches);
      const clockOut = getLastOut(rec.punches);
      ws.addRow({
        code: empCode(emp), name: cap(fullName(emp)), designation: cap(emp.designation),
        department: cap(emp.department), location: cap(emp.outlet_location), weeklyOff: weeklyOffOf(emp),
        date, day: dayName(date), dayType,
        clockIn: clockIn ? fmtTime12(clockIn) : '', clockOut: clockOut ? fmtTime12(clockOut) : '',
        hoursWorked: fmtDuration(Number(rec.total_hours) || 0), extra: fmtDuration(extra), ot,
      });
    });
    applySheetChrome(ws, ws.columns.length);

    // How many times each person did overtime in the range, and the total.
    const byEmp = new Map();
    overtimeRows.forEach((r) => {
      const t = byEmp.get(r.emp.id) || { emp: r.emp, days: 0, ot: 0, extra: 0 };
      t.days += 1; t.ot += r.ot; t.extra += r.extra;
      byEmp.set(r.emp.id, t);
    });
    const wsSum = wb.addWorksheet('Overtime Summary');
    wsSum.columns = [
      { header: 'EMP CODE', key: 'code', width: 10 },
      { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
      { header: 'DEPARTMENT', key: 'department', width: 16 },
      { header: 'LOCATION', key: 'location', width: 14 },
      { header: 'TIMES (OT DAYS)', key: 'days', width: 16 },
      { header: 'TOTAL OT HOURS', key: 'ot', width: 16 },
      { header: 'TOTAL EXTRA TIME', key: 'extra', width: 18 },
    ];
    [...byEmp.values()].sort((a, b) => b.ot - a.ot || b.days - a.days).forEach((t) => {
      wsSum.addRow({
        code: empCode(t.emp), name: cap(fullName(t.emp)), department: cap(t.emp.department), location: cap(t.emp.outlet_location),
        days: t.days, ot: t.ot, extra: fmtDuration(t.extra),
      });
    });
    applySheetChrome(wsSum, wsSum.columns.length);
  }

  function addCompOffSheet(wb, selectedKeys) {
    const ws = wb.addWorksheet('Comp Off Earned');
    ws.columns = columnsFor('comp_off').filter((c) => selectedKeys.has(c.key));
    compOffRows.forEach(({ emp, date, rec, credit, offDay, shift, extra, dayType }) => {
      const clockIn = getFirstIn(rec.punches);
      const clockOut = getLastOut(rec.punches);
      ws.addRow({
        code: empCode(emp), name: cap(fullName(emp)), designation: cap(emp.designation),
        department: cap(emp.department), location: cap(emp.outlet_location), weeklyOff: weeklyOffOf(emp),
        date, day: dayName(date), dayType,
        reason: !offDay ? 'Extra hours past the shift'
          : dayType === 'Weekly off' ? 'Weekly off worked'
            : dayType === 'Holiday' ? 'Holiday worked' : 'Weekly off / holiday worked',
        clockIn: clockIn ? fmtTime12(clockIn) : '', clockOut: clockOut ? fmtTime12(clockOut) : '',
        hoursWorked: fmtDuration(Number(rec.total_hours) || 0),
        shift: offDay ? '' : fmtDuration(shift), extra: offDay ? '' : fmtDuration(extra),
        credit,
      });
    });
    applySheetChrome(ws, ws.columns.length);

    // Date-wise: how many employees earned comp off that day, and how much.
    const byDate = new Map();
    compOffRows.forEach((r) => {
      const t = byDate.get(r.date) || { date: r.date, people: 0, days: 0, who: [] };
      t.people += 1; t.days += r.credit; t.who.push(`${cap(fullName(r.emp))} (${r.credit})`);
      byDate.set(r.date, t);
    });
    const wsDate = wb.addWorksheet('Comp Off By Date');
    wsDate.columns = [
      { header: 'DATE', key: 'date', width: 12 },
      { header: 'DAY', key: 'day', width: 6 },
      { header: 'EMPLOYEES', key: 'people', width: 12 },
      { header: 'TOTAL EARNED (DAYS)', key: 'days', width: 20 },
      { header: 'WHO (DAYS EARNED)', key: 'who', width: 80 },
    ];
    [...byDate.values()].forEach((t) => wsDate.addRow({ date: t.date, day: dayName(t.date), people: t.people, days: t.days, who: t.who.join(', ') }));
    applySheetChrome(wsDate, wsDate.columns.length);

    const byEmp = new Map();
    compOffRows.forEach((r) => {
      const t = byEmp.get(r.emp.id) || { emp: r.emp, times: 0, days: 0 };
      t.times += 1; t.days += r.credit;
      byEmp.set(r.emp.id, t);
    });
    const wsEmp = wb.addWorksheet('Comp Off By Employee');
    wsEmp.columns = [
      { header: 'EMP CODE', key: 'code', width: 10 },
      { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
      { header: 'DEPARTMENT', key: 'department', width: 16 },
      { header: 'TIMES EARNED', key: 'times', width: 14 },
      { header: 'EARNED IN RANGE (DAYS)', key: 'days', width: 22 },
      { header: 'BALANCE NOW (DAYS)', key: 'balance', width: 20 },
    ];
    [...byEmp.values()].sort((a, b) => b.days - a.days).forEach((t) => {
      wsEmp.addRow({
        code: empCode(t.emp), name: cap(fullName(t.emp)), department: cap(t.emp.department),
        times: t.times, days: t.days, balance: Number(t.emp.comp_off_balance || 0),
      });
    });
    applySheetChrome(wsEmp, wsEmp.columns.length);

    // Last sheet: everyone's comp off balance today (earned in range or not,
    // HR adjustments included), zero balances left out, with a grand total.
    const wsBal = wb.addWorksheet('Comp Off Balance');
    wsBal.columns = [
      { header: 'EMP CODE', key: 'code', width: 10 },
      { header: 'EMPLOYEE NAME', key: 'name', width: 24 },
      { header: 'DEPARTMENT', key: 'department', width: 16 },
      { header: 'LOCATION', key: 'location', width: 14 },
      { header: 'COMP OFF BALANCE (DAYS)', key: 'balance', width: 24 },
    ];
    compOffBalanceRows.forEach((emp) => {
      wsBal.addRow({
        code: empCode(emp), name: cap(fullName(emp)), department: cap(emp.department),
        location: cap(emp.outlet_location), balance: Number(emp.comp_off_balance),
      });
    });
    applySheetChrome(wsBal, wsBal.columns.length);
    const totalRow = wsBal.addRow({
      name: 'TOTAL', balance: compOffBalanceRows.reduce((s, e) => s + Number(e.comp_off_balance), 0),
    });
    totalRow.font = { bold: true };
  }

  const SHEET_BUILDERS = {
    employee_details: addEmployeeDetailsSheet,
    attendance_log:   addAttendanceLogSheet,
    attendance_register: addAttendanceRegisterSheet,
    monthly_payroll:  addMonthlyPayrollSheet,
    leave_summary:    addLeaveSummarySheet,
    late_comers:      addLateComersSheet,
    absentees:        addAbsenteesSheet,
    overtime:         addOvertimeSheet,
    comp_off:         addCompOffSheet,
    new_joiners:      addNewJoinersSheet,
  };
  // Builders that need fetchEmployeeMasterExtras().
  const needsExtras = (reportId) => reportId === 'employee_details' || reportId === 'new_joiners';

  // Attendance Log/Register, Late Comers, Absentees, Overtime and Comp Off all read the same shared
  // attFrom/attTo range fetch instead of the `year` selector everything else uses.
  const usesDateRange = (reportId) => ['attendance_log', 'attendance_register', 'late_comers', 'absentees', 'overtime', 'comp_off'].includes(reportId);

  function getRowCount(reportId) {
    if (reportId === 'attendance_log') {
      return dayRowsByEmployee.reduce((s, e) => s + e.rows.length, 0);
    }
    if (reportId === 'attendance_register') return register.rows.length;
    if (reportId === 'late_comers') {
      return lateInstancesInRange().length;
    }
    if (reportId === 'absentees') {
      return absenteeGrid.rows.length;
    }
    if (reportId === 'overtime') return overtimeRows.length;
    if (reportId === 'comp_off') return compOffRows.length || compOffBalanceRows.length;
    if (reportId === 'new_joiners') return newJoiners.factory.length + newJoiners.office.length;
    if (!filteredSummary.length) return 0;
    if (reportId === 'employee_details') return filteredSummary.length;
    if (reportId === 'monthly_payroll')  return filteredSummary.reduce((s, r) => s + Object.keys(r.payMap).length, 0);
    if (reportId === 'leave_summary')    return filteredSummary.length;
    return 0;
  }

  async function downloadWorkbook(wb, filename) {
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Filenames carry the active Outlet/Department/Division filters so a batch
  // of per-outlet or per-department downloads doesn't collide or get mixed up.
  const filterSuffix = (reportId) => {
    const parts = [];
    if (scopeLabel && reportId !== 'new_joiners') parts.push(scopeLabel.replace(/ \+ /g, '+'));
    if (deptFilter) parts.push(deptFilter);
    if (divisionFilter) parts.push(divisionFilter);
    return parts.length ? `_${parts.join('_').replace(/\s+/g, '_')}` : '';
  };

  // With `withJoinerBalances`, each new joiner also gets earned_leave_balance:
  // the Earned Leave ledger summed today — the same number as Leave Balances
  // and the app. Read only for the joiners listed, not the whole tenant. Also
  // shift_label: the default shift as the employee form shows it.
  async function loadEmployeeExtras(withJoinerBalances = false) {
    const joinerIds = withJoinerBalances ? [...newJoiners.factory, ...newJoiners.office].map((e) => e.id) : [];
    const [{ data, error }, balRes, shiftRes] = await Promise.all([
      fetchEmployeeMasterExtras(tenant.id),
      joinerIds.length ? fetchTenantLeaveBalances(tenant.id, joinerIds) : { data: [] },
      joinerIds.length ? listShifts(tenant.id) : { data: [] },
    ]);
    if (error) throw error;
    if (balRes.error) throw balRes.error;
    if (shiftRes.error) throw shiftRes.error;
    const shiftById = Object.fromEntries((shiftRes.data || []).map((s) => [s.id, `${s.name} (${s.start_time}-${s.end_time})`]));
    joinerIds.forEach((id) => {
      if (data[id]?.shift_id) data[id].shift_label = shiftById[data[id].shift_id] || '';
    });
    (balRes.data || [])
      .filter((b) => /earned/i.test(b.leave_type?.name || ''))
      .forEach((b) => {
        if (!data[b.profile_id]) return;
        data[b.profile_id].earned_leave_balance = (data[b.profile_id].earned_leave_balance || 0) + Number(b.balance || 0);
      });
    return data;
  }

  const handleDownload = async (reportId) => {
    if (getRowCount(reportId) === 0) return showToast('No data to export', 'warning');
    setExporting(reportId);
    try {
      const { default: ExcelJS } = await import('exceljs');
      const config = REPORT_CONFIGS.find(r => r.id === reportId);
      const wb = new ExcelJS.Workbook();
      SHEET_BUILDERS[reportId](wb, getSelectedKeys(reportId), needsExtras(reportId) ? await loadEmployeeExtras(reportId === 'new_joiners') : undefined);
      const suffix = usesDateRange(reportId) ? `${attFrom}_to_${attTo}`
        : reportId === 'new_joiners' ? (joinFrom === joinTo ? joinFrom : `${joinFrom}_to_${joinTo}`)
          : dateStr(new Date());
      await downloadWorkbook(wb, `${config.filename}${filterSuffix(reportId)}_${suffix}.xlsx`);
      showToast(`${config.label} downloaded`, 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    } finally {
      setExporting(null);
    }
  };

  const handleExportAll = async () => {
    if (!filteredSummary.length) return showToast('No data to export', 'warning');
    setExporting('all');
    try {
      const { default: ExcelJS } = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      const extras = await loadEmployeeExtras(visibleConfigs.some((c) => c.id === 'new_joiners'));
      visibleConfigs.forEach(config => SHEET_BUILDERS[config.id](wb, getSelectedKeys(config.id), needsExtras(config.id) ? extras : undefined));
      await downloadWorkbook(wb, `master_report${filterSuffix()}_${dateStr(new Date())}.xlsx`);
      showToast('Master report exported successfully', 'success');
    } catch (err) {
      showToast('Export failed: ' + err.message, 'error');
    } finally {
      setExporting(null);
    }
  };

  return (
    <>
      <Header
        title="Master Report"
        breadcrumb="Dashboard / Master Report"
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              className="form-select"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              disabled={loading || exporting !== null}
              title="Report year — payroll and leave data is scoped to this year (Attendance Log uses its own date range below)"
            >
              {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button
              className="btn btn-primary"
              onClick={handleExportAll}
              disabled={exporting !== null || loading}
            >
              {exporting === 'all'
                ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Generating…</>
                : <><i className="fas fa-file-excel" /> Export All Sheets</>}
            </button>
          </div>
        }
      />

      <div className="page-content">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div className="spinner" style={{ margin: '0 auto 16px' }} />Loading employee data…
          </div>
        ) : (
          <>
            {/* Outlet -> Division -> Department -> Date, applied to every report below.
                Outlet persists across the whole app (OutletViewContext, localStorage-backed),
                so it's already set once and carried between this page, Late Comers Report, etc. */}
            <div className="filter-bar" style={{ marginBottom: 20, flexWrap: 'wrap' }}>
              {raniwala && pickedOutlets && (
                <OutletChecklist
                  options={outletOptions}
                  picked={pickedOutlets}
                  onChange={setPickedOutlets}
                  label={allOutletsPicked ? 'All Outlets (Combined)' : scopeLabel}
                  disabled={exporting !== null}
                />
              )}
              {!raniwala && outlets.length > 0 && (
                <select
                  className="form-select"
                  value={selectedOutletId || ''}
                  onChange={(e) => selectOutlet(e.target.value || null)}
                  disabled={exporting !== null}
                  title="Location (Outlet)"
                >
                  <option value="">All Outlets (Combined)</option>
                  {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
              {raniwala && divisions.length > 0 && (
                <select
                  className="form-select"
                  value={divisionFilter}
                  onChange={(e) => setDivisionFilter(e.target.value)}
                  disabled={exporting !== null}
                >
                  <option value="">All Divisions</option>
                  {divisions.map((d) => <option key={d}>{d}</option>)}
                </select>
              )}
              <select
                className="form-select"
                value={deptFilter}
                onChange={(e) => setDeptFilter(e.target.value)}
                disabled={exporting !== null}
              >
                <option value="">All Departments</option>
                {departments.map((d) => <option key={d}>{d}</option>)}
              </select>
              <input
                type="date"
                className="form-input"
                style={{ maxWidth: 150 }}
                value={attFrom}
                max={attTo}
                disabled={exporting !== null}
                onChange={(e) => setAttFrom(e.target.value)}
                title="Attendance Log: from date"
              />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>to</span>
              <input
                type="date"
                className="form-input"
                style={{ maxWidth: 150 }}
                value={attTo}
                min={attFrom}
                max={dateStr(new Date())}
                disabled={exporting !== null}
                onChange={(e) => setAttTo(e.target.value)}
                title="Attendance Log: to date"
              />
            </div>

            {/* Stats row */}
            <div className="stats-row" style={{ marginBottom: 20 }}>
              <div className="stat-card">
                <div className="stat-icon" style={{ background: 'var(--primary-light)', color: 'var(--primary)' }}>
                  <i className="fas fa-users" />
                </div>
                <div>
                  <div className="stat-value">{filteredEmployees.length}</div>
                  <div className="stat-label">Active Employees</div>
                </div>
              </div>
              {!hrSupport && (<>
              <div className="stat-card">
                <div className="stat-icon" style={{ background: 'var(--success-light)', color: 'var(--success)' }}>
                  <i className="fas fa-shield-alt" />
                </div>
                <div>
                  <div className="stat-value">{filteredEmployees.filter(e => e.pf_enabled || e.esic_enabled).length}</div>
                  <div className="stat-label">With Compliance</div>
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-icon" style={{ background: 'var(--warning-light)', color: 'var(--warning)' }}>
                  <i className="fas fa-times-circle" />
                </div>
                <div>
                  <div className="stat-value">{filteredEmployees.filter(e => !e.pf_enabled && !e.esic_enabled).length}</div>
                  <div className="stat-label">Non-Compliance</div>
                </div>
              </div>
              </>)}
              <div className="stat-card" style={{ alignItems: 'flex-start' }}>
                <div className="stat-icon" style={{ background: 'var(--danger-light)', color: 'var(--danger)' }}>
                  <i className="fas fa-arrow-right-from-bracket" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="stat-value">
                    {turnover.length ? `${turnover[turnover.length - 1].rate}%` : '—'}
                  </div>
                  <div className="stat-label">Employee Turnover (this month)</div>
                  {turnover.length > 0 && (() => {
                    const max = Math.max(1, ...turnover.map((t) => t.leavers));
                    return (
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 44, marginTop: 8 }}>
                        {turnover.map((t) => (
                          <div key={t.label} title={`${t.label}: ${t.leavers} left, ${t.joiners} joined · ${t.rate}% turnover`}
                            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                            <div style={{
                              width: '100%', maxWidth: 16, borderRadius: 3,
                              height: Math.max(3, Math.round((t.leavers / max) * 30)),
                              background: t.leavers ? 'var(--danger)' : 'var(--border)',
                            }} />
                            <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{t.label}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>
            </div>

            {/* Individual Report Download Cards */}
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-header">
                <h3>Download Reports</h3>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Download each report individually, or use <strong>Export All Sheets</strong> above for a combined workbook
                </span>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: 16,
                padding: '4px 20px 20px',
              }}>
                {visibleConfigs.map(config => {
                  const count      = getRowCount(config.id);
                  const isExporting = exporting === config.id;
                  const busy        = exporting !== null;
                  const isAttendance = usesDateRange(config.id);
                  return (
                    <div
                      key={config.id}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 10,
                        padding: '16px 18px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                        background: 'var(--card-bg)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={{
                          width: 44, height: 44, borderRadius: 10, flexShrink: 0,
                          background: config.iconBg, color: config.iconFg,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 18,
                        }}>
                          <i className={`fas ${config.icon}`} />
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
                            {config.label}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                            {attRangeLoading && isAttendance
                              ? 'Loading…'
                              : count > 0
                                ? <>{count.toLocaleString()} row{count !== 1 ? 's' : ''}</>
                                : <span style={{ color: 'var(--warning)' }}>No data</span>}
                          </div>
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, flexGrow: 1 }}>
                        {(hrSupport && config.hrSupportDesc) || (raniwala && config.raniwalaDesc) || config.desc}
                      </div>
                      {isAttendance && (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input
                            type="date"
                            className="form-input"
                            style={{ fontSize: 12, padding: '4px 6px' }}
                            value={attFrom}
                            max={attTo}
                            disabled={busy}
                            onChange={(e) => setAttFrom(e.target.value)}
                            title="From date"
                          />
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>to</span>
                          <input
                            type="date"
                            className="form-input"
                            style={{ fontSize: 12, padding: '4px 6px' }}
                            value={attTo}
                            min={attFrom}
                            max={dateStr(new Date())}
                            disabled={busy}
                            onChange={(e) => setAttTo(e.target.value)}
                            title="To date"
                          />
                        </div>
                      )}
                      {config.id === 'new_joiners' && (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <input
                            type="month"
                            className="form-input"
                            style={{ fontSize: 12, padding: '4px 6px' }}
                            value={joinFrom}
                            max={joinTo}
                            disabled={busy}
                            onChange={(e) => e.target.value && setJoinFrom(e.target.value)}
                            title="Joined from month"
                          />
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>to</span>
                          <input
                            type="month"
                            className="form-input"
                            style={{ fontSize: 12, padding: '4px 6px' }}
                            value={joinTo}
                            min={joinFrom}
                            max={thisMonth}
                            disabled={busy}
                            onChange={(e) => e.target.value && setJoinTo(e.target.value)}
                            title="Joined to month"
                          />
                        </div>
                      )}
                      <ColumnPicker
                        columns={columnsFor(config.id).map((c) => ({ key: c.key, label: c.header }))}
                        selected={getSelectedKeys(config.id)}
                        onChange={(next) => setSelectedKeys(config.id, next)}
                        disabled={busy}
                      />
                      <button
                        className="btn btn-outline btn-block btn-sm"
                        style={{ marginTop: 2 }}
                        onClick={() => handleDownload(config.id)}
                        disabled={busy || count === 0 || (isAttendance && attRangeLoading)}
                      >
                        {isExporting
                          ? <><div className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} /> Downloading…</>
                          : <><i className="fas fa-download" /> Download .xlsx</>}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

          </>
        )}
      </div>
    </>
  );
}
