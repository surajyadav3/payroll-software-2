// Day rows behind Master Report's date-range sheets (Attendance Log,
// Absentees). Pure — no Supabase, no React — so the rules are unit
// tested (tests/unit/attendance-register.test.mjs).
import { dateStr, getTenantWeeklyOffDays } from './helpers.js';
import { RANIWALA_SHEET_SETTLED_MONTHS } from './paidDays.js';

// Absent/Leave days are worked out per calendar day, so a mistyped year in
// the From box (e.g. 0026) can't be allowed to loop over centuries.
export const MAX_ABSENCE_DAYS = 366;

// Raniwala's report wording for a day that has an attendance row. Late, Half
// Day and Mispunch are already scored in the DB by their own rules (shift
// late threshold, half/full-day hours, single punch — essl_apply_to_attendance
// and mark_mispunches_for), so those are shown as stored. The one relabel:
// the DB calls a day with both a clock-in and a clock-out but under the
// half-day hours 'Absent'; the report calls it 'Short Fall', which leaves
// 'Absent' meaning "did not come at all".
// A holiday of the employee's own outlet (or a tenant-wide one). An outlet
// with holidays switched off (outlets.holidays_enabled) skips the tenant-wide
// ones but still gets holidays added for that outlet itself.
function isHolidayFor(emp, outlet, holidaysByDate, date) {
  return (holidaysByDate[date] || []).some((h) => (h.outlet_id
    ? h.outlet_id === emp.outlet_id
    : outlet?.holidays_enabled !== false));
}

/**
 * What kind of day `date` is for this employee: 'Weekly off' (their own
 * outlet's weekly off, else the company's — Raniwala's Delhi outlet is off
 * Monday, so a Delhi Sunday is a 'Working day'), 'Holiday', or 'Working day'.
 * Same order as trg_comp_off_credit_from_hours, which credits comp off for
 * an off day worked and only for time past the shift on a working day.
 */
export function dayTypeFor({ emp, outlet, tenant, holidays = [], date }) {
  const weekday = new Date(`${date}T00:00:00`).getDay();
  if (getTenantWeeklyOffDays(tenant, outlet).includes(weekday)) return 'Weekly off';
  if (isHolidayFor(emp, outlet, { [date]: holidays.filter((h) => h.date === date) }, date)) return 'Holiday';
  return 'Working day';
}

export function raniwalaDayStatus(rec) {
  const status = rec.status || '';
  return status === 'Absent' && (rec.punches || []).length >= 2 ? 'Short Fall' : status;
}

/**
 * One entry per employee with their day rows `{ date, rec, status, leave }`
 * in the fromDate/toDate range, oldest first. `leave` is the leave request
 * behind the day, when there is one: the approved request on a 'Leave' day,
 * or a still-pending request on an 'Absent' day (Raniwala only).
 *
 * Other tenants (`raniwala` false): just the attendance rows that exist,
 * status as stored.
 *
 * Raniwala: status reworded by raniwalaDayStatus, plus a row (rec = null) for
 * every day up to `today` with NO attendance row on which the employee was on
 * approved leave ('Leave') or simply didn't come ('Absent'). Days before
 * joining, holidays of the employee's outlet and their weekly off are neither
 * — same precedence as My Team's calendar (holiday, then leave, then weekly off).
 *
 * `leaves` are the tenant's leave requests of any status; only an Approved
 * one makes a day 'Leave'.
 *
 * `attByProfile` is `{ [profileId]: { [date]: attendanceRow } }`.
 */
