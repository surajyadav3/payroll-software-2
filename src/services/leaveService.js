import { supabase } from '@/lib/supabase';
import { getOrCreateQuota, determineApproverRole, incrementSelfCount, incrementManagerCount, SELF_LIMIT } from './requestQuotaService';
import { getFirstApproverRole } from './approvalService';
import { notifyProfiles, notifyRoles, withHrRole, getRequesterLabel } from './notificationService';
import { l1RequestLeave } from './l1Service';
import { leaveDays } from '@/lib/halfDayLeave';
import { dateStr } from '@/lib/helpers';

/**
 * Fetch leave requests for a tenant. Returns every request regardless of
 * status or approval tier (Pending/Approved/Rejected, self/manager/admin) —
 * managers need visibility into auto-approved and admin-approved leaves too,
 * not just the ones routed to them for action. Callers gate the
 * Approve/Reject actions themselves based on required_approver_role.
 * @param {string} tenantId
 */
export async function listAllLeaveRequests(tenantId) {
  const { data, error } = await supabase
    .from('leave_requests')
    .select(`
      *,
      profile:profile_directory!leave_requests_profile_id_fkey(first_name, middle_name, last_name, department, designation, employee_id),
      approver:profile_directory!leave_requests_approved_by_fkey(first_name, middle_name, last_name),
      manager_decider:profile_directory!leave_requests_manager_decided_by_fkey(first_name, middle_name, last_name),
      hr_decider:profile_directory!leave_requests_hr_decided_by_fkey(first_name, middle_name, last_name),
      hod_decider:profile_directory!leave_requests_hod_decided_by_fkey(first_name, middle_name, last_name),
      management_decider:profile_directory!leave_requests_management_decided_by_fkey(first_name, middle_name, last_name),
      stage_manager:profile_directory!leave_requests_manager_id_fkey(first_name, middle_name, last_name),
      stage_hod:profile_directory!leave_requests_hod_id_fkey(first_name, middle_name, last_name)
    `)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  return { data: data || [], error };
}

