// Paid days behind Raniwala's Run Payroll. Pure — no Supabase, no React — so
// the rules are unit tested (tests/unit/paid-days.test.mjs).
import { dateStr, getTenantWeeklyOffDays, isFullPaidDayStatus, computeLateDeductionDays } from './helpers.js';

// Months HR closed from their own signed-off sheet (the attendance was aligned
// to it day by day), as 'YYYY-MM'. The sheet's days are final, so the
// late-coming ladder is not taken off again for these.
//   2026-09: "Sep Attendance & Remaining Leave balance.xlsx" (migration 20261010_6)
export const RANIWALA_SHEET_SETTLED_MONTHS = ['2026-09'];

/**
 * Raniwala pays the calendar month (30/31 days), not the days worked: someone
 * who works all 26 working days of a 30-day month is paid 30. So
 *
 *   paid days = days in the month − unpaid days
 *
 * Paid without a punch: the employee's weekly off, a holiday of their outlet
 * (same precedence as My Team's calendar — an outlet with holidays switched
 * off only gets its weekly off) and approved leave of a paid type.
 * Unpaid: days before joining, a working day with no attendance row, Absent,
 * Mispunch, Pending Approval and approved leave of an unpaid type; Half Day
 * loses half.
 *
 * A month still running is paid only up to `today`: on 11 Oct, someone
 * present every working day so far has 11 paid days, not 31. Today itself
 * counts only when it has an attendance row or is already paid (weekly off,
 * holiday, paid leave). A working day not yet punched is still in progress.
 *
 * `month` is 0-indexed. `attByDate` is `{ [date]: attendanceRow }` for this
 * employee, `leaves` their Approved leave requests, `unpaidLeaveTypes` the
 * leave type names with is_paid = false. A request's `unpaid_days` are its
 * last days, the ones its Earned Leave balance did not cover (20261011_2):
 * those are unpaid too. A half-day leave (`half_day` set, 20261013_2) is half
 * a day of leave: the day is paid in full when the other half was worked
 * (Half Day or better) and the leave is of a paid type, else what is missing
 * is unpaid. Both halves of a date approved = a whole day of leave.
 *
 * `fromDay` / `toDay` limit the count to part of the month (a month HR pays
 * in two runs, see raniwalaSplitFor): days outside them are not counted.
 *
 * Sandwich rule (tenant.sandwich_rule_enabled, from tenant.sandwich_rule_from,
 * 20261020_1) — a weekly off is unpaid when the nearest working day on BOTH
 * sides (stepping over other weekly offs and holidays) was a whole day of
 * absence: no attendance row / 'Absent' with no hours, or approved leave of
 * an unpaid type. A holiday is always paid, so Absent – holiday – Absent is
 * two days off pay, but Absent – weekly off – Absent is three. A weekly off
 * between two leave days is the DB's job: it charges a leave balance and
 * writes a leave_sandwich_days row; `sandwichDays` are this employee's rows,
 * and one with paid = false is unpaid. Not for months closed from HR's sheet.
 * The neighbours can fall outside the month: `edgeDays` says how many days
 * either side of it `attByDate` / `holidays` / `leaves` were loaded for; a
 * neighbour beyond that, today or later is unknown, so the weekly off stays
 * paid.
 *
 * Returns `{ paidDays, daysCounted, unpaidDays, lateCount, lateDeduction,
 * sandwichDates }`. daysCounted is how many days of the month were counted
 * (the whole month once it is over). paidDays is daysCounted minus unpaid
 * days, with the tenant's late-coming ladder already taken off.
 * sandwichDates are the weekly offs the sandwich rule made unpaid.
 */
/** 'YYYY-MM-DD' plus n days. */
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return dateStr(new Date(y, m - 1, d + n));
}