export function buildDayRows({
  raniwala, tenant, outlets = [], employees, attByProfile,
  fromDate, toDate, today, leaves = [], holidays = [],
}) {
  const days = [];
  const approvedByProfile = {};
  const pendingByProfile = {};
  const holidaysByDate = {};
  const outletById = Object.fromEntries(outlets.map((o) => [o.id, o]));
  if (raniwala && fromDate && toDate) {
    const end = toDate < today ? toDate : today;
    const d = new Date(`${end}T00:00:00`);
    for (let i = 0; i < MAX_ABSENCE_DAYS && dateStr(d) >= fromDate; i++, d.setDate(d.getDate() - 1)) {
      days.push({ date: dateStr(d), weekday: d.getDay() });
    }
    leaves.forEach((lr) => {
      const status = (lr.status || '').toLowerCase();
      const byProfile = status === 'approved' ? approvedByProfile : status === 'pending' ? pendingByProfile : null;
      if (!byProfile || !lr.start_date || !lr.end_date) return;
      (byProfile[lr.profile_id] = byProfile[lr.profile_id] || []).push(lr);
    });
    holidays.forEach((h) => {
      (holidaysByDate[h.date] = holidaysByDate[h.date] || []).push(h);
    });
  }

  return employees.map((emp) => {
    const am = attByProfile[emp.id] || {};
    if (!raniwala) {
      return { emp, rows: Object.keys(am).sort().map((date) => ({ date, rec: am[date], status: am[date].status || '', leave: null })) };
    }
    const covering = (list, date) => (list || []).find((lr) => date >= lr.start_date && date <= lr.end_date) || null;
    const approvedOn = (date) => covering(approvedByProfile[emp.id], date);
    const pendingOn = (date) => covering(pendingByProfile[emp.id], date);
    const rows = Object.keys(am).map((date) => {
      const status = raniwalaDayStatus(am[date]);
      const leave = status === 'Leave' ? approvedOn(date) : status === 'Absent' ? pendingOn(date) : null;
      return { date, rec: am[date], status, leave };
    });
    const outlet = outletById[emp.outlet_id];
    const offDays = getTenantWeeklyOffDays(tenant, outlet);
    days.forEach(({ date, weekday }) => {
      if (am[date]) return;
      if (emp.join_date && date < emp.join_date) return;
      if (isHolidayFor(emp, outlet, holidaysByDate, date)) return;
      const leave = approvedOn(date);
      if (leave) {
        rows.push({ date, rec: null, status: 'Leave', leave });
      } else if (!offDays.includes(weekday)) {
        rows.push({ date, rec: null, status: 'Absent', leave: pendingOn(date) });
      }
    });
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return { emp, rows };
  });
}

// Attendance Register cell code per stored/derived day status — the short
// codes HR's own register sheet uses (P, Late, HF, L, WO …).
export const REGISTER_CODES = {
  Present: 'P', Travel: 'P', 'Show Visit': 'P',
  Late: 'Late', 'Half Day': 'HF', 'Short Fall': 'SF', Mispunch: 'MP',
  Leave: 'L', Absent: 'A', 'Comp Off': 'CO',
};

// Register codes that are not a day present (buildRegister's presentDays).
const NOT_PRESENT_CODES = new Set(['L', 'A', 'CO', 'WO', 'HOL']);

const firstPunch = (punches, type, pickLast) => {
  const times = (punches || []).filter((p) => p.punch_type === type).map((p) => p.punch_time).sort();
  return (pickLast ? times[times.length - 1] : times[0]) || null;
};

/**
 * Master Report's Attendance Register: one row per employee, one cell per
 * date in fromDate..toDate, built on buildDayRows' `entries` so the day
 * statuses match the Attendance Log exactly.
 *
 * Each cell is `{ date, code, in, out }`: `code` is the REGISTER_CODES code
 * for a day with a row (an 'Absent' with a punch is 'MP', as in the
 * Absentees grid), else 'HOL' (holiday of the employee's outlet), 'WO'
 * (their weekly off) or '' (before joining, after `today`, or — for tenants
 * other than Raniwala, whose missing days aren't inferred — no record).
 * `in`/`out` are the first clock-in and last clock-out punch_time, or null.
 *
 * `workingDays` = days in the range from the joining date on that are
 * neither a holiday nor a weekly off. `counts` tallies the cell codes.
 * `presentDays` = days the employee came in: every code except Leave,
 * Absent, Comp Off, Weekly Off, Holiday and blank — so P (incl. Travel /
 * Show Visit), Late, Half Day, Short Fall and Mispunch each count as one,
 * as does a weekly off or holiday worked (stored as P).
 */
export function buildRegister({ entries, tenant, outlets = [], fromDate, toDate, today, holidays = [] }) {
  const dates = [];
  if (fromDate && toDate) {
    const d = new Date(`${fromDate}T00:00:00`);
    for (let i = 0; i < MAX_ABSENCE_DAYS && dateStr(d) <= toDate; i++, d.setDate(d.getDate() + 1)) {
      dates.push({ date: dateStr(d), weekday: d.getDay() });
    }
  }
  const outletById = Object.fromEntries(outlets.map((o) => [o.id, o]));
  const holidaysByDate = {};
  holidays.forEach((h) => { (holidaysByDate[h.date] = holidaysByDate[h.date] || []).push(h); });

  const rows = entries.map(({ emp, rows: dayRows }) => {
    const byDate = Object.fromEntries(dayRows.map((r) => [r.date, r]));
    const outlet = outletById[emp.outlet_id];
    const offDays = getTenantWeeklyOffDays(tenant, outlet);
    const counts = {};
    let workingDays = 0;
    const cells = dates.map(({ date, weekday }) => {
      const joined = !emp.join_date || date >= emp.join_date;
      const holiday = isHolidayFor(emp, outlet, holidaysByDate, date);
      const weeklyOff = offDays.includes(weekday);
      if (joined && !holiday && !weeklyOff) workingDays++;
      const row = byDate[date];
      let code = '';
      if (row) code = row.status === 'Absent' && (row.rec?.punches || []).length ? 'MP' : (REGISTER_CODES[row.status] || row.status || '');
      else if (joined && date <= today) code = holiday ? 'HOL' : weeklyOff ? 'WO' : '';
      return {
        date, code,
        in: firstPunch(row?.rec?.punches, 'in', false),
        out: firstPunch(row?.rec?.punches, 'out', true),
      };
    });
    markSandwichAbsences(cells, tenant, today);
    cells.forEach(({ code }) => { if (code) counts[code] = (counts[code] || 0) + 1; });
    const presentDays = cells.filter(({ code }) => code && !NOT_PRESENT_CODES.has(code)).length;
    return { emp, workingDays, presentDays, counts, cells };
  });
  return { dates, rows };
}

