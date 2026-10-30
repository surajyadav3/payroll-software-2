import { supabase } from '@/lib/supabase';
import { getOrCreateQuota, determineApproverRole, incrementSelfCount, incrementManagerCount, SELF_LIMIT } from './requestQuotaService';
import { notifyProfiles, notifyRoles, withHrRole, getRequesterLabel } from './notificationService';

/**
 * Fetch special requests for a tenant. Returns every request regardless of
 * status or approval tier (Pending/Approved/Rejected, self/manager/admin) --
 * managers need visibility into auto-approved and admin-approved requests
 * too, not just the ones routed to them for action. Callers gate the
 * Approve/Reject actions themselves based on required_approver_role.
 */
export async function listAllSpecialRequests(tenantId) {
  const { data, error } = await supabase
    .from('special_requests')
    .select(`
      *,
      profile:profiles!special_requests_profile_id_fkey(first_name, middle_name, last_name, department, ctc, employee_id),
      approver:profile_directory!special_requests_approved_by_fkey(first_name, middle_name, last_name)
    `)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  return { data: data || [], error };
}

/** Fetch special requests for the current employee. */
export async function listMySpecialRequests(profileId) {
  const { data, error } = await supabase
    .from('special_requests')
    .select('*')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

/**
 * Submit a special request with tiered quota routing.
 * `tenantSettings` carries the superadmin-configured auto-approval controls
 * (Toggle Services → Special Requests Auto-Approval): pass
 * `{ autoApprovalEnabled, autoApprovalLimit }` from the caller's already-loaded
 * tenant record. A tenant with auto-approval turned off gets selfLimit 0, so
 * every request skips straight to manager/admin.
 * Returns { error, tier } where tier is 'self' | 'manager' | 'admin'.
 */
export async function submitSpecialRequest(payload, tenantSettings = {}) {
  const { tenant_id, profile_id, request_type, request_date } = payload;

  // Block resubmission of the same request type for a date that already has
  // a Pending or Approved request -- once reviewed (or awaiting review)
  // there's nothing left to request, and without this an employee could
  // spam the same date/type over and over after it's already been approved.
  const { data: existing } = await supabase
    .from('special_requests')
    .select('id, status')
    .eq('profile_id', profile_id)
    .eq('request_date', request_date)
    .eq('request_type', request_type)
    .in('status', ['Pending', 'Approved'])
    .limit(1);

  if (existing?.length > 0) {
    const status = existing[0].status;
    return {
      error: new Error(
        status === 'Approved'
          ? `Your ${request_type} request for ${request_date} has already been approved — no need to request again.`
          : `You already have a pending ${request_type} request for ${request_date}.`
      ),
    };
  }

  const selfLimit = tenantSettings.autoApprovalEnabled === false
    ? 0
    : (tenantSettings.autoApprovalLimit ?? SELF_LIMIT);

  const quota = await getOrCreateQuota(tenant_id, profile_id);
  const tier  = determineApproverRole(quota, selfLimit);

  const finalPayload = {
    ...payload,
    status:                 tier === 'self' ? 'Approved' : 'Pending',
    required_approver_role: tier,
    approval_level:         tier === 'self' ? 'self' : null,
  };

  const { data: inserted, error } = await supabase.from('special_requests').insert([finalPayload]).select('id, status, required_approver_role').single();

  // enforce_special_request_approval_tier (see
  // 20260903_5_server_side_regularize_special_approval_enforcement.sql)
  // re-derives the tier from the tenant's *current* settings and may
  // silently overwrite status/required_approver_role if this client's view
  // was stale. Trust what actually landed in the row, not the pre-insert
  // guess above — otherwise a request the server downgraded to Pending
  // would still show an "auto-approved" toast and never consume its
  // self-approval quota.
  const actualTier = inserted?.required_approver_role || tier;

  if (!error && actualTier === 'self') {
    await incrementSelfCount(tenant_id, profile_id);
  }

  if (!error && inserted?.id) {
    const requester = await getRequesterLabel(profile_id);
    if (actualTier === 'self') {
      await notifyProfiles(tenant_id, [profile_id], {
        type: 'special_request_auto_approved',
        title: 'Special request auto-approved',
        body: `Your ${payload.request_type || ''} request was automatically approved.`,
        linkKey: 'special_requests',
        relatedId: inserted.id,
      });
      await notifyRoles(tenant_id, ['admin'], {
        type: 'special_request_auto_approved',
        title: 'Special request auto-approved',
        body: `${requester} submitted a ${payload.request_type || ''} request — auto-approved, no action needed.`,
        linkKey: 'special_requests',
        actorId: profile_id,
        relatedId: inserted.id,
      }, profile_id);
    } else {
      await notifyRoles(tenant_id, withHrRole([actualTier]), {
        type: 'special_request_submitted',
        title: 'New special request',
        body: `${requester} submitted a new ${payload.request_type || ''} request — needs your review.`,
        linkKey: 'special_requests',
        actorId: profile_id,
        relatedId: inserted.id,
      }, profile_id);
    }
  }

  return { error, tier: actualTier };
}

/**
 * Approve or reject a special request.
 * approverRole: 'manager' | 'admin' | 'superadmin'
 * When manager approves, increments that employee's manager quota.
 */
export async function updateSpecialRequestStatus(id, status, approverId, approverRole = 'admin') {
  const { data: req } = await supabase
    .from('special_requests')
    .select('profile_id, tenant_id')
    .eq('id', id)
    .single();

  // Only transition a request that's still Pending — prevents a double-clicked Approve
  // from crediting the manager quota (or, for Salary Overtime, payroll) twice.
  const { data: updated, error } = await supabase
    .from('special_requests')
    .update({ status, approved_by: approverId })
    .eq('id', id)
    .eq('status', 'Pending')
    .select('id');

  if (!error && updated?.length === 0) {
    return { error: new Error('This request has already been reviewed.') };
  }

  if (!error && status === 'Approved' && approverRole === 'manager' && req?.tenant_id) {
    await incrementManagerCount(req.tenant_id, req.profile_id);
  }

  if (!error && req?.tenant_id && req?.profile_id) {
    await notifyProfiles(req.tenant_id, [req.profile_id], {
      type: `special_request_${status.toLowerCase()}`,
      title: `Special request ${status}`,
      body: `Your special request was ${status.toLowerCase()}.`,
      linkKey: 'special_requests',
      actorId: approverId,
      relatedId: id,
    });
  }

  return { error };
}
