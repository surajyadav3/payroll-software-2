// Raniwala Jewellers' salary structure. Pure — no Supabase, no React — so the
// rules are unit tested (tests/unit/raniwala-payroll.test.mjs) and the same
// numbers drive Salary Structure, Run Payroll and the payslip.
//
// Everything starts from one figure per employee, the monthly GROSS salary
// (employee_salaries.gross, read into emp.ctc). Nothing here is configured per
// component: the rules below are the structure.
//
// Some staff are paid on a lower ACTUAL gross (employee_salaries.actual_gross)
// than their structure gross: PF, ESIC and the slip are on the structure gross,
// and the difference for the days paid is deducted as the Gross Advance (HR's
// salary sheet: "DIFF" / "Cash Ad"; employee_salaries.gross_advance stores the
// full-month difference).

export const RANIWALA_RULES = {
  // Gross below this splits 75/25 into Basic/HRA, gross at or above it 50/50.
  splitThreshold: 50000,
  belowSplit:   { basic: 75, hra: 25 },
  atOrAboveSplit: { basic: 50, hra: 50 },
  // PF is on Basic, and Basic above the ceiling is ignored — which is what
  // caps the two contributions at Rs.3,000 and Rs.3,250.
  pfBasicCeiling: 25000,
  pfEmployeeRate: 12,
  pfEmployerRate: 13,
  // ESIC only exists for a Basic below this limit.
  esicBasicLimit: 21000,
  esicEmployeeRate: 0.75,
  esicEmployerRate: 3.25,
  // Retention is a share of gross held back during probation.
  retentionOptions: [0, 5, 10],
  // An advance can be given once the employee has completed this many months.
  advanceMinServiceMonths: 12,
};

// Wording on Raniwala's payslips, salary sheet and payroll screens (HR,
// 17 Oct 2026). The actual-gross deduction is the "Gross Advance" (HR,
// 19 Oct 2026; was "Salary Adjustment") — not "Advance", which is the loan
// recovery line.
export const RANIWALA_LABELS = {
  totalEarnings: 'Total Earnings Before Deductions',
  adjustment: 'Gross Advance',
};

// The PF ceiling in force for a pay period. 'new' is the government rule from
// 17 Sep 2026 (RANIWALA_RULES above); 'old' is the rule before it: the same
// 12% / 13% of Basic, but only on Basic up to Rs.15,000 — Rs.1,800 / Rs.1,950.
export const RANIWALA_PF_RULES = {
  new: { key: 'new', label: 'New PF rule', basicCeiling: RANIWALA_RULES.pfBasicCeiling, period: 'From 17 Sep 2026' },
  old: { key: 'old', label: 'Old PF rule', basicCeiling: 15000, period: 'Up to 16 Sep 2026' },
};

// Months HR paid in two runs, as 'YYYY-MM' -> the two parts. Each part is run
// on its own (its own paid days, PF rule and PF tick per employee); the final
// payslip adds them up. `toDay` null is the last day of the month.
//   2026-09: the new PF rule started on 17 Sep, so HR paid 1–16 and 17–30.
export const RANIWALA_SPLIT_MONTHS = {
  '2026-09': [
    { part: 1, fromDay: 1, toDay: 16, pfRule: 'old' },
    { part: 2, fromDay: 17, toDay: null, pfRule: 'new' },
  ],
};

const pad = (n) => String(n).padStart(2, '0');
const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num = (v) => Number(v) || 0;

