import { supabase } from '@/lib/supabase';
import { dateStr } from '@/lib/helpers';

const DIRECTORY_COLS = 'id, first_name, middle_name, last_name, employee_id, role, status, department, designation, division, manager_id, hod_id, outlet_id, outlet_location';

/**
 * Everyone below `rootId` in the manager_id tree (any depth), plus anyone
 * whose hod_id is `rootId` and their trees, from an already-loaded
 * directory — the same set the DB's my_team_ids() returns, so the list here
 * matches what RLS lets a Raniwala manager/HOD read.
 */
export function collectTeam(directory, rootId) {
  const byManager = new Map();
  directory.forEach((p) => {
    if (!p.manager_id) return;
    if (!byManager.has(p.manager_id)) byManager.set(p.manager_id, []);
    byManager.get(p.manager_id).push(p);
  });
  const seen = new Set([rootId]);
  const out = [];
  const queue = [...(byManager.get(rootId) || []), ...directory.filter((p) => p.hod_id === rootId)];
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
    queue.push(...(byManager.get(p.id) || []));
  }
  return out;
}

/**
 * First ancestor of `profileId` with the given role (e.g. the HOD above a
 * manager). For 'hod', an explicitly assigned hod_id wins over the chain.
 */
export function findAncestorWithRole(directory, profileId, role) {
  const byId = new Map(directory.map((p) => [p.id, p]));
  const explicit = role === 'hod' ? byId.get(byId.get(profileId)?.hod_id) : null;
  if (explicit?.role === 'hod') return explicit;
  let cur = byId.get(byId.get(profileId)?.manager_id);
  for (let i = 0; cur && i < 8; i++) {
    if (cur.role === role) return cur;
    cur = byId.get(cur.manager_id);
  }
  return null;
}

// PostgREST caps a response at 1000 rows; a big department's month of
// attendance (100+ people x 30 days) is well past that, so page through it.
async function fetchAllPages(build, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) return { data: rows, error };
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return { data: rows, error: null };
  }
}

/**
 * Everything the My Team page needs for one month, in one round of parallel
 * queries: the team (from the directory), their contact details, the month's
 * attendance, leaves (approved + pending, so upcoming leave shows before it's
 * approved), approved WFH, holidays and outlets (for weekly offs and the
 * outlets that observe no holidays). RLS
 * scopes every table to the caller's team at Raniwala.
 */
export async function fetchTeamMonth(tenantId, meId, year, month) {
  const { data: directory, error: dirErr } = await supabase
    .from('profile_directory')
    .select(DIRECTORY_COLS)
    .eq('tenant_id', tenantId);
  if (dirErr) return { error: dirErr };

  const team = collectTeam(directory || [], meId).filter((p) => p.status === 'Active');
  const ids = team.map((p) => p.id);
  const first = dateStr(new Date(year, month, 1));
  const last = dateStr(new Date(year, month + 1, 0));

  if (ids.length === 0) {
    return { directory: directory || [], team: [], details: [], attendance: [], leaves: [], wfh: [], holidays: [], outlets: [], error: null };
  }

  const [details, attendance, leaves, wfh, holidays, outlets] = await Promise.all([
    supabase.from('profiles').select('id, phone, join_date, weekly_holiday').in('id', ids),
    fetchAllPages(() => supabase.from('attendance').select('profile_id, date, status')
      .in('profile_id', ids).gte('date', first).lte('date', last).order('date')),
    supabase.from('leave_requests')
      .select('id, profile_id, leave_type, start_date, end_date, status, current_stage, duration_days, half_day, half_day_from, half_day_to')
      .in('profile_id', ids).in('status', ['Pending', 'Approved'])
      .lte('start_date', last)
      .gte('end_date', first),
    supabase.from('wfh_requests').select('profile_id, from_date, to_date').in('profile_id', ids).eq('status', 'Approved')
      .lte('from_date', last).gte('to_date', first),
    supabase.from('holidays').select('date, name, outlet_id').eq('tenant_id', tenantId).gte('date', first).lte('date', last),
    supabase.from('outlets').select('id, name, weekly_off_days, weekly_off_per_employee, holidays_enabled').eq('tenant_id', tenantId),
  ]);

  return {
    directory: directory || [],
    team,
    details: details.data || [],
    attendance: attendance.data || [],
    leaves: leaves.data || [],
    wfh: wfh.data || [],
    holidays: holidays.data || [],
    outlets: outlets.data || [],
    error: details.error || attendance.error || leaves.error || wfh.error || holidays.error || outlets.error,
  };
}

/** Upcoming (today onwards) approved or pending leave for the team, soonest first. */
export async function fetchTeamUpcomingLeaves(teamIds, days = 45) {
  if (!teamIds.length) return { data: [], error: null };
  const today = new Date();
  const until = new Date(today);
  until.setDate(until.getDate() + days);
  const { data, error } = await supabase
    .from('leave_requests')
    .select('id, profile_id, leave_type, start_date, end_date, status, current_stage, duration_days, short_notice')
    .in('profile_id', teamIds)
    .in('status', ['Pending', 'Approved'])
    .gte('end_date', dateStr(today))
    .lte('start_date', dateStr(until))
    .order('start_date', { ascending: true });
  return { data: data || [], error };
}
