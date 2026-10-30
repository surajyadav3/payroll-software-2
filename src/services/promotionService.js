import { supabase } from '@/lib/supabase';
import { setEmployeeSalary } from '@/services/employeeSalaryService';

/** List all promotions for an employee. */
export async function listEmployeePromotions(profileId) {
  const { data, error } = await supabase
    .from('employee_promotions')
    .select('*, created_by_profile:profile_directory!employee_promotions_created_by_fkey(first_name, middle_name, last_name)')
    .eq('profile_id', profileId)
    .order('effective_date', { ascending: false });
  return { data: data || [], error };
}

/**
 * Record a promotion/increment.
 * Also updates the employee's current designation and CTC.
 *
 * Salary-private tenant (Raniwala, 20261014_4): the salary lives in
 * employee_salaries, so gross and CTC are set there (with its history) and
 * both pairs go on the promotion row (20261024_7). profiles.ctc is never
 * written: profiles_salary_to_private would take it as the gross.
 */
export async function recordPromotion(tenantId, profileId, {
  effectiveDate, oldDesignation, newDesignation, oldCtc, newCtc, oldGross, newGross, notes, createdBy,
  salaryPrivate = false,
}) {
  if (salaryPrivate && (newGross || newCtc)) {
    const { error: salErr } = await setEmployeeSalary({
      profileId,
      gross: newGross || null,
      ctc: newCtc || null,
      effectiveFrom: effectiveDate || null,
      source: 'increment',
      note: notes || null,
    });
    if (salErr) return { error: salErr };
  }

  const { error: histErr } = await supabase
    .from('employee_promotions')
    .insert([{
      tenant_id:       tenantId,
      profile_id:      profileId,
      effective_date:  effectiveDate,
      old_designation: oldDesignation || null,
      new_designation: newDesignation || null,
      old_ctc:         oldCtc  || null,
      new_ctc:         newCtc  || null,
      ...(salaryPrivate ? { old_gross: oldGross || null, new_gross: newGross || null } : {}),
      notes:           notes   || null,
      created_by:      createdBy,
    }]);
  if (histErr) return { error: histErr };

  const updates = {};
  if (newDesignation) updates.designation = newDesignation;
  if (newCtc && !salaryPrivate) updates.ctc = newCtc;

  if (Object.keys(updates).length > 0) {
    const { error: profErr } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', profileId);
    if (profErr) return { error: profErr };
  }

  return { error: null };
}
