// Unit tests for Raniwala's salary structure (Salary Structure, Run Payroll, payslip).
// Run: node --test tests/unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  raniwalaStructure, raniwalaPf, raniwalaEsic, retentionFor, probationEndDate,
  advanceEligibility, calcRaniwalaPay, raniwalaSlipDetails, raniwalaBreakup,
  RANIWALA_PF_RULES, raniwalaSplitFor, raniwalaPartPay, partSlipDetails, partFromLine, raniwalaPfDifference,
} from '../../src/lib/raniwalaPayroll.js';

// October 2026 has 31 days.
const oct = (over = {}) => calcRaniwalaPay({ gross: 20000, paidDays: 31, monthDays: 31, year: 2026, month: 9, ...over });
const line = (list, name) => list.find((l) => l.name === name)?.amount ?? 0;

test('gross below 50,000 splits 75% Basic / 25% HRA', () => {
  const s = raniwalaStructure(40000);
  assert.deepEqual([s.basicPercent, s.hraPercent, s.basic, s.hra], [75, 25, 30000, 10000]);
  assert.deepEqual([raniwalaStructure(49999).basicPercent, raniwalaStructure(49999).basic], [75, 37499]);
});

test('gross of 50,000 or more splits 50% Basic / 50% HRA', () => {
  assert.deepEqual([raniwalaStructure(50000).basic, raniwalaStructure(50000).hra], [25000, 25000]);
  assert.deepEqual([raniwalaStructure(110000).basic, raniwalaStructure(110000).hra], [55000, 55000]);
});

test('PF is 12% / 13% of Basic below 25,000', () => {
  assert.deepEqual(raniwalaPf(15000), { capped: false, employee: 1800, employer: 1950 });
  assert.deepEqual(raniwalaPf(24999), { capped: false, employee: 3000, employer: 3250 });
});

test('PF is capped at 3,000 / 3,250 from a Basic of 25,000', () => {
  assert.deepEqual(raniwalaPf(25000), { capped: true, employee: 3000, employer: 3250 });
  assert.deepEqual(raniwalaPf(55000), { capped: true, employee: 3000, employer: 3250 });
});

test('ESIC applies only when Basic is below 21,000', () => {
  assert.deepEqual(raniwalaEsic(15000, 15000), { applicable: true, employee: 113, employer: 488 });
  assert.deepEqual(raniwalaEsic(20999, 20999), { applicable: true, employee: 157, employer: 682 });
  assert.deepEqual(raniwalaEsic(21000, 21000), { applicable: false, employee: 0, employer: 0 });
  assert.deepEqual(raniwalaEsic(30000, 30000), { applicable: false, employee: 0, employer: 0 });
});

test('ESIC cover follows the full-month Basic, the amount follows the Basic earned', () => {
  // Basic 30,000 is outside ESIC even in a month where only half of it is earned.
  assert.equal(raniwalaEsic(30000, 15000).applicable, false);
  assert.deepEqual(raniwalaEsic(18000, 9000), { applicable: true, employee: 68, employer: 293 });
});

// HR's "New Structure" salary breakup sheet, gross 20,822 — figure for figure.
test('the salary breakup matches the HR sheet, with employer contribution and CTC', () => {
  const b = raniwalaBreakup(20822, 0);
  assert.deepEqual([b.basicPercent, b.hraPercent, b.esicApplicable, b.pfCapped], [75, 25, true, false]);
  assert.deepEqual(b.month, {
    gross: 20822, basic: 15617, hra: 5205,
    pfEmployee: 1874, esicEmployee: 117, retention: 0,
    payableInProbation: 18831, payableAfterProbation: 18831,
    pfEmployer: 2030, esicEmployer: 508, ctc: 23360,
  });
  assert.deepEqual(b.annum, {
    gross: 249864, basic: 187398, hra: 62466,
    pfEmployee: 22488, esicEmployee: 1405, retention: 0,
    payableInProbation: 225971, payableAfterProbation: 225971,
    pfEmployer: 24362, esicEmployer: 6090, ctc: 280316,
  });
});

test('the breakup shows retention only in the probation payable', () => {
  const b = raniwalaBreakup(20822, 5);
  assert.deepEqual([b.month.retention, b.month.payableInProbation, b.month.payableAfterProbation], [1041, 17790, 18831]);
  assert.equal(b.annum.retention, 0);
});

