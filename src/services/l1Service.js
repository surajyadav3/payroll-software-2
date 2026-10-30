import { supabase } from '@/lib/supabase';
import { dateStr } from '@/lib/helpers';

/**
 * L1 SPOC — a colleague HR names to use CrewCore for employees who can't
 * (migration 20261024_1_l1_spoc_acts_for_employees). The L1 sees their
 * people's attendance / leave / balances and files leave + regularize
 * requests for them. They are not an approver: a request they file routes to
 * the employee's own manager / HOD / HR exactly as if the employee sent it.
 * Same calls as the app's services/l1Service.ts.
 */

// The sidebar asks on every page; the list only changes when HR reassigns people.
const CACHE_MS = 5 * 60 * 1000;
let cache = null; // { userId, at, data }

/** The employees the signed-in user is L1 for (empty for almost everyone). */
export async function fetchMyL1Members(userId, force = false) {
  if (!force && cache && cache.userId === userId && Date.now() - cache.at < CACHE_MS) {
    return { data: cache.data, error: null };
  }
  const { data, error } = await supabase.rpc('my_l1_members');
  if (!error) cache = { userId, at: Date.now(), data: data || [] };
  return { data: data || [], error };
}

/** The member's shift halves, for the half-day choice on the leave form. */
export async function fetchMemberHalfDayWindows(memberId) {
  const { data, error } = await supabase.rpc('l1_member_half_day_windows', { p_employee: memberId });
  return { data: data || null, error };
}

/** Leave filed by the L1 — returns the inserted row, as the employee's own insert would. */
export async function l1RequestLeave({ profile_id, leave_type, start_date, end_date, half_day, reason }) {
  const { data, error } = await supabase.rpc('l1_request_leave', {
    p_employee: profile_id,
    p_leave_type: leave_type,
    p_start_date: start_date,
    p_end_date: end_date,
    p_half_day: half_day || null,
    p_reason: reason,
  });
  return { data: (Array.isArray(data) ? data[0] : data) || null, error };
}

/** Regularization filed by the L1 — the DB applies the regularize window and tier as for the employee. */
export async function l1RequestRegularize({ profile_id, date, clockInTime, clockOutTime, reason }) {
  const { data, error } = await supabase.rpc('l1_request_regularize', {
    p_employee: profile_id,
    p_date: date,
    p_clock_in: clockInTime,
    p_clock_out: clockOutTime,
    p_reason: reason,
  });
  return { data: (Array.isArray(data) ? data[0] : data) || null, error };
}

/**
 * Attendance (with punches), approved + pending leave, approved WFH,
 * holidays and outlets for the L1's people between two dates. RLS lets the L1
 * read only their own people's rows ("… l1 sees own people" policies).
 */
export async function fetchL1Days(tenantId, memberIds, first, last) {
  if (!memberIds.length) {
    return { attendance: [], leaves: [], wfh: [], holidays: [], outlets: [], error: null };
  }
  const [attendance, leaves, wfh, holidays, outlets] = await Promise.all([
    supabase.from('attendance').select('profile_id, date, status, total_hours, punches(punch_time, punch_type, next_day)')
      .in('profile_id', memberIds).gte('date', first).lte('date', last).order('date'),
    supabase.from('leave_requests')
      .select('id, profile_id, leave_type, start_date, end_date, status, half_day, half_day_from, half_day_to')
      .in('profile_id', memberIds).in('status', ['Pending', 'Approved'])
      .lte('start_date', last).gte('end_date', first),
    supabase.from('wfh_requests').select('profile_id, from_date, to_date')
      .in('profile_id', memberIds).eq('status', 'Approved').lte('from_date', last).gte('to_date', first),
    supabase.from('holidays').select('date, name, outlet_id').eq('tenant_id', tenantId).gte('date', first).lte('date', last),
    supabase.from('outlets').select('id, name, weekly_off_days, weekly_off_per_employee, holidays_enabled').eq('tenant_id', tenantId),
  ]);
  return {
    attendance: attendance.data || [],
    leaves: leaves.data || [],
    wfh: wfh.data || [],
    holidays: holidays.data || [],
    outlets: outlets.data || [],
    error: attendance.error || leaves.error || wfh.error || holidays.error || outlets.error,
  };
}

/** One calendar month of fetchL1Days for one member. */
export function fetchL1MemberMonth(tenantId, memberId, year, month) {
  return fetchL1Days(tenantId, [memberId], dateStr(new Date(year, month, 1)), dateStr(new Date(year, month + 1, 0)));
}

// ── HR side: who is whose L1 ──────────────────────────────────────────────

/**
 * Every active employee who has an L1, plus each L1's own row (an L1 may
 * have left — HR then sees them marked Inactive and moves their people).
 */
export async function listL1Assignments(tenantId) {
  const { data: members, error } = await supabase
    .from('profiles')
    .select('id, first_name, middle_name, last_name, employee_id, department, designation, outlet_location, l1_spoc_id')
    .eq('tenant_id', tenantId)
    .not('l1_spoc_id', 'is', null)
    .eq('status', 'Active')
    .order('first_name');
  if (error) return { members: [], l1s: [], error };
  const l1Ids = [...new Set((members || []).map((m) => m.l1_spoc_id))];
  if (!l1Ids.length) return { members: [], l1s: [], error: null };
  const { data: l1s, error: l1Err } = await supabase
    .from('profiles')
    .select('id, first_name, middle_name, last_name, employee_id, department, designation, outlet_location, status')
    .in('id', l1Ids)
    .order('first_name');
  return { members: members || [], l1s: l1s || [], error: l1Err };
}

/** Sets (or clears, with null) an employee's L1. HR only — trg_profiles_l1_spoc_guard. */
export async function setEmployeeL1(employeeIds, l1Id) {
  const ids = Array.isArray(employeeIds) ? employeeIds : [employeeIds];
  const { error } = await supabase.from('profiles').update({ l1_spoc_id: l1Id || null }).in('id', ids);
  return { error };
}