/** `months` after a 'YYYY-MM-DD' date, as 'YYYY-MM-DD'. */
export function addMonths(date, months) {
  const [y, m, d] = date.split('-').map(Number);
  return toYmd(new Date(y, m - 1 + months, d));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10-05' -> '05 Oct 2026', '—' when there is no date. */
export const fmtYmd = (date) => {
  if (!date) return '—';
  const [y, m, d] = date.split('-').map(Number);
  return `${pad(d)} ${MONTHS[m - 1]} ${y}`;
};

/** Last day of a 0-indexed month, as 'YYYY-MM-DD'. */
export const monthEndDate = (year, month) =>
  `${year}-${pad(month + 1)}-${pad(new Date(year, month + 1, 0).getDate())}`;

/**
 * The two parts of a month HR pays in two runs (RANIWALA_SPLIT_MONTHS), with
 * their dates filled in, or null for a month paid in one run. `month` is
 * 0-indexed.
 */
export function raniwalaSplitFor(year, month) {
  const parts = RANIWALA_SPLIT_MONTHS[`${year}-${pad(month + 1)}`];
  if (!parts) return null;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return parts.map((p) => {
    const toDay = p.toDay || lastDay;
    return {
      ...p,
      toDay,
      days: toDay - p.fromDay + 1,
      fromDate: `${year}-${pad(month + 1)}-${pad(p.fromDay)}`,
      toDate: `${year}-${pad(month + 1)}-${pad(toDay)}`,
      label: `${p.fromDay}–${toDay} ${MONTHS[month]}`,
      rule: RANIWALA_PF_RULES[p.pfRule],
    };
  });
}

/** Basic/HRA share for a monthly gross: 75/25 below Rs.50,000, 50/50 from Rs.50,000. */
export function raniwalaSplit(gross) {
  return num(gross) < RANIWALA_RULES.splitThreshold ? RANIWALA_RULES.belowSplit : RANIWALA_RULES.atOrAboveSplit;
}

/**
 * PF on the Basic actually earned in the month. Basic of Rs.25,000 or more
 * pays the capped Rs.3,000 (employee) / Rs.3,250 (employer); below it, 12% and
 * 13% of the Basic. `months` scales the ceiling for a per-annum figure;
 * `basicCeiling` is Rs.15,000 under the old PF rule (Rs.1,800 / Rs.1,950).
 */
export function raniwalaPf(earnedBasic, months = 1, basicCeiling = RANIWALA_RULES.pfBasicCeiling) {
  const ceiling = basicCeiling * months;
  const wage = Math.min(Math.max(0, num(earnedBasic)), ceiling);
  return {
    capped: num(earnedBasic) >= ceiling,
    employee: Math.round((wage * RANIWALA_RULES.pfEmployeeRate) / 100),
    employer: Math.round((wage * RANIWALA_RULES.pfEmployerRate) / 100),
  };
}

/**
 * ESIC. Whether the employee is covered is decided on their full-month Basic
 * (below Rs.21,000), so a month with absences never moves anyone in or out of
 * ESIC; the contribution itself is 0.75% / 3.25% of the Basic earned, to the
 * nearest rupee — as on HR's "New Structure" salary breakup sheet (Basic
 * 15,617 gives 117 and 508).
 */
export function raniwalaEsic(fullBasic, earnedBasic) {
  const applicable = num(fullBasic) > 0 && num(fullBasic) < RANIWALA_RULES.esicBasicLimit;
  if (!applicable) return { applicable: false, employee: 0, employer: 0 };
  const earned = Math.max(0, num(earnedBasic));
  // Rates are in hundredths of a percent so the maths stays in whole numbers.
  const share = (rate) => Math.round((earned * Math.round(rate * 100)) / 10000);
  return {
    applicable: true,
    employee: share(RANIWALA_RULES.esicEmployeeRate),
    employer: share(RANIWALA_RULES.esicEmployerRate),
  };
}

/**
 * The full-month structure for a gross salary — what Salary Structure shows
 * and what a month with every day paid comes out to.
 */
export function raniwalaStructure(gross) {
  const g = Math.max(0, num(gross));
  const split = raniwalaSplit(g);
  const basic = Math.round((g * split.basic) / 100);
  const hra = g - basic;
  return {
    gross: g,
    basicPercent: split.basic,
    hraPercent: split.hra,
    basic,
    hra,
    pf: raniwalaPf(basic),
    esic: raniwalaEsic(basic, basic),
  };
}

/**
 * The salary breakup as HR's "New Structure" sheet lays it out: the gross
 * split into Basic and HRA, the deductions, what is payable during and after
 * probation, then the company's contribution and the CTC — per month and per
 * annum. A full month, no absences.
 *
 * Per annum is the same rules on twelve months of gross, which is how the
 * sheet gets it (so it can differ from 12 x the rounded monthly rupee).
 * Retention only runs during probation, so it has no per-annum figure.
 * `pfRule` 'old' is the structure before 17 Sep 2026 (PF ceiling Rs.15,000).
 */
export function raniwalaBreakup(gross, retentionPercent = 0, pfRule = 'new') {
  const g = Math.max(0, num(gross));
  const split = raniwalaSplit(g);
  const fullBasic = Math.round((g * split.basic) / 100);
  const ceiling = (RANIWALA_PF_RULES[pfRule] || RANIWALA_PF_RULES.new).basicCeiling;
  const column = (months) => {
    const total = g * months;
    const basic = Math.round((total * split.basic) / 100);
    const pf = raniwalaPf(basic, months, ceiling);
    const esic = raniwalaEsic(fullBasic, basic);
    const retention = months === 1 ? Math.round((total * num(retentionPercent)) / 100) : 0;
    const payableAfterProbation = total - pf.employee - esic.employee;
    return {
      gross: total,
      basic,
      hra: total - basic,
      pfEmployee: pf.employee,
      esicEmployee: esic.employee,
      retention,
      payableInProbation: payableAfterProbation - retention,
      payableAfterProbation,
      pfEmployer: pf.employer,
      esicEmployer: esic.employer,
      ctc: total + pf.employer + esic.employer,
    };
  };
  return {
    basicPercent: split.basic,
    hraPercent: split.hra,
    retentionPercent: num(retentionPercent),
    pfRule: (RANIWALA_PF_RULES[pfRule] || RANIWALA_PF_RULES.new).key,
    pfCeiling: ceiling,
    pfCapped: fullBasic >= ceiling,
    esicApplicable: fullBasic > 0 && fullBasic < RANIWALA_RULES.esicBasicLimit,
    month: column(1),
    annum: column(12),
  };
}

/**
 * The date probation completes: the date HR set for payroll, else date of
 * joining + the employee's probation months. Null when neither is known —
 * the employee is then not treated as being on probation.
 */
export function probationEndDate(emp, settings) {
  if (settings?.probation_end_date) return settings.probation_end_date;
  if (emp?.join_date && num(emp?.probation_months) > 0) return addMonths(emp.join_date, num(emp.probation_months));
  return null;
}

/**
 * Retention for one payroll month. HR picks None / 5% / 10%, but it is only
 * taken while the employee is on probation for the whole month: from the
 * month probation completes in, it is 0 again without anyone switching it off.
 *
 * `state` says why: 'none' (HR chose None), 'no-date' (a rate is chosen but no
 * probation completion date is known), 'closed' (probation is over) or 'active'.
 */
export function retentionFor({ percent, probationEnd, year, month }) {
  const chosen = RANIWALA_RULES.retentionOptions.includes(num(percent)) ? num(percent) : 0;
  if (!chosen) return { percent: 0, chosen: 0, state: 'none' };
  if (!probationEnd) return { percent: 0, chosen, state: 'no-date' };
  if (probationEnd <= monthEndDate(year, month)) return { percent: 0, chosen, state: 'closed' };
  return { percent: chosen, chosen, state: 'active' };
}

/** Whether an advance may be given: the employee must have completed one year. */
export function advanceEligibility(joinDate, today) {
  if (!joinDate) return { eligible: false, eligibleOn: null };
  const eligibleOn = addMonths(joinDate, RANIWALA_RULES.advanceMinServiceMonths);
  return { eligible: eligibleOn <= today, eligibleOn };
}

/**
 * The deduction that brings pay down to the actual gross: structure gross
 * earned minus actual gross earned for the same days. 0 when there is no
 * actual gross, or it is not below the structure gross.
 */
export function actualGrossDiff(gross, actualGross, ratio) {
  const g = Math.max(0, num(gross));
  const a = num(actualGross);
  if (!(a > 0 && a < g)) return 0;
  return Math.round(g * ratio) - Math.round(a * ratio);
}

/**
 * What one stretch of days earns, before any monthly deduction: the earned
 * gross split into Basic and HRA, overtime, and PF and ESIC on that Basic.
 * A whole month is one part; a month HR pays in two runs (raniwalaSplitFor)
 * has one per run. `paidDays` is out of the whole month's `monthDays`, so the
 * two parts of a month add up to what one run would pay.
 *
 * PF is ticked per part (`pfOn`), and its ceiling is the part's rule
 * ('new' Rs.25,000, 'old' Rs.15,000 of Basic), applied to the Basic earned in
 * the part. ESIC has no switch: it follows the Basic alone — covered when the
 * full-month Basic is below Rs.21,000, on the Basic earned.
 */
export function raniwalaPartPay({
  gross, paidDays, monthDays, pfOn = true, pfRule = 'new', otPay = 0, otHours = 0, actualGross = 0,
}) {
  const structure = raniwalaStructure(gross);
  const days = Math.max(0, num(paidDays));
  const ratio = monthDays ? Math.min(1, days / monthDays) : 0;

  // Earned gross first, then split it, so Basic + HRA always add up to it.
  const earnedGross = Math.round(structure.gross * ratio);
  const basic = Math.round((earnedGross * structure.basicPercent) / 100);
  const rule = RANIWALA_PF_RULES[pfRule] || RANIWALA_PF_RULES.new;
  return {
    paidDays: days,
    gross: structure.gross,
    earnedGross,
    basic,
    hra: earnedGross - basic,
    otPay: Math.round(num(otPay)),
    otHours: num(otHours),
    pfOn,
    esicOn: true,
    pfRule: rule.key,
    pf: pfOn ? raniwalaPf(basic, 1, rule.basicCeiling) : { capped: false, employee: 0, employer: 0 },
    esic: raniwalaEsic(structure.basic, basic),
    actualGross: actualGrossDiff(structure.gross, actualGross, ratio) ? num(actualGross) : 0,
    diff: actualGrossDiff(structure.gross, actualGross, ratio),
  };
}

/**
 * One employee's pay for one month.
 *
 *   gross         monthly gross salary (employee_salaries.gross)
 *   actualGross   the lower gross actually paid, if any (employee_salaries.actual_gross)
 *   paidDays      days paid this month before the late cut (see calendarPaidDays), may be x.5
 *   monthDays     days in the month (28–31)
 *   year, month   payroll month, `month` 0-indexed
 *   settings      the employee's employee_payroll_settings row (may be missing)
 *   probationEnd  probationEndDate(emp, settings)
 *   otPay/otHours approved overtime for the month
 *   additions     this month's salary_additions rows (arrear, incentive, dues…)
 *   advances      the employee's Active advances
 *   parts         a month paid in two runs: each run's raniwalaPartPay result,
 *                 with its `label` ('1–16 Sep'). Paid days, Basic, HRA,
 *                 overtime, PF and ESIC are then the parts added up, and
 *                 paidDays / otPay / otHours are not used.
 *   lateDays      HR's late deduction, in days (HR, 30 Oct 2026). They come
 *                 off the paid days; the earnings stay on the days before the
 *                 cut and the slip shows the days' pay as "Late Deduction"
 *                 (actual gross per day where one is set). Not in a two-run month.
 *   presentDays   days actually attended, stored for the slip / Run Payroll only
 *
 * Order of deductions: PF, ESIC and Retention come off first, then HR's own
 * deduction entries, then TDS, then the advance instalment. TDS and the
 * advance are fixed rupee amounts, so they are limited to the pay that is
 * left — an advance balance is never reduced by money that was not actually
 * recovered. `shortfall` reports what could not be taken. Retention, arrears,
 * TDS and the advance are monthly: in a two-run month they are taken once,
 * here, never per part.
 *
 * A part filled from HR's own salary sheet carries `sheet`: { retention,
 * arrear, tds, advance, advanceBalance } in rupees, as the sheet has them.
 * Then those amounts are used as they are (added over the parts) and the
 * employee's settings, salary_additions and advances are not looked at — so
 * nothing outside the payslip is touched by such a run.
 */
export function calcRaniwalaPay({
  gross, paidDays, monthDays, year, month, actualGross = 0,
  settings = null, probationEnd = null,
  otPay = 0, otHours = 0, additions = [], advances = [], parts = null,
  lateDays = 0, presentDays = null,
}) {
  const structure = raniwalaStructure(gross);
  const pfOn = settings?.pf_applicable !== false;
  const pieces = parts || [raniwalaPartPay({ gross, paidDays, monthDays, pfOn, otPay, otHours, actualGross })];
  const total = (pick) => pieces.reduce((s, p) => s + pick(p), 0);
  const split = !!parts;

  const days = total((p) => p.paidDays);
  const earnedGross = total((p) => p.earnedGross);
  const basic = total((p) => p.basic);
  const hra = total((p) => p.hra);
  const ot = total((p) => p.otPay);
  const otH = total((p) => p.otHours);
  const diff = total((p) => num(p.diff));
  const paidOnActual = pieces.map((p) => num(p.actualGross)).find((a) => a > 0) || 0;
  const pf = {
    capped: pieces.some((p) => p.pf.capped),
    employee: total((p) => p.pf.employee),
    employer: total((p) => p.pf.employer),
  };
  const esic = {
    applicable: pieces.some((p) => p.esic.applicable),
    employee: total((p) => p.esic.employee),
    employer: total((p) => p.esic.employer),
  };
  // '1–16 Sep 1,800 + 17–30 Sep 1,680', so the slip shows where a sum came from.
  const byPart = (pick) => pieces.map((p) => `${p.label} ${pick(p).toLocaleString('en-IN')}`).join(' + ');

  const earnings = [
    { name: 'Basic Pay', amount: basic, note: split ? byPart((p) => p.basic) : `${structure.basicPercent}% of gross` },
    { name: 'HRA', amount: hra, note: split ? byPart((p) => p.hra) : `${structure.hraPercent}% of gross` },
  ];
  if (ot > 0) earnings.push({ name: 'Overtime', amount: ot, note: otH ? `${otH} h` : '' });

  const fromSheet = pieces.some((p) => p.sheet);
  const sheetSum = (key) => Math.round(pieces.reduce((t, p) => t + num(p.sheet?.[key]), 0));

  const arrears = fromSheet
    ? (sheetSum('arrear') > 0 ? [{ id: null, name: 'Arrear', category: 'earning', amount: sheetSum('arrear'), remark: 'as per HR salary sheet' }] : [])
    : additions.map((a) => ({
      id: a.id,
      name: a.component_name,
      category: a.category === 'deduction' ? 'deduction' : 'earning',
      amount: Math.round(num(a.amount)),
      remark: a.reason || '',
    }));
  arrears.filter((a) => a.category === 'earning').forEach((a) => {
    earnings.push({ name: a.name, amount: a.amount, remark: a.remark });
  });

  let retention = retentionFor({ percent: settings?.retention_percent, probationEnd, year, month });
  let retentionAmount = Math.round((earnedGross * retention.percent) / 100);
  if (fromSheet) {
    retentionAmount = sheetSum('retention');
    const pct = earnedGross ? Math.round((retentionAmount * 100) / earnedGross) : 0;
    retention = { percent: retentionAmount ? pct : 0, chosen: retentionAmount ? pct : 0, state: retentionAmount ? 'sheet' : 'none' };
  }

  const deductions = [];
  if (pf.employee > 0) {
    deductions.push({ name: 'PF (Employee)', amount: pf.employee, note: split ? byPart((p) => p.pf.employee) : pf.capped ? 'capped' : `${RANIWALA_RULES.pfEmployeeRate}% of Basic` });
  }
  if (esic.employee > 0) {
    deductions.push({ name: 'ESIC (Employee)', amount: esic.employee, note: split ? byPart((p) => p.esic.employee) : `${RANIWALA_RULES.esicEmployeeRate}% of Basic` });
  }
  if (retentionAmount > 0) {
    deductions.push({
      name: `Retention (${retention.percent}%)`, amount: retentionAmount,
      note: fromSheet ? 'as per HR salary sheet' : `${retention.percent}% of gross, probation till ${fmtYmd(probationEnd)}`,
    });
  }
  if (diff > 0) {
    deductions.push({
      name: RANIWALA_LABELS.adjustment, amount: diff,
      note: split ? byPart((p) => num(p.diff)) : '',
    });
  }
  // A day's pay is what the employee is paid for a day: the actual gross
  // where one is set, never more than the Basic + HRA earned (less the Adj).
  const lateCut = split ? 0 : Math.min(Math.max(0, num(lateDays)), days);
  const lateAmount = lateCut > 0
    ? Math.min(Math.round(((paidOnActual || structure.gross) * lateCut) / monthDays), Math.max(0, earnedGross - diff))
    : 0;
  if (lateAmount > 0) {
    deductions.push({ name: 'Late Deduction', amount: lateAmount, note: `${lateCut} day${lateCut === 1 ? '' : 's'}` });
  }
  arrears.filter((a) => a.category === 'deduction').forEach((a) => {
    deductions.push({ name: a.name, amount: a.amount, remark: a.remark });
  });

  const totalEarnings = earnings.reduce((s, e) => s + e.amount, 0);
  let left = totalEarnings - deductions.reduce((s, d) => s + d.amount, 0);

  const tdsSet = fromSheet ? Math.max(0, sheetSum('tds')) : Math.max(0, Math.round(num(settings?.tds_monthly)));
  const tds = Math.min(tdsSet, Math.max(0, left));
  if (tds > 0) deductions.push({ name: 'TDS', amount: tds, note: fromSheet ? 'as per HR salary sheet' : 'set by HR' });
  left -= tds;

  // The sheet's "Advance Balance" is what is still owed AFTER that sheet's
  // deduction (HR, 14 Oct 2026); in a two-run month the last part that has
  // one is the month's closing balance. No advances row behind it (id null),
  // so none is changed.
  const sheetAdvance = sheetSum('advance');
  const advancePieces = pieces.filter((p) => num(p.sheet?.advance) > 0 || num(p.sheet?.advanceBalance) > 0);
  const sheetClosing = advancePieces.length ? num(advancePieces[advancePieces.length - 1].sheet.advanceBalance) : 0;
  const openAdvances = fromSheet
    ? (sheetAdvance + sheetClosing > 0 ? [{ id: null, emi: sheetAdvance, balance: sheetClosing + sheetAdvance }] : [])
    : advances.filter((a) => num(a.balance) > 0);
  const advanceOpening = openAdvances.reduce((s, a) => s + num(a.balance), 0);
  let advanceDue = 0;
  const advanceLines = [];
  openAdvances.forEach((a) => {
    const due = Math.min(num(a.emi), num(a.balance));
    advanceDue += due;
    const take = Math.min(due, Math.max(0, left));
    if (take > 0) advanceLines.push({ id: a.id, amount: take });
    left -= take;
  });
  const advanceDeduction = advanceLines.reduce((s, a) => s + a.amount, 0);

  const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);

  return {
    paidDays: days - lateCut,
    paidBeforeLate: days,
    presentDays,
    lateDays: lateCut,
    lateDeduction: lateAmount,
    monthDays,
    structure,
    earnedGross,
    basic,
    hra,
    otPay: ot,
    otHours: otH,
    actualGross: paidOnActual,
    diff,
    parts: split ? pieces : null,
    arrears,
    arrearNet: arrears.reduce((s, a) => s + (a.category === 'earning' ? a.amount : -a.amount), 0),
    earnings,
    deductions,
    pf,
    esic,
    pfApplicable: pieces.some((p) => p.pfOn),
    esicApplicable: pieces.some((p) => p.esicOn),
    retention: { ...retention, amount: retentionAmount, probationEnd },
    tds,
    advanceLines,
    advanceDeduction,
    advanceOpening,
    advanceBalance: advanceOpening - advanceDeduction,
    shortfall: { tds: tdsSet - tds, advance: advanceDue - advanceDeduction },
    totalEarnings,
    totalDeductions,
    netPay: totalEarnings - totalDeductions - advanceDeduction,
  };
}