test('the breakup caps PF per annum and drops ESIC above the limit', () => {
  const b = raniwalaBreakup(60000);
  assert.deepEqual([b.month.pfEmployee, b.month.pfEmployer, b.month.esicEmployer, b.month.ctc], [3000, 3250, 0, 63250]);
  assert.deepEqual([b.annum.pfEmployee, b.annum.pfEmployer, b.annum.ctc], [36000, 39000, 759000]);
  assert.deepEqual([b.pfCapped, b.esicApplicable], [true, false]);
});

test('a full month: gross 20,000 gives Basic 15,000, HRA 5,000, PF 1,800, ESIC 113', () => {
  const p = oct();
  assert.deepEqual([p.basic, p.hra, p.totalEarnings], [15000, 5000, 20000]);
  assert.deepEqual([p.pf.employee, p.pf.employer, p.esic.employee, p.esic.employer], [1800, 1950, 113, 488]);
  assert.equal(p.netPay, 20000 - 1800 - 113);
});

test('a full month: gross 60,000 gives Basic 30,000, capped PF and no ESIC', () => {
  const p = oct({ gross: 60000 });
  assert.deepEqual([p.basic, p.hra, p.pf.employee, p.pf.employer, p.esic.employee], [30000, 30000, 3000, 3250, 0]);
  assert.equal(p.netPay, 57000);
});

test('paid days pro-rate the gross, and Basic + HRA still add up to it', () => {
  const p = oct({ gross: 20000, paidDays: 27.5 });
  assert.equal(p.earnedGross, Math.round((20000 * 27.5) / 31));
  assert.equal(p.basic + p.hra, p.earnedGross);
  assert.equal(p.pf.employee, Math.round(p.basic * 0.12));
  assert.equal(oct({ paidDays: 0 }).netPay, 0);
});

test('PF can be switched off for an employee; ESIC cannot — it follows the Basic', () => {
  const p = oct({ settings: { pf_applicable: false, esic_applicable: false } });
  assert.deepEqual([p.pf.employee, p.pf.employer, p.esic.employee, p.netPay], [0, 0, 113, 20000 - 113]);
});

test('retention is taken only while probation runs past the month', () => {
  const during = retentionFor({ percent: 10, probationEnd: '2027-03-01', year: 2026, month: 9 });
  assert.deepEqual([during.percent, during.state], [10, 'active']);
  // Probation completing inside the month closes retention for that month.
  const ending = retentionFor({ percent: 10, probationEnd: '2026-10-31', year: 2026, month: 9 });
  assert.deepEqual([ending.percent, ending.state], [0, 'closed']);
  assert.equal(retentionFor({ percent: 5, probationEnd: '2026-11-01', year: 2026, month: 9 }).percent, 5);
  assert.equal(retentionFor({ percent: 5, probationEnd: null, year: 2026, month: 9 }).state, 'no-date');
  assert.equal(retentionFor({ percent: 0, probationEnd: '2027-03-01', year: 2026, month: 9 }).state, 'none');
  assert.equal(retentionFor({ percent: 7, probationEnd: '2027-03-01', year: 2026, month: 9 }).percent, 0);
});

test('retention is a share of the gross earned and stops by itself after probation', () => {
  const settings = { retention_percent: 5 };
  assert.equal(line(oct({ settings, probationEnd: '2027-03-01' }).deductions, 'Retention (5%)'), 1000);
  const after = oct({ settings, probationEnd: '2026-09-30' });
  assert.equal(after.retention.amount, 0);
  assert.equal(after.deductions.some((d) => d.name.startsWith('Retention')), false);
});

test('probation completes on the date HR set, else joining date + probation months', () => {
  assert.equal(probationEndDate({ join_date: '2026-09-01', probation_months: 6 }, null), '2027-03-01');
  assert.equal(probationEndDate({ join_date: '2026-09-01', probation_months: 6 }, { probation_end_date: '2026-12-15' }), '2026-12-15');
  assert.equal(probationEndDate({ join_date: '2026-09-01', probation_months: 0 }, null), null);
});

test('an advance needs one completed year of service', () => {
  assert.deepEqual(advanceEligibility('2025-10-10', '2026-10-10'), { eligible: true, eligibleOn: '2026-10-10' });
  assert.deepEqual(advanceEligibility('2025-10-11', '2026-10-10'), { eligible: false, eligibleOn: '2026-10-11' });
  assert.equal(advanceEligibility(null, '2026-10-10').eligible, false);
});