export function calendarPaidDays({
  year, month, emp, tenant, outlet = null, attByDate = {},
  holidays = [], leaves = [], unpaidLeaveTypes = [], today, fromDay = 1, toDay = null,
  sandwichDays = [], edgeDays = 0,
}) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const offDays = getTenantWeeklyOffDays(tenant, outlet);
  // An outlet with holidays switched off skips the tenant-wide ones only.
  const holidayDates = new Set(
    holidays
      .filter((h) => (h.outlet_id ? h.outlet_id === emp.outlet_id : outlet?.holidays_enabled !== false))
      .map((h) => h.date)
  );
  const leavesOn = (date) => leaves.filter((lr) => date >= lr.start_date && date <= lr.end_date);
  const isPaidLeave = (leave, date) => !!leave && !unpaidLeaveTypes.includes(leave.leave_type)
    && !(leave.unpaid_days > 0 && date >= addDays(leave.end_date, 1 - leave.unpaid_days));

  const monthKey = `${year}-${String(month + 1).padStart(2, '0')}`;
  const settled = RANIWALA_SHEET_SETTLED_MONTHS.includes(monthKey);
  const sandwichOn = !!tenant?.sandwich_rule_enabled && !settled;
  const sandwichFrom = tenant?.sandwich_rule_from || '';
  const unpaidSandwich = new Set(sandwichDays.filter((s) => s.paid === false).map((s) => s.date));
  const knownFrom = addDays(`${monthKey}-01`, -edgeDays);
  const knownTo = addDays(`${monthKey}-${String(daysInMonth).padStart(2, '0')}`, edgeDays);
  const isOff = (date) => holidayDates.has(date) || offDays.includes(new Date(`${date}T00:00:00`).getDay());
  // A whole day of pay lost on a working day: absent, or unpaid leave.
  const unpaidAbsence = (date) => {
    if (date < knownFrom || date > knownTo || (today && date >= today)) return false;
    if (emp.join_date && date < emp.join_date) return false;
    const dayLeaves = leavesOn(date);
    const leave = dayLeaves.find((lr) => !lr.half_day);
    if (leave) return !isPaidLeave(leave, date);
    if (dayLeaves.length) return false;
    const rec = attByDate[date];
    return !rec || (rec.status === 'Absent' && !(Number(rec.total_hours) > 0));
  };
  // The nearest working day before (step -1) / after (step 1) an off day.
  const nearestWorkingDay = (date, step) => {
    let d = addDays(date, step);
    for (let i = 0; i < 7 && isOff(d); i++) d = addDays(d, step);
    return isOff(d) ? null : d;
  };
  const sandwichUnpaid = (date, rec) => {
    if (!sandwichOn || date < sandwichFrom || holidayDates.has(date)) return false;
    if (unpaidSandwich.has(date)) return true;
    // Came in on the weekly off: worked, not part of an absence.
    if (rec && (rec.status !== 'Absent' || Number(rec.total_hours) > 0)) return false;
    const before = nearestWorkingDay(date, -1);
    const after = nearestWorkingDay(date, 1);
    return !!before && !!after && unpaidAbsence(before) && unpaidAbsence(after);
  };

  let unpaidDays = 0;
  let daysCounted = 0;
  let lateCount = 0;
  const sandwichDates = [];
  const lastDay = Math.min(daysInMonth, toDay || daysInMonth);
  for (let day = fromDay; day <= lastDay; day++) {
    const d = new Date(year, month, day);
    const date = dateStr(d);
    if (today && date > today) break;
    const rec = attByDate[date];
    const offDay = offDays.includes(d.getDay()) || holidayDates.has(date);
    const dayLeaves = leavesOn(date);
    const leave = dayLeaves.find((lr) => !lr.half_day) || null;
    const halves = leave ? [] : dayLeaves.filter((lr) => lr.half_day);
    const halfPaid = Math.min(1, halves.reduce((n, lr) => n + (isPaidLeave(lr, date) ? 0.5 : 0), 0));
    if (date === today && !rec && !offDay && !isPaidLeave(leave, date) && halfPaid < 1) break;
    daysCounted += 1;
    // A weekly off / holiday has no shift, so it is never a late day.
    if (rec?.status === 'Late' && !offDay) lateCount += 1;

    if (emp.join_date && date < emp.join_date) { unpaidDays += 1; continue; }
    if (offDay) {
      if (sandwichUnpaid(date, rec)) { unpaidDays += 1; sandwichDates.push(date); }
      continue;
    }

    if (halves.length) {
      // Half-day leave: the worked half comes from the attendance row.
      const worked = !rec || rec.status === 'Leave' ? 0
        : rec.status === 'Half Day' ? 0.5
        : isFullPaidDayStatus(rec.status) ? 1 : 0;
      unpaidDays += 1 - Math.min(1, worked + halfPaid);
      continue;
    }

    if (!rec) {
      if (!isPaidLeave(leave, date)) unpaidDays += 1;
    } else if (rec.status === 'Leave') {
      // A 'Leave' row with no request behind it (HR marked it by hand) is paid.
      if (leave && !isPaidLeave(leave, date)) unpaidDays += 1;
    } else if (rec.status === 'Half Day') {
      unpaidDays += 0.5;
    } else if (!isFullPaidDayStatus(rec.status)) {
      unpaidDays += 1;
    }
  }

  const lateDeduction = settled ? 0 : computeLateDeductionDays(lateCount, tenant);
  return {
    paidDays: Math.max(0, daysCounted - unpaidDays - lateDeduction),
    daysCounted,
    unpaidDays,
    lateCount,
    lateDeduction,
    sandwichDates,
  };
}
