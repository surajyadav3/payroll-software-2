import { supabase } from '@/lib/supabase';
import { getLocalDateString } from '@/lib/helpers';

export async function fetchHolidays(tenantId, year, month, outletId) {
  let query = supabase
    .from('holidays')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('date', { ascending: true });

  if (outletId) {
    query = query.or(`outlet_id.is.null,outlet_id.eq.${outletId}`);
  }

  if (year) {
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    query = query.gte('date', start).lte('date', end);
  }

  const { data, error } = await query;
  if (error) {
    console.error('fetchHolidays err:', error);
    return { data: [], error };
  }
  return { data, error: null };
}

/**
 * Holidays of every outlet inside a date range — used by Master Report to keep
 * holidays out of the absentee list. Callers match outlet_id per employee
 * (NULL outlet_id = applies to all outlets).
 */
export async function fetchHolidaysInRange(tenantId, fromDate, toDate) {
  const { data, error } = await supabase
    .from('holidays')
    .select('date, name, outlet_id')
    .eq('tenant_id', tenantId)
    .gte('date', fromDate)
    .lte('date', toDate);
  return { data: data || [], error };
}

/** Today's holiday for a tenant (and outlet, if given), if any — used to trigger the post-login celebration overlay. */
export async function fetchTodayHoliday(tenantId, outletId) {
  if (!tenantId) return { data: null, error: null };
  const today = getLocalDateString();
  let query = supabase
    .from('holidays')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('date', today);

  if (outletId) {
    query = query.or(`outlet_id.is.null,outlet_id.eq.${outletId}`);
  }

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) {
    console.error('fetchTodayHoliday err:', error);
    return { data: null, error };
  }
  return { data, error: null };
}

export async function addHoliday(tenantId, name, date, type = 'Public Holiday', outletId = null) {
  const { data, error } = await supabase
    .from('holidays')
    .insert([{ tenant_id: tenantId, outlet_id: outletId, name, date, type }])
    .select()
    .single();
  return { data, error };
}

export async function deleteHoliday(id) {
  const { error } = await supabase.from('holidays').delete().eq('id', id);
  return { error };
}

// Optional Holidays
export async function fetchMyOptionalHolidays(profileId) {
  const { data, error } = await supabase
    .from('employee_optional_holidays')
    .select('id, holiday_id')
    .eq('profile_id', profileId);
  return { data: data || [], error };
}

export async function addMyOptionalHoliday(tenantId, profileId, holidayId) {
  const { data, error } = await supabase
    .from('employee_optional_holidays')
    .insert([{ tenant_id: tenantId, profile_id: profileId, holiday_id: holidayId }])
    .select()
    .single();
  return { data, error };
}

export async function removeMyOptionalHoliday(id) {
  const { error } = await supabase.from('employee_optional_holidays').delete().eq('id', id);
  return { error };
}
