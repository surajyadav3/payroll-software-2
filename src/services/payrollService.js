import { supabase } from '@/lib/supabase';
import { calcSalary, calcPfEsic, buildPfStatutoryInfo, calcOtPay, calcTds, HIGH_SALARY_THRESHOLD, fullName } from '@/lib/helpers';
import { raniwalaSlipDetails } from '@/lib/raniwalaPayroll';

/** Fetch one payroll run (with all its payslips) for a given month/year and country group. */
export async function fetchPayroll(tenantId, month, year, countryGroup = 'Compliance') {
  const { data, error } = await supabase
    .from('payrolls')
    .select('*, payslips(*)')
    .eq('tenant_id', tenantId)
    .eq('month', month + 1)
    .eq('year', year)
    .eq('country_group', countryGroup)
    .maybeSingle();
  return { data: data || null, error };
}

/**
 * Process payroll for a month and country group.
 * Uses the process_payroll_by_country RPC for atomic insert.
 *
 * New optional inputs (Payroll engine depth):
 *  - taxSlab: this tenant's active tax_slabs row (see taxService.fetchActiveTaxSlab) — omit to skip TDS.
 *  - declarationsByProfile: { [profile_id]: tax_declarations[] } (see taxService.fetchDeclarationsForTenant).
 *  - salaryAdditions: pending salary_additions rows due this month (see salaryAdditionsService.fetchPendingSalaryAdditions).
 *  - pfSettings: this tenant's { wageCeiling, rate } (tenant.pf_wage_ceiling / pf_employee_rate,
 *    see SalaryPage.jsx's Statutory Settings card) — omit to use the statutory defaults (Rs.15,000 / 12%).
 * Employees with `is_withheld` are skipped entirely and returned in `withheld` so the caller can surface them.
 */
export async function processPayroll({ tenantId, month, year, countryGroup, employees, components, advances, workDays, workDayOverrides, overtimeRequests = [], shiftHours = 8, taxSlab = null, declarationsByProfile = {}, salaryAdditions = [], pfSettings = {} }) {
  const payrollMonth = month + 1;

  const withheld = employees.filter((e) => e.is_withheld);
  const payableEmployees = employees.filter((e) => !e.is_withheld);

  // Build a map: profile_id → total approved overtime pay this month.
  // Overtime cash is only for employees whose CTC is below the threshold.
  const otByEmployee = {};
  overtimeRequests.forEach((req) => {
    const pid = req.profile_id;
    const emp = payableEmployees.find(e => e.id === pid);
    if (!emp || (emp.ctc || 0) >= HIGH_SALARY_THRESHOLD) return;
    const pay = req.overtime_pay > 0
      ? Number(req.overtime_pay)
      : calcOtPay(emp.ctc, shiftHours, req.overtime_hours || 0);
    otByEmployee[pid] = (otByEmployee[pid] || 0) + pay;
  });

  const payload = payableEmployees.map((emp) => {
    const actualDays = workDayOverrides[emp.id] !== undefined ? workDayOverrides[emp.id] : workDays;
    const sal        = calcSalary(emp.ctc || 0, components, workDays, actualDays);

    // Apply PF and ESIC statutory deductions if enabled for this employee
    const pfEsicDeds = calcPfEsic(emp, emp.ctc || 0, actualDays, workDays, pfSettings);
    pfEsicDeds.forEach((d) => {
      sal.deductions.push(d);
      sal.totalDeduction += d.amount;
      sal.net            -= d.amount;
    });

    // Info-only PF statutory block (UAN, employee/employer contribution) for
    // the payslip template — null for a non-PF employee, so the payslip
    // renders the plain (non-PF) layout with no code branching needed there.
    const pfInfo = buildPfStatutoryInfo(emp, emp.ctc || 0, actualDays, workDays, pfSettings);

    // Income tax (TDS) — skipped entirely when no active slab config is passed in.
    const tds = calcTds(emp.ctc || 0, declarationsByProfile[emp.id], taxSlab, actualDays, workDays);
    if (tds) {
      sal.deductions.push(tds);
      sal.totalDeduction += tds.amount;
      sal.net            -= tds.amount;
    }

    // Add approved salary overtime pay as an extra earning line
    const otPay = otByEmployee[emp.id] || 0;
    if (otPay > 0) {
      sal.earnings.push({ name: 'Salary Overtime', amount: otPay });
      sal.totalEarning += otPay;
      sal.net          += otPay;
    }

    // Fold in this month's one-off/recurring pay items (arrears, incentives,
    // retention bonus, encashment, gratuity payout, ...).
    const empAdditions = salaryAdditions.filter((a) => a.profile_id === emp.id);
    empAdditions.forEach((a) => {
      const line = { name: a.component_name, amount: Number(a.amount) || 0 };
      if (a.category === 'earning') {
        sal.earnings.push(line);
        sal.totalEarning += line.amount;
        sal.net          += line.amount;
      } else {
        sal.deductions.push(line);
        sal.totalDeduction += line.amount;
        sal.net            -= line.amount;
      }
    });

    const empAdvances = advances
      .filter((a) => a.profile_id === emp.id && a.balance > 0)
      .map(a => ({ id: a.id, amount: Math.min(a.emi, a.balance) }));

    const totalAdvDed = empAdvances.reduce((sum, a) => sum + a.amount, 0);

    return {
      profile_id:          emp.id,
      emp_name:            fullName(emp),
      department:          emp.department  || '',
      designation:         emp.designation || '',
      ctc:                 emp.ctc         || 0,
      work_days:           actualDays,
      total_work_days:     workDays,
      gross_earnings:      sal.totalEarning,
      total_deductions:    sal.totalDeduction,
      advance_deduction:   totalAdvDed,
      net_pay:             sal.net - totalAdvDed,
      breakdown:           { earnings: sal.earnings, deductions: sal.deductions, pfInfo },
      advances:            empAdvances,
      salary_addition_ids: empAdditions.map((a) => a.id),
    };
  });

  const { data, error } = await supabase.rpc('process_payroll_by_country', {
    p_tenant_id:     tenantId,
    p_month:         payrollMonth,
    p_year:          year,
    p_country_group: countryGroup,
    p_data:          payload,
  });

  if (error) throw error;
  return { payroll_id: data, withheld };
}

