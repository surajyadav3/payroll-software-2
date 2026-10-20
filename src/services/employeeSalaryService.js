import { supabase } from '@/lib/supabase';

// Employee salary (monthly gross, CTC, actual gross, and the Gross Advance =
// gross - actual gross, a generated column from 20261019_2) lives in
// employee_salaries, not on the profile, for a tenant with
// tenants.salary_private (Raniwala) — migration 20261014_4. RLS lets payroll
// HR read the tenant's rows and an employee read only their own; a manager,
// HOD or the HR Support login gets nothing back. Every change is kept in
// employee_salary_history (HR only).

const SALARY_COLS = 'profile_id, gross, ctc, actual_gross, gross_advance, updated_at';

/** { [profileId]: salaryRow } for the given employees (or the whole tenant). */
export async function fetchSalaryMap(tenantId, profileIds = null) {
  let q = supabase.from('employee_salaries').select(SALARY_COLS).eq('tenant_id', tenantId);
  if (profileIds) {
    if (!profileIds.length) return { data: {}, error: null };
    q = q.in('profile_id', profileIds);
  }
  const { data, error } = await q;
  return { data: Object.fromEntries((data || []).map((s) => [s.profile_id, s])), error };
}

/**
 * Puts each employee's salary on their row the way the rest of the app reads
 * it: `ctc` = monthly gross (what payroll runs on), plus `salary_ctc`,
 * `actual_gross` and `gross_advance`. Rows without a salary row are left as they are, so other
 * tenants (salary still on the profile) are unaffected.
 */
export function mergeSalaries(rows, salaryMap) {
  return (rows || []).map((r) => {
    const s = salaryMap?.[r.id];
    if (!s) return r;
    return {
      ...r,
      ctc: Number(s.gross) || 0,
      salary_ctc: s.ctc == null ? null : Number(s.ctc),
      actual_gross: s.actual_gross == null ? null : Number(s.actual_gross),
      gross_advance: Number(s.gross_advance) || 0,
    };
  });
}

/** A `{ data, error }` employee list with salaries merged in (salary-private tenants only). */
export async function withSalaries(tenant, res) {
  if (!tenant?.salary_private || res?.error || !res?.data?.length) return res;
  const { data: map } = await fetchSalaryMap(tenant.id, res.data.length > 200 ? null : res.data.map((r) => r.id));
  return { ...res, data: mergeSalaries(res.data, map) };
}

/**
 * Set an employee's salary. `null`/`undefined` keeps what is there; 0 clears
 * CTC / actual gross. Only payroll HR may call this (checked in the DB).
 */
export async function setEmployeeSalary({ profileId, gross, ctc, actualGross, effectiveFrom = null, source = 'manual', note = null }) {
  const n = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  const { data, error } = await supabase.rpc('set_employee_salary', {
    p_profile_id: profileId,
    p_gross: n(gross),
    p_ctc: n(ctc),
    p_actual_gross: n(actualGross),
    p_effective_from: effectiveFrom,
    p_source: source,
    p_note: note,
  });
  return { data, error };
}

/** The signed-in employee's own salary row (or null). */
export async function fetchMySalary(profileId) {
  const { data, error } = await supabase.from('employee_salaries').select(SALARY_COLS).eq('profile_id', profileId).maybeSingle();
  return { data, error };
}

/**
 * Everything HR needs to see an employee's pay over time:
 *   revisions  every salary change (newest first)
 *   months     pay per month: two-run months from payroll_part_runs (each
 *              part, with HR's sheet extras), processed months from payslips
 *   advances   advances with their repayments
 */
export async function fetchSalaryHistory(tenantId, profileId) {
  const [rev, runs, slips, advs] = await Promise.all([
    supabase.from('employee_salary_history')
      .select('id, gross, ctc, actual_gross, gross_advance, prev_gross, prev_ctc, prev_actual_gross, effective_from, source, note, changed_at, changer:profiles!employee_salary_history_changed_by_fkey(first_name, last_name)')
      .eq('profile_id', profileId).order('changed_at', { ascending: false }),
    supabase.from('payroll_part_runs').select('year, month, part, from_date, to_date, pf_rule, lines').eq('tenant_id', tenantId)
      .order('year', { ascending: false }).order('month', { ascending: false }).order('part'),
    supabase.from('payslips').select('id, work_days, total_work_days, gross_earnings, total_deductions, net_pay, breakdown, payrolls!inner(month, year, released_at)')
      .eq('profile_id', profileId),
    supabase.from('advances').select('id, type, amount, emi, paid, balance, status, remarks, created_at, advance_repayments(amount, month, year)')
      .eq('profile_id', profileId).order('created_at', { ascending: false }),
  ]);
  const error = rev.error || runs.error || slips.error || advs.error;
  const parts = (runs.data || []).flatMap((r) => {
    const line = (r.lines || []).find((l) => l.profileId === profileId);
    return line ? [{ ...line, year: r.year, month: r.month, part: r.part, fromDate: r.from_date, toDate: r.to_date }] : [];
  });
  return {
    data: { revisions: rev.data || [], parts, payslips: slips.data || [], advances: advs.data || [] },
    error,
  };
}
