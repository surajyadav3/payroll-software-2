// Unit tests for Raniwala's calendar-month paid days (Run Payroll).
// Run: node --test tests/unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarPaidDays } from '../../src/lib/paidDays.js';

// September 2026: 30 days, Sundays on 6/13/20/27, Mondays on 7/14/21/28.
// October 2026: 31 days, Sundays on 4/11/18/25.
const tenant = { weekly_off_days: [0] };
const office = { id: 'office', weekly_off_days: null, holidays_enabled: true };
const emp = (over = {}) => ({ id: 'e1', outlet_id: 'office', join_date: '2024-01-01', ...over });
const pad = (n) => String(n).padStart(2, '0');

/** Attendance for every non-Sunday day of a 2026 month (1-indexed `m`), then `over` on top. */
const worked = (m, over = {}) => {
  const att = {};
  const days = new Date(2026, m, 0).getDate();
  for (let day = 1; day <= days; day++) {
    if (new Date(2026, m - 1, day).getDay() !== 0) att[`2026-${pad(m)}-${pad(day)}`] = { status: 'Present' };
  }
  for (const [date, status] of Object.entries(over)) {
    if (status === null) delete att[date];
    else att[date] = { status };
  }
  return att;
};
const sept = (over = {}) => calendarPaidDays({
  year: 2026, month: 8, emp: emp(), tenant, outlet: office, attByDate: worked(9), today: '2026-10-10', ...over,
});

test('26 worked days in a 30-day month pay 30; in a 31-day month, 31', () => {
  assert.equal(sept().paidDays, 30);
  const oct = calendarPaidDays({
    year: 2026, month: 9, emp: emp(), tenant, outlet: office, attByDate: worked(10), today: '2026-11-05',
  });
  assert.equal(oct.paidDays, 31);
});

test('a working day with no punch, Absent, Mispunch and Pending Approval are unpaid; Half Day loses half', () => {
  const r = sept({ attByDate: worked(9, {
    '2026-09-01': null,
    '2026-09-02': 'Absent',
    '2026-09-03': 'Mispunch',
    '2026-09-04': 'Pending Approval',
    '2026-09-05': 'Half Day',
  }) });
  assert.equal(r.unpaidDays, 4.5);
  assert.equal(r.paidDays, 25.5);
});

test('weekly off is paid whether or not it was worked, and follows the outlet', () => {
  assert.equal(sept({ attByDate: worked(9, { '2026-09-06': 'Half Day' }) }).paidDays, 30);
  // Delhi is off on Monday: the four Mondays are paid, the four Sundays are working days.
  const delhi = { id: 'delhi', weekly_off_days: [1], holidays_enabled: false };
  const r = sept({ emp: emp({ outlet_id: 'delhi' }), outlet: delhi });
  assert.equal(r.unpaidDays, 4);
  assert.equal(r.paidDays, 26);
});

test('an outlet holiday is paid; not for another outlet; holidays off skips only company-wide ones', () => {
  const att = worked(9, { '2026-09-17': null });
  const holidays = [{ date: '2026-09-17', outlet_id: 'office' }];
  const companyWide = [{ date: '2026-09-17', outlet_id: null }];
  const noHolidays = { ...office, holidays_enabled: false };
  assert.equal(sept({ attByDate: att, holidays }).paidDays, 30);
  assert.equal(sept({ attByDate: att, holidays: [{ date: '2026-09-17', outlet_id: 'factory' }] }).paidDays, 29);
  assert.equal(sept({ attByDate: att, holidays: companyWide }).paidDays, 30);
  assert.equal(sept({ attByDate: att, holidays: companyWide, outlet: noHolidays }).paidDays, 29);
  assert.equal(sept({ attByDate: att, holidays, outlet: noHolidays }).paidDays, 30);
});

test('approved paid leave is paid, unpaid leave is not — with or without an attendance row', () => {
  const earned = { start_date: '2026-09-01', end_date: '2026-09-02', leave_type: 'Earned Leave' };
  const unpaid = { start_date: '2026-09-03', end_date: '2026-09-04', leave_type: 'Unpaid Leave' };
  const r = sept({
    attByDate: worked(9, { '2026-09-01': null, '2026-09-02': 'Leave', '2026-09-03': null, '2026-09-04': 'Leave' }),
    leaves: [earned, unpaid],
    unpaidLeaveTypes: ['Unpaid Leave'],
  });
  assert.equal(r.unpaidDays, 2);
  assert.equal(r.paidDays, 28);
  // A 'Leave' row HR set by hand, with no request behind it, is paid.
  assert.equal(sept({ attByDate: worked(9, { '2026-09-08': 'Leave' }) }).paidDays, 30);
});