/** Fetch leave requests for a specific employee. */
export async function listMyLeaveRequests(profileId) {
  const { data, error } = await supabase
    .from('leave_requests')
    .select('*')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

/**
 * The signed-in employee's shift split in two, for a half-day leave (20261013_2):
 * { shift_name, shift_start, shift_end, first_half: { from, to }, second_half: { from, to } }.
 */
export async function fetchMyHalfDayWindows() {
  const { data, error } = await supabase.rpc('my_leave_half_day_windows');
  return { data: data || null, error };
}

/** Check if an employee is still in their probation period. Returns { inProbation, endsOn }. */
export async function checkProbationStatus(profileId) {
  const { data: prof } = await supabase
    .from('profiles')
    .select('join_date, probation_months, probation_earned_leaves')
    .eq('id', profileId)
    .single();

  if (!prof || !prof.probation_months || !prof.join_date) {
    return { inProbation: false, endsOn: null, earnedLeaves: 0 };
  }

  const [y, m, d] = prof.join_date.split('-').map(Number);
  const joinDate  = new Date(y, m - 1, d);
  const endsOn    = new Date(joinDate);
  endsOn.setMonth(endsOn.getMonth() + prof.probation_months);
  const inProbation = new Date() < endsOn;

  return {
    inProbation,
    endsOn:       endsOn.toISOString().split('T')[0],
    earnedLeaves: prof.probation_earned_leaves || 0,
  };
}

/**
 * Submit a leave request with tiered quota routing.
 * `tenantSettings` carries the superadmin-configured auto-approval controls
 * (Toggle Services → Leave Auto-Approval): pass `{ autoApprovalEnabled, autoApprovalLimit }`
 * from the caller's already-loaded tenant record. A tenant with auto-approval
 * turned off gets selfLimit 0, so every request skips straight to manager/admin.
 * Returns { error, tier } where tier is 'self' | 'manager' | 'admin'.
 * When tier === 'self' the request is auto-approved immediately (no HR needed).
 * `tenantSettings.asL1`: the signed-in user is the employee's L1 filing it for
 * them (l1Service) — the DB routes it as the employee's own request.
 */
export async function requestLeave(payload, tenantSettings = {}) {
  const { tenant_id, profile_id } = payload;
  const { asL1 = false } = tenantSettings;

  // Optional per-tenant override: if an admin has configured an approval
  // chain for leave_requests, its first step wins over the self/manager/admin
  // quota tiers below — most tenants have no chain configured, so this is a
  // no-op for them and the existing quota-based routing is unaffected.
  // An L1 can't read the employee's quota; the DB's tier trigger decides.
  const chainRole = asL1 ? null : await getFirstApproverRole(tenant_id, 'leave_requests');

  const selfLimit = tenantSettings.autoApprovalEnabled === false
    ? 0
    : (tenantSettings.autoApprovalLimit ?? SELF_LIMIT);

  const quota = asL1 ? null : await getOrCreateQuota(tenant_id, profile_id);
  const tier  = asL1 ? 'manager' : chainRole || determineApproverRole(quota, selfLimit);

  const finalPayload = {
    ...payload,
    status:                 tier === 'self' ? 'Approved' : 'Pending',
    required_approver_role: tier,
    approval_level:         tier === 'self' ? 'self' : null,
  };

  const { data: inserted, error } = asL1
    ? await l1RequestLeave(payload)
    : await supabase.from('leave_requests').insert([finalPayload])
      .select('id, status, required_approver_role, manager_id, manager_status, hr_status, requires_hr_approval').single();

  // The enforce_leave_request_approval_tier DB trigger (see
  // 20260903_3_server_side_leave_approval_enforcement.sql) re-derives the
  // tier from the tenant's *current* settings and may silently overwrite
  // status/required_approver_role if this client's view of them was stale
  // (e.g. auto-approval was just switched off in another session/tab).
  // Trust what actually landed in the row, not the pre-insert guess above —
  // otherwise a downgraded-to-Pending request would still show an
  // "auto-approved" toast and never get its self-approval quota consumed.
  const actualTier = inserted?.required_approver_role || tier;

  if (!error && actualTier === 'self' && !asL1) {
    await incrementSelfCount(tenant_id, profile_id);
  }

  // Self-approved requests skip updateLeaveStatus entirely, so ledger the
  // deduction here instead — record_leave_deduction is idempotent and a
  // silent no-op for leave types with no matching leave_types config yet.
  if (!error && actualTier === 'self' && !asL1 && inserted?.id) {
    const { error: ledgerErr } = await supabase.rpc('record_leave_deduction', { p_leave_request_id: inserted.id });
    if (ledgerErr) console.error('record_leave_deduction failed:', ledgerErr); // non-fatal — the leave request itself already succeeded
  }

  if (!error && inserted?.id) {
    // Raniwala multi-stage rows (manager_status is only ever set by the DB
    // trigger for those): the DB itself notifies whoever's stage is up
    // (trg_notify_leave_stage, 20260926_1), so the app and web agree.
    if (inserted.manager_status) {
      return { error, tier: actualTier };
    }
    const requester = await getRequesterLabel(profile_id);
    if (actualTier === 'self') {
      await notifyProfiles(tenant_id, [profile_id], {
        type: 'leave_request_auto_approved',
        title: 'Leave request auto-approved',
        body: `Your ${payload.leave_type || ''} leave request was automatically approved.`,
        linkKey: 'leave_requests',
        relatedId: inserted.id,
      });
      // HR still gets a heads-up even on a self-approved request — nothing
      // for them to act on, but they should never be left unaware a leave
      // request came in and went through.
      await notifyRoles(tenant_id, ['admin'], {
        type: 'leave_request_auto_approved',
        title: 'Leave request auto-approved',
        body: `${requester} submitted a ${payload.leave_type || ''} leave request — auto-approved, no action needed.`,
        linkKey: 'leave_requests',
        actorId: profile_id,
        relatedId: inserted.id,
      }, profile_id);
    } else {
      await notifyRoles(tenant_id, withHrRole([actualTier]), {
        type: 'leave_request_submitted',
        title: 'New leave request',
        body: `${requester} submitted a new ${payload.leave_type || ''} leave request — needs your review.`,
        linkKey: 'leave_requests',
        actorId: profile_id,
        relatedId: inserted.id,
      }, profile_id);
    }
  }

  return { error, tier: actualTier };
}

/**
 * Shared by updateLeaveStatus() and the Raniwala manager/HR decision
 * functions below: on a final Approved/Rejected outcome, decrements Comp Off
 * balance (Comp Off leave type only), records the leave-ledger deduction,
 * and notifies the employee. Never fires for an intermediate Pending state
 * (e.g. a Raniwala manager approving a >3-day leave that still awaits HR).
 */
async function runLeaveApprovalOutcome(leave, id, approverId, status) {
  if (status === 'Approved') {
    if (leave?.leave_type === 'Comp Off') {
      const days = leaveDays(leave); // a half day takes 0.5
      // Atomic — avoids the lost-update race from a read-then-write on comp_off_balance.
      await supabase.rpc('adjust_comp_off_balance', { p_profile_id: leave.profile_id, p_delta: -days });
    }

    const { error: ledgerErr } = await supabase.rpc('record_leave_deduction', { p_leave_request_id: id });
    if (ledgerErr) console.error('record_leave_deduction failed:', ledgerErr); // non-fatal — approval itself already succeeded
  }

  if (leave?.tenant_id && leave?.profile_id) {
    await notifyProfiles(leave.tenant_id, [leave.profile_id], {
      type: `leave_request_${status.toLowerCase()}`,
      title: `Leave request ${status}`,
      body: `Your ${leave.leave_type || ''} leave request was ${status.toLowerCase()}.`,
      linkKey: 'leave_requests',
      actorId: approverId,
      relatedId: id,
    });
  }
}

/**
 * Approve or Reject a leave request — the single-stage quota-tier flow every
 * tenant except Raniwala uses (and Raniwala still uses for anything inserted
 * before 20260921_2, or any non-leave request type).
 * approverRole: 'manager' | 'admin' | 'superadmin'
 * When manager approves, increments that employee's manager quota for the month.
 * When approving a Comp Off leave, decrements comp_off_balance.
 */
export async function updateLeaveStatus(id, status, approverId, approverRole = 'admin') {
  const { data: leave } = await supabase
    .from('leave_requests')
    .select('leave_type, start_date, end_date, half_day, profile_id, tenant_id')
    .eq('id', id)
    .single();

  // Only transition a request that's still Pending — without this guard a double-clicked
  // Approve (or a click after someone else already actioned it) re-runs the balance
  // deduction / quota increment below a second time for the same request.
  const { data: updated, error } = await supabase
    .from('leave_requests')
    .update({ status, approved_by: approverId })
    .eq('id', id)
    .eq('status', 'Pending')
    .select('id');

  if (!error && updated?.length === 0) {
    return { error: new Error('This request has already been reviewed.') };
  }

  if (!error && status === 'Approved' && approverRole === 'manager' && leave?.tenant_id && leave?.profile_id) {
    await incrementManagerCount(leave.tenant_id, leave.profile_id);
  }

  if (!error) await runLeaveApprovalOutcome(leave, id, approverId, status);

  return { error };
}

// Raniwala stage -> the leave_requests columns that stage owns.
const STAGE_COLUMNS = {
  manager:    { status: 'manager_status',    by: 'manager_decided_by',    at: 'manager_decided_at' },
  hod:        { status: 'hod_status',        by: 'hod_decided_by',        at: 'hod_decided_at' },
  hr:         { status: 'hr_status',         by: 'hr_decided_by',         at: 'hr_decided_at' },
  management: { status: 'management_status', by: 'management_decided_by', at: 'management_decided_at' },
};

/**
 * Raniwala-only: one approver's decision on their own stage of a leave
 * request (Manager -> HOD -> HR -> Management, see
 * 20260926_1_raniwala_hod_management_roles_and_leave_flow.sql). The DB
 * trigger only lets the caller move the stage whose turn it currently is —
 * except HR, whose decision is final at any stage (stages still waiting
 * become 'Skipped', 20261003_3) — stamps decided_by/at itself, derives the
 * overall status, and notifies the next approver. This just sends the
 * decision and, on a final outcome, runs the ledger deduction + employee
 * notification.
 */
export async function decideLeaveStage(id, stage, decision, approverId) {
  const cols = STAGE_COLUMNS[stage];
  if (!cols) return { error: new Error('Unknown approval stage') };

  const { data: updated, error } = await supabase
    .from('leave_requests')
    .update({ [cols.status]: decision, [cols.by]: approverId, [cols.at]: new Date().toISOString() })
    .eq('id', id)
    // HR may decide at any stage, so only require the request to be open.
    .eq(stage === 'hr' ? 'status' : 'current_stage', stage === 'hr' ? 'Pending' : stage)
    .select('id, status, profile_id, tenant_id, leave_type, start_date, end_date, half_day')
    .maybeSingle();

  if (error) return { error };
  if (!updated) return { error: new Error('This request has already been reviewed.') };

  if (updated.status === 'Approved' || updated.status === 'Rejected') {
    await runLeaveApprovalOutcome(updated, id, approverId, updated.status);
  }
  return { error: null };
}

/**
 * Which Raniwala stage (if any) `profile` may decide on `req` right now —
 * mirrors enforce_leave_dual_approval()'s own checks so the buttons only
 * show for the one person the DB will accept.
 */
export function myLeaveStage(req, profile) {
  if (!req?.current_stage || req.status !== 'Pending' || !profile) return null;
  const { role, id } = profile;
  // Manager / HOD stages go by who is assigned, not current role (an HOD
  // can be someone's direct manager; a role can change mid-request).
  if (req.current_stage === 'manager' && req.manager_id === id) return 'manager';
  if (req.current_stage === 'hod' && req.hod_id === id) return 'hod';
  // HR can decide at any stage; it's final and skips whoever hasn't acted.
  if (role === 'admin' || role === 'superadmin') return 'hr';
  if (req.current_stage === 'management' && role === 'management') return 'management';
  return null;
}

/**
 * Approved leave requests of any type that overlap a month (0-indexed), plus
 * `padDays` either side of it (the sandwich rule looks at the days around a
 * weekly off on the 1st / last day) — for Run Payroll's paid-days tally
 * (lib/paidDays).
 * `*`, not a column list: unpaid_days only exists once 20261011_2 is applied,
 * and naming a missing column fails the whole query.
 */
export async function fetchApprovedLeavesForMonth(tenantId, month, year, padDays = 0) {
  const startDate = dateStr(new Date(year, month, 1 - padDays));
  const endDate   = dateStr(new Date(year, month + 1, padDays));

  const { data, error } = await supabase
    .from('leave_requests')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'Approved')
    .lte('start_date', endDate)
    .gte('end_date', startDate);
  return { data: data || [], error };
}