test('the advance instalment comes off every month and the balance follows', () => {
  const p = oct({ advances: [{ id: 'a1', emi: 2000, balance: 10000 }] });
  assert.deepEqual(p.advanceLines, [{ id: 'a1', amount: 2000 }]);
  assert.deepEqual([p.advanceOpening, p.advanceDeduction, p.advanceBalance], [10000, 2000, 8000]);
  assert.equal(p.netPay, 20000 - 1800 - 113 - 2000);
  // The last instalment is only what is still owed.
  assert.equal(oct({ advances: [{ id: 'a1', emi: 2000, balance: 500 }] }).advanceDeduction, 500);
});

test('arrears and incentives add to pay, deduction entries come off, remarks are kept', () => {
  const p = oct({ additions: [
    { id: 'x1', component_name: 'Arrear', category: 'earning', amount: 1500, reason: 'Sept short payment' },
    { id: 'x2', component_name: 'Incentive', category: 'earning', amount: 500, reason: '' },
    { id: 'x3', component_name: 'Previous month deduction', category: 'deduction', amount: 300, reason: 'Uniform' },
  ] });
  assert.equal(p.totalEarnings, 22000);
  assert.equal(p.arrearNet, 1700);
  assert.equal(p.earnings.find((e) => e.name === 'Arrear').remark, 'Sept short payment');
  assert.equal(line(p.deductions, 'Previous month deduction'), 300);
  // PF stays on Basic: an arrear does not change it.
  assert.equal(p.pf.employee, 1800);
});

test('TDS is the amount HR set', () => {
  const p = oct({ gross: 110000, settings: { tds_monthly: 5000 } });
  assert.equal(line(p.deductions, 'TDS'), 5000);
  assert.equal(p.netPay, 110000 - 3000 - 5000);
});

test('TDS and the advance never take more than the pay that is left', () => {
  const p = oct({ paidDays: 3, settings: { tds_monthly: 1000 }, advances: [{ id: 'a1', emi: 5000, balance: 9000 }] });
  assert.equal(p.netPay, 0);
  assert.equal(p.tds, 1000);
  assert.equal(p.advanceDeduction, p.totalEarnings - p.totalDeductions);
  assert.equal(p.shortfall.advance, 5000 - p.advanceDeduction);
  assert.equal(p.advanceBalance, 9000 - p.advanceDeduction);
});

test('overtime is an earning on top of the structure', () => {
  const p = oct({ otPay: 645, otHours: 8 });
  assert.equal(line(p.earnings, 'Overtime'), 645);
  assert.equal(p.totalEarnings, 20645);
});

test('the slip keeps father name, paid days and every component', () => {
  const pay = oct({ paidDays: 27.5, settings: { retention_percent: 10, tds_monthly: 0 }, probationEnd: '2027-01-01' });
  const d = raniwalaSlipDetails(pay, {
    emp: { employee_id: '467', join_date: '2026-07-01' },
    settings: { father_name: 'RAMESH KUMAR' },
  });
  assert.equal(d.fatherName, 'RAMESH KUMAR');
  assert.equal(d.empCode, '467');
  assert.deepEqual([d.paidDays, d.monthDays, d.grossSalary], [27.5, 31, 20000]);
  assert.equal(d.retentionPercent, 10);
  assert.equal(d.retentionAmount, Math.round(pay.earnedGross * 0.1));
  assert.equal(d.basic + d.hra, d.earnedGross);
});

// ── September 2026: paid in two runs, 1–16 on the old PF rule, 17–30 on the new ──
const [P1, P2] = raniwalaSplitFor(2026, 8);
const part = (p, over = {}) => ({ ...raniwalaPartPay({ gross: 40000, monthDays: 30, paidDays: p.days, pfRule: p.pfRule, ...over }), part: p.part, label: p.label });

test('September 2026 is two parts: 1–16 on the old PF rule, 17–30 on the new', () => {
  assert.deepEqual([P1.fromDate, P1.toDate, P1.days, P1.pfRule], ['2026-09-01', '2026-09-16', 16, 'old']);
  assert.deepEqual([P2.fromDate, P2.toDate, P2.days, P2.pfRule], ['2026-09-17', '2026-09-30', 14, 'new']);
  assert.equal(raniwalaSplitFor(2026, 9), null);
});

test('the old PF rule caps at 1,800 / 1,950 from a Basic of 15,000; below it 12% / 13%', () => {
  const old = RANIWALA_PF_RULES.old.basicCeiling;
  assert.deepEqual(raniwalaPf(15000, 1, old), { capped: true, employee: 1800, employer: 1950 });
  assert.deepEqual(raniwalaPf(22500, 1, old), { capped: true, employee: 1800, employer: 1950 });
  assert.deepEqual(raniwalaPf(12000, 1, old), { capped: false, employee: 1440, employer: 1560 });
});