test('Earned Leave beyond the balance: its last unpaid_days are unpaid', () => {
  // 5 days, 15–19 Sep (Tue–Sat), balance covered 3: 18 and 19 Sep are Loss of Pay.
  const leave = { start_date: '2026-09-15', end_date: '2026-09-19', leave_type: 'Earned Leave', unpaid_days: 2 };
  const leaveRows = Object.fromEntries([15, 16, 17, 18, 19].map((day) => [`2026-09-${day}`, 'Leave']));
  const r = sept({ attByDate: worked(9, leaveRows), leaves: [leave], unpaidLeaveTypes: ['Unpaid Leave'] });
  assert.equal(r.unpaidDays, 2);
  assert.equal(r.paidDays, 28);
  assert.equal(sept({ attByDate: worked(9, leaveRows), leaves: [{ ...leave, unpaid_days: 0 }] }).paidDays, 30);
});

test('half-day leave: paid half + worked half is a full day; what is missing is unpaid', () => {
  const half = (date, half_day, leave_type = 'Earned Leave') => ({ start_date: date, end_date: date, leave_type, half_day });
  const r = sept({
    attByDate: worked(9, {
      '2026-09-01': 'Half Day',   // worked the other half: paid in full
      '2026-09-02': null,         // never came: half unpaid
      '2026-09-03': 'Half Day',   // unpaid half day: half unpaid
      '2026-09-04': 'Leave',      // both halves approved: whole day of leave
      '2026-09-05': 'Absent',     // came but not long enough: half unpaid
    }),
    leaves: [
      half('2026-09-01', 'first_half'), half('2026-09-02', 'second_half'),
      half('2026-09-03', 'first_half', 'Unpaid Leave'),
      half('2026-09-04', 'first_half'), half('2026-09-04', 'second_half'),
      half('2026-09-05', 'second_half'),
    ],
    unpaidLeaveTypes: ['Unpaid Leave'],
  });
  assert.equal(r.unpaidDays, 1.5);
  assert.equal(r.paidDays, 28.5);
});

test('days before joining are unpaid, including weekly offs', () => {
  // Joined Mon 21 Sep: 21–30 Sep is 10 calendar days.
  const r = sept({ emp: emp({ join_date: '2026-09-21' }) });
  assert.equal(r.unpaidDays, 20);
  assert.equal(r.paidDays, 10);
});

test('a running month is paid only up to today', () => {
  const att = {};
  for (let day = 1; day <= 9; day++) {
    if (new Date(2026, 9, day).getDay() !== 0) att[`2026-10-${pad(day)}`] = { status: 'Present' };
  }
  att['2026-10-13'] = { status: 'Leave' }; // future leave is not counted yet
  const oct = (today, over = {}) => calendarPaidDays({
    year: 2026, month: 9, emp: emp(), tenant, outlet: office, attByDate: { ...att, ...over }, today,
  });
  // 1–9 Oct: 8 working days present + Sunday the 4th.
  assert.deepEqual([oct('2026-10-09').paidDays, oct('2026-10-09').daysCounted], [9, 9]);
  // Fri 9th not punched yet: still in progress, neither paid nor counted.
  const att8 = oct('2026-10-09', { '2026-10-09': undefined });
  assert.deepEqual([att8.paidDays, att8.daysCounted, att8.unpaidDays], [8, 8, 0]);
  // Thu 8th Absent: counted and unpaid.
  const absent = oct('2026-10-09', { '2026-10-08': { status: 'Absent' } });
  assert.deepEqual([absent.paidDays, absent.daysCounted], [8, 9]);
  // Sun 11th is a weekly off, so it counts with no punch; Sat 10th unpunched is unpaid.
  const sun = oct('2026-10-11');
  assert.deepEqual([sun.paidDays, sun.daysCounted], [10, 11]);
  // Joined 6 Oct: 1–5 Oct are counted and unpaid.
  const joined = calendarPaidDays({ year: 2026, month: 9, emp: emp({ join_date: '2026-10-06' }), tenant, outlet: office, attByDate: att, today: '2026-10-09' });
  assert.deepEqual([joined.paidDays, joined.daysCounted], [4, 9]);
});

