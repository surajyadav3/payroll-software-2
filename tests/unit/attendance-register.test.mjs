// Unit tests for Master Report's day rows (Raniwala Absent / Leave / Short Fall).
// Run: node --test tests/unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDayRows, buildRegister, buildAbsenteeGrid, raniwalaDayStatus, dayTypeFor, registerOutletScope, MAX_ABSENCE_DAYS } from '../../src/lib/attendanceRegister.js';

const punches = (...times) => times.map((t, i) => ({ punch_time: t, punch_type: i === 0 ? 'in' : 'out' }));
const rec = (status, total_hours, ...times) => ({ status, total_hours, punches: punches(...times) });

// 2026-10-05 is a Monday; 2026-10-04 and 2026-10-11 are Sundays.
const tenant = { weekly_off_days: [0] };
const outlets = [
  { id: 'office', weekly_off_days: null, holidays_enabled: true },
  { id: 'delhi', weekly_off_days: [1], holidays_enabled: true },
  { id: 'factory', weekly_off_days: null, holidays_enabled: false },
];
const emp = (over = {}) => ({ id: 'e1', outlet_id: 'office', join_date: '2026-01-01', ...over });
const build = (over = {}) => buildDayRows({
  raniwala: true, tenant, outlets, employees: [emp()], attByProfile: {},
  fromDate: '2026-10-05', toDate: '2026-10-09', today: '2026-10-10', ...over,
});
const statuses = (entry) => Object.fromEntries(entry.rows.map((r) => [r.date, r.status]));

test('status wording: only Absent-with-both-punches becomes Short Fall', () => {
  assert.equal(raniwalaDayStatus(rec('Absent', 3.2, '10:00', '13:12')), 'Short Fall');
  assert.equal(raniwalaDayStatus(rec('Absent', 0)), 'Absent');
  assert.equal(raniwalaDayStatus(rec('Half Day', 6, '10:00', '16:00')), 'Half Day');
  assert.equal(raniwalaDayStatus(rec('Mispunch', 0, '10:00')), 'Mispunch');
  assert.equal(raniwalaDayStatus(rec('Late', 8.5, '11:00', '19:30')), 'Late');
  assert.equal(raniwalaDayStatus(rec('Present', 9, '10:00', '19:00')), 'Present');
  assert.equal(raniwalaDayStatus(rec('Leave', 0)), 'Leave');
});

