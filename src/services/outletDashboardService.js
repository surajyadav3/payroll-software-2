import { supabase } from '@/lib/supabase';
import { listOutlets } from './tenantService';
import { todayStr, STAFF_ROLES } from '@/lib/helpers';

/**
 * Per-outlet stats for the current tenant — the single-tenant equivalent of
 * groupService.fetchGroupDashboard, which aggregates across *separate*
 * tenants in a group. Here everything stays inside one tenant's RLS scope
 * (the caller already has full tenant-wide read access as admin/superadmin),
 * so this is plain client-side aggregation instead of a SECURITY DEFINER RPC.
 *
 * Attendance/leave rows don't carry outlet_id directly (only profiles do),
 * so counts are built by mapping profile_id -> outlet_id rather than relying
 * on an embedded join.
 */
export async function fetchOutletsOverview(tenantId) {
  const today = todayStr();

  const [outletsRes, employeesRes, attendanceRes, leavesRes] = await Promise.all([
    listOutlets(tenantId),
    supabase
      .from('profiles')
      .select('id, outlet_id')
      .eq('tenant_id', tenantId)
      .in('role', STAFF_ROLES)
      .eq('status', 'Active'),
    supabase
      .from('attendance')
      .select('profile_id, status')
      .eq('tenant_id', tenantId)
      .eq('date', today),
    supabase
      .from('leave_requests')
      .select('profile_id')
      .eq('tenant_id', tenantId)
      .eq('status', 'Pending'),
  ]);

  const error = outletsRes.error || employeesRes.error || attendanceRes.error || leavesRes.error;

  const outlets = outletsRes.data || [];
  const employees = employeesRes.data || [];
  const attendance = attendanceRes.data || [];
  const leaves = leavesRes.data || [];

  const outletIdByProfile = new Map(employees.map((e) => [e.id, e.outlet_id || null]));

  const blank = () => ({
    employee_count: 0, present_today: 0, late_today: 0, absent_today: 0,
    half_day_today: 0, on_leave_today: 0, on_duty_today: 0, review_today: 0, pending_leaves: 0,
  });
  const statsByOutlet = new Map(outlets.map((o) => [o.id, blank()]));
  statsByOutlet.set(null, blank()); // unassigned bucket

  employees.forEach((e) => {
    const key = statsByOutlet.has(e.outlet_id) ? e.outlet_id : null;
    statsByOutlet.get(key).employee_count++;
  });

  attendance.forEach((a) => {
    const outletId = outletIdByProfile.has(a.profile_id) ? outletIdByProfile.get(a.profile_id) : undefined;
    if (outletId === undefined) return; // attendance row for someone not active/employee — ignore
    const key = statsByOutlet.has(outletId) ? outletId : null;
    const s = statsByOutlet.get(key);
    if (a.status === 'Present' || a.status === 'Late') s.present_today++;
    if (a.status === 'Late') s.late_today++;
    if (a.status === 'Absent') s.absent_today++;
    if (a.status === 'Half Day') s.half_day_today++;
    if (a.status === 'Leave' || a.status === 'Comp Off') s.on_leave_today++;
    if (a.status === 'Travel' || a.status === 'Show Visit') s.on_duty_today++; // worked, off-site
    if (a.status === 'Mispunch' || a.status === 'Pending Approval') s.review_today++; // needs HR/manager action
  });

  leaves.forEach((l) => {
    const outletId = outletIdByProfile.has(l.profile_id) ? outletIdByProfile.get(l.profile_id) : undefined;
    if (outletId === undefined) return;
    const key = statsByOutlet.has(outletId) ? outletId : null;
    statsByOutlet.get(key).pending_leaves++;
  });

  const rows = outlets.map((o) => ({ id: o.id, name: o.name, address: o.address, city: o.city, ...statsByOutlet.get(o.id) }));

  const unassigned = statsByOutlet.get(null);
  if (unassigned.employee_count > 0) {
    rows.push({ id: null, name: 'Unassigned', address: '', city: '', ...unassigned });
  }

  return { data: rows, error };
}