/** A payslip's breakdown column, whether it arrived as JSON text or an object. */
export function parseBreakdown(slip) {
  try {
    return (typeof slip?.breakdown === 'string' ? JSON.parse(slip.breakdown) : slip?.breakdown) || { earnings: [], deductions: [] };
  } catch {
    return { earnings: [], deductions: [] };
  }
}

/**
 * Bank, PF and ESIC account details as the payslip shows them. The UAN only
 * when PF is deducted this month, the ESIC number (profiles.esic_number) only
 * when ESIC is (`pfOn` / `esicOn` null = no line at all).
 */
export function slipBankDetails(emp, pfOn, esicOn = false) {
  return {
    bankName: (emp?.bank_name || '').trim(),
    bankAcc: (emp?.bank_acc || '').trim(),
    ifsc: (emp?.ifsc_code || '').trim().toUpperCase(),
    pfOn: !!pfOn,
    uan: pfOn ? (emp?.pf_number || '').trim() : '',
    esicOn: !!esicOn,
    esicNo: esicOn ? (emp?.esic_number || '').trim() : '',
  };
}

/**
 * What a payslip stores under breakdown.raniwala — every figure the slip, the
 * Run Payroll table and the salary register show, frozen at the time payroll
 * was processed so later edits to the employee never rewrite a past slip.
 */
