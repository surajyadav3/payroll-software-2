import { supabase } from '@/lib/supabase';

// Announcements: types, draft / scheduled / live / archived, pinning, expiry, audience,
// acknowledgement receipts (migration 20261008_1_comms_manage_archive).
//
// Who sees what is enforced by the database (RLS): employees only ever receive what is live
// for them. Admins receive everything in their tenant, so the feed below filters to what is
// live; the Manage list shows the rest. Notifications are sent by the database on publish
// (in-app row per audience member -> push), never from here.

export const KINDS = {
  important: { label: 'Important', icon: 'fa-circle-exclamation', badge: 'badge-danger', accent: '#BE123C' },
  update: { label: 'Update', icon: 'fa-bullhorn', badge: 'badge-info', accent: '#5A3FE8' },
  birthday: { label: 'Birthday', icon: 'fa-cake-candles', badge: 'badge-pink', accent: '#E8531F' },
  alert: { label: 'Alert', icon: 'fa-triangle-exclamation', badge: 'badge-warning', accent: '#B45309' },
};

const SELECT = '*, author:profile_directory!announcements_created_by_fkey(first_name, middle_name, last_name)';

// "New" marks are remembered per browser (no read-tracking rows on the server);
// acknowledgements are the only server-side receipts.
const SEEN_KEY = 'cc-announcements-seen';
export function readSeenAnnouncements() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
}
export function markAnnouncementsSeen(ids) {
  const next = readSeenAnnouncements();
  ids.forEach((id) => next.add(id));
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...next].slice(-300))); } catch { /* storage blocked */ }
}

/** Draft / scheduled / live / expired / archived, from the row. */
export function announcementState(a, now = Date.now()) {
  if (a.status === 'draft' || a.status === 'archived') return a.status;
  if (a.publish_at && new Date(a.publish_at).getTime() > now) return 'scheduled';
  if (a.expires_at && new Date(a.expires_at).getTime() <= now) return 'expired';
  return 'live';
}

const pinnedFirst = (x, y) => (y.pinned - x.pinned) || (new Date(y.publish_at || y.created_at) - new Date(x.publish_at || x.created_at));

/**
 * What is live right now — the feed everyone reads (Announcements page, Home).
 * Pinned first, then newest. `limit` caps the rows (Home).
 */
export async function listAnnouncements(tenantId, { limit } = {}) {
  const nowIso = new Date().toISOString();
  let query = supabase
    .from('announcements')
    .select(SELECT)
    .eq('tenant_id', tenantId)
    .eq('status', 'published')
    .or(`publish_at.is.null,publish_at.lte.${nowIso}`)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });
  if (limit) query = query.limit(limit);
  const { data, error } = await query;
  return { data: (data || []).sort(pinnedFirst), error };
}

/** HR: everything — drafts, scheduled, live, expired and archived. */
export async function listManagedAnnouncements(tenantId) {
  const { data, error } = await supabase
    .from('announcements')
    .select(SELECT)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(200);
  return { data: data || [], error };
}

function toRow(f) {
  return {
    title: f.title.trim(),
    body: (f.body || '').trim(),
    kind: f.kind,
    pinned: !!f.pinned,
    requires_ack: !!f.requiresAck,
    audience: f.audience,
    audience_departments: f.audience === 'departments' ? f.departments : [],
    audience_outlets: f.audience === 'outlets' ? f.outlets : [],
    expires_at: f.expiresAt ? new Date(f.expiresAt).toISOString() : null,
  };
}

/**
 * Create an announcement. `when`: 'now' publishes, 'at' schedules for `at`, 'draft' saves a draft.
 * The database notifies the audience when it goes live.
 */
export async function createAnnouncement({ tenantId, createdBy, form }) {
  const row = {
    ...toRow(form),
    tenant_id: tenantId,
    created_by: createdBy,
    status: form.when === 'draft' ? 'draft' : 'published',
    publish_at: form.when === 'at' ? new Date(form.at).toISOString() : null,
  };
  const { data, error } = await supabase.from('announcements').insert([row]).select('id').single();
  return { data, error };
}

/** Edit the content of a draft, scheduled or live announcement (archived ones are locked by the DB). */
export async function updateAnnouncement(id, form) {
  const { error } = await supabase.from('announcements').update(toRow(form)).eq('id', id);
  return { error };
}

/** Publish a draft now, or schedule it for `at`. */
export async function publishAnnouncement(id, at = null) {
  const { error } = await supabase
    .from('announcements')
    .update({ status: 'published', publish_at: at ? new Date(at).toISOString() : null })
    .eq('id', id);
  return { error };
}

