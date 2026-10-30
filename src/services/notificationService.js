import { supabase } from '@/lib/supabase';
import { fullName } from '@/lib/helpers';

// Birthday / work-anniversary notifications are a same-day visual: show them
// only on their own day (IST). The DB also deletes them after midnight
// (purge_past_celebrations); this keeps the bell right in between.
const istDayStartIso = () => {
  const ist = new Date(Date.now() + 330 * 60000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 330 * 60000).toISOString();
};
const hidePastCelebrations = (q) =>
  q.or(`created_at.gte.${istDayStartIso()},and(type.not.ilike.birthday*,type.not.ilike.*anniversar*)`);

/** Latest notifications for one user, newest first. */
export async function listMyNotifications(profileId, limit = 50) {
  const { data, error } = await hidePastCelebrations(supabase
    .from('app_notifications')
    .select('*')
    .eq('profile_id', profileId))
    .order('created_at', { ascending: false })
    .limit(limit);
  return { data: data || [], error };
}

export async function countUnread(profileId) {
  const { count, error } = await hidePastCelebrations(supabase
    .from('app_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', profileId))
    .eq('is_read', false);
  return { count: count || 0, error };
}

export async function markRead(id) {
  const { error } = await supabase
    .from('app_notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('id', id);
  return { error };
}

export async function markAllRead(profileId) {
  const { error } = await supabase
    .from('app_notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('profile_id', profileId)
    .eq('is_read', false);
  return { error };
}

/**
 * Bulk-inserts one notification row per recipient. Never throws — a failed
 * notification shouldn't undo or block the action that triggered it, so
 * callers just `await` this as a fire-and-forget last step (same non-fatal
 * style as the record_leave_deduction RPC call in leaveService.js).
 */
export async function notifyProfiles(tenantId, profileIds, { type, title, body = '', linkKey = null, actorId = null, relatedId = null }) {
  const ids = [...new Set((profileIds || []).filter(Boolean))];
  if (!tenantId || ids.length === 0 || !type || !title) return;

  const rows = ids.map((profile_id) => ({
    tenant_id: tenantId,
    profile_id,
    actor_id: actorId,
    type,
    title,
    body,
    link_key: linkKey,
    related_id: relatedId,
  }));

  const { error } = await supabase.from('app_notifications').insert(rows);
  if (error) console.error('notifyProfiles failed:', error.message);
}

/** Notifies every profile in the tenant with one of the given roles. */
export async function notifyRoles(tenantId, roles, opts, excludeProfileId = null) {
  if (!tenantId || !roles?.length) return;

  // profile_directory, not profiles: employees can only read their own profiles row.
  let query = supabase.from('profile_directory').select('id').eq('tenant_id', tenantId).in('role', roles);
  if (excludeProfileId) query = query.neq('id', excludeProfileId);

  const { data, error } = await query;
  if (error) { console.error('notifyRoles failed to resolve recipients:', error.message); return; }

  await notifyProfiles(tenantId, (data || []).map((p) => p.id), opts);
}

/**
 * Roles a request-submission notification should always reach, regardless
 * of whichever self/manager quota tier ends up deciding who actually
 * approves it (see requestQuotaService.determineApproverRole) — HR should
 * always be told a request came in, not just whoever the tier happens to
 * route the approval step to.
 */
export const withHrRole = (roles) => [...new Set([...(roles || []), 'admin'])];

/**
 * "Full Name (Outlet)" label for a notification body — or just the name if
 * the employee has no outlet assigned — so a leave/WFH/regularize/special-
 * request notification tells the reviewer who sent it and from where
 * without them having to open it first.
 */
export async function getRequesterLabel(profileId) {
  const { data } = await supabase
    .from('profile_directory')
    .select('first_name, middle_name, last_name, outlet_location')
    .eq('id', profileId)
    .maybeSingle();
  if (!data) return '';
  const name = fullName(data);
  return data.outlet_location ? `${name} (${data.outlet_location})` : name;
}

/** Notifies every profile in the tenant, regardless of role. */
export async function notifyTenant(tenantId, opts, excludeProfileId = null) {
  if (!tenantId) return;

  let query = supabase.from('profile_directory').select('id').eq('tenant_id', tenantId);
  if (excludeProfileId) query = query.neq('id', excludeProfileId);

  const { data, error } = await query;
  if (error) { console.error('notifyTenant failed to resolve recipients:', error.message); return; }

  await notifyProfiles(tenantId, (data || []).map((p) => p.id), opts);
}