export function raniwalaSlipDetails(pay, { emp, settings }) {
  return {
    empCode: emp?.employee_id || '',
    fatherName: settings?.father_name || '',
    joinDate: emp?.join_date || null,
    ...slipBankDetails(emp, pay.pfApplicable, pay.esic.applicable),
    paidDays: pay.paidDays,
    monthDays: pay.monthDays,
    ...(pay.presentDays != null ? { presentDays: pay.presentDays } : {}),
    ...(pay.lateDays > 0 ? { paidBeforeLate: pay.paidBeforeLate, lateDays: pay.lateDays, lateDeduction: pay.lateDeduction } : {}),
    grossSalary: pay.structure.gross,
    basicPercent: pay.structure.basicPercent,
    hraPercent: pay.structure.hraPercent,
    fullBasic: pay.structure.basic,
    fullHra: pay.structure.hra,
    earnedGross: pay.earnedGross,
    basic: pay.basic,
    hra: pay.hra,
    overtime: pay.otPay,
    overtimeHours: pay.otHours,
    arrears: pay.arrears.map(({ name, category, amount, remark }) => ({ name, category, amount, remark })),
    arrearNet: pay.arrearNet,
    pfEmployee: pay.pf.employee,
    pfEmployer: pay.pf.employer,
    pfCapped: pay.pf.capped,
    actualGross: pay.actualGross,
    actualGrossDiff: pay.diff,
    esicApplicable: pay.esic.applicable,
    esicEmployee: pay.esic.employee,
    esicEmployer: pay.esic.employer,
    retentionPercent: pay.retention.percent,
    retentionAmount: pay.retention.amount,
    probationEndDate: pay.retention.probationEnd,
    tds: pay.tds,
    advanceOpening: pay.advanceOpening,
    advanceDeducted: pay.advanceDeduction,
    advanceBalance: pay.advanceBalance,
    // A month paid in two runs: what each run paid.
    ...(pay.parts ? { parts: pay.parts.map(partSlipDetails) } : {}),
  };
}