/** Take it out of everyone's feed; kept for the record and can be restored. */
export async function archiveAnnouncement(id) {
  const { error } = await supabase.from('announcements').update({ status: 'archived', pinned: false }).eq('id', id);
  return { error };
}

/** Bring an archived announcement back as a draft. Re-publishing it doesn't notify anyone again. */
export async function restoreAnnouncement(id) {
  const { error } = await supabase.from('announcements').update({ status: 'draft' }).eq('id', id);
  return { error };
}

export async function setAnnouncementPinned(id, pinned) {
  const { error } = await supabase.from('announcements').update({ pinned }).eq('id', id);
  return { error };
}

/** Admin-only: delete permanently (acknowledgements go with it). */
export async function deleteAnnouncement(id) {
  const { error } = await supabase.from('announcements').delete().eq('id', id);
  return { error };
}

/** HR: everyone in the audience, with when they acknowledged (null = not yet). */
export async function getAnnouncementReceipts(id) {
  const { data, error } = await supabase.rpc('announcement_receipts', { p_id: id });
  return { data: data || [], error };
}

/** Records that a user has read & acknowledged an announcement. Idempotent — re-acknowledging is a silent no-op. */
export async function acknowledgeAnnouncement(announcementId, profileId, tenantId) {
  const { error } = await supabase
    .from('announcement_acknowledgements')
    .upsert([{ announcement_id: announcementId, profile_id: profileId, tenant_id: tenantId }], {
      onConflict: 'announcement_id,profile_id',
      ignoreDuplicates: true,
    });
  return { error };
}

/** Map of announcementId -> acknowledged_at for the current user's own acknowledgements. */
export async function listMyAcknowledgements(tenantId, profileId) {
  const { data, error } = await supabase
    .from('announcement_acknowledgements')
    .select('announcement_id, acknowledged_at')
    .eq('tenant_id', tenantId)
    .eq('profile_id', profileId);

  const map = {};
  (data || []).forEach((row) => { map[row.announcement_id] = row.acknowledged_at; });
  return { data: map, error };
}

/** Map of announcementId -> acknowledgement count, for the admin view. */
export async function countAcknowledgements(tenantId) {
  const { data, error } = await supabase
    .from('announcement_acknowledgements')
    .select('announcement_id')
    .eq('tenant_id', tenantId);

  const map = {};
  (data || []).forEach((row) => { map[row.announcement_id] = (map[row.announcement_id] || 0) + 1; });
  return { data: map, error };
}

/** Tenant switch for the daily automatic Birthday posts. */
export async function setAutoBirthdayPosts(tenantId, enabled) {
  const { error } = await supabase.from('tenants').update({ auto_birthday_posts: enabled }).eq('id', tenantId);
  return { error };
}

// ───────────────────────── birthday card photos (20261028_4) ─────────────────────────
// HR's photo per employee, private bucket birthday-photos/<tenant>/<profile>-<time>.jpg. A new
// file name per upload, so a changed photo is never served from cache.
const PHOTO_BUCKET = 'birthday-photos';
const photoUrls = new Map();

/** Signed URL for a stored photo (cached for the visit; valid 6 h). */
export async function birthdayPhotoUrl(path) {
  if (!path) return null;
  if (!photoUrls.has(path)) {
    photoUrls.set(path, supabase.storage.from(PHOTO_BUCKET).createSignedUrl(path, 6 * 3600)
      .then(({ data }) => data?.signedUrl || null));
  }
  return photoUrls.get(path);
}

/** Photo path per profile id, for HR's Birthday cards list. */
export async function listBirthdayPhotos(profileIds) {
  if (!profileIds.length) return { data: {}, error: null };
  const { data, error } = await supabase.from('profiles').select('id, birthday_photo').in('id', profileIds);
  const map = {};
  (data || []).forEach((r) => { map[r.id] = r.birthday_photo; });
  return { data: map, error };
}

/** Upload (blob = compressed JPEG) or remove (blob = null) an employee's birthday photo. */
export async function setBirthdayPhoto(tenantId, profileId, blob, oldPath) {
  let path = null;
  if (blob) {
    path = `${tenantId}/${profileId}-${Date.now()}.jpg`;
    const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg' });
    if (error) return { error };
  }
  const { error } = await supabase.rpc('set_birthday_photo', { p_profile: profileId, p_path: path });
  if (error) {
    if (path) await supabase.storage.from(PHOTO_BUCKET).remove([path]);
    return { error };
  }
  if (oldPath) await supabase.storage.from(PHOTO_BUCKET).remove([oldPath]);
  return { data: path, error: null };
}
