import { supabase } from '@/lib/supabase';
import { STAFF_ROLES } from '@/lib/helpers';

export const EMPLOYEE_PAGE_SIZE = 25;

/**
 * supabase.functions.invoke() reports any non-2xx response as a generic
 * FunctionsHttpError without surfacing the JSON body — pull the real
 * `{ error }` message out of the response so callers can inspect it
 * (e.g. "already exists" / rate-limit detection during bulk import).
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

// The edge functions verify the caller's session with the auth server
// (auth.getUser), unlike ordinary table reads which only check the JWT
// signature — so a session that was revoked elsewhere (e.g. the same admin
// account logged out on another device) still browses fine but fails here.
const SESSION_ENDED_MSG = 'Your login session has ended (this account was signed out on another device or tab). Please log out and log in again, then retry.';
const isSessionEndedError = (msg) => /not authenticated|session not found|session_not_found/i.test(msg || '');

async function invokeWithRetry(fnName, body, maxRetries = 2) {
  let lastErr;
  let refreshed = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { data, error } = await supabase.functions.invoke(fnName, { body });
    const msg = error ? await invokeMessage(error) : data?.error;
    if (!msg) return data;
    if (isSessionEndedError(msg)) {
      // One refresh attempt: recovers an access token that merely expired.
      // A revoked session can't be refreshed — tell the user plainly.
      if (!refreshed) {
        refreshed = true;
        const { error: refreshErr } = await supabase.auth.refreshSession();
        if (!refreshErr) { attempt--; continue; }
      }
      throw new Error(SESSION_ENDED_MSG);
    }
    lastErr = new Error(msg);
    if (attempt < maxRetries && isTransientAuthError(msg)) {
      await sleep(400 * (attempt + 1));
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

/**
 * Paginated, server-side-filtered employee list.
 * Returns { data, count, error } — count is the total matching rows.
 */
export async function listEmployees(tenantId, { page = 1, search = '', department = '', division = '', status = '', outletId = '', managerId = '' } = {}) {
  // employee_current_passwords is RLS-scoped to superadmin, or an admin
  // reading their own tenant (see 20260901_1_hr_current_password_read.sql) —
  // it comes back empty for any other caller, so it's safe to always embed.
  let q = supabase
    .from('profiles')
    .select('*, outlets(name), employee_current_passwords(password, updated_at)', { count: 'exact' })
    .eq('tenant_id', tenantId)
    .neq('role', 'superadmin')
    .order('first_name');

  // Restricts a manager's "My Team" view to their own direct reports —
  // profiles.manager_id, kept in sync with reporting_relationships by the
  // set_direct_manager RPC (see orgHierarchyService). This profiles-table
  // read is still a UI-level scope, not an RLS boundary (a manager account
  // can still read the whole tenant's profiles here) — but for Raniwala,
  // leave_requests RLS itself now scopes manager access to their own team's
  // rows (leave_requests.manager_id = auth.uid()), see
  // 20260921_2_raniwala_leave_manager_hod_approval.sql. Every other tenant's
  // manager access to leave_requests is still tenant-wide, unchanged.
  if (managerId) q = q.eq('manager_id', managerId);

  if (department) q = q.eq('department', department);
  if (division)   q = q.eq('division', division);
  if (status)     q = q.eq('status', status);
  // Include employees with no outlet assigned yet (outlet_id IS NULL — e.g. just
  // added, or imported without a branch) in every outlet-scoped view instead of
  // a strict equality match, otherwise a freshly added employee is invisible
  // until someone happens to pick "Combined/All Outlets".
  if (outletId)   q = q.or(`outlet_id.eq.${outletId},outlet_id.is.null`);
  if (search) {
    // A single-word query matches any one field directly. A multi-word query
    // (e.g. "Suraj Yadav") can't match any single column that way — no column
    // holds the full name — so each word is required to match *some* field
    // independently (chained .or() calls AND together in PostgREST), which
    // finds the row via first_name="Suraj" AND last_name="Yadav" without
    // needing a concatenated-name column.
    search.trim().split(/\s+/).filter(Boolean).forEach((word) => {
      q = q.or(
        `first_name.ilike.%${word}%,middle_name.ilike.%${word}%,last_name.ilike.%${word}%,email.ilike.%${word}%,department.ilike.%${word}%,employee_id.ilike.%${word}%,essl_employee_code.ilike.%${word}%`
      );
    });
  }

  const from = (page - 1) * EMPLOYEE_PAGE_SIZE;
  q = q.range(from, from + EMPLOYEE_PAGE_SIZE - 1);

  const { data, error, count } = await q;
  return { data: data || [], error, count: count || 0 };
}