/** One part of a two-run month, as the slip and the part runs store it. */
export function partSlipDetails(p) {
  return {
    part: p.part,
    label: p.label,
    pfRule: p.pfRule,
    paidDays: p.paidDays,
    gross: p.gross,
    earnedGross: p.earnedGross,
    basic: p.basic,
    hra: p.hra,
    overtime: p.otPay,
    overtimeHours: p.otHours,
    pfOn: p.pfOn,
    pfEmployee: p.pf.employee,
    pfEmployer: p.pf.employer,
    pfCapped: p.pf.capped,
    esicOn: p.esicOn,
    esicApplicable: p.esic.applicable,
    esicEmployee: p.esic.employee,
    esicEmployer: p.esic.employer,
    ...(num(p.diff) > 0 ? { actualGross: num(p.actualGross), diff: num(p.diff) } : {}),
    ...(p.sheet ? { sheet: p.sheet } : {}),
  };
}

/**
 * What a month paid in parts took in PF above the new rule's monthly cap
 * (Rs.3,000 employee / Rs.3,250 employer, RANIWALA_RULES). Sept 2026's two
 * runs each applied their own ceiling, so 1–16 (old rule, up to Rs.1,800) plus
 * 17–30 can add up to more than a whole month under the new rule; HR returns
 * the employee's excess in the next month's pay (Difference page). `parts` are
 * the slip's breakdown.raniwala.parts; a part with PF off counts 0.
 */
