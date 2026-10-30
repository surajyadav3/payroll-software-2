import { supabase } from '@/lib/supabase';

// Legacy KRA table, still written by the mobile app. The web Performance
// screen (src/crew/pages/performance) has its own goals and KPIs; this read
// only feeds the dashboard's recent-activity list.

/** List KRAs visible to the caller: their own, company-wide, or (for admin/manager) everyone's. */
export async function listKras(tenantId, { profileId = null } = {}) {
  let q = supabase
    .from('kras')
    .select('*, profile:profile_directory!kras_profile_id_fkey(first_name, middle_name, last_name, department), kra_kpis(*)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (profileId) q = q.or(`profile_id.eq.${profileId},profile_id.is.null`);
  const { data, error } = await q;
  return { data: data || [], error };
}
