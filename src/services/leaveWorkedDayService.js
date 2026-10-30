import { supabase } from '@/lib/supabase';

/**
 * Days an employee came in during their own approved leave (20261024_6).
 * The DB lists each one when the first punch lands and scores the day from
 * its punches; HR then gives the leave day back or keeps it as leave.
 * @param {'pending'|'approved'|'rejected'|'all'} status
 */
export async function listLeaveWorkedDays(status = 'pending') {
  const { data, error } = await supabase.rpc('list_leave_worked_days', { p_status: status });
  return { data: data || [], error };
}

/** HR: approve = leave day back to the balance; reject = the day stays leave. */
export async function decideLeaveWorkedDay(id, approve, note = '') {
  const { data, error } = await supabase.rpc('hr_decide_leave_worked_day', {
    p_id: id, p_approve: approve, p_note: note,
  });
  return { data, error };
}