export function raniwalaPfDifference(parts) {
  const cap = raniwalaPf(RANIWALA_RULES.pfBasicCeiling);
  const side = (key, capped) => {
    const byPart = (parts || []).map((p) => (p.pfOn === false ? 0 : num(p[key])));
    const total = byPart.reduce((t, v) => t + v, 0);
    return { byPart, total, cap: capped, diff: Math.max(0, total - capped) };
  };
  return { employee: side('pfEmployee', cap.employee), employer: side('pfEmployer', cap.employer) };
}

/** The reverse: a stored part line back into the shape calcRaniwalaPay adds up. */
export function partFromLine(line, part) {
  return {
    part: part.part,
    label: part.label,
    pfRule: line.pfRule,
    paidDays: num(line.paidDays),
    gross: num(line.gross),
    earnedGross: num(line.earnedGross),
    basic: num(line.basic),
    hra: num(line.hra),
    otPay: num(line.overtime),
    otHours: num(line.overtimeHours),
    pfOn: line.pfOn !== false,
    esicOn: line.esicOn !== false,
    pf: { capped: !!line.pfCapped, employee: num(line.pfEmployee), employer: num(line.pfEmployer) },
    esic: { applicable: !!line.esicApplicable, employee: num(line.esicEmployee), employer: num(line.esicEmployer) },
    actualGross: num(line.actualGross),
    diff: num(line.diff),
    sheet: line.sheet || null,
  };
}
