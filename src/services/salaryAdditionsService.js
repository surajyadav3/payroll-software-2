import { supabase } from '@/lib/supabase';

/** All one-off/recurring pay items for a tenant (arrears, incentives, retention bonus, encashment, gratuity payout, ...). */
export async function listSalaryAdditions(tenantId) {
  const { data, error } = await supabase
    .from('salary_additions')
    .select('*, profile:profile_directory!salary_additions_profile_id_fkey(first_name, middle_name, last_name, department)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

/**
 * Pending (unpaid) items due in a specific payroll month/year — this is what
 * processPayroll folds into each employee's earnings/deductions, same way it
 * already folds `advances`.
 */
export async function fetchPendingSalaryAdditions(tenantId, month, year) {
  const { data, error } = await supabase
    .from('salary_additions')
    .select('*')
    .eq('tenant_id', tenantId)
    .in('status', ['Pending', 'Approved'])
    .eq('effective_month', month)
    .eq('effective_year', year);
  return { data: data || [], error };
}

export async function createSalaryAddition(tenantId, createdBy, payload) {
  const { error } = await supabase.from('salary_additions').insert([{
    tenant_id: tenantId,
    profile_id: payload.profile_id,
    component_name: payload.component_name.trim(),
    category: payload.category,
    amount: parseFloat(payload.amount) || 0,
    is_recurring: !!payload.is_recurring,
    effective_month: parseInt(payload.effective_month),
    effective_year: parseInt(payload.effective_year),
    reason: payload.reason || '',
    status: 'Approved',
    created_by: createdBy,
  }]);
  return { error };
}

export async function updateSalaryAdditionStatus(id, status) {
  const { error } = await supabase.from('salary_additions').update({ status }).eq('id', id);
  return { error };
}

export async function deleteSalaryAddition(id) {
  const { error } = await supabase.from('salary_additions').delete().eq('id', id);
  return { error };
}

/** The pay items with one name due in a payroll month (e.g. every "PF Difference (Sep 2026)"). */
export async function listSalaryAdditionsNamed(tenantId, componentName, month, year) {
  const { data, error } = await supabase
    .from('salary_additions')
    .select('id, profile_id, amount, status, reason, created_at')
    .eq('tenant_id', tenantId)
    .eq('component_name', componentName)
    .eq('effective_month', month)
    .eq('effective_year', year);
  return { data: data || [], error };
}

/**
 * Many pay items in one request — `items` = [{ profile_id, amount }], all with
 * the same name, category, month and reason. Approved, like a pay item HR adds
 * by hand, so the payroll run for that month folds them in.
 */
export async function createSalaryAdditions(tenantId, createdBy, { component_name, category, effective_month, effective_year, reason = '' }, items) {
  if (!items.length) return { error: null };
  const { error } = await supabase.from('salary_additions').insert(items.map((i) => ({
    tenant_id: tenantId,
    profile_id: i.profile_id,
    component_name,
    category,
    amount: i.amount,
    is_recurring: false,
    effective_month,
    effective_year,
    reason,
    status: 'Approved',
    created_by: createdBy,
  })));
  return { error };
}
