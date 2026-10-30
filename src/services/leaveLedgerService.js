import { supabase } from '@/lib/supabase';

/** Configured leave types for a tenant (admin-managed). */
export async function listLeaveTypes(tenantId) {
  const { data, error } = await supabase
    .from('leave_types')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('name');
  return { data: data || [], error };
}

/**
 * Keka-style default categories, seeded for any tenant that has none yet —
 * covers tenants created after 20260813_8_keka_leave_categories.sql (which
 * only backfilled tenants that existed at migration time). Safe to call
 * repeatedly; a no-op once any leave type exists for the tenant.
 */
const DEFAULT_LEAVE_TYPES = [
  { name: 'Planned Leave', is_paid: true, carry_forward: true, max_carry_forward_days: 5, accrual_frequency: 'yearly', accrual_days: 12, annual_quota: 12, encashable: true, max_continuous_days: null },
  { name: 'Emergency Leave', is_paid: true, carry_forward: false, max_carry_forward_days: 0, accrual_frequency: 'yearly', accrual_days: 5, annual_quota: 5, encashable: false, max_continuous_days: 3 },
  { name: 'Unplanned Leave', is_paid: false, carry_forward: false, max_carry_forward_days: 0, accrual_frequency: 'none', accrual_days: 0, annual_quota: 6, encashable: false, max_continuous_days: null },
  // Unlimited — never blocked by a balance, never shows a depleting ring.
  { name: 'Unpaid Leave', is_paid: false, carry_forward: false, max_carry_forward_days: 0, accrual_frequency: 'none', accrual_days: 0, annual_quota: 0, encashable: false, max_continuous_days: null, is_unlimited: true },
];

export async function seedDefaultLeaveTypesIfEmpty(tenantId) {
  const { data: existing } = await listLeaveTypes(tenantId);
  if (existing.length > 0) return { seeded: false };
  for (const t of DEFAULT_LEAVE_TYPES) {
    await supabase.from('leave_types').insert([{ tenant_id: tenantId, ...t, is_active: true }]);
  }
  return { seeded: true };
}

export async function saveLeaveType(tenantId, payload, editId = null) {
  const row = {
    tenant_id: tenantId,
    name: payload.name.trim(),
    is_paid: !!payload.is_paid,
    carry_forward: !!payload.carry_forward,
    max_carry_forward_days: parseFloat(payload.max_carry_forward_days) || 0,
    accrual_frequency: payload.accrual_frequency,
    accrual_days: parseFloat(payload.accrual_days) || 0,
    annual_quota: parseFloat(payload.annual_quota) || 0,
    encashable: !!payload.encashable && !payload.is_unlimited,
    max_continuous_days: payload.max_continuous_days ? parseFloat(payload.max_continuous_days) : null,
    is_active: payload.is_active !== false,
    is_unlimited: !!payload.is_unlimited,
  };
  if (editId) {
    const { error } = await supabase.from('leave_types').update(row).eq('id', editId);
    return { error };
  }
  const { error } = await supabase.from('leave_types').insert([row]);
  return { error };
}

export async function deleteLeaveType(id) {
  const { error } = await supabase.from('leave_types').delete().eq('id', id);
  return { error };
}

/**
 * One employee's ledger-derived balances across every configured leave type —
 * `allocated`/`used` (in addition to the net `balance`) is what lets the Leave
 * page show a "X of Y remaining" ring instead of just a bare remaining number.
 */
export async function fetchMyLeaveBalances(profileId) {
  const { data, error } = await supabase
    .from('leave_balances_detail')
    .select('*, leave_type:leave_types(name, encashable, is_unlimited, is_paid, annual_quota, accrual_frequency, accrual_days, carry_forward, max_carry_forward_days, max_continuous_days)')
    .eq('profile_id', profileId);
  return { data: data || [], error };
}

/** Every employee's balances for a tenant (admin view). */
export async function fetchTenantLeaveBalances(tenantId, profileIds = null) {
  if (profileIds && !profileIds.length) return { data: [], error: null };
  let q = supabase
    .from('leave_balances')
    .select('*, leave_type:leave_types(name, encashable, is_unlimited)')
    .eq('tenant_id', tenantId);
  if (profileIds) q = q.in('profile_id', profileIds);
  const { data, error } = await q;
  return { data: data || [], error };
}

/**
 * Leave balances on a date, per employee — the ledger summed up to `asOf`
 * ('YYYY-MM-DD'), for the payslip's Leave Balance box (balance on the last
 * day of the slip's month, so a later month's credit is not in it). Unlimited
 * types (Unpaid Leave) have no balance and are left out. RLS returns the
 * tenant's rows to HR and only their own to an employee.
 * data = { [profileId]: { asOf, rows: [{ name, days }] } }.
 */