test('late-coming ladder comes off the paid days, except in a month settled from the HR sheet', () => {
  const ladder = { ...tenant, late_deduction_enabled: true };
  const lates = (m) => worked(m, Object.fromEntries([1, 2, 3, 5].map((day) => [`2026-${pad(m)}-${pad(day)}`, 'Late'])));
  const oct = calendarPaidDays({
    year: 2026, month: 9, emp: emp(), tenant: ladder, outlet: office, attByDate: lates(10), today: '2026-11-05',
  });
  assert.equal(oct.lateCount, 4);
  assert.equal(oct.lateDeduction, 0.5);
  assert.equal(oct.paidDays, 30.5);

  const sep = sept({ tenant: ladder, attByDate: lates(9) });
  assert.equal(sep.lateCount, 4);
  assert.equal(sep.lateDeduction, 0);
  assert.equal(sep.paidDays, 30);
});

test('a month paid in two runs counts each part on its own days, adding up to the month', () => {
  const absentIn = worked(9, { '2026-09-10': 'Absent', '2026-09-22': 'Absent', '2026-09-23': 'Half Day' });
  const p1 = sept({ attByDate: absentIn, fromDay: 1, toDay: 16 });
  const p2 = sept({ attByDate: absentIn, fromDay: 17, toDay: 30 });
  assert.deepEqual([p1.daysCounted, p1.paidDays], [16, 15]);
  assert.deepEqual([p2.daysCounted, p2.paidDays], [14, 12.5]);
  assert.equal(p1.paidDays + p2.paidDays, sept({ attByDate: absentIn }).paidDays);
  // Joining inside the second part: nothing in the first, the rest of the second.
  const late = calendarPaidDays({ year: 2026, month: 8, emp: emp({ join_date: '2026-09-20' }), tenant, outlet: office, attByDate: worked(9), today: '2026-10-10', fromDay: 1, toDay: 16 });
  assert.equal(late.paidDays, 0);
});

// ── Sandwich rule (20261020_1) ──────────────────────────────────────────────
// October 2026: Thu 1, holiday Fri 2 (Gandhi Jayanti), Sat 3, Sun 4 … Sun 11,
// Mon 12, Tue 13. November 2026 starts on a Sunday.
const sandwichTenant = { weekly_off_days: [0], sandwich_rule_enabled: true, sandwich_rule_from: '2026-10-01' };
const delhi = { id: 'delhi', weekly_off_days: [1], holidays_enabled: false };
const gandhi = [{ date: '2026-10-02', outlet_id: null }];

/** Present on every day of 2026 month `m` that isn't `offWeekday` or a holiday, then `over` on top (null = no row). */
const workedOn = (m, offWeekday, over = {}, holidayDates = ['2026-10-02']) => {
  const att = {};
  const days = new Date(2026, m, 0).getDate();
  for (let day = 1; day <= days; day++) {
    const date = `2026-${pad(m)}-${pad(day)}`;
    if (new Date(2026, m - 1, day).getDay() !== offWeekday && !holidayDates.includes(date)) att[date] = { status: 'Present' };
  }
  for (const [date, status] of Object.entries(over)) {
    if (status === null) delete att[date];
    else att[date] = typeof status === 'string' ? { status } : status;
  }
  return att;
};
const oct = (over = {}) => calendarPaidDays({
  year: 2026, month: 9, emp: emp(), tenant: sandwichTenant, outlet: office, holidays: gandhi,
  attByDate: workedOn(10, 0), today: '2026-11-10', ...over,
});

test('sandwich: absent on both sides of the weekly off makes it unpaid too', () => {
  // Absent Sat 10 (no row) and Mon 12 ('Absent'): Sun 11 is lost as well.
  const r = oct({ attByDate: workedOn(10, 0, { '2026-10-10': null, '2026-10-12': 'Absent' }) });
  assert.equal(r.paidDays, 28);
  assert.deepEqual(r.sandwichDates, ['2026-10-11']);
  // Absent on one side only: the weekly off stays paid.
  assert.equal(oct({ attByDate: workedOn(10, 0, { '2026-10-10': null }) }).paidDays, 30);
});

test('sandwich: a holiday between two absences is paid — 2 absent, not 3', () => {
  const r = oct({ attByDate: workedOn(10, 0, { '2026-10-01': null, '2026-10-03': null }) });
  assert.equal(r.paidDays, 29);
  assert.deepEqual(r.sandwichDates, []);
});

test('sandwich: the weekly off follows the outlet — Delhi is off Monday', () => {
  // Jaspreet's case: absent Sunday 11 and Tuesday 13, so Monday 12 is unpaid.
  const att = workedOn(10, 1, { '2026-10-11': null, '2026-10-13': null }, []);
  const r = calendarPaidDays({
    year: 2026, month: 9, emp: emp({ outlet_id: 'delhi' }), tenant: sandwichTenant, outlet: delhi,
    holidays: gandhi, attByDate: att, today: '2026-11-10',
  });
  assert.deepEqual(r.sandwichDates, ['2026-10-12']);
  assert.equal(r.paidDays, 28);
});