/**
 * Distinct non-empty division names for the current tenant, optionally
 * narrowed to one outlet and/or one department — so a division filter/dropdown
 * only ever offers divisions that actually exist at the currently-selected
 * outlet and/or department (Outlet -> Division -> Department cascade for the
 * list-page filter bar; Department -> Division cascade for the Add/Edit
 * Employee form's Division dropdown).
 */
export async function listDivisions(tenantId, outletId = '', department = '') {
  let q = supabase
    .from('profiles')
    .select('division')
    .eq('tenant_id', tenantId)
    .neq('division', '')
    .not('division', 'is', null);
  if (outletId) q = q.eq('outlet_id', outletId);
  if (department) q = q.eq('department', department);
  const { data, error } = await q;
  const divisions = [...new Set((data || []).map(r => r.division))].sort();
  return { data: divisions, error };
}

/**
 * Distinct non-empty department names for the current tenant, optionally
 * narrowed to one outlet and/or division — the last leg of the Outlet ->
 * Division -> Department filter cascade. Distinct from tenantService's
 * listDepartments, which returns the full tenant-wide master list (used for
 * the Add/Edit Employee form, where every department should stay selectable
 * regardless of whatever filter is currently applied to the list view).
 */
export async function listDistinctDepartments(tenantId, { outletId = '', division = '' } = {}) {
  let q = supabase
    .from('profiles')
    .select('department')
    .eq('tenant_id', tenantId)
    .neq('department', '')
    .not('department', 'is', null);
  if (outletId) q = q.eq('outlet_id', outletId);
  if (division) q = q.eq('division', division);
  const { data, error } = await q;
  const departments = [...new Set((data || []).map(r => r.department))].sort();
  return { data: departments, error };
}

/** Lightweight list for dropdowns (id + name only). */
/**
 * Active colleagues for pickers/name lookups on pages employees can open
 * (Feedback, 1-on-1s, KRAs, PIP, Reviews, Interviews). Reads profile_directory
 * — names/role/department only — since employees can't read other profiles
 * rows. Use listActiveEmployees for admin pages that need payroll fields.
 */
export async function listColleagues(tenantId) {
  const { data, error } = await supabase
    .from('profile_directory')
    .select('id, first_name, middle_name, last_name, employee_id, department, designation, division, role, manager_id, outlet_id, outlet_location')
    .eq('tenant_id', tenantId)
    .eq('status', 'Active')
    .in('role', STAFF_ROLES)
    .order('first_name');
  return { data: data || [], error };
}

export async function listActiveEmployees(tenantId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, first_name, middle_name, last_name, department, designation, division, ctc, role, country, join_date, probation_months, pf_enabled, pf_number, pf_amount, esic_enabled, esic_amount, leave_allocation, employee_id, essl_employee_code, outlet_id, outlet_location, is_withheld, withheld_reason, bank_acc, bank_name, ifsc_code, manager_id, comp_off_balance, overtime_applicable, comp_off_eligible')
    .eq('tenant_id', tenantId)
    .eq('status', 'Active')
    .in('role', STAFF_ROLES)
    .order('first_name');
  return { data: data || [], error };
}

/**
 * The personal / contact / ID / bank fields the Master Report's Employee
 * Details sheet adds on top of listActiveEmployees, as
 * `{ [profileId]: { ...profileCols, details, father_name } }`. Fetched only
 * when that sheet is downloaded, so ordinary page loads stay lean. `details`
 * is the profile_details row (gender, addresses, emergency contacts …);
 * father_name comes from employee_payroll_settings, which RLS hides from
 * HR Support (it simply comes back empty).
 */
