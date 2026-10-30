import { supabase } from '@/lib/supabase';

// ── Employee side ────────────────────────────────────────────────────────

/** Whether Live Tracking is currently switched on for this one employee. */
export async function getMyTrackingToggle(profileId) {
  const { data, error } = await supabase
    .from('employee_tracking_toggles')
    .select('enabled')
    .eq('employee_id', profileId)
    .maybeSingle();
  return { data: !!data?.enabled, error };
}

/** Writes one GPS fix for the currently-authenticated employee. */
export async function insertPing(tenantId, employeeId, outletId, lat, lng, accuracy, recordedDate) {
  const { error } = await supabase.from('employee_location_pings').insert([{
    tenant_id: tenantId,
    employee_id: employeeId,
    outlet_id: outletId || null,
    lat,
    lng,
    accuracy: accuracy ?? null,
    recorded_date: recordedDate,
  }]);
  return { error };
}

// ── Admin side ───────────────────────────────────────────────────────────

/**
 * Every active (non-superadmin) employee in the tenant, with their current
 * tracking on/off state and their most recent ping (for "last seen"). Two
 * queries instead of an embed — employee_last_ping is a view keyed on
 * employee_id only, not a declared FK, so PostgREST can't auto-embed it.
 */
// outlets(*) rather than a column list: the weekly-off columns differ between
// databases while migrations roll out (weekly_off_per_employee, 20261023_1), and
// naming one that isn't there yet fails the whole query and empties the page.
export async function listTenantEmployeesWithTrackingState(tenantId) {
  const [{ data: employees, error }, { data: toggles }, { data: lastPings }] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, first_name, middle_name, last_name, outlet_id, weekly_holiday, outlets(*)')
      .eq('tenant_id', tenantId)
      .eq('status', 'Active')
      .neq('role', 'superadmin')
      .order('first_name'),
    supabase.from('employee_tracking_toggles').select('employee_id, enabled').eq('tenant_id', tenantId),
    listLastPings(tenantId),
  ]);
  const toggleByEmployee = new Map((toggles || []).map((t) => [t.employee_id, t.enabled]));
  const lastPingByEmployee = new Map((lastPings || []).map((p) => [p.employee_id, p]));
  const merged = (employees || []).map((e) => ({
    ...e,
    tracking_enabled: toggleByEmployee.get(e.id) || false,
    last_ping: lastPingByEmployee.get(e.id) || null,
  }));
  return { data: merged, error };
}

/** Each employee's most recent position (employee_last_ping), for "last seen" / current location. */
export async function listLastPings(tenantId) {
  const { data, error } = await supabase
    .from('employee_last_ping')
    .select('employee_id, lat, lng, recorded_at')
    .eq('tenant_id', tenantId);
  return { data: data || [], error };
}

/** Turns Live Tracking on/off for one employee. */
export async function setEmployeeTracking(tenantId, employeeId, enabled, updatedBy) {
  const { error } = await supabase.from('employee_tracking_toggles').upsert(
    [{ tenant_id: tenantId, employee_id: employeeId, enabled, updated_at: new Date().toISOString(), updated_by: updatedBy || null }],
    { onConflict: 'tenant_id,employee_id' }
  );
  return { error };
}

/**
 * One employee's attendance day for the Live Tracking track: clock-in/out
 * coordinates, hours and the day's punches. null when there's no row.
 */
export async function getTrackedAttendanceDay(tenantId, employeeId, dateStr) {
  const { data, error } = await supabase
    .from('attendance')
    .select('status, total_hours, punch_in_lat, punch_in_lng, punch_out_lat, punch_out_lng, punches(punch_time, punch_type, approval_status)')
    .eq('tenant_id', tenantId)
    .eq('profile_id', employeeId)
    .eq('date', dateStr)
    .maybeSingle();
  return { data, error };
}

/**
 * Attendance status + punch times on one date for the listed employees, for
 * the Employees table's Present / Absent column. One query; employees with
 * no row that day are simply missing from the result.
 */
export async function listAttendanceStatusForDate(tenantId, employeeIds, dateStr) {
  if (!employeeIds.length) return { data: [], error: null };
  const { data, error } = await supabase
    .from('attendance')
    .select('profile_id, status, punches(punch_time, punch_type)')
    .eq('tenant_id', tenantId)
    .eq('date', dateStr)
    .in('profile_id', employeeIds);
  return { data: data || [], error };
}

/** Every ping for one employee on one calendar date (recorded_date, "YYYY-MM-DD"), oldest first. */
export async function listPingsForEmployeeDate(tenantId, employeeId, dateStr) {
  const { data, error } = await supabase
    .from('employee_location_pings')
    .select('lat, lng, accuracy, recorded_at')
    .eq('tenant_id', tenantId)
    .eq('employee_id', employeeId)
    .eq('recorded_date', dateStr)
    .order('recorded_at');
  return { data: data || [], error };
}