test('each part is paid on its days out of the whole month, PF on the Basic earned in it', () => {
  // Gross 40,000 -> full Basic 30,000. 16 of 30 days: gross 21,333, Basic 16,000 -> old cap.
  const a = part(P1);
  assert.deepEqual([a.earnedGross, a.basic, a.hra, a.pf.employee, a.pf.employer, a.pf.capped], [21333, 16000, 5333, 1800, 1950, true]);
  // 14 of 30 days: gross 18,667, Basic 14,000 -> under the new 25,000 ceiling.
  const b = part(P2);
  assert.deepEqual([b.earnedGross, b.basic, b.pf.employee, b.pf.employer, b.pf.capped], [18667, 14000, 1680, 1820, false]);
  // ESIC cover is on the full-month Basic (30,000), so neither part has it.
  assert.deepEqual([a.esic.applicable, b.esic.applicable], [false, false]);
});

test('PF can be ticked on in one part and off in the other', () => {
  const a = part(P1, { pfOn: true });
  const b = part(P2, { pfOn: false });
  const p = calcRaniwalaPay({ gross: 40000, monthDays: 30, year: 2026, month: 8, parts: [a, b] });
  assert.deepEqual([p.pf.employee, p.pf.employer], [1800, 1950]);
  assert.equal(p.netPay, 40000 - 1800);
});

test('the final September slip adds both parts, and monthly items are taken once', () => {
  const a = part(P1, { gross: 20000 });
  const b = part(P2, { gross: 20000, otPay: 300, otHours: 4 });
  const p = calcRaniwalaPay({
    gross: 20000, monthDays: 30, year: 2026, month: 8, parts: [a, b],
    settings: { tds_monthly: 200, retention_percent: 5 }, probationEnd: '2027-01-01',
    additions: [{ id: 'x1', component_name: 'Arrear', category: 'earning', amount: 1000, reason: 'Aug' }],
    advances: [{ id: 'a1', emi: 500, balance: 2000 }],
  });
  assert.equal(p.paidDays, 30);
  assert.equal(p.earnedGross, a.earnedGross + b.earnedGross);
  assert.equal(p.basic + p.hra, p.earnedGross);
  assert.equal(p.pf.employee, a.pf.employee + b.pf.employee);
  assert.equal(p.esic.employee, a.esic.employee + b.esic.employee);
  assert.equal(line(p.earnings, 'Overtime'), 300);
  assert.equal(line(p.deductions, 'Retention (5%)'), Math.round(p.earnedGross * 0.05));
  assert.equal(line(p.deductions, 'TDS'), 200);
  assert.equal(p.advanceDeduction, 500);
  assert.equal(p.totalEarnings, p.earnedGross + 300 + 1000);
  assert.match(p.deductions.find((d) => d.name === 'PF (Employee)').note, /1–16 Sep .* \+ 17–30 Sep /);
});

test('a stored part line reads back into the same pay, and the slip keeps both parts', () => {
  const a = part(P1);
  const b = part(P2, { pfOn: false });
  const back = [partFromLine(partSlipDetails(a), P1), partFromLine(partSlipDetails(b), P2)];
  const direct = calcRaniwalaPay({ gross: 40000, monthDays: 30, year: 2026, month: 8, parts: [a, b] });
  const stored = calcRaniwalaPay({ gross: 40000, monthDays: 30, year: 2026, month: 8, parts: back });
  assert.equal(stored.netPay, direct.netPay);
  assert.deepEqual(stored.deductions, direct.deductions);
  const d = raniwalaSlipDetails(stored, { emp: {}, settings: null });
  assert.deepEqual(d.parts.map((x) => [x.label, x.paidDays, x.pfOn, x.pfEmployee]), [['1–16 Sep', 16, true, 1800], ['17–30 Sep', 14, false, 0]]);
});

test('a one-run month has no parts on the slip', () => {
  assert.equal(raniwalaSlipDetails(oct(), { emp: {}, settings: null }).parts, undefined);
});

