import { supabase } from '@/lib/supabase';
import { notifyProfiles, notifyRoles, getRequesterLabel } from './notificationService';

export const TRAVEL_MODES = ['Flight', 'Train', 'Bus', 'Cab', 'Own Vehicle', 'Other'];

export async function listMyTravelRequests(profileId) {
  const { data, error } = await supabase
    .from('travel_requests')
    .select('*, legs:travel_legs(*)')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

export async function listTenantTravelRequests(tenantId) {
  const { data, error } = await supabase
    .from('travel_requests')
    .select('*, legs:travel_legs(*), profile:profile_directory!travel_requests_profile_id_fkey(first_name, middle_name, last_name, employee_id, department)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  return { data: data || [], error };
}

export async function createTravelRequest(tenantId, profileId, payload, legs = []) {
  const { data: req, error } = await supabase.from('travel_requests').insert([{
    tenant_id: tenantId, profile_id: profileId, purpose: payload.purpose,
    from_date: payload.from_date, to_date: payload.to_date, estimated_cost: parseFloat(payload.estimated_cost) || 0,
  }]).select().single();
  if (error) return { error };

  if (legs.length) {
    const rows = legs.map((l) => ({ travel_request_id: req.id, from_city: l.from_city, to_city: l.to_city, travel_date: l.travel_date, mode: l.mode }));
    const { error: legErr } = await supabase.from('travel_legs').insert(rows);
    if (legErr) return { error: legErr };
  }

  const requester = await getRequesterLabel(profileId);
  await notifyRoles(tenantId, ['admin', 'manager'], {
    type: 'travel_request_submitted',
    title: 'New travel request',
    body: `${requester} submitted a new travel request (${payload.purpose || ''}) — needs your review.`,
    linkKey: 'travel_requests',
    actorId: profileId,
    relatedId: req.id,
  }, profileId);

  return { error: null, requestId: req.id };
}

export async function updateTravelRequestStatus(id, status, approvedBy) {
  const { data: req } = await supabase.from('travel_requests').select('tenant_id, profile_id').eq('id', id).single();

  const { error } = await supabase.from('travel_requests').update({ status, approved_by: approvedBy }).eq('id', id);

  if (!error && req?.tenant_id && req?.profile_id) {
    await notifyProfiles(req.tenant_id, [req.profile_id], {
      type: `travel_request_${status.toLowerCase()}`,
      title: `Travel request ${status}`,
      body: `Your travel request was ${status.toLowerCase()}.`,
      linkKey: 'travel_requests',
      actorId: approvedBy,
      relatedId: id,
    });
  }
  return { error };
}

export async function deleteTravelRequest(id) {
  const { error } = await supabase.from('travel_requests').delete().eq('id', id);
  return { error };
}