export async function fetchLeaveBalancesAsOf(tenantId, asOf, profileIds = null) {
  if (profileIds && !profileIds.length) return { data: {}, error: null };
  // A long id list would not fit in the request URL; the tenant's rows are then read instead.
  const ids = profileIds && profileIds.length <= 200 ? profileIds : null;
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase
      .from('leave_ledger')
      .select('profile_id, days, leave_type:leave_types(name, is_unlimited)')
      .eq('tenant_id', tenantId)
      .lte('effective_date', asOf)
      .order('id')
      .range(from, from + PAGE - 1);
    if (ids) q = q.in('profile_id', ids);
    const { data, error } = await q;
    if (error) return { data: {}, error };
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  const sums = {};
  rows.forEach((r) => {
    if (!r.leave_type || r.leave_type.is_unlimited) return;
    const byType = (sums[r.profile_id] ||= {});
    byType[r.leave_type.name] = (byType[r.leave_type.name] || 0) + Number(r.days || 0);
  });
  const data = Object.fromEntries(Object.entries(sums).map(([pid, byType]) => [pid, {
    asOf,
    rows: Object.entries(byType).sort(([a], [b]) => a.localeCompare(b)).map(([name, days]) => ({ name, days })),
  }]));
  return { data, error: null };
}

/** Full ledger history for one employee/leave type — audit trail behind the balance number. */
export async function fetchLeaveLedgerHistory(profileId, leaveTypeId) {
  const { data, error } = await supabase
    .from('leave_ledger')
    .select('*')
    .eq('profile_id', profileId)
    .eq('leave_type_id', leaveTypeId)
    .order('effective_date', { ascending: false });
  return { data: data || [], error };
}

/**
 * One employee's whole ledger, every leave type, oldest first — one request
 * feeds the Leave Tracker's statement and running balance for all types.
 */
export async function fetchMyLeaveLedger(profileId) {
  const { data, error } = await supabase
    .from('leave_ledger')
    .select('id, leave_type_id, entry_type, days, effective_date, leave_request_id, note, created_at')
    .eq('profile_id', profileId)
    .order('effective_date', { ascending: true })
    .order('created_at', { ascending: true });
  return { data: data || [], error };
}

/**
 * Leave actually taken in a date range, tenant-wide (admin view): the ledger
 * deduction of every approved request — with that request's dates and reason —
 * plus HR's "Leave taken (not applied in app)" removals from Leave Balances.
 * Other negative adjustments (corrections, encashment, expiry) are not leave.
 */
export async function fetchLeavesTaken(tenantId, from, to) {
  const { data, error } = await supabase
    .from('leave_ledger')
    .select('id, profile_id, leave_type_id, entry_type, days, effective_date, note, leave_request:leave_requests(start_date, end_date, reason)')
    .eq('tenant_id', tenantId)
    .lt('days', 0)
    .in('entry_type', ['Deduction', 'Allocation'])
    .gte('effective_date', from)
    .lte('effective_date', to)
    .order('effective_date', { ascending: false });
  const rows = (data || []).filter((r) => r.entry_type === 'Deduction' || /^leave taken/i.test(r.note || ''));
  return { data: rows, error };
}

/** Admin manual allocation/adjustment. */
export async function allocateLeave(profileId, leaveTypeId, days, note = '') {
  const { error } = await supabase.rpc('allocate_leave', {
    p_profile_id: profileId, p_leave_type_id: leaveTypeId, p_days: days, p_entry_type: 'Allocation', p_note: note,
  });
  return { error };
}

/**
 * Raniwala: how much of an Earned Leave request the balance covers, the same
 * figures the DB stamps on the request when it is submitted (20261011_2).
 * data = { balance, held, available, requested, paid_days, unpaid_days }.
 */
export async function previewEarnedLeaveSplit(profileId, startDate, endDate) {
  const { data, error } = await supabase.rpc('raniwala_earned_leave_split', {
    p_profile_id: profileId, p_start: startDate, p_end: endDate,
  });
  return { data, error };
}

/** Ledger the deduction for an approved (non-Comp-Off) leave request — safe to call more than once (idempotent). */
export async function recordLeaveDeduction(leaveRequestId) {
  const { error } = await supabase.rpc('record_leave_deduction', { p_leave_request_id: leaveRequestId });
  return { error };
}

/** Encash `days` of balance for `amount` ₹, applied to the given payroll month via a salary_additions row. */
export async function recordLeaveEncashment(profileId, leaveTypeId, days, amount, month, year) {
  const { error } = await supabase.rpc('record_leave_encashment', {
    p_profile_id: profileId, p_leave_type_id: leaveTypeId, p_days: days, p_amount: amount, p_month: month, p_year: year,
  });
  return { error };
}