test('the old structure caps PF at 1,800 / 1,950 from a Basic of 15,000, the rest unchanged', () => {
  const oldB = raniwalaBreakup(40000, 0, 'old');
  const newB = raniwalaBreakup(40000, 0, 'new');
  assert.deepEqual([oldB.month.basic, oldB.month.pfEmployee, oldB.month.pfEmployer, oldB.pfCapped], [30000, 1800, 1950, true]);
  assert.deepEqual([newB.month.pfEmployee, newB.month.pfEmployer, newB.pfCapped], [3000, 3250, true]);
  assert.equal(oldB.month.ctc, 40000 + 1950);
  assert.deepEqual([oldB.annum.pfEmployee, oldB.annum.pfEmployer], [21600, 23400]);
  // Below the old ceiling both structures are the same.
  assert.deepEqual(raniwalaBreakup(20000, 0, 'old').month, raniwalaBreakup(20000).month);
});

test('parts from HR\'s sheet use the sheet\'s retention, arrear, TDS and advance, not the employee\'s records', () => {
  const a = { ...part(P1, { gross: 51800 }), sheet: { retention: 2763, arrear: 0, tds: 1000, advance: 5000, advanceBalance: 15000 } };
  const b = { ...part(P2, { gross: 50500 }), sheet: { retention: 2357, arrear: 696 } };
  const p = calcRaniwalaPay({
    gross: 50500, monthDays: 30, year: 2026, month: 8, parts: [a, b],
    // Ignored for a sheet run:
    settings: { retention_percent: 5, tds_monthly: 9999 }, probationEnd: '2027-01-01',
    additions: [{ id: 'x1', component_name: 'Incentive', category: 'earning', amount: 777 }],
    advances: [{ id: 'adv1', emi: 2000, balance: 8000 }],
  });
  assert.equal(line(p.deductions, 'Retention (10%)'), 2763 + 2357);
  assert.equal(line(p.earnings, 'Arrear'), 696);
  assert.equal(line(p.earnings, 'Incentive'), 0);
  assert.equal(p.tds, 1000);
  assert.deepEqual(p.advanceLines, [{ id: null, amount: 5000 }]);
  // The sheet's Advance Balance is what is left after the month's deduction.
  assert.deepEqual([p.advanceOpening, p.advanceBalance], [20000, 15000]);
  assert.deepEqual(p.arrears.map((x) => x.id), [null]);
  // The sheet amounts survive being stored and read back.
  const back = [partFromLine(partSlipDetails(a), P1), partFromLine(partSlipDetails(b), P2)];
  assert.equal(calcRaniwalaPay({ gross: 50500, monthDays: 30, year: 2026, month: 8, parts: back }).netPay, p.netPay);
});

test('OT slabs: past 8h 30m on a working day, every hour on the weekly off', async () => {
  const { raniwalaPayableOtHours, raniwalaExtraHours, isWeeklyOffDate } = await import('../../src/lib/helpers.js');
  assert.equal(raniwalaPayableOtHours(10), 0);          // 1h 30m past the shift
  assert.equal(raniwalaPayableOtHours(11), 2);
  assert.equal(raniwalaPayableOtHours(14), 8);
  assert.equal(raniwalaPayableOtHours(6.6, true), 8);   // Factory Sunday ~6h 35m
  assert.equal(raniwalaPayableOtHours(3.5, true), 3);
  assert.equal(raniwalaPayableOtHours(1.5, true), 0);
  assert.equal(raniwalaExtraHours(6.6, true), 6.6);
  assert.equal(raniwalaExtraHours(6.6), 0);
  // Delhi is off Monday; the company (and Office / Factory) Sunday.
  const tenant = { weekly_off_days: [0] };
  const delhi = { weekly_off_days: [1] };
  assert.equal(isWeeklyOffDate('2026-10-12', tenant, delhi), true);
  assert.equal(isWeeklyOffDate('2026-10-11', tenant, delhi), false);
  assert.equal(isWeeklyOffDate('2026-10-11', tenant, null), true);
});

