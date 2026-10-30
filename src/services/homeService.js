import { supabase } from '@/lib/supabase';
import { dateStr } from '@/lib/helpers';
import { collectTeam } from './teamService';
import { myLeaveStage } from './leaveService';

// Data for the Home page. Every query is small and scoped: counts use
// head-only requests, lists select a handful of columns. RLS still decides
// what each person may read (a Raniwala manager / HOD only gets their team).

const isHr = (profile) => profile?.role === 'admin' || profile?.role === 'superadmin';

/** My attendance rows for the last `days` days (today included), oldest first. */
export async function fetchMyRecentDays(profileId, days = 7) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  const { data, error } = await supabase
    .from('attendance')
    .select('date, status, total_hours')
    .eq('profile_id', profileId)
    .gte('date', dateStr(from))
    .lte('date', dateStr(to))
    .order('date');
  return { data: data || [], error };
}

/**
 * Open (Pending) leave requests this person can read — RLS already limits a
 * Raniwala manager / HOD to their own team. Only the routing columns, so the
 * Home tiles can work out "waiting for me" without loading the requests.
 */
export async function fetchOpenLeaveQueue(tenantId) {
  const { data, error } = await supabase
    .from('leave_requests')
    .select('id, profile_id, status, current_stage, manager_id, hod_id, required_approver_role')
    .eq('tenant_id', tenantId)
    .eq('status', 'Pending');
  return { data: data || [], error };
}

/**
 * Of the open requests, the ones that are this person's to decide — the same
 * rule as the Leave page's buttons. Staged (Raniwala) requests: only the
 * stage's own manager / HOD, or Management at theirs (myLeaveStage). Older
 * single-step requests routed to managers: only when the employee is in this
 * person's team, so one manager never counts another team's leave.
 */
export function leavesWaitingFor(queue, profile, teamIds) {
  return queue.filter((r) => (r.current_stage
    ? myLeaveStage(r, profile)
    : r.required_approver_role === 'manager' && teamIds.has(r.profile_id)));
}

/** My own requests still pending, split by kind (leave, regularize). */
export async function countMyPendingRequests(profileId) {
  const [leave, reg] = await Promise.all([
    supabase.from('leave_requests').select('id', { count: 'exact', head: true }).eq('profile_id', profileId).eq('status', 'Pending'),
    supabase.from('regularize_requests').select('id', { count: 'exact', head: true }).eq('profile_id', profileId).eq('status', 'Pending'),
  ]);
  return { leave: leave.count || 0, regularize: reg.count || 0, error: leave.error || reg.error };
}

/**
 * Ids of the people this person looks after: everyone under them by
 * manager_id / hod_id (same set as the DB's my_team_ids()), or — for HR —
 * the whole active company, narrowed to the selected outlet when one is set.
 */
export async function fetchMyPeople(tenantId, profile, outletProfileIds = null) {
  const { data, error } = await supabase
    .from('profile_directory')
    .select('id, first_name, middle_name, last_name, status, manager_id, hod_id, designation, department')
    .eq('tenant_id', tenantId)
    .eq('status', 'Active');
  if (error) return { data: [], error };
  let people = isHr(profile) ? (data || []).filter((p) => p.id !== profile.id) : collectTeam(data || [], profile.id);
  if (isHr(profile) && outletProfileIds) people = people.filter((p) => outletProfileIds.has(p.id));
  return { data: people, error: null };
}

/** Today's attendance status per person, for the given ids. */
export async function fetchStatusToday(ids) {
  if (!ids.length) return { data: [], error: null };
  const today = dateStr(new Date());
  const rows = [];
  // Chunked so a large company never builds an over-long URL.
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await supabase
      .from('attendance')
      .select('profile_id, status')
      .eq('date', today)
      .in('profile_id', ids.slice(i, i + 300));
    if (error) return { data: rows, error };
    rows.push(...(data || []));
  }
  return { data: rows, error: null };
}

/** Approved leave and WFH covering today, for the given ids. */
export async function fetchOutToday(ids) {
  if (!ids.length) return { leave: [], wfh: [], error: null };
  const today = dateStr(new Date());
  const leave = [];
  const wfh = [];
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const [l, w] = await Promise.all([
      supabase.from('leave_requests').select('id, profile_id, leave_type, start_date, end_date')
        .in('profile_id', chunk).eq('status', 'Approved').lte('start_date', today).gte('end_date', today),
      supabase.from('wfh_requests').select('id, profile_id, from_date, to_date')
        .in('profile_id', chunk).eq('status', 'Approved').lte('from_date', today).gte('to_date', today),
    ]);
    if (l.error || w.error) return { leave, wfh, error: l.error || w.error };
    leave.push(...(l.data || []));
    wfh.push(...(w.data || []));
  }
  return { leave, wfh, error: null };
}