/**
 * Weekly offs the sandwich rule counted as leave in a month (0-indexed), with
 * `paid` = whether a balance paid for it (leave_sandwich_days, 20261020_1).
 */
export async function fetchLeaveSandwichDays(tenantId, month, year) {
  const { data, error } = await supabase
    .from('leave_sandwich_days')
    .select('profile_id, date, paid')
    .eq('tenant_id', tenantId)
    .gte('date', dateStr(new Date(year, month, 1)))
    .lte('date', dateStr(new Date(year, month + 1, 0)));
  return { data: data || [], error };
}

/** Returns a map of profileId → approved Comp Off leave days for a given month (0-indexed). */
export async function fetchApprovedCompOffLeavesForMonth(tenantId, month, year) {
  const m = month + 1;
  const startDate = `${year}-${String(m).padStart(2, '0')}-01`;
  const endDate   = new Date(year, month + 1, 0).toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('leave_requests')
    .select('profile_id, start_date, end_date, half_day')
    .eq('tenant_id', tenantId)
    .eq('leave_type', 'Comp Off')
    .eq('status', 'Approved')
    .lte('start_date', endDate)
    .gte('end_date', startDate);

  const [msy, msm, msd] = startDate.split('-').map(Number);
  const [mey, mem, med] = endDate.split('-').map(Number);
  const monthStart = new Date(msy, msm - 1, msd);
  const monthEnd   = new Date(mey, mem - 1, med);

  const byEmployee = {};
  (data || []).forEach(leave => {
    const [lsy, lsm, lsd] = leave.start_date.split('-').map(Number);
    const [ley, lem, led] = leave.end_date.split('-').map(Number);
    const s = new Date(Math.max(new Date(lsy, lsm - 1, lsd), monthStart));
    const e = new Date(Math.min(new Date(ley, lem - 1, led), monthEnd));
    let days = 0;
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) days++;
    if (leave.half_day && days > 0) days = 0.5;
    byEmployee[leave.profile_id] = (byEmployee[leave.profile_id] || 0) + days;
  });

  return { data: byEmployee, error };
}