test('actual gross: PF/ESIC on the structure gross, the difference deducted (HR sheet, Sep 2026)', async () => {
  const { actualGrossDiff } = await import('../../src/lib/raniwalaPayroll.js');
  const [P1s, P2s] = raniwalaSplitFor(2026, 8);
  // VINAYAK HARIT (350): structure 33,500, actual 27,000, PF NA, 14 days of 17–30 Sep.
  const v2 = raniwalaPartPay({ gross: 33500, actualGross: 27000, paidDays: 14, monthDays: 30, pfOn: false, pfRule: 'new' });
  assert.deepEqual([v2.earnedGross, v2.diff, v2.esic.employee], [15633, 3033, 0]);
  // Factory RAJ DAS (770): 16 days of 1–16 Sep -> Cash Ad 3,467.
  assert.equal(raniwalaPartPay({ gross: 33500, actualGross: 27000, paidDays: 16, monthDays: 30, pfOn: false, pfRule: 'old' }).diff, 3467);
  const v1 = raniwalaPartPay({ gross: 33500, actualGross: 27000, paidDays: 16, monthDays: 30, pfOn: false, pfRule: 'old' });
  const pay = calcRaniwalaPay({
    gross: 33500, monthDays: 30, year: 2026, month: 8,
    parts: [{ ...v1, part: 1, label: P1s.label }, { ...v2, part: 2, label: P2s.label }],
  });
  // Take-home = actual gross for the 30 days: 27,000.
  assert.equal(pay.netPay, 27000);
  assert.equal(pay.diff, 3467 + 3033);
  assert.equal(pay.deductions.find((d) => d.name === 'Gross Advance').amount, 6500);
  // Stored and read back, the difference survives.
  const back = partFromLine(partSlipDetails({ ...v2, part: 2, label: P2s.label }), P2s);
  assert.deepEqual([back.actualGross, back.diff], [27000, 3033]);
  // One-run month: same rule.
  assert.equal(calcRaniwalaPay({ gross: 33500, actualGross: 27000, paidDays: 31, monthDays: 31, year: 2026, month: 9, settings: { pf_applicable: false } }).netPay, 27000);
  // No actual gross, or not below the structure: nothing deducted.
  assert.equal(actualGrossDiff(33500, 0, 1), 0);
  assert.equal(actualGrossDiff(33500, 40000, 1), 0);
});

test('Sept PF difference: both parts added up, less the new monthly cap', () => {
  // 1–16 old rule capped (1,800 / 1,950) + 17–30 new rule on a large Basic.
  const d = raniwalaPfDifference([
    { pfOn: true, pfEmployee: 1800, pfEmployer: 1950 },
    { pfOn: true, pfEmployee: 2546, pfEmployer: 2758 },
  ]);
  assert.deepEqual(d.employee, { byPart: [1800, 2546], total: 4346, cap: 3000, diff: 1346 });
  assert.deepEqual(d.employer, { byPart: [1950, 2758], total: 4708, cap: 3250, diff: 1458 });
});

test('Sept PF difference: nothing to return under the cap, and a part with PF off counts 0', () => {
  const under = raniwalaPfDifference([{ pfEmployee: 1171, pfEmployer: 1268 }, { pfEmployee: 1009, pfEmployer: 1093 }]);
  assert.deepEqual([under.employee.total, under.employee.diff, under.employer.diff], [2180, 0, 0]);
  const off = raniwalaPfDifference([{ pfOn: false, pfEmployee: 1800, pfEmployer: 1950 }, { pfOn: true, pfEmployee: 3000, pfEmployer: 3250 }]);
  assert.deepEqual([off.employee.total, off.employee.diff, off.employer.diff], [3000, 0, 0]);
});

test('Late deduction: HR\'s days come off the paid days and show as a Late Deduction line', () => {
  const full = oct();
  const late = oct({ lateDays: 2, presentDays: 25 });
  assert.equal(late.paidDays, 29);
  assert.equal(late.paidBeforeLate, 31);
  // Earnings stay on the 31 days; 20,000 ÷ 31 × 2 = 1,290 comes off.
  assert.equal(late.totalEarnings, full.totalEarnings);
  assert.deepEqual(late.deductions.find((d) => d.name === 'Late Deduction'), { name: 'Late Deduction', amount: 1290, note: '2 days' });
  assert.equal(late.netPay, full.netPay - 1290);
  const d = raniwalaSlipDetails(late, { emp: {}, settings: null });
  assert.deepEqual([d.paidDays, d.presentDays, d.lateDays, d.lateDeduction], [29, 25, 2, 1290]);
  // None set: no line, nothing extra stored.
  assert.equal(full.deductions.some((x) => x.name === 'Late Deduction'), false);
  assert.equal(raniwalaSlipDetails(full, { emp: {}, settings: null }).lateDays, undefined);
});

test('Late deduction: on the actual gross where one is set, never more than the days paid', () => {
  const late = oct({ actualGross: 15500, lateDays: 1 });
  assert.equal(late.deductions.find((x) => x.name === 'Late Deduction').amount, 500);
  const over = oct({ paidDays: 1, lateDays: 5 });
  assert.equal(over.paidDays, 0);
  assert.equal(over.lateDays, 1);
});
