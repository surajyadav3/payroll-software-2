import { supabase } from '@/lib/supabase';

// employee_payroll_settings: what HR decides per employee for payroll —
// father's name, probation completion date, retention rate, monthly TDS and
// whether PF / ESIC apply (see 20261010_7_raniwala_payroll_structure.sql).
// An employee with no row is on the defaults.

/** Every employee's payroll settings for a tenant, as `{ [profile_id]: row }`. */
export async function fetchPayrollSettings(tenantId) {
  const { data, error } = await supabase
    .from('employee_payroll_settings')
    .select('profile_id, father_name, probation_end_date, retention_percent, tds_monthly, pf_applicable, esic_applicable')
    .eq('tenant_id', tenantId);
  return { data: Object.fromEntries((data || []).map((r) => [r.profile_id, r])), error };
}

/**
 * Save part of one employee's payroll settings; fields left out of `patch`
 * keep their value. Returns the saved row.
 */
export async function savePayrollSettings(tenantId, profileId, patch) {
  const row = { profile_id: profileId, tenant_id: tenantId };
  if ('father_name' in patch) row.father_name = String(patch.father_name || '').trim().toUpperCase();
  if ('probation_end_date' in patch) row.probation_end_date = patch.probation_end_date || null;
  if ('retention_percent' in patch) row.retention_percent = Number(patch.retention_percent) || 0;
  if ('tds_monthly' in patch) row.tds_monthly = Math.max(0, Number(patch.tds_monthly) || 0);
  if ('pf_applicable' in patch) row.pf_applicable = !!patch.pf_applicable;
  if ('esic_applicable' in patch) row.esic_applicable = !!patch.esic_applicable;

  const { data, error } = await supabase
    .from('employee_payroll_settings')
    .upsert(row, { onConflict: 'profile_id' })
    .select('profile_id, father_name, probation_end_date, retention_percent, tds_monthly, pf_applicable, esic_applicable')
    .single();
  return { data, error };
}