/**
 * Process Raniwala's payroll for a month. The figures are already worked out
 * by calcRaniwalaPay (lib/raniwalaPayroll.js) — the same rows HR saw on Run
 * Payroll — so this only shapes them for process_payroll_by_country.
 *
 * `rows` is `[{ emp, settings, pay }]`. Raniwala has one run per month
 * (PF/ESIC follow the salary rules, not a per-employee flag), stored under the
 * 'Compliance' group. Withheld employees are skipped and returned.
 */
export async function processRaniwalaPayroll({ tenantId, month, year, rows }) {
  const withheld = rows.filter((r) => r.emp.is_withheld).map((r) => r.emp);
  const strip = ({ name, amount, note, remark }) => ({ name, amount, ...(note ? { note } : {}), ...(remark ? { remark } : {}) });

  const payload = rows.filter((r) => !r.emp.is_withheld).map(({ emp, settings, pay }) => ({
    profile_id:          emp.id,
    emp_name:            fullName(emp),
    department:          emp.department  || '',
    designation:         emp.designation || '',
    ctc:                 pay.structure.gross,
    work_days:           pay.paidDays,
    total_work_days:     pay.monthDays,
    gross_earnings:      pay.totalEarnings,
    total_deductions:    pay.totalDeductions,
    advance_deduction:   pay.advanceDeduction,
    net_pay:             pay.netPay,
    breakdown: {
      earnings:   pay.earnings.map(strip),
      deductions: pay.deductions.map(strip),
      raniwala:   raniwalaSlipDetails(pay, { emp, settings }),
    },
    // Lines with no row behind them (amounts from HR's salary sheet) change
    // no advance and no salary addition.
    advances:            pay.advanceLines.filter((a) => a.id),
    salary_addition_ids: pay.arrears.filter((a) => a.id).map((a) => a.id),
  }));

  const { data, error } = await supabase.rpc('process_payroll_by_country', {
    p_tenant_id:     tenantId,
    p_month:         month + 1,
    p_year:          year,
    p_country_group: 'Compliance',
    p_data:          payload,
  });

  if (error) throw error;
  return { payroll_id: data, withheld };
}

/** Payroll GL journal rows (department-level debit/credit) for one processed run. */
export async function fetchPayrollGlEntries(payrollId) {
  const { data, error } = await supabase
    .from('payroll_gl_entries')
    .select('*')
    .eq('payroll_id', payrollId)
    .order('department');
  return { data: data || [], error };
}

