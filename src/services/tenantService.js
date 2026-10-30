import { supabase } from '@/lib/supabase';
import { STAFF_ROLES } from '@/lib/helpers';

/**
 * supabase.functions.invoke() reports any non-2xx response as a generic
 * FunctionsHttpError without surfacing the JSON body — pull the real
 * `{ error }` message out of the response so callers can show it.
 */
async function invokeMessage(error) {
  if (!error?.context?.json) return error?.message || 'Request failed';
  try {
    const body = await error.context.json();
    return body?.error || error.message;
  } catch {
    return error.message;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// This project's Supabase auth server fleet is inconsistently synced on a
// rotated JWT signing key — some replicas verify a valid session token fine,
// others intermittently reject it with this exact message. It's transient
// (confirmed: back-to-back identical calls alternate pass/fail), so a couple
// of quick retries clears it without the caller ever seeing it.
const isTransientAuthError = (msg) => /invalid jwt|signature is invalid|unable to (parse|verify) signature/i.test(msg || '');

async function invokeWithRetry(fnName, body, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { data, error } = await supabase.functions.invoke(fnName, { body });
    const msg = error ? await invokeMessage(error) : data?.error;
    if (!msg) return data;
    lastErr = new Error(msg);
    if (attempt < maxRetries && isTransientAuthError(msg)) {
      await sleep(400 * (attempt + 1));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

const normalizeHoliday = (holiday) => {
  const dateValue = holiday.holiday_date || holiday.date;
  return {
    ...holiday,
    holiday_date: dateValue,
    date: dateValue,
    description: holiday.description || holiday.type || '',
    status: holiday.status || 'Approved',
    requested_by: holiday.requested_by || null,
    approved_by: holiday.approved_by || null,
    approved_at: holiday.approved_at || null,
    updated_at: holiday.updated_at || holiday.created_at || null,
  };
};

export async function updateTenant(tenantId, payload) {
  const { error } = await supabase.from('tenants').update(payload).eq('id', tenantId);
  return { error };
}

/**
 * Permanently deletes a tenant (company) — superadmin only (RLS: "tenants:
 * superadmin_platform_all"). Cascades to every tenant-scoped table
 * (profiles, departments, payrolls, attendance, leave_requests, outlets,
 * announcements, policies, etc.) per the FKs in the base schema.
 */
export async function deleteTenant(tenantId) {
  const { error } = await supabase.from('tenants').delete().eq('id', tenantId);
  return { error };
}

export async function listDepartments(tenantId) {
  const { data, error } = await supabase
    .from('departments')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('name');
  return { data: data || [], error };
}

export async function addDepartment(tenantId, name) {
  const { error } = await supabase
    .from('departments')
    .insert([{ tenant_id: tenantId, name: name.trim() }]);
  return { error };
}

export async function removeDepartment(id) {
  const { error } = await supabase.from('departments').delete().eq('id', id);
  return { error };
}

export async function listShifts(tenantId) {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('name');
  return { data: data || [], error };
}

export async function addShift(tenantId, shift) {
  const { error } = await supabase
    .from('shifts')
    .insert([{ ...shift, tenant_id: tenantId }]);
  return { error };
}

/**
 * @param {string} tenantId
 * @param {string|null} [outletId] - When given, returns tenant-wide holidays
 *   (outlet_id IS NULL) plus holidays scoped to this outlet only. Omit to
 *   return every holiday across the whole tenant (all outlets combined).
 */
export async function listHolidays(tenantId, outletId) {
  let query = supabase
    .from('holidays')
    .select('*')
    .eq('tenant_id', tenantId);

  if (outletId) {
    query = query.or(`outlet_id.is.null,outlet_id.eq.${outletId}`);
  }

  const { data, error } = await query.order('date', { ascending: true });

  return { data: (data || []).map(normalizeHoliday), error };
}

export async function addHoliday(tenantId, holiday) {
  const { error } = await supabase
    .from('holidays')
    .insert([{
      tenant_id: tenantId,
      outlet_id: holiday.outlet_id || null,
      name: holiday.name,
      date: holiday.date || holiday.holiday_date,
      type: holiday.type || holiday.description || 'Public Holiday',
    }]);
  return { error };
}

export async function importHolidays(tenantId, holidays, outletId) {
  const rows = holidays.map((h) => ({
    tenant_id: tenantId,
    outlet_id: h.outlet_id || outletId || null,
    name: h.name,
    date: h.date || h.holiday_date,
    type: h.type || h.description || 'Public Holiday',
  }));
  const { error } = await supabase
    .from('holidays')
    .upsert(rows, { onConflict: 'tenant_id,outlet_id,date', ignoreDuplicates: true });
  return { error };
}

export async function updateHoliday(holidayId, holiday) {
  const { error } = await supabase
    .from('holidays')
    .update({
      name: holiday.name,
      date: holiday.date || holiday.holiday_date,
      type: holiday.type || holiday.description || 'Public Holiday',
    })
    .eq('id', holidayId);
  return { error };
}

export async function updateHolidayStatus(holidayId, status) {
  const { error } = await supabase
    .from('holidays')
    .update({ status })
    .eq('id', holidayId);
  return { error };
}

export async function deleteHoliday(holidayId) {
  // RLS turns a disallowed delete into "0 rows", not an error — report it.
  const { data, error } = await supabase.from('holidays').delete().eq('id', holidayId).select('id');
  if (!error && !data?.length) return { error: new Error('You are not allowed to delete this holiday.') };
  return { error };
}

export async function initializeMajorHolidays(tenantId) {
  // The initialize_major_holidays RPC does not exist in the DB — insert directly.
  const year = new Date().getFullYear();
  const rows = [
    { tenant_id: tenantId, name: 'Republic Day',    date: `${year}-01-26`, type: 'Public Holiday' },
    { tenant_id: tenantId, name: 'Holi',            date: `${year}-03-14`, type: 'Festival of colors' },
    { tenant_id: tenantId, name: 'Labour Day',      date: `${year}-05-01`, type: "International Workers' Day" },
    { tenant_id: tenantId, name: 'Independence Day',date: `${year}-08-15`, type: 'National holiday' },
    { tenant_id: tenantId, name: 'Gandhi Jayanti',  date: `${year}-10-02`, type: 'National holiday' },
    { tenant_id: tenantId, name: 'Diwali',          date: `${year}-10-31`, type: 'Festival of lights' },
    { tenant_id: tenantId, name: 'Christmas Day',   date: `${year}-12-25`, type: 'Major festival' },
  ];
  const { error } = await supabase
    .from('holidays')
    .upsert(rows, { onConflict: 'tenant_id,outlet_id,date', ignoreDuplicates: true });
  return { error };
}

export async function removeShift(id) {
  const { error } = await supabase.from('shifts').delete().eq('id', id);
  return { error };
}

/** Grace/threshold config used by the nightly auto-attendance sweep (mark_attendance_from_punches). */
export async function updateShiftThresholds(id, { grace_minutes, early_exit_threshold_minutes, auto_absent_after_hours, early_departure_after, late_arrival_allowance_until }) {
  const { error } = await supabase.from('shifts').update({
    grace_minutes: parseInt(grace_minutes) || 0,
    early_exit_threshold_minutes: parseInt(early_exit_threshold_minutes) || 0,
    auto_absent_after_hours: parseInt(auto_absent_after_hours) || 0,
    // Per-shift monthly early-departure / late-arrival allowance window (see
    // shifts.early_departure_after / late_arrival_allowance_until). Blank clears it.
    early_departure_after: early_departure_after || null,
    late_arrival_allowance_until: late_arrival_allowance_until || null,
  }).eq('id', id);
  return { error };
}

/**
 * Aggregate dashboard stats — all queries run in parallel. `outletProfileIds`
 * (a Set, from OutletViewContext) narrows the employee/advances queries to
 * one outlet's people; `processedPayrolls` stays tenant-wide since a payroll
 * run is a per-tenant batch, not owned by any single outlet.
 */
export async function fetchDashboardStats(tenantId, outletProfileIds = null) {
  // Every active staff member — managers, HODs and management are employees
  // too. HR (admin) logins count only when they're a real person with an
  // employee code; a shared HR login (e.g. "RANIWALA HR") has none.
  let empsQuery = supabase.from('profiles').select('id, ctc').eq('tenant_id', tenantId).eq('status', 'Active')
    .or('role.in.(employee,manager,hod,management),and(role.eq.admin,employee_id.not.is.null)');
  let advQuery = supabase.from('advances').select('balance, profile_id').eq('tenant_id', tenantId).eq('status', 'Active');
  if (outletProfileIds) {
    const ids = [...outletProfileIds];
    empsQuery = empsQuery.in('id', ids);
    advQuery = advQuery.in('profile_id', ids);
  }

  const [empsRes, payrollRes, advRes, salRes] = await Promise.all([
    empsQuery,
    supabase.from('payrolls').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('status', 'Processed'),
    advQuery,
    // A salary-private tenant keeps the gross in employee_salaries (payroll HR
    // reads it; anyone else gets no rows, so their total stays the profile's).
    supabase.from('employee_salaries').select('profile_id, gross').eq('tenant_id', tenantId),
  ]);

  const activeEmployees     = empsRes.data?.length || 0;
  const grossById           = Object.fromEntries((salRes.data || []).map((r) => [r.profile_id, Number(r.gross) || 0]));
  const totalCTC            = empsRes.data?.reduce((s, e) => s + (grossById[e.id] ?? (e.ctc || 0)), 0) || 0;
  const processedPayrolls   = payrollRes.count || 0;
  const outstandingAdvances = advRes.data?.reduce((s, a) => s + (a.balance || 0), 0) || 0;
  const error               = empsRes.error || payrollRes.error || advRes.error;

  return { activeEmployees, totalCTC, processedPayrolls, outstandingAdvances, error };
}

/** All tenants — superadmin only. */
export async function listAllTenants() {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

/**
 * Creates a new company (tenant) plus its first admin login via the
 * create-tenant edge function — superadmin only. Returns
 * { tenantId, joinCode, adminEmail, tempPassword } on success.
 */
export async function createTenant(payload) {
  return invokeWithRetry('create-tenant', payload);
}

/** Branches ("outlets") for a tenant. */
export async function listOutlets(tenantId) {
  const { data, error } = await supabase
    .from('outlets')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('name');
  return { data: data || [], error };
}

export async function createOutlet(tenantId, outlet) {
  const { error } = await supabase
    .from('outlets')
    .insert([{
      tenant_id: tenantId,
      name: outlet.name.trim(),
      address: (outlet.address || '').trim(),
      city: (outlet.city || '').trim(),
    }]);
  return { error };
}

export async function updateOutlet(id, payload) {
  const { error } = await supabase.from('outlets').update(payload).eq('id', id);
  return { error };
}

export async function removeOutlet(id) {
  const { error } = await supabase.from('outlets').delete().eq('id', id);
  return { error };
}

export async function getOutlet(id) {
  if (!id) return { data: null, error: null };
  const { data, error } = await supabase.from('outlets').select('*').eq('id', id).maybeSingle();
  return { data, error };
}

/**
 * Resolves the effective attendance/geofencing settings for an outlet, falling back
 * to the tenant-level defaults for any field the outlet hasn't overridden (NULL).
 */
export function resolveAttendanceSettings(tenant, outlet) {
  return {
    geofence_lat: outlet?.geofence_lat ?? tenant?.geofence_lat ?? null,
    geofence_lng: outlet?.geofence_lng ?? tenant?.geofence_lng ?? null,
    geofence_radius: outlet?.geofence_radius ?? tenant?.geofence_radius ?? 200,
    min_half_day_hours: outlet?.min_half_day_hours ?? tenant?.min_half_day_hours ?? 4,
    min_full_day_hours: outlet?.min_full_day_hours ?? tenant?.min_full_day_hours ?? 8,
    // No outlet/tenant reporting time configured -> default reporting time is
    // 10:30 AM with a 0-minute grace, i.e. a punch at 10:31 or later is Late.
    // Fixed, single-field rule: Report Time (shift_start) + Late Allowed
    // minutes (late_threshold) — a punch more than late_threshold minutes
    // after shift_start is Late, every time, for every day of the month.
    // There is no separate monthly "grace" waiver on top of this anymore
    // (retired the late_grace_minutes/late_grace_max_per_month mechanism
    // from 20260914_6/20260916_1 — it was quietly turning some genuinely
    // late arrivals back into 'Present' and hiding them from reports).
    shift_start: outlet?.shift_start ?? tenant?.shift_start ?? '10:30',
    shift_end: outlet?.shift_end ?? tenant?.shift_end ?? '18:00',
    late_threshold: outlet?.late_threshold ?? tenant?.late_threshold ?? 0,
    // Outlet-level override of the tenant-wide weekly off days.
    weekly_off_days: outlet?.weekly_off_days ?? tenant?.weekly_off_days ?? [],
  };
}

/**
 * Re-scores Present/Late on existing attendance rows against whatever Report
 * Time / Late Allowed minutes are configured *right now* — call this right
 * after saving those settings so already-written rows for the affected
 * window reflect the new rule immediately, not just punches from here on.
 * `outletId` null recomputes every outlet under the tenant (i.e. after a
 * company-wide default change). Returns how many rows actually changed.
 */
export async function recomputeAttendanceLateStatus(tenantId, outletId, fromDate, toDate) {
  const { data, error } = await supabase.rpc('recompute_attendance_late_status', {
    p_tenant_id: tenantId,
    p_outlet_id: outletId,
    p_from_date: fromDate,
    p_to_date: toDate,
  });
  return { count: data ?? 0, error };
}

/**
 * Extra outlets (beyond the profile's own `outlet_id`) a profile is allowed to
 * clock in/out from — e.g. HR who visits multiple branches. Returns outlet ids only.
 */
export async function listProfileOutletAccess(profileId) {
  if (!profileId) return { data: [], error: null };
  const { data, error } = await supabase
    .from('profile_outlet_access')
    .select('outlet_id')
    .eq('profile_id', profileId);
  return { data: (data || []).map((r) => r.outlet_id), error };
}

/** Replaces the full set of extra clock-in outlets for a profile. */
export async function setProfileOutletAccess(tenantId, profileId, outletIds) {
  const { error: delErr } = await supabase.from('profile_outlet_access').delete().eq('profile_id', profileId);
  if (delErr) return { error: delErr };
  if (!outletIds.length) return { error: null };
  const { error } = await supabase
    .from('profile_outlet_access')
    .insert(outletIds.map((outlet_id) => ({ tenant_id: tenantId, profile_id: profileId, outlet_id })));
  return { error };
}

/**
 * Every outlet a profile may clock in/out from: their home outlet plus any
 * extra access grants. Used to check geofencing against all of them at once.
 *
 * When `tenant.allow_any_outlet_clockin` is on ("multifencing"), the home
 * outlet / per-employee grants are skipped entirely and every active outlet
 * in the tenant becomes a candidate fence — any employee can clock in/out at
 * any of the company's locations, just still nowhere outside all of them.
 */
export async function listAccessibleOutlets(profileId, primaryOutletId, tenant) {
  if (tenant?.allow_any_outlet_clockin && tenant?.id) {
    const { data, error } = await supabase
      .from('outlets')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('is_active', true);
    return { data: data || [], error };
  }

  const ids = new Set();
  if (primaryOutletId) ids.add(primaryOutletId);
  const { data: extraIds } = await listProfileOutletAccess(profileId);
  extraIds.forEach((id) => ids.add(id));
  if (!ids.size) return { data: [], error: null };
  const { data, error } = await supabase.from('outlets').select('*').in('id', Array.from(ids));
  return { data: data || [], error };
}

/**
 * Moves an employee to a different outlet within the same tenant, keeping an
 * append-only audit trail (outlet_transfers) instead of silently overwriting
 * the employee's branch — every transfer stays in the history.
 */
export async function transferEmployeeOutlet({ tenantId, profileId, toOutletId, toOutletName, fromOutletId, fromOutletName, transferredBy, notes }) {
  const { error: histErr } = await supabase.from('outlet_transfers').insert([{
    tenant_id: tenantId,
    profile_id: profileId,
    from_outlet_id: fromOutletId || null,
    from_outlet_name: fromOutletName || '',
    to_outlet_id: toOutletId,
    to_outlet_name: toOutletName || '',
    transferred_by: transferredBy,
    notes: notes || '',
  }]);
  if (histErr) return { error: histErr };

  // Keep outlet_location (the free-text branch field used by listBranches/filters) in sync.
  const { error } = await supabase
    .from('profiles')
    .update({ outlet_id: toOutletId, outlet_location: toOutletName || '' })
    .eq('id', profileId);
  return { error };
}

/** Outlet-transfer history for one employee, newest first. */
export async function fetchOutletTransferHistory(profileId) {
  const { data, error } = await supabase
    .from('outlet_transfers')
    .select('*, transferred_by_profile:profile_directory!outlet_transfers_transferred_by_fkey(first_name, middle_name, last_name)')
    .eq('profile_id', profileId)
    .order('transferred_at', { ascending: false });
  return { data: data || [], error };
}

/** Active employees with no outlet assigned yet (outlet_id IS NULL) — the pool a bulk assignment acts on. */
export async function listUnassignedEmployees(tenantId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, first_name, middle_name, last_name, department, designation, outlet_location')
    .eq('tenant_id', tenantId)
    .eq('status', 'Active')
    .is('outlet_id', null)
    .in('role', STAFF_ROLES)
    .order('first_name');
  return { data: data || [], error };
}

/**
 * Assigns many employees to one outlet in a single action, recording an
 * outlet_transfers history row for each (from_outlet_id is always null here —
 * this is specifically for employees who never had an outlet before).
 */
export async function bulkAssignOutlet({ tenantId, profileIds, toOutletId, toOutletName, transferredBy, notes }) {
  if (!profileIds || profileIds.length === 0) return { error: null };

  const { error: histErr } = await supabase.from('outlet_transfers').insert(
    profileIds.map((profileId) => ({
      tenant_id: tenantId,
      profile_id: profileId,
      from_outlet_id: null,
      from_outlet_name: '',
      to_outlet_id: toOutletId,
      to_outlet_name: toOutletName || '',
      transferred_by: transferredBy,
      notes: notes || '',
    }))
  );
  if (histErr) return { error: histErr };

  const { error } = await supabase
    .from('profiles')
    .update({ outlet_id: toOutletId, outlet_location: toOutletName || '' })
    .in('id', profileIds);
  return { error };
}

/**
 * Returns the company name for a given org code, or null if not found.
 * Callable before login (anon) — used for the join-company preview.
 */
export async function lookupOrgCode(orgCode) {
  if (!orgCode || orgCode.trim().length < 4) return { companyName: null, error: null };
  const { data, error } = await supabase.rpc('lookup_org', { p_org_code: orgCode.trim() });
  return { companyName: data || null, error };
}

/**
 * Called after supabase.auth.signUp() during employee self-signup.
 * Finds the tenant by org code and creates the employee profile.
 */
export async function employeeJoinWorkspace(orgCode, firstName, lastName, userId) {
  const { data, error } = await supabase.rpc('employee_join_workspace', {
    p_org_code:   orgCode.trim().toUpperCase(),
    p_first_name: firstName.trim(),
    p_last_name:  lastName.trim(),
    p_user_id:    userId || null,
  });
  if (error) throw error;
  return data; // 'ok'
}