// Sandwich rule (20261020_1), as Run Payroll counts it (lib/paidDays): a
// weekly off with nothing recorded whose nearest working day on both sides,
// stepping over other weekly offs and holidays, is 'A' is unpaid, so it is
// shown as 'A' too (`sandwich: true`). A holiday stays 'HOL'. A neighbour
// outside the range, or today (not over yet), leaves the weekly off as 'WO'.
// Leave on both sides needs nothing here: the DB writes that weekly off as a
// 'Leave' row. Not in a month closed from HR's sheet.
function markSandwichAbsences(cells, tenant, today) {
  if (!tenant?.sandwich_rule_enabled) return;
  const from = tenant.sandwich_rule_from || '';
  const off = (c) => c.code === 'WO' || c.code === 'HOL';
  const neighbour = (i, step) => {
    let j = i + step;
    while (j >= 0 && j < cells.length && off(cells[j])) j += step;
    return j >= 0 && j < cells.length ? cells[j] : null;
  };
  // Decide every weekly off from the codes as they were, then mark.
  const sandwiched = cells.map((c, i) => {
    if (c.code !== 'WO' || c.date < from || RANIWALA_SHEET_SETTLED_MONTHS.includes(c.date.slice(0, 7))) return false;
    const before = neighbour(i, -1);
    const after = neighbour(i, 1);
    return before?.code === 'A' && after?.code === 'A' && after.date < today;
  });
  sandwiched.forEach((yes, i) => {
    if (yes) Object.assign(cells[i], { code: 'A', sandwich: true });
  });
}

// A day the Absentees report counts: no clock in and no clock out — plain
// absent or on leave. A day with any punch (Short Fall, Mispunch, or someone
// who punched while on leave) is not an absence.
export function isAbsenteeDay(row) {
  return (row.status === 'Absent' || row.status === 'Leave') && !(row.rec?.punches || []).length;
}

/**
 * The Absentees grid: buildRegister's date columns, kept to the employees
 * with at least one absentee day (isAbsenteeDay), with that count.
 *
 * Returns `{ dates, rows }`. `dates` is the ascending list of 'YYYY-MM-DD'.
 * Each row is `{ emp, absentDays, cells }` where `cells[date]` is
 * `{ code, absent, status, leave }` or null (no code: before joining or after
 * `today`). `code` is the register code — A / L on an absentee day, P, Late,
 * HF, SF, MP, CO on a day with punches, HOL / WO on a holiday / weekly off.
 * The DB's 'Absent' with a single punch shows as MP: it is not an absence.
 *
 * Takes buildRegister's arguments (`entries` = buildDayRows' output).
 */
export function buildAbsenteeGrid(args) {
  const { dates, rows } = buildRegister(args);
  const dayRowsById = Object.fromEntries(args.entries.map(({ emp, rows: dayRows }) => [
    emp.id, Object.fromEntries(dayRows.map((r) => [r.date, r])),
  ]));
  const gridRows = rows.map(({ emp, cells: regCells }) => {
    const byDate = dayRowsById[emp.id] || {};
    const cells = {};
    let absentDays = 0;
    regCells.forEach(({ date, code, sandwich }) => {
      const r = byDate[date];
      const absent = (!!r && isAbsenteeDay(r)) || !!sandwich;
      if (absent) absentDays += 1;
      cells[date] = code
        ? { code: !absent && code === 'A' ? 'MP' : code, absent, status: r?.status || '', leave: r?.leave || null }
        : null;
    });
    return { emp, absentDays, cells };
  }).filter((r) => r.absentDays > 0);
  return { dates: dates.map((x) => x.date), rows: gridRows };
}