/**
 * Generic NEFT/RTGS-style bank payout rows for a processed run's payslips.
 * Column layout is a common-denominator template — adjust to your bank's
 * exact bulk-upload format before using it for a real transfer.
 */
export function buildBankFileRows(payslips, employeesById, narration = 'Salary Payment') {
  return (payslips || []).map((p) => {
    const emp = employeesById[p.profile_id] || {};
    return {
      'Employee Name':   p.emp_name,
      'Account Number':  emp.bank_acc || '',
      'IFSC Code':       emp.ifsc_code      || '',
      'Bank Name':       emp.bank_name      || '',
      'Amount':          p.net_pay,
      'Narration':       narration,
    };
  });
}

/**
 * Release a run's payslips to employees, or hold them back again. A Raniwala
 * run starts held when it is processed (20261013_1); until it is released an
 * employee cannot read their own payslip.
 */
export async function setPayrollReleased(payrollId, released, profileId) {
  const { data, error } = await supabase
    .from('payrolls')
    .update(released ? { released_at: new Date().toISOString(), released_by: profileId } : { released_at: null, released_by: null })
    .eq('id', payrollId)
    .select('id, released_at')
    .single();
  return { data, error };
}

/** Delete a payroll run and all its payslips. */
export async function revertPayroll(payrollId) {
  const { error } = await supabase.rpc('revert_payroll_atomic', { p_payroll_id: payrollId });
  if (error) throw error;
}

/** Fetch payslips for a month (admin view). */
export async function fetchPayslipsByMonth(tenantId, month, year) {
  // A month can have two runs (Compliance + Non-Compliance), so this must not
  // be a single-row fetch: that errored and showed no payslips at all.
  const { data: payrolls, error } = await supabase
    .from('payrolls')
    .select('id, released_at, payslips(*)')
    .eq('tenant_id', tenantId)
    .eq('month', month + 1)
    .eq('year', year);
  // released_at rides along so the page can say which slips employees cannot see yet.
  return { data: (payrolls || []).flatMap((p) => (p.payslips || []).map((s) => ({ ...s, released_at: p.released_at }))), error };
}

/** Fetch a single employee's payslip for a given month. */
export async function fetchMyPayslip(tenantId, profileId, month, year) {
  // There can now be two payroll records per month (India + International)
  // so we fetch all IDs for the month and search payslips across them.
  const { data: payrolls, error: pErr } = await supabase
    .from('payrolls')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('month', month + 1)
    .eq('year', year);
  if (pErr) return { data: null, error: pErr };
  if (!payrolls?.length) return { data: null, error: null };

  const { data, error } = await supabase
    .from('payslips')
    .select('*')
    .eq('profile_id', profileId)
    .in('payroll_id', payrolls.map(p => p.id))
    .maybeSingle();
  return { data: data || null, error };
}

/** Fetch all payslips across every payroll run for a tenant — used for master report. */
/** Scoped to one calendar year — see fetchAllAttendanceWithPunches for why. */
export async function fetchAllPayslipsForReport(tenantId, year = new Date().getFullYear()) {
  const { data, error } = await supabase
    .from('payrolls')
    .select('month, year, payslips(profile_id, net_pay)')
    .eq('tenant_id', tenantId)
    .eq('year', year);
  return { data: data || [], error };
}

/**
 * Fetch all approved Salary Overtime requests for a given month.
 * month is 0-indexed (like JS Date). Returns one row per approval with
 * profile_id, overtime_hours (payable), and overtime_pay (pre-calculated).
 */
export async function fetchApprovedOvertimeForMonth(tenantId, month, year) {
  const m     = month + 1; // 1-indexed
  const start = `${year}-${String(m).padStart(2, '0')}-01`;
  const end   = new Date(year, month + 1, 0).toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('special_requests')
    .select('profile_id, overtime_hours, overtime_pay')
    .eq('tenant_id', tenantId)
    .eq('request_type', 'Salary Overtime')
    .eq('status', 'Approved')
    .gte('request_date', start)
    .lte('request_date', end);
  return { data: data || [], error };
}

/** Count of processed payrolls for a tenant. */
export async function fetchPayrollCount(tenantId) {
  const { count, error } = await supabase
    .from('payrolls')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'Processed');
  return { count: count || 0, error };
}