test('a working day with no attendance row is Absent; recorded days keep their row', () => {
  const [entry] = build({
    attByProfile: { e1: {
      '2026-10-05': rec('Present', 9, '10:00', '19:00'),
      '2026-10-06': rec('Absent', 2, '10:00', '12:00'),
      '2026-10-07': rec('Mispunch', 0, '10:05'),
    } },
  });
  assert.deepEqual(statuses(entry), {
    '2026-10-05': 'Present', '2026-10-06': 'Short Fall', '2026-10-07': 'Mispunch',
    '2026-10-08': 'Absent', '2026-10-09': 'Absent',
  });
  assert.deepEqual(entry.rows.map((r) => r.date), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
  assert.equal(entry.rows[3].rec, null);
});

test('approved leave without an attendance row is Leave, carrying its request', () => {
  const casual = { profile_id: 'e1', status: 'Approved', start_date: '2026-10-06', end_date: '2026-10-07', leave_type: 'Casual Leave' };
  const [entry] = build({
    leaves: [casual],
    attByProfile: { e1: { '2026-10-07': rec('Leave', 0) } },
  });
  assert.equal(statuses(entry)['2026-10-06'], 'Leave');
  assert.deepEqual(entry.rows.filter((r) => r.status === 'Leave').map((r) => r.leave), [casual, casual]);
  assert.equal(statuses(entry)['2026-10-08'], 'Absent');
  assert.equal(entry.rows.find((r) => r.date === '2026-10-08').leave, null);
});

test('pending leave stays Absent but carries the request; rejected leave is ignored', () => {
  const pending = { profile_id: 'e1', status: 'Pending', start_date: '2026-10-06', end_date: '2026-10-06', leave_type: 'Sick Leave' };
  const rejected = { profile_id: 'e1', status: 'Rejected', start_date: '2026-10-07', end_date: '2026-10-07', leave_type: 'Sick Leave' };
  const [entry] = build({ leaves: [pending, rejected], fromDate: '2026-10-06', toDate: '2026-10-07' });
  assert.deepEqual(statuses(entry), { '2026-10-06': 'Absent', '2026-10-07': 'Absent' });
  assert.deepEqual(entry.rows.map((r) => r.leave), [pending, null]);
});

test('weekly off follows the outlet, falling back to the tenant', () => {
  const range = { fromDate: '2026-10-04', toDate: '2026-10-05' };       // Sun, Mon
  const [office] = build(range);
  assert.deepEqual(statuses(office), { '2026-10-05': 'Absent' });       // Sunday off
  const [delhi] = build({ ...range, employees: [emp({ outlet_id: 'delhi' })] });
  assert.deepEqual(statuses(delhi), { '2026-10-04': 'Absent' });        // Monday off
});

test('holidays are not absences — own outlet or all outlets; holidays off skips only all-outlet ones', () => {
  const holidays = [
    { date: '2026-10-06', name: 'All outlets', outlet_id: null },
    { date: '2026-10-07', name: 'Delhi only', outlet_id: 'delhi' },
  ];
  const range = { fromDate: '2026-10-06', toDate: '2026-10-07', holidays };
  assert.deepEqual(statuses(build(range)[0]), { '2026-10-07': 'Absent' });
  assert.deepEqual(statuses(build({ ...range, employees: [emp({ outlet_id: 'delhi' })] })[0]), {});
  assert.deepEqual(statuses(build({ ...range, employees: [emp({ outlet_id: 'factory' })] })[0]),
    { '2026-10-06': 'Absent', '2026-10-07': 'Absent' });
  const own = [...holidays, { date: '2026-10-07', name: 'Factory only', outlet_id: 'factory' }];
  assert.deepEqual(statuses(build({ ...range, holidays: own, employees: [emp({ outlet_id: 'factory' })] })[0]),
    { '2026-10-06': 'Absent' });
});

test('no absences before joining or after today', () => {
  const [entry] = build({ employees: [emp({ join_date: '2026-10-08' })], toDate: '2026-10-20', today: '2026-10-09' });
  assert.deepEqual(statuses(entry), { '2026-10-08': 'Absent', '2026-10-09': 'Absent' });
});

test('a runaway From date is capped, recorded rows still all listed', () => {
  const [entry] = build({ fromDate: '0026-10-05', attByProfile: { e1: { '2020-01-01': rec('Present', 9, '10:00', '19:00') } } });
  assert.ok(entry.rows.length <= MAX_ABSENCE_DAYS + 1);
  assert.equal(entry.rows[0].date, '2020-01-01');
});

test('other tenants: only recorded rows, status untouched', () => {
  const [entry] = build({ raniwala: false, attByProfile: { e1: { '2026-10-06': rec('Absent', 2, '10:00', '12:00') } } });
  assert.deepEqual(statuses(entry), { '2026-10-06': 'Absent' });
});

test('register: one cell per date with code and first-in / last-out', () => {
  const casual = { profile_id: 'e1', status: 'Approved', start_date: '2026-10-07', end_date: '2026-10-07', leave_type: 'Casual Leave' };
  const args = {
    attByProfile: { e1: {
      '2026-10-05': rec('Late', 8.6, '10:40:00', '13:00:00', '19:20:00'),
      '2026-10-06': rec('Half Day', 5, '10:00:00', '15:00:00'),
    } },
    leaves: [casual],
    holidays: [{ date: '2026-10-08', outlet_id: null }],
    fromDate: '2026-10-04', toDate: '2026-10-11', today: '2026-10-09',
  };
  const entries = build(args);
  const { dates, rows: [row] } = buildRegister({ entries, tenant, outlets, ...args });
  assert.equal(dates.length, 8);
  assert.deepEqual(row.cells.map((c) => c.code), ['WO', 'Late', 'HF', 'L', 'HOL', 'A', '', '']);
  assert.equal(row.cells[1].in, '10:40:00');
  assert.equal(row.cells[1].out, '19:20:00');
  assert.equal(row.cells[3].in, null);
  // Mon–Sat minus the holiday; both Sundays are weekly off.
  assert.equal(row.workingDays, 5);
  assert.deepEqual(row.counts, { WO: 1, Late: 1, HF: 1, L: 1, HOL: 1, A: 1 });
  // Late + Half Day; not leave, absent, weekly off, holiday or blank.
  assert.equal(row.presentDays, 2);
});

test('register: total present counts every day come in, not leave / absent / comp off / offs', () => {
  const args = {
    fromDate: '2026-10-04', toDate: '2026-10-10', today: '2026-10-10',
    attByProfile: { e1: {
      '2026-10-04': rec('Present', 6, '10:00', '16:00'), // Sunday worked
      '2026-10-05': rec('Show Visit', 0),
      '2026-10-06': rec('Absent', 0, '10:00'), // single punch -> MP
      '2026-10-07': rec('Comp Off', 0),
      '2026-10-08': rec('Late', 9, '10:50', '19:50'),
      '2026-10-09': rec('Absent', 3, '10:00', '13:00'), // Short Fall
    } },
  };
  const { rows: [row] } = buildRegister({ entries: build(args), tenant, outlets, ...args });
  assert.deepEqual(row.cells.map((c) => c.code), ['P', 'P', 'MP', 'CO', 'Late', 'SF', 'A']);
  assert.equal(row.presentDays, 5);
});

test('register: days before joining are blank and not working days', () => {
  const args = { fromDate: '2026-10-05', toDate: '2026-10-09', today: '2026-10-10', employees: [emp({ join_date: '2026-10-08' })] };
  const { rows: [row] } = buildRegister({ entries: build(args), tenant, outlets, ...args });
  assert.deepEqual(row.cells.map((c) => c.code), ['', '', '', 'A', 'A']);
  assert.equal(row.workingDays, 2);
});

test('absentee grid: only employees absent at least once, with the count and date codes', () => {
  const sick = { profile_id: 'e1', status: 'Approved', start_date: '2026-10-07', end_date: '2026-10-07', leave_type: 'Sick Leave' };
  const args = {
    employees: [emp(), emp({ id: 'e2' })],
    attByProfile: {
      e1: { '2026-10-05': rec('Present', 9, '10:00', '19:00'), '2026-10-06': rec('Absent', 0, '10:00') },
      e2: { '2026-10-05': rec('Present', 9, '10:00', '19:00'), '2026-10-06': rec('Present', 9, '10:00', '19:00'), '2026-10-07': rec('Present', 9, '10:00', '19:00'), '2026-10-08': rec('Present', 9, '10:00', '19:00') },
    },
    leaves: [sick],
    fromDate: '2026-10-04', toDate: '2026-10-08', today: '2026-10-08',
  };
  const grid = buildAbsenteeGrid({ entries: build(args), tenant, outlets, ...args });
  assert.deepEqual(grid.dates, ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
  assert.equal(grid.rows.length, 1);
  const [row] = grid.rows;
  assert.equal(row.emp.id, 'e1');
  // Leave + plain absent; the single-punch 'Absent' is a mispunch, not counted.
  assert.equal(row.absentDays, 2);
  assert.deepEqual(grid.dates.map((d) => row.cells[d]?.code), ['WO', 'P', 'MP', 'L', 'A']);
  assert.equal(row.cells['2026-10-07'].leave, sick);
});

test('day type: weekly off is the outlet\'s own (Delhi off Monday, Sunday is a working day)', () => {
  const byId = Object.fromEntries(outlets.map((o) => [o.id, o]));
  const type = (outletId, date, holidays = []) => dayTypeFor({
    emp: emp({ outlet_id: outletId }), outlet: byId[outletId], tenant, holidays, date,
  });
  assert.equal(type('delhi', '2026-10-05'), 'Weekly off');
  assert.equal(type('delhi', '2026-10-11'), 'Working day');
  assert.equal(type('office', '2026-10-11'), 'Weekly off');
  assert.equal(type('office', '2026-10-05'), 'Working day');
  const hol = [{ date: '2026-10-07', outlet_id: null }];
  assert.equal(type('office', '2026-10-07', hol), 'Holiday');
  assert.equal(type('factory', '2026-10-07', hol), 'Working day');
  assert.equal(type('office', '2026-10-07', [{ date: '2026-10-07', outlet_id: 'delhi' }]), 'Working day');
});

test('register: sandwich rule — a weekly off between two absent days is A, a holiday stays HOL', () => {
  const sandwichTenant = { weekly_off_days: [0], sandwich_rule_enabled: true, sandwich_rule_from: '2026-10-01' };
  const p = rec('Present', 9, '10:00', '19:00');
  // Sat 10 absent, Sun 11 off, Mon 12 absent; Thu 1 absent, Fri 2 holiday, Sat 3 absent.
  const att = { '2026-10-05': p, '2026-10-06': p, '2026-10-07': p, '2026-10-08': p, '2026-10-09': p, '2026-10-13': p };
  const holidays = [{ date: '2026-10-02', outlet_id: null }];
  const args = { fromDate: '2026-10-01', toDate: '2026-10-13', today: '2026-10-20', holidays };
  const entries = build({ attByProfile: { e1: att }, tenant: sandwichTenant, ...args });
  const reg = (t) => Object.fromEntries(buildRegister({ entries, tenant: t, outlets, ...args }).rows[0].cells.map((c) => [c.date, c.code]));
  const on = reg(sandwichTenant);
  assert.equal(on['2026-10-02'], 'HOL');
  assert.equal(on['2026-10-11'], 'A');
  assert.equal(on['2026-10-04'], 'WO'); // Sat 3 absent but Mon 5 present
  assert.equal(reg(tenant)['2026-10-11'], 'WO');
  const grid = buildAbsenteeGrid({ entries, tenant: sandwichTenant, outlets, ...args });
  assert.equal(grid.rows[0].cells['2026-10-11'].code, 'A');
  assert.equal(grid.rows[0].cells['2026-10-11'].absent, true);
});

test('register outlet scope: Factory alone; Office takes every non-factory outlet', () => {
  const named = [
    { id: 'office', name: 'Office Staff' }, { id: 'factory', name: 'Factory Staff' },
    { id: 'delhi', name: 'Delhi Experience Centre' }, { id: 'gurugram', name: 'Gurugram' }, { id: 'b2b', name: 'B2B SALES' },
  ];
  const staff = ['office', 'factory', 'delhi', 'gurugram', 'b2b', null].map((o, i) => emp({ id: `e${i}`, outlet_id: o }));
  const ids = (scope) => scope.employees.map((e) => e.id);
  const factory = registerOutletScope({ employees: staff, outlets: named, selectedOutletId: 'factory' });
  assert.deepEqual(ids(factory), ['e1']);
  assert.deepEqual(factory.outletNames, ['Factory Staff']);
  const office = registerOutletScope({ employees: staff, outlets: named, selectedOutletId: 'office' });
  assert.deepEqual(ids(office), ['e0', 'e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(office.outletNames, ['Office Staff', 'Delhi Experience Centre', 'Gurugram', 'B2B SALES']);
  // Any other outlet, or Combined: the usual outlet scope.
  assert.equal(registerOutletScope({ employees: staff, outlets: named, selectedOutletId: 'delhi' }), null);
  assert.equal(registerOutletScope({ employees: staff, outlets: named, selectedOutletId: null }), null);
});

test('register Total Present counts Present, Late, Half Day, Short Fall and Mispunch, not Absent / Leave', () => {
  const entries = build({
    leaves: [{ profile_id: 'e1', status: 'Approved', start_date: '2026-10-09', end_date: '2026-10-09' }],
    attByProfile: { e1: {
      '2026-10-05': rec('Late', 8, '11:00', '19:00'),
      '2026-10-06': rec('Absent', 2, '10:00', '12:00'),
      '2026-10-07': rec('Mispunch', 0, '10:05'),
      '2026-10-08': rec('Half Day', 5, '10:00', '15:00'),
    } },
  });
  const [row] = buildRegister({ entries, tenant, outlets, fromDate: '2026-10-05', toDate: '2026-10-09', today: '2026-10-10' }).rows;
  assert.deepEqual(row.cells.map((c) => c.code), ['Late', 'SF', 'MP', 'HF', 'L']);
  assert.equal(row.presentDays, 4);
});

test('weekly off per employee (Gurgaon): own Weekly Holiday, Flexible falls back, register marks WO', () => {
  const gurgaon = { id: 'gurgaon', weekly_off_days: null, weekly_off_per_employee: true, holidays_enabled: false };
  const type = (weekly_holiday, date) => dayTypeFor({
    emp: emp({ outlet_id: 'gurgaon', weekly_holiday }), outlet: gurgaon, tenant, date,
  });
  assert.equal(type('Wednesday', '2026-10-07'), 'Weekly off');
  assert.equal(type('Wednesday', '2026-10-11'), 'Working day');
  assert.equal(type('Flexible', '2026-10-11'), 'Weekly off');
  // The flag is off elsewhere: an office profile saying Monday still uses Sunday.
  assert.equal(dayTypeFor({ emp: emp({ weekly_holiday: 'Monday' }), outlet: outlets[0], tenant, date: '2026-10-05' }), 'Working day');

  const { rows } = buildRegister({
    entries: [{ emp: emp({ outlet_id: 'gurgaon', weekly_holiday: 'Monday' }), rows: [] }],
    tenant, outlets: [gurgaon], fromDate: '2026-10-04', toDate: '2026-10-05', today: '2026-10-22',
  });
  assert.deepEqual(rows[0].cells.map((c) => c.code), ['', 'WO']);
});
