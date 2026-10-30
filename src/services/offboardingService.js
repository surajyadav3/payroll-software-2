import { supabase } from '@/lib/supabase';
import { STAFF_ROLES, todayStr } from '@/lib/helpers';
import { notifyProfiles } from './notificationService';

// ── Checklist library ───────────────────────────────────────────────────────
export async function listChecklistItems(tenantId) {
  const { data, error } = await supabase.from('offboarding_checklist_items').select('*').eq('tenant_id', tenantId).order('sort_order').order('created_at');
  return { data: data || [], error };
}
export async function createChecklistItem(tenantId, payload) {
  const { error } = await supabase.from('offboarding_checklist_items').insert([{
    tenant_id: tenantId, title: payload.title.trim(), description: payload.description || '', category: payload.category || 'General',
  }]);
  return { error };
}
export async function deleteChecklistItem(id) {
  const { error } = await supabase.from('offboarding_checklist_items').delete().eq('id', id);
  return { error };
}

// ── Processes ────────────────────────────────────────────────────────────
export async function listProcesses(tenantId) {
  const { data, error } = await supabase
    .from('offboarding_processes')
    .select('*, profile:profile_directory!offboarding_processes_profile_id_fkey(first_name, middle_name, last_name, department), tasks:offboarding_process_tasks(id, title, category, status)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

/** An employee's own offboarding process (most recent), with its tasks. */
export async function fetchMyProcess(profileId) {
  const { data, error } = await supabase
    .from('offboarding_processes')
    .select('*, tasks:offboarding_process_tasks(*)')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return { data: data || null, error };
}

/**
 * Where an offboarding stands against its exit date (the employee's last
 * day): days left while In Progress, 0 on the last day. The DB sets the
 * status itself (trigger + daily job, migration 20261024_4): In Progress
 * until the exit date, Completed — and the employee Inactive — the day after.
 */
export function exitCountdown(process) {
  if (process.status !== 'In Progress' || !process.exit_date) return null;
  const days = Math.round((new Date(process.exit_date) - new Date(todayStr())) / 86400000);
  if (days <= 0) return 'Last day today';
  return days === 1 ? '1 day left' : `${days} days left`;
}

/** Starts a new offboarding process for an exiting employee, copying the current checklist library into editable tasks. */
export async function startProcess(tenantId, profileId, payload, createdBy) {
  const { data: process, error } = await supabase.from('offboarding_processes').insert([{
    tenant_id: tenantId, profile_id: profileId, reason: payload.reason || '',
    applied_on: payload.applied_on || todayStr(),
    exit_date: payload.exit_date || todayStr(),
    notes: payload.notes || '', created_by: createdBy,
  }]).select('id').single();
  if (error) return { error };

  const { data: items } = await listChecklistItems(tenantId);
  if (items.length > 0) {
    const rows = items.map((item) => ({
      tenant_id: tenantId, process_id: process.id, title: item.title, description: item.description,
      category: item.category, sort_order: item.sort_order, assigned_to: profileId,
    }));
    const { error: tasksError } = await supabase.from('offboarding_process_tasks').insert(rows);
    if (tasksError) return { error: tasksError };
  }

  await notifyProfiles(tenantId, [profileId], {
    type: 'offboarding_started',
    title: 'Offboarding checklist started',
    body: 'Your exit checklist is ready — take a look at your remaining tasks.',
    linkKey: 'my-offboarding',
    relatedId: process.id,
  });

  return { error: null };
}

export async function updateProcess(id, payload) {
  const req = payload.status
    ? (await supabase.from('offboarding_processes').select('tenant_id, profile_id').eq('id', id).single()).data
    : null;

  // The DB may settle on a different status than asked (it follows the exit date).
  const { data, error } = await supabase.from('offboarding_processes').update(payload).eq('id', id).select('status').single();
  const status = data?.status || payload.status;

  if (!error && req?.tenant_id && req?.profile_id) {
    await notifyProfiles(req.tenant_id, [req.profile_id], {
      type: `offboarding_${status.toLowerCase().replace(/\s+/g, '_')}`,
      title: `Offboarding ${status}`,
      body: `Your offboarding status was updated to ${status}.`,
      linkKey: 'my-offboarding',
      relatedId: id,
    });
  }
  return { error };
}

export async function updateTaskStatus(id, status) {
  const { error } = await supabase.from('offboarding_process_tasks').update({
    status, completed_at: status === 'Done' ? new Date().toISOString() : null,
  }).eq('id', id);
  return { error };
}

/**
 * Monthly joiners/leavers for the last `months` calendar months (oldest
 * first), plus turnover % = leavers / average headcount that month. An exit
 * is a non-cancelled offboarding process, dated by last_working_day (falling
 * back to exit_date). Pass `profileIds` (a Set) to scope to an outlet.
 * Two narrow selects — only ids and dates, no joins.
 */
export async function fetchTurnoverTrend(tenantId, months = 6, profileIds = null) {
  const [profRes, offRes] = await Promise.all([
    supabase.from('profiles').select('id, join_date, status').eq('tenant_id', tenantId).in('role', STAFF_ROLES),
    supabase.from('offboarding_processes').select('profile_id, exit_date, last_working_day, status').eq('tenant_id', tenantId).neq('status', 'Cancelled'),
  ]);
  const inScope = (id) => !profileIds || profileIds.has(id);
  const profiles = (profRes.data || []).filter((p) => inScope(p.id));
  const exitOn = {};
  (offRes.data || []).forEach((o) => {
    if (!inScope(o.profile_id)) return;
    const d = o.last_working_day || o.exit_date;
    if (d && (!exitOn[o.profile_id] || d > exitOn[o.profile_id])) exitOn[o.profile_id] = d;
  });

  // Headcount on a date: joined by then and not yet exited. Inactive
  // profiles with no offboarding record have no known exit date, so they're
  // left out rather than guessed at.
  const headcountOn = (day) => profiles.filter((p) => {
    if (!p.join_date || p.join_date > day) return false;
    const ex = exitOn[p.id];
    if (ex) return ex >= day;
    return p.status === 'Active';
  }).length;

  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const trend = [];
  for (let i = months - 1; i >= 0; i--) {
    const y = new Date(now.getFullYear(), now.getMonth() - i, 1).getFullYear();
    const m = new Date(now.getFullYear(), now.getMonth() - i, 1).getMonth();
    const start = `${y}-${pad(m + 1)}-01`;
    const end = `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`;
    const leavers = Object.values(exitOn).filter((d) => d >= start && d <= end).length;
    const joiners = profiles.filter((p) => p.join_date && p.join_date >= start && p.join_date <= end).length;
    const avgHead = (headcountOn(start) + headcountOn(end)) / 2;
    trend.push({
      label: new Date(y, m, 1).toLocaleDateString('en-IN', { month: 'short' }),
      leavers,
      joiners,
      rate: avgHead > 0 ? Math.round((leavers / avgHead) * 1000) / 10 : 0,
    });
  }
  return { data: trend, error: profRes.error || offRes.error };
}