export async function fetchEmployeeMasterExtras(tenantId) {
  const [profRes, detRes, setRes] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, email, phone, date_of_birth, pan, aadhar, esic_number, passport_number, hod_id, manager_display_name, hod_display_name, weekly_holiday')
      .eq('tenant_id', tenantId)
      .eq('status', 'Active')
      .in('role', STAFF_ROLES),
    supabase
      .from('profile_details')
      .select('profile_id, date_of_birth, gender, marital_status, blood_group, nationality, personal_email, work_number, residence_number, current_address, permanent_address, emergency_contacts')
      .eq('tenant_id', tenantId),
    supabase
      .from('employee_payroll_settings')
      .select('profile_id, father_name')
      .eq('tenant_id', tenantId),
  ]);
  if (profRes.error) return { data: {}, error: profRes.error };
  const details = Object.fromEntries((detRes.data || []).map((d) => [d.profile_id, d]));
  const fathers = Object.fromEntries((setRes.data || []).map((s) => [s.profile_id, s.father_name]));
  const data = Object.fromEntries((profRes.data || []).map((p) => [p.id, {
    ...p, details: details[p.id] || {}, father_name: fathers[p.id] || '',
  }]));
  return { data, error: null };
}

// NOTE: when payload.manager_id changes, this writes profiles.manager_id
// directly and does NOT touch reporting_relationships (the org-hierarchy
// source of truth used by src/services/orgHierarchyService.js's
// set_direct_manager RPC). That means a manager reassigned here can leave
// reporting_relationships stale relative to it — accepted gap for now; a
// follow-up should add a sync trigger so either write path stays consistent.
export async function updateEmployee(id, payload) {
  const { error } = await supabase.from('profiles').update(payload).eq('id', id);
  return { error };
}

export async function updateEmployeeAdmin(id, payload) {
  try {
    await invokeWithRetry('update-employee-admin', { id, payload });
    return { error: null };
  } catch (err) {
    return { error: err };
  }
}

/**
 * Corrects an employee's login email via the update-employee-email edge
 * function, which updates both the Supabase Auth account (what they actually
 * sign in with) and the profiles row — without touching their password, so
 * an existing temp/self-set password keeps working.
 */
export async function updateEmployeeEmail(id, email) {
  try {
    await invokeWithRetry('update-employee-email', { id, email });
    return { error: null };
  } catch (err) {
    return { error: err };
  }
}

/**
 * Corrects an employee's phone number via the update-employee-phone edge
 * function. If they have no real login email (i.e. they sign in with a
 * phone-derived placeholder — see phoneToPlaceholderEmail), this also moves
 * their Auth account to the new placeholder so login keeps matching the
 * number they type. Password is left untouched either way.
 */
export async function updateEmployeePhone(id, phone) {
  try {
    await invokeWithRetry('update-employee-phone', { id, phone });
    return { error: null };
  } catch (err) {
    return { error: err };
  }
}

export async function setEmployeeStatus(id, status) {
  const { error } = await supabase.from('profiles').update({ status }).eq('id', id);
  return { error };
}

/** Withhold/release an employee's salary — processPayroll skips withheld employees entirely. */
export async function setEmployeeWithholding(id, isWithheld, reason = '') {
  const { error } = await supabase.from('profiles').update({
    is_withheld: isWithheld,
    withheld_reason: isWithheld ? reason : '',
  }).eq('id', id);
  return { error };
}

export async function removeEmployee(id) {
  const { error } = await supabase.from('profiles').delete().eq('id', id);
  return { error };
}

/**
 * Creates a Supabase Auth user and profile via the create-employee-user edge
 * function, which runs with the service-role key server-side and verifies
 * the caller is an admin/manager of the target tenant before doing anything.
 * Returns { tempPassword } on success, throws on failure.
 */
export async function createEmployee(tenantId, profileData) {
  const data = await invokeWithRetry('create-employee-user', { tenantId, profileData });
  return { tempPassword: data.tempPassword, userId: data.userId };
}

/**
 * Admin-triggered password reset for an existing employee via the
 * reset-employee-password edge function: generates a fresh temporary
 * password, sets it on their Auth account, and forces a change on next
 * login. Returns { tempPassword } on success, throws on failure.
 */
export async function resetEmployeePassword(id) {
  const data = await invokeWithRetry('reset-employee-password', { id });
  return { tempPassword: data.tempPassword };
}

/** Clears the must_change_password flag after employee sets their own password.
 *  Uses a SECURITY DEFINER RPC because employees have no UPDATE policy on profiles. */
export async function clearMustChangePassword() {
  const { error } = await supabase.rpc('clear_must_change_password');
  return { error };
}

/**
 * Records the employee's current password in employee_current_passwords, a
 * table only superadmin can read (see 20260810_employee_current_password.sql).
 * Called right after an employee sets their own password for the first time,
 * since profiles.temp_password is left stale at that point on purpose.
 */
export async function recordCurrentPassword(password) {
  const { error } = await supabase.rpc('set_current_password', { p_password: password });
  return { error };
}
