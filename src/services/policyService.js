import { supabase } from '@/lib/supabase';
import { notifyRoles } from './notificationService';
import { fullName } from '@/lib/helpers';

const BUCKET = 'policy-pdfs';

// Policies: category, summary, draft / published / archived, must-acknowledge, versions with a
// "what changed" note (migration 20261008_1_comms_manage_archive). Employees only ever receive
// published policies (RLS); the database notifies everyone when one goes live or gets a new version.

export const POLICY_CATEGORIES = {
  general: 'General', hr: 'HR', leave: 'Leave', attendance: 'Attendance', conduct: 'Code of conduct',
  it: 'IT & security', travel: 'Travel', finance: 'Finance & expenses', safety: 'Health & safety',
};

const SELECT = '*, author:profile_directory!policies_created_by_fkey(first_name, middle_name, last_name)';

/** The policy library everyone reads: published only, newest first. */
export async function listPolicies(tenantId) {
  const { data, error } = await supabase
    .from('policies')
    .select(SELECT)
    .eq('tenant_id', tenantId)
    .eq('status', 'published')
    .order('published_at', { ascending: false, nullsFirst: false });
  return { data: data || [], error };
}

/** HR: every policy, drafts and archived included. */
export async function listManagedPolicies(tenantId) {
  const { data, error } = await supabase
    .from('policies')
    .select(SELECT)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

async function uploadAttachment(tenantId, file) {
  const path = `${tenantId}/${Date.now()}-${file.name}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type || 'application/octet-stream' });
  if (error) return { error };
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return { pdf_url: pub.publicUrl, pdf_name: file.name };
}

const toRow = (f) => ({
  title: f.title.trim(),
  body: (f.body || '').trim(),
  category: f.category,
  summary: f.summary?.trim() || null,
  requires_ack: !!f.requiresAck,
});

/**
 * Admin-only: create a policy, optionally with a PDF / photo. `publish` false saves a draft
 * nobody sees yet; true publishes it (the database notifies everyone).
 */
export async function createPolicy({ tenantId, createdBy, form, pdfFile, publish }) {
  let file = { pdf_url: '', pdf_name: '' };
  if (pdfFile) {
    const up = await uploadAttachment(tenantId, pdfFile);
    if (up.error) return { error: up.error };
    file = up;
  }
  const { error } = await supabase
    .from('policies')
    .insert([{ ...toRow(form), ...file, tenant_id: tenantId, created_by: createdBy, status: publish ? 'published' : 'draft' }]);
  return { error };
}

/** Admin-only: edit a policy's text / attachment in place (no new version, nobody re-asked). */
export async function updatePolicy({ tenantId, id, form, pdfFile, removeFile }) {
  const row = toRow(form);
  if (pdfFile) {
    const up = await uploadAttachment(tenantId, pdfFile);
    if (up.error) return { error: up.error };
    Object.assign(row, up);
  } else if (removeFile) {
    Object.assign(row, { pdf_url: '', pdf_name: '' });
  }
  const { error } = await supabase.from('policies').update(row).eq('id', id);
  return { error };
}

/**
 * Admin-only: publish what is now saved as the next version, with a note on what changed.
 * `reask` clears everyone's acknowledgement so they confirm the new version (old count kept in history).
 */
export async function publishPolicyVersion(id, changeNote, reask = true) {
  const { data, error } = await supabase.rpc('policy_new_version', { p_policy_id: id, p_change_note: changeNote, p_reask: reask });
  return { data, error };
}

export async function setPolicyStatus(id, status) {
  const { error } = await supabase.from('policies').update({ status }).eq('id', id);
  return { error };
}

/** Admin-only: delete a policy roll-out. */
export async function deletePolicy(id) {
  const { error } = await supabase.from('policies').delete().eq('id', id);
  return { error };
}

/**
 * Records that a user has read & acknowledged a policy. Idempotent —
 * re-acknowledging is a silent no-op. Notifies HR/admins of who
 * acknowledged, and when, so they don't have to go check.
 */
export async function acknowledgePolicy(policyId, profile, tenantId, policyTitle) {
  const { error } = await supabase
    .from('policy_acknowledgements')
    .upsert([{ policy_id: policyId, profile_id: profile.id, tenant_id: tenantId, source: 'web' }], {
      onConflict: 'policy_id,profile_id',
      ignoreDuplicates: true,
    });

  if (!error) {
    await notifyRoles(tenantId, ['admin'], {
      type: 'policy_ack',
      title: 'Policy acknowledged',
      body: `${fullName(profile)} acknowledged "${policyTitle}"`,
      linkKey: 'policies',
      actorId: profile.id,
      relatedId: policyId,
    }, profile.id);
  }

  return { error };
}

/** Map of policyId -> acknowledged_at for the current user's own acknowledgements. */
export async function listMyAcknowledgements(tenantId, profileId) {
  const { data, error } = await supabase
    .from('policy_acknowledgements')
    .select('policy_id, acknowledged_at')
    .eq('tenant_id', tenantId)
    .eq('profile_id', profileId);

  const map = {};
  (data || []).forEach((row) => { map[row.policy_id] = row.acknowledged_at; });
  return { data: map, error };
}

/** Map of policyId -> acknowledgement count, for the admin summary badge. */
export async function countAcknowledgements(tenantId) {
  const { data, error } = await supabase
    .from('policy_acknowledgements')
    .select('policy_id')
    .eq('tenant_id', tenantId);

  const map = {};
  (data || []).forEach((row) => { map[row.policy_id] = (map[row.policy_id] || 0) + 1; });
  return { data: map, error };
}

/**
 * Logs that the current user downloaded/opened a policy's attachment
 * (policy_downloads keeps one row per download — table owned by the app
 * team's policy_ack_source_and_downloads migration). Fire-and-forget: a
 * failure never blocks the download itself.
 */
export async function recordPolicyDownload(policyId, profileId, tenantId) {
  const { error } = await supabase
    .from('policy_downloads')
    .insert([{ policy_id: policyId, profile_id: profileId, tenant_id: tenantId, source: 'web' }]);
  return { error };
}

/**
 * Admin-only: per-employee status for one policy — who acknowledged and/or
 * downloaded it, when, and from which device (web or mobile app). Returns
 * two maps keyed by profile_id; the page joins them onto the employee list
 * so HR also sees who has NOT done either yet.
 */
export async function fetchPolicyAudit(policyId) {
  const [acks, downloads] = await Promise.all([
    supabase.from('policy_acknowledgements').select('profile_id, acknowledged_at, source').eq('policy_id', policyId),
    // Ascending, so toMap's last-write-wins keeps each person's latest download.
    supabase.from('policy_downloads').select('profile_id, downloaded_at, source').eq('policy_id', policyId).order('downloaded_at'),
  ]);
  const toMap = (rows) => Object.fromEntries((rows || []).map((r) => [r.profile_id, r]));
  return {
    acks: toMap(acks.data),
    downloads: toMap(downloads.data),
    error: acks.error || downloads.error,
  };
}
