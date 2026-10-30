import { supabase } from '@/lib/supabase';
import { notifyProfiles, notifyRoles, withHrRole, getRequesterLabel } from './notificationService';

const SELECT = `
  *,
  profile:profile_directory!profile_verification_requests_profile_id_fkey(first_name, middle_name, last_name, department, designation, employee_id),
  reviewer:profile_directory!profile_verification_requests_reviewed_by_fkey(first_name, middle_name, last_name, role)
`;

const FIELD_GROUP_LABEL = { bank: 'Bank Details', pan: 'PAN', aadhar: 'Aadhar', dob: 'Date of Birth' };

/** Admin/Manager: all verification requests for a tenant, newest first. */
export async function listAllVerificationRequests(tenantId) {
  const { data, error } = await supabase
    .from('profile_verification_requests')
    .select(SELECT)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

/** Employee: their own verification requests, newest first (submitted from the app or the web Welcome tab). */
export async function listMyVerificationRequests(profileId) {
  const { data, error } = await supabase
    .from('profile_verification_requests')
    .select('*')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

/**
 * Approve/reject in one DB transaction (review_verification_request,
 * 20260923_5_profile_verification_review.sql): claims the Pending request,
 * and on approval copies the new values into profiles and stamps the field
 * group's *_verified_at. Only HR (admin) or the employee's own reporting
 * manager may review — enforced server-side.
 */
async function reviewVerificationRequest(requestId, approve) {
  const { error } = await supabase.rpc('review_verification_request', { p_request_id: requestId, p_approve: approve });
  return { error: error ? new Error(error.message) : null };
}

export async function approveVerificationRequest(request, reviewerId) {
  const { error } = await reviewVerificationRequest(request.id, true);
  if (error) return { error };

  await notifyProfiles(request.tenant_id, [request.profile_id], {
    type: 'verification_request_approved',
    title: `${FIELD_GROUP_LABEL[request.field_group]} verified`,
    body: `Your updated ${FIELD_GROUP_LABEL[request.field_group]} was approved and is now verified.`,
    linkKey: 'verification_requests',
    actorId: reviewerId,
    relatedId: request.id,
  });
  return { error: null };
}

export async function rejectVerificationRequest(request, reviewerId) {
  const { error } = await reviewVerificationRequest(request.id, false);
  if (error) return { error };

  await notifyProfiles(request.tenant_id, [request.profile_id], {
    type: 'verification_request_rejected',
    title: `${FIELD_GROUP_LABEL[request.field_group]} change rejected`,
    body: `Your requested ${FIELD_GROUP_LABEL[request.field_group]} change was rejected. Your previous details remain verified.`,
    linkKey: 'verification_requests',
    actorId: reviewerId,
    relatedId: request.id,
  });
  return { error: null };
}

/**
 * Employee: stages a Bank/PAN/Aadhar change for HR review — never writes to
 * profiles (RLS only allows inserting your own row as Pending). Used by the
 * mobile app's Profile tab and the web Welcome tab. One Pending request per
 * field group (DB unique index → error code 23505).
 *
 * Raniwala (20261024_3): the DB applies it at once and returns the row as
 * Approved (self-verified, DOB too) — nothing for HR to review, so no notice.
 */
export async function submitVerificationRequest({ tenantId, profileId, fieldGroup, oldValue, newValue }) {
  const { data, error } = await supabase
    .from('profile_verification_requests')
    .insert([{ tenant_id: tenantId, profile_id: profileId, field_group: fieldGroup, old_value: oldValue, new_value: newValue }])
    .select()
    .single();

  if (!error && data?.id && data.status === 'Pending') {
    const requester = await getRequesterLabel(profileId);
    const opts = {
      type: 'verification_request_submitted',
      title: `New ${FIELD_GROUP_LABEL[fieldGroup]} verification request`,
      body: `${requester} updated their ${FIELD_GROUP_LABEL[fieldGroup]} — needs your review.`,
      linkKey: 'verification_requests',
      actorId: profileId,
      relatedId: data.id,
    };
    // HR plus this employee's own reporting manager — not every manager.
    await notifyRoles(tenantId, withHrRole([]), opts, profileId);
    const { data: me } = await supabase.from('profile_directory').select('manager_id').eq('id', profileId).maybeSingle();
    if (me?.manager_id) await notifyProfiles(tenantId, [me.manager_id], opts);
  }
  if (error?.code === '23505') {
    return { data: null, error: new Error(`You already have a pending ${FIELD_GROUP_LABEL[fieldGroup]} request awaiting review.`) };
  }
  return { data, error };
}

/** Employee: withdraw their own still-Pending request (RLS: own + Pending only). */
export async function cancelVerificationRequest(id) {
  const { error } = await supabase.from('profile_verification_requests').delete().eq('id', id).eq('status', 'Pending');
  return { error };
}