test('sandwich: weekly offs and holidays in one run — only the weekly off is lost', () => {
  // Holiday on Mon 12 for this outlet: absent Sat 10 + Tue 13 → Sun 11 unpaid, Mon 12 paid.
  const r = oct({
    holidays: [...gandhi, { date: '2026-10-12', outlet_id: 'office' }],
    attByDate: workedOn(10, 0, { '2026-10-10': null, '2026-10-12': null, '2026-10-13': null }),
  });
  assert.deepEqual(r.sandwichDates, ['2026-10-11']);
  assert.equal(r.paidDays, 28);
});

test('sandwich: unpaid leave counts like an absence; paid leave does not', () => {
  const att = workedOn(10, 0, { '2026-10-10': 'Leave', '2026-10-12': null });
  const leaves = (type) => [{ start_date: '2026-10-10', end_date: '2026-10-10', leave_type: type }];
  const unpaid = oct({ attByDate: att, leaves: leaves('Unpaid Leave'), unpaidLeaveTypes: ['Unpaid Leave'] });
  assert.deepEqual(unpaid.sandwichDates, ['2026-10-11']);
  assert.equal(unpaid.paidDays, 28);
  const paid = oct({ attByDate: att, leaves: leaves('Earned Leave'), unpaidLeaveTypes: ['Unpaid Leave'] });
  assert.deepEqual(paid.sandwichDates, []);
  assert.equal(paid.paidDays, 30);
  // A half day on one side is not a whole day of absence.
  assert.equal(oct({ attByDate: workedOn(10, 0, { '2026-10-10': 'Half Day', '2026-10-12': null }) }).sandwichDates.length, 0);
});

test('sandwich: leave on both sides is the DB row — unpaid only when no balance paid it', () => {
  const att = workedOn(10, 0, { '2026-10-10': 'Leave', '2026-10-11': 'Leave', '2026-10-12': 'Leave' });
  const leaves = [
    { start_date: '2026-10-10', end_date: '2026-10-10', leave_type: 'Earned Leave' },
    { start_date: '2026-10-12', end_date: '2026-10-12', leave_type: 'Earned Leave' },
  ];
  assert.equal(oct({ attByDate: att, leaves, sandwichDays: [{ date: '2026-10-11', paid: true }] }).paidDays, 31);
  const lop = oct({ attByDate: att, leaves, sandwichDays: [{ date: '2026-10-11', paid: false }] });
  assert.equal(lop.paidDays, 30);
  assert.deepEqual(lop.sandwichDates, ['2026-10-11']);
});

test('sandwich: not when worked, switched off, before the start date or in a sheet-settled month', () => {
  const absentAround = workedOn(10, 0, { '2026-10-10': null, '2026-10-11': { status: 'Present', total_hours: 6 }, '2026-10-12': null });
  assert.equal(oct({ attByDate: absentAround }).paidDays, 29);
  const both = workedOn(10, 0, { '2026-10-10': null, '2026-10-12': null });
  assert.equal(oct({ attByDate: both, tenant: { ...sandwichTenant, sandwich_rule_enabled: false } }).paidDays, 29);
  assert.equal(oct({ attByDate: both, tenant: { ...sandwichTenant, sandwich_rule_from: '2026-10-15' } }).paidDays, 29);
  // September is closed from HR's sheet.
  const sep = sept({ tenant: { ...sandwichTenant, sandwich_rule_from: null }, attByDate: worked(9, { '2026-09-12': null, '2026-09-14': null }) });
  assert.equal(sep.paidDays, 28);
});

test('sandwich: across the month edge only with the next days loaded, and not before they happen', () => {
  // Sun 1 Nov between absent Sat 31 Oct and absent Mon 2 Nov.
  const att = { ...workedOn(10, 0, { '2026-10-31': null }), ...workedOn(11, 0, { '2026-11-02': null }, []) };
  const nov = (over) => calendarPaidDays({
    year: 2026, month: 10, emp: emp(), tenant: sandwichTenant, outlet: office, attByDate: att, today: '2026-12-05', ...over,
  });
  assert.deepEqual(nov({ edgeDays: 3 }).sandwichDates, ['2026-11-01']);
  assert.deepEqual(nov({}).sandwichDates, []);
  // October run on 2 Nov: Sun 25 between absent Sat 24 and today's Mon 26 —
  // a day not yet over is unknown, so Sunday stays paid for now.
  const running = oct({ attByDate: workedOn(10, 0, { '2026-10-24': null, '2026-10-26': null }), today: '2026-10-26' });
  assert.deepEqual(running.sandwichDates, []);
});
