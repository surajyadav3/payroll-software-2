import { supabase } from '@/lib/supabase';
import { todayStr, timeStr, diffHours, checkGeofenceMulti, geofenceIsConfigured, computeEarlyLateBreach } from '@/lib/helpers';
import { getOrCreateQuota, determineApproverRole, incrementSelfCount, incrementManagerCount, SELF_LIMIT } from './requestQuotaService';
import { resolveAttendanceSettings, listAccessibleOutlets, getOutlet } from './tenantService';
import { isFeatureEnabledForOutlet } from './featureService';
import { getApprovedWfhForDate } from './wfhService';
import { notifyProfiles, notifyRoles, withHrRole, getRequesterLabel } from './notificationService';

/** Full month attendance (with punches) for one employee — used in calendar views. */
export async function fetchMyMonthAttendance(profileId, year, month) {
  const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const endDay    = new Date(year, month + 1, 0).getDate();
  const endDate   = `${year}-${String(month + 1).padStart(2, '0')}-${endDay}`;

  const { data, error } = await supabase
    .from('attendance')
    .select('*, punches(*)')
    .eq('profile_id', profileId)
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date');
  return { data: data || [], error };
}

/** Clock in for today. Creates or reuses the attendance row, then inserts a punch-in. */
export async function clockIn(tenantId, profileId, tenant, locationData = null) {
  const today = todayStr();

  // Custom shift logic — computed unconditionally so the upsert below has a full
  // row ready; on conflict (row already exists) it's ignored and the existing
  // row's status/location are left untouched.
  const { data: profile } = await supabase.from('profiles').select('shift_id, outlet_id').eq('id', profileId).single();
  const { data: outlet } = await getOutlet(profile?.outlet_id);
  const attSettings = resolveAttendanceSettings(tenant, outlet);
  let shiftStart = attSettings.shift_start;
  let lateMin    = attSettings.late_threshold;
  if (profile?.shift_id) {
    const { data: shift } = await supabase.from('shifts').select('start_time').eq('id', profile.shift_id).single();
    if (shift) shiftStart = shift.start_time;
  }

  const [sh, sm] = shiftStart.split(':').map(Number);
  const now      = new Date();
  const diffMin  = (now.getHours() * 60 + now.getMinutes()) - (sh * 60 + sm);
  // Fixed rule, every day of the month: later than Report Time + Late Allowed
  // minutes is Late, full stop — no monthly grace waiver on top of this.
  let status     = diffMin > lateMin ? 'Late' : 'Present';

  // Authoritative, server-side geofence check for clock-IN. The dashboard already
  // gates this client-side (useGeofenceClock), but a client can't be trusted to
  // enforce it honestly — flaky/backgrounded mobile geolocation, a stale watch
  // position, or a directly-called API request can all skip that check — so this
  // re-verifies and actually rejects the punch, rather than merely flagging it.
  // Passes if inside ANY of the employee's accessible outlets (home outlet + any
  // extra multi-outlet access grants, or every outlet when the tenant has
  // "allow_any_outlet_clockin" on), not just their single home outlet. Approved
  // WFH for today lifts the requirement entirely, same as the client. A
  // superadmin turning the 'geofencing' feature off for this employee's home
  // outlet (Toggle Services > Geofencing > Scope) lifts it too — mirrors
  // outlet_geofencing_enabled()/profile_punch_is_inside_geofence() in
  // 20260918_1_outlet_geofencing_toggle.sql, which enforces the same rule at
  // the DB layer for the raw INSERT.
  const [{ data: accessibleOutlets }, { data: approvedWfh }, geofencingOn] = await Promise.all([
    listAccessibleOutlets(profileId, profile?.outlet_id, tenant),
    getApprovedWfhForDate(profileId, today),
    isFeatureEnabledForOutlet(tenantId, profile?.outlet_id, 'geofencing'),
  ]);

  let outOfGeofence = false;
  if (!approvedWfh && geofencingOn && geofenceIsConfigured(accessibleOutlets, tenant)) {
    if (locationData?.lat == null || locationData?.lng == null) {
      throw new Error('Location is required to clock in. Please allow location access and try again.');
    }
    outOfGeofence = checkGeofenceMulti(locationData.lat, locationData.lng, accessibleOutlets, tenant);
    if (outOfGeofence === true) {
      throw new Error('You are outside all of your allowed clock-in locations. Move inside one of them and try again.');
    }
    outOfGeofence = false; // reached only when inside a fence or not configured
  }

  // Atomic create-if-missing on (profile_id, date) — a select-then-insert here let a
  // double-tap (or slow network + retry) create two attendance rows for the same day.
  const { error: upsertErr } = await supabase
    .from('attendance')
    .upsert(
      [{
        tenant_id: tenantId,
        profile_id: profileId,
        date: today,
        status,
        location: 'Office',
        punch_in_lat: locationData?.lat,
        punch_in_lng: locationData?.lng,
        out_of_geofence: outOfGeofence,
      }],
      { onConflict: 'profile_id,date', ignoreDuplicates: true }
    );
  if (upsertErr) throw upsertErr;

  const { data: att, error: fetchErr } = await supabase
    .from('attendance')
    .select('id')
    .eq('profile_id', profileId)
    .eq('date', today)
    .single();
  if (fetchErr) throw fetchErr;

  const { error: punchErr } = await supabase
    .from('punches')
    .insert([{ attendance_id: att.id, punch_time: timeStr(new Date()), punch_type: 'in', source: 'app' }]);
  if (punchErr) throw punchErr;

  // Comp off for working a weekly off / holiday is credited by the DB
  // (trg_comp_off_credit_from_hours, 20260928_4) from the day's hours, for
  // comp-off-eligible employees — nothing to grant here.

  await notifyProfiles(tenantId, [profileId], {
    type: 'clock_in',
    title: 'Clocked in',
    body: `You clocked in at ${timeStr(new Date())}.`,
    linkKey: 'attendance',
  });
}

/**
 * Clock out for today. Inserts punch-out and recalculates total_hours + status.
 *
 * `allowOutsideGeofence` exists ONLY for the automatic safety-net clock-out
 * fired by useGeofenceClock when someone has been outside every allowed fence
 * for AUTO_CLOCKOUT_GRACE_MS straight (see doAutoClockOut in the dashboard
 * pages) — that call reports genuinely-outside coordinates in order to END an
 * out-of-bounds session, which is the opposite of the fraud this check exists
 * to stop, so it must always be able to go through. A manual, user-initiated
 * clock-out must never set this flag.
 */
export async function clockOut(profileId, locationData = null, { allowOutsideGeofence = false } = {}) {
  const today = todayStr();

  const { data: att, error: fetchErr } = await supabase
    .from('attendance')
    .select('id, tenant_id, status, profile:profiles!attendance_profile_id_fkey(outlet_id, shift_id)')
    .eq('profile_id', profileId)
    .eq('date', today)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!att) throw new Error('No clock-in found for today. Please clock in first.');

  // Thresholds: the employee's home outlet override, falling back to the tenant default.
  const outletId = att.profile?.outlet_id;
  const shiftId = att.profile?.shift_id;
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, min_half_day_hours, min_full_day_hours, geofence_lat, geofence_lng, geofence_radius, allow_any_outlet_clockin')
    .eq('id', att.tenant_id)
    .single();
  const [{ data: outlet }, { data: accessibleOutlets }, { data: approvedWfh }, { data: shift }, geofencingOn] = await Promise.all([
    outletId
      ? supabase.from('outlets').select('min_half_day_hours, min_full_day_hours, geofence_lat, geofence_lng, geofence_radius').eq('id', outletId).maybeSingle()
      : Promise.resolve({ data: null }),
    listAccessibleOutlets(profileId, outletId, tenant),
    getApprovedWfhForDate(profileId, today),
    shiftId
      ? supabase.from('shifts').select('start_time, end_time, early_departure_after, late_arrival_allowance_until').eq('id', shiftId).maybeSingle()
      : Promise.resolve({ data: null }),
    isFeatureEnabledForOutlet(att.tenant_id, outletId, 'geofencing'),
  ]);

  // Authoritative, server-side geofence check for clock-OUT — same rule as
  // clock-IN (see comment there, including the 'geofencing' per-outlet
  // toggle). Previously this only *flagged* out_of_geofence and let the
  // punch-out through regardless, which meant an employee could leave the
  // premises and still clock out from anywhere; now it's rejected outright,
  // same as clock-in, unless this is the automatic safety-net clock-out (see
  // allowOutsideGeofence doc above).
  let outOfGeofence = false;
  if (!allowOutsideGeofence && !approvedWfh && geofencingOn && geofenceIsConfigured(accessibleOutlets, tenant)) {
    if (locationData?.lat == null || locationData?.lng == null) {
      throw new Error('Location is required to clock out. Please allow location access and try again.');
    }
    if (checkGeofenceMulti(locationData.lat, locationData.lng, accessibleOutlets, tenant) === true) {
      throw new Error('You are outside all of your allowed clock-in locations. Move inside one of them and try again.');
    }
  } else if (allowOutsideGeofence) {
    outOfGeofence = checkGeofenceMulti(locationData?.lat, locationData?.lng, accessibleOutlets, tenant) === true;
  }

  const punchOutTime = timeStr(new Date());
  const { error: punchErr } = await supabase
    .from('punches')
    .insert([{ attendance_id: att.id, punch_time: punchOutTime, punch_type: 'out', source: 'app' }]);
  if (punchErr) throw punchErr;

  const { data: allPunches, error: allErr } = await supabase
    .from('punches')
    .select('*')
    .eq('attendance_id', att.id)
    .order('punch_time');
  if (allErr) throw allErr;

  // First punch of the day to the last, of EITHER type — not paired in/out
  // sessions. A double-tap on Clock In/Out, or a mistaken extra clock-in
  // after already clocking out, is still stored in `punches` above, it just
  // no longer shifts every later in/out pairing by one slot and skews the
  // total (mirrors trg_recompute_attendance_from_punches, the actual source
  // of truth for this employee's own row — see that migration).
  const sortedTimes = allPunches.map((p) => p.punch_time).sort();
  const firstPunch = sortedTimes[0];
  const lastPunch  = sortedTimes[sortedTimes.length - 1];
  const total = diffHours(firstPunch, lastPunch);

  const {
    min_half_day_hours: halfMin, min_full_day_hours: fullMin,
    shift_start: resolvedShiftStart, shift_end: resolvedShiftEnd,
  } = resolveAttendanceSettings(tenant, outlet);

  let status = 'Absent';
  if (total >= fullMin) {
    status = 'Present';
  } else if (total >= halfMin) {
    status = 'Half Day';
  }
  // A day that was already marked 'Late' at clock-in stays 'Late' once the
  // employee has put in a full day's hours — clocking out must never quietly
  // erase the late arrival. A short day (Half Day/Absent) still wins, since
  // leaving early on top of arriving late is a bigger problem than either alone.
  if (att.status === 'Late' && status === 'Present') {
    status = 'Late';
  }

  // One-time-per-calendar-month allowance for an extreme early departure or
  // extreme late arrival (per-shift, opt-in via shifts.early_departure_after /
  // late_arrival_allowance_until). The first breach in the month keeps the
  // status computed above; any further breach forces Half Day.
  let allowanceUsed = false;
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const isEarlyDeparture = !!(shift?.early_departure_after && toMin(lastPunch) < toMin(shift.early_departure_after));
  const isExtremeLateArrival = !!(shift?.late_arrival_allowance_until && toMin(firstPunch) > toMin(shift.late_arrival_allowance_until));
  if ((isEarlyDeparture || isExtremeLateArrival) && status !== 'Absent') {
    const monthStart = `${today.slice(0, 7)}-01`;
    const { count: allowanceCount } = await supabase
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('profile_id', profileId)
      .eq('monthly_allowance_used', true)
      .gte('date', monthStart)
      .lte('date', today);
    if (!allowanceCount) {
      allowanceUsed = true;
    } else {
      status = 'Half Day';
    }
  }

  // Early Left / Late Arrival monthly-grace counter — independent, additive,
  // visibility-only (see computeEarlyLateBreach doc). The employee's own
  // shift override, falling back to the outlet/tenant resolution, gives the
  // shift boundaries the 90-minute rule is measured against.
  const effectiveShiftStart = shift?.start_time || resolvedShiftStart;
  const effectiveShiftEnd   = shift?.end_time   || resolvedShiftEnd;
  let earlyLateFlag = false;
  let earlyLateGraced = false;
  if (computeEarlyLateBreach(firstPunch, lastPunch, effectiveShiftStart, effectiveShiftEnd)) {
    const monthStart = `${today.slice(0, 7)}-01`;
    const { count: breachCount } = await supabase
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('profile_id', profileId)
      // Any earlier breach day this month — graced OR counted. Counting only
      // flagged rows kept the count at 0 after the graced first breach, so
      // every breach in the month was graced. Today excluded so a re-punch
      // on the same day doesn't count itself.
      .or('early_late_flag.eq.true,early_late_graced.eq.true')
      .gte('date', monthStart)
      .lt('date', today);
    if (!breachCount) {
      earlyLateGraced = true;
    } else {
      earlyLateFlag = true;
    }
  }

  await supabase
    .from('attendance')
    .update({
      total_hours: Math.round(total * 100) / 100,
      status,
      monthly_allowance_used: allowanceUsed,
      early_late_flag: earlyLateFlag,
      early_late_graced: earlyLateGraced,
      punch_out_lat: locationData?.lat,
      punch_out_lng: locationData?.lng,
      ...(outOfGeofence ? { out_of_geofence: true } : {}),
    })
    .eq('id', att.id);

  await notifyProfiles(att.tenant_id, [profileId], {
    type: 'clock_out',
    title: 'Clocked out',
    body: `You clocked out. Total hours today: ${(Math.round(total * 100) / 100).toFixed(2)}.`,
    linkKey: 'attendance',
  });

  return { total };
}

/** Team attendance snapshot for a specific date (admin view). */
export async function fetchTeamAttendance(tenantId, date) {
  const [empsRes, deptsRes, attRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('tenant_id', tenantId).eq('status', 'Active'),
    supabase.from('departments').select('name').eq('tenant_id', tenantId),
    // day_shift: the shift picked from the day's punches (20261024_8).
    supabase.from('attendance').select('*, punches(*), day_shift:shifts(name, start_time, end_time)').eq('tenant_id', tenantId).eq('date', date),
  ]);

  return {
    employees:   empsRes.data   || [],
    departments: (deptsRes.data || []).map((d) => d.name),
    records:     attRes.data    || [],
    error:       empsRes.error || deptsRes.error || attRes.error,
  };
}

export async function fetchTodayAttendanceSummary(tenantId, date, outletProfileIds = null) {
  let profilesQuery = supabase.from('profiles').select('id').eq('tenant_id', tenantId).eq('status', 'Active');
  if (outletProfileIds) profilesQuery = profilesQuery.in('id', [...outletProfileIds]);

  const [profilesRes, attendanceRes] = await Promise.all([
    profilesQuery,
    supabase.from('attendance').select('profile_id, status').eq('tenant_id', tenantId).eq('date', date),
  ]);

  const error = profilesRes.error || attendanceRes.error;
  const statusMap = {};
  (attendanceRes.data || []).forEach((row) => {
    statusMap[row.profile_id] = row.status;
  });

  const summary = { total: 0, present: 0, absent: 0, late: 0, halfDay: 0, leave: 0 };
  summary.total = (profilesRes.data || []).length;

  (profilesRes.data || []).forEach((profile) => {
    const status = statusMap[profile.id];
    if (status === 'Present') summary.present += 1;
    else if (status === 'Late') { summary.present += 1; summary.late += 1; }
    else if (status === 'Half Day') summary.halfDay += 1;
    else if (status === 'Leave') summary.leave += 1;
  });

  summary.absent = summary.total - summary.present - summary.halfDay - summary.leave;
  if (summary.absent < 0) summary.absent = 0;
  return { ...summary, error };
}

/** Upsert a manual attendance entry (admin override) with audit logging. */
export async function saveManualAttendance(tenantId, { profile_id, date, clockIn: ci, clockOut: co, status, reason }, changedBy) {
  const hours = (ci && co) ? Math.round(diffHours(ci, co) * 100) / 100 : 0;

  // Fetch existing record to capture old values for audit
  const { data: existing, error: fetchErr } = await supabase
    .from('attendance')
    .select('id, status, total_hours')
    .eq('profile_id', profile_id)
    .eq('date', date)
    .maybeSingle();
  if (fetchErr) throw fetchErr;

  const action = existing ? 'update' : 'create';
  const oldStatus = existing?.status ?? null;
  const oldHours  = existing?.total_hours ?? null;

  // Atomic upsert on (profile_id, date) — a select-then-insert/update here could create
  // a duplicate row for the same day under a race (e.g. two admin tabs saving at once).
  const { data: saved, error: upsertErr } = await supabase
    .from('attendance')
    .upsert(
      [{ tenant_id: tenantId, profile_id, date, status, total_hours: hours, location: 'Office (Manual)' }],
      { onConflict: 'profile_id,date' }
    )
    .select('id')
    .single();
  if (upsertErr) throw upsertErr;
  const attId = saved.id;

  await supabase.from('punches').delete().eq('attendance_id', attId);

  const punches = [];
  if (ci) punches.push({ attendance_id: attId, punch_time: ci, punch_type: 'in', source: 'manual' });
  if (co) punches.push({ attendance_id: attId, punch_time: co, punch_type: 'out', source: 'manual' });
  if (punches.length) {
    const { error: punchErr } = await supabase.from('punches').insert(punches);
    if (punchErr) throw punchErr;
  }

  // Marking a day 'Comp Off' spends 1 day from the employee's earned
  // balance; correcting a day away from 'Comp Off' refunds it. No-op if the
  // status isn't actually changing across the Comp Off boundary (e.g. saving
  // the same 'Comp Off' entry again, or editing hours on a non-Comp-Off day).
  if (status === 'Comp Off' && oldStatus !== 'Comp Off') {
    await supabase.rpc('adjust_comp_off_balance', { p_profile_id: profile_id, p_delta: -1 });
  } else if (oldStatus === 'Comp Off' && status !== 'Comp Off') {
    await supabase.rpc('adjust_comp_off_balance', { p_profile_id: profile_id, p_delta: 1 });
  }

  // Write audit log entry
  if (changedBy) {
    await supabase.from('attendance_audit_log').insert([{
      tenant_id: tenantId,
      attendance_id: attId,
      profile_id: profile_id,
      changed_by: changedBy,
      date,
      action,
      old_status: oldStatus,
      new_status: status,
      old_hours: oldHours,
      new_hours: hours,
      reason: reason || '',
    }]);
  }
}

/** Attendance stats for the current month — for the employee self-service dashboard. */
export async function fetchMyMonthStats(profileId, year, month) {
  const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const endDay    = new Date(year, month + 1, 0).getDate();
  const endDate   = `${year}-${String(month + 1).padStart(2, '0')}-${endDay}`;

  const { data, error } = await supabase
    .from('attendance')
    .select('status')
    .eq('profile_id', profileId)
    .gte('date', startDate)
    .lte('date', endDate);

  const presentDays = (data || []).filter((r) => r.status === 'Present' || r.status === 'Late').length;
  return { presentDays, error };
}

/** Fetch all attendance records for a tenant for a given month/year. */
export async function fetchAllTenantAttendance(tenantId, year, month) {
  const startDate = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const endDay    = new Date(year, month + 1, 0).getDate();
  const endDate   = `${year}-${String(month + 1).padStart(2, '0')}-${endDay}`;

  const { data, error } = await supabase
    .from('attendance')
    .select('profile_id, status, date, total_hours')
    .eq('tenant_id', tenantId)
    .gte('date', startDate)
    .lte('date', endDate);
  return { data: data || [], error };
}

/**
 * Fetch every employee's attendance (with punches, for clock-in time) across a date
 * range — used by Master Report's Attendance Log and Late Comers Report cards
 * (date-range-wise, not employee-wise). Callers scope the result to the active
 * outlet client-side via scopedToOutlet, same as fetchAllAttendanceWithPunches.
 */
export async function fetchAttendanceRangeWithPunches(tenantId, fromDate, toDate) {
  const PAGE_SIZE = 1000;
  const all = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from('attendance')
      .select('profile_id, date, status, total_hours, punches(punch_time, punch_type)')
      .eq('tenant_id', tenantId)
      .gte('date', fromDate)
      .lte('date', toDate)
      .order('date')
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) return { data: all, error };
    all.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return { data: all, error: null };
}

/** Fetch audit log entries for a tenant, optionally filtered by date. */
export async function fetchAttendanceAuditLog(tenantId, date) {
  let query = supabase
    .from('attendance_audit_log')
    .select('*, changed_by_profile:profile_directory!attendance_audit_log_changed_by_fkey(first_name, middle_name, last_name), target_profile:profile_directory!attendance_audit_log_profile_id_fkey(first_name, middle_name, last_name)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (date) {
    query = query.eq('date', date);
  }

  const { data, error } = await query;
  return { data: data || [], error };
}

/**
 * Fetch attendance records with punches for every employee in a tenant, scoped to one
 * calendar year — used for master report. An unbounded all-time fetch here would pull
 * hundreds of thousands of rows once a few years of daily attendance accumulate.
 *
 * Paginated in PAGE_SIZE chunks: PostgREST caps a single response at its
 * project-configured max rows (1000 by default), so a tenant with enough
 * employees/days in a year silently had its later months truncated by a single
 * unpaged request — the query is ordered by date ascending, so whatever fell
 * past the cap (the most recent months) just vanished from the result.
 */
export async function fetchAllAttendanceWithPunches(tenantId, year = new Date().getFullYear()) {
  const PAGE_SIZE = 1000;
  const all = [];
  for (let page = 0; ; page++) {
    const { data, error } = await supabase
      .from('attendance')
      .select('id, profile_id, date, status, total_hours, punches(punch_time, punch_type)')
      .eq('tenant_id', tenantId)
      .gte('date', `${year}-01-01`)
      .lte('date', `${year}-12-31`)
      .order('date')
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) return { data: all, error };
    all.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return { data: all, error: null };
}

/** Fetch just the profile info for an employee (join_date, name, etc.) */
export async function fetchEmployeeProfileInfo(profileId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('first_name, middle_name, last_name, join_date, probation_months, department, designation')
    .eq('id', profileId)
    .single();
  return { profile: data, error };
}

/** Fetch complete attendance history for one employee from their join date. */
export async function fetchEmployeeFullHistory(profileId) {
  const { data: prof } = await supabase
    .from('profiles')
    .select('first_name, middle_name, last_name, join_date, department, designation')
    .eq('id', profileId)
    .single();

  // Fetch all attendance records (no date filter yet — need earliest to compute fromDate)
  const { data: allRecords, error } = await supabase
    .from('attendance')
    .select('date, status, total_hours, punches(punch_time, punch_type)')
    .eq('profile_id', profileId)
    .order('date');

  // Determine start date: join_date → first attendance record → today
  let fromDate = prof?.join_date || null;
  if (!fromDate && allRecords && allRecords.length > 0) {
    fromDate = allRecords[0].date;
  }
  if (!fromDate) {
    fromDate = todayStr();
  }

  return { data: allRecords || [], profile: prof, fromDate, error };
}

// ── Regularization Requests (employee-initiated) ──────────────────────────────

/**
 * Employee submits a regularize request with tiered quota routing.
 * `tenantSettings` carries the superadmin-configured auto-approval controls
 * (Toggle Services → Attendance Regularization Auto-Approval): pass
 * `{ autoApprovalEnabled, autoApprovalLimit }` from the caller's already-loaded
 * tenant record. A tenant with auto-approval off gets selfLimit 0, so every
 * request skips straight to manager/admin.
 * Returns { data, error, tier } where tier is 'self' | 'manager' | 'admin'.
 * When tier === 'self' the attendance change is applied immediately (no approval wait).
 */
export async function submitRegularizeRequest(tenantId, profileId, { date, clockInTime, clockOutTime, reason }, tenantSettings = {}) {
  // Block resubmission for a date that already has a Pending or Approved
  // request -- once reviewed (or awaiting review) there's nothing left to
  // regularize, and without this an employee could spam the same date over
  // and over after it's already been approved.
  const { data: existing } = await supabase
    .from('regularize_requests')
    .select('id, status')
    .eq('profile_id', profileId)
    .eq('date', date)
    .in('status', ['Pending', 'Approved'])
    .limit(1);

  if (existing?.length > 0) {
    const status = existing[0].status;
    return {
      data: null,
      error: new Error(
        status === 'Approved'
          ? `Your attendance for ${date} has already been approved — no need to request again.`
          : `You already have a pending regularization request for ${date}.`
      ),
    };
  }

  const selfLimit = tenantSettings.autoApprovalEnabled === false
    ? 0
    : (tenantSettings.autoApprovalLimit ?? SELF_LIMIT);

  const quota = await getOrCreateQuota(tenantId, profileId);
  const tier  = determineApproverRole(quota, selfLimit);

  const payload = {
    tenant_id:      tenantId,
    profile_id:     profileId,
    date,
    clock_in_time:  clockInTime  || null,
    clock_out_time: clockOutTime || null,
    reason,
    status:                 tier === 'self' ? 'Approved' : 'Pending',
    required_approver_role: tier,
    approval_level:         tier === 'self' ? 'self' : null,
  };

  const { data, error } = await supabase
    .from('regularize_requests')
    .insert([payload])
    .select()
    .single();

  // enforce_regularize_request_approval_tier (see
  // 20260903_5_server_side_regularize_special_approval_enforcement.sql)
  // re-derives the tier from the tenant's *current* settings and may
  // silently overwrite status/required_approver_role if this client's view
  // was stale. Trust what actually landed in the row before applying the
  // attendance change or notifying anyone — otherwise a request the server
  // downgraded to Pending would still get its attendance auto-marked
  // Present and its self-approval quota consumed.
  const actualTier = data?.required_approver_role || tier;

  // The attendance change itself (punches replaced with the requested
  // in/out, hours + status recomputed) is applied by the DB trigger
  // trg_apply_approved_regularize_request the moment the row lands as
  // Approved -- see 20260925_6_regularize_apply_in_db_and_3day_window.sql.

  // Only spend a self-approval slot once the attendance change AND the request
  // record both succeeded — incrementing earlier burned quota on failed attempts
  // (e.g. a blocked audit-log insert) with nothing actually recorded.
  if (actualTier === 'self' && !error) {
    await incrementSelfCount(tenantId, profileId);
  }

  if (!error && data?.id) {
    const requester = await getRequesterLabel(profileId);
    if (actualTier === 'self') {
      await notifyProfiles(tenantId, [profileId], {
        type: 'regularize_auto_approved',
        title: 'Regularize request auto-approved',
        body: `Your attendance correction for ${date} was automatically approved.`,
        linkKey: 'regularize_attendance',
        relatedId: data.id,
      });
      await notifyRoles(tenantId, ['admin'], {
        type: 'regularize_auto_approved',
        title: 'Regularize request auto-approved',
        body: `${requester} submitted an attendance correction for ${date} — auto-approved, no action needed.`,
        linkKey: 'regularize_attendance',
        actorId: profileId,
        relatedId: data.id,
      }, profileId);
    } else {
      // An HOD approves for the people directly under them, like a manager;
      // for Raniwala the DB trigger keeps only the requester's own line.
      await notifyRoles(tenantId, withHrRole(actualTier === 'manager' ? ['manager', 'hod'] : [actualTier]), {
        type: 'regularize_request_submitted',
        title: 'New regularize request',
        body: `${requester} submitted a new attendance correction for ${date} — needs your review.`,
        linkKey: 'regularize_attendance',
        actorId: profileId,
        relatedId: data.id,
      }, profileId);
    }
  }

  return { data, error, tier: actualTier };
}

/**
 * Admin/Manager: list all regularization requests for a tenant. Returns every
 * request regardless of status or approval tier (Pending/Approved/Rejected,
 * self/manager/admin) -- managers need visibility into auto-approved and
 * admin-approved requests too, not just the ones routed to them for action.
 * Callers gate the Approve/Reject actions themselves based on
 * required_approver_role.
 */
export async function listRegularizeRequests(tenantId) {
  const { data, error } = await supabase
    .from('regularize_requests')
    .select(`
      *,
      profile:profile_directory!regularize_requests_profile_id_fkey(first_name, middle_name, last_name, department, designation),
      reviewer:profile_directory!regularize_requests_reviewed_by_fkey(first_name, middle_name, last_name, role)
    `)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  return { data: data || [], error };
}

/** Employee: list their own regularization requests */
export async function listMyRegularizeRequests(profileId) {
  const { data, error } = await supabase
    .from('regularize_requests')
    .select('*')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: false })
    .limit(20);
  return { data: data || [], error };
}

/**
 * Approve a regularize request: apply attendance change and mark Approved.
 * reviewerRole: 'manager' | 'admin' | 'superadmin'
 * When manager approves, increments that employee's manager quota.
 */
export async function approveRegularizeRequest(request, reviewerId, reviewerRole = 'admin') {
  // Claim the request first (only if still Pending) — otherwise a double-click, or two
  // reviewers acting at once, would re-apply the attendance change a second time.
  const reviewedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from('regularize_requests')
    .update({ status: 'Approved', reviewed_by: reviewerId, reviewed_at: reviewedAt })
    .eq('id', request.id)
    .eq('status', 'Pending')
    .select('id');

  if (claimErr) return { error: claimErr };
  if (claimed?.length === 0) return { error: new Error('This request has already been reviewed.') };

  // Flipping status to Approved fires trg_apply_approved_regularize_request,
  // which writes the corrected punches/hours/status for that day.

  if (reviewerRole === 'manager') {
    await incrementManagerCount(request.tenant_id, request.profile_id);
  }

  await notifyProfiles(request.tenant_id, [request.profile_id], {
    type: 'regularize_request_approved',
    title: 'Regularize request approved',
    body: `Your attendance correction for ${request.date} was approved.`,
    linkKey: 'regularize_attendance',
    actorId: reviewerId,
    relatedId: request.id,
  });

  return { error: null };
}

/** Reject a regularization request */
export async function rejectRegularizeRequest(requestId, reviewerId) {
  // Fetched purely to notify the requester below — the update itself only needs the id.
  const { data: req } = await supabase
    .from('regularize_requests')
    .select('tenant_id, profile_id, date')
    .eq('id', requestId)
    .single();

  const reviewedAt = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from('regularize_requests')
    .update({ status: 'Rejected', reviewed_by: reviewerId, reviewed_at: reviewedAt })
    .eq('id', requestId)
    .eq('status', 'Pending')
    .select('id');

  if (!error && updated?.length === 0) {
    return { error: new Error('This request has already been reviewed.') };
  }

  if (!error && req?.tenant_id && req?.profile_id) {
    await notifyProfiles(req.tenant_id, [req.profile_id], {
      type: 'regularize_request_rejected',
      title: 'Regularize request rejected',
      body: `Your attendance correction for ${req.date} was rejected.`,
      linkKey: 'regularize_attendance',
      actorId: reviewerId,
      relatedId: requestId,
    });
  }
  return { error };
}

// ─────────────────────────────────────────────────────────────────────────────

/** Bulk regularize attendance for multiple employees across a date range */
export async function regularizeAttendance(tenantId, {
  fromDate,
  toDate,
  employeeIds,
  status,
  clockInTime = null,
  clockOutTime = null,
  reason = '',
  changedBy
}) {
  if (!fromDate || !toDate || !employeeIds || employeeIds.length === 0 || !status) {
    throw new Error('Missing required fields: fromDate, toDate, employeeIds, status');
  }

  if (!reason || reason.trim() === '') {
    throw new Error('Reason is required for attendance regularization');
  }

  if (fromDate > toDate) {
    throw new Error('From date must be less than or equal to To date');
  }

  if (toDate > todayStr()) {
    throw new Error('Cannot regularize future dates');
  }

  // Parse as local dates to avoid UTC-midnight timezone shifts
  const [ffy, ffm, ffd] = fromDate.split('-').map(Number);
  const [tty, ttm, ttd] = toDate.split('-').map(Number);
  const from = new Date(ffy, ffm - 1, ffd);
  const to = new Date(tty, ttm - 1, ttd);

  const dates = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }

  // Get tenant configuration for hour calculations, plus each employee's outlet
  // (if any) so an outlet's own half/full-day thresholds override the tenant default.
  const [{ data: tenantData, error: tenantErr }, { data: employeeOutlets }, { data: tenantOutlets }] = await Promise.all([
    supabase.from('tenants').select('min_half_day_hours, min_full_day_hours').eq('id', tenantId).single(),
    supabase.from('profiles').select('id, outlet_id').in('id', employeeIds),
    supabase.from('outlets').select('id, min_half_day_hours, min_full_day_hours').eq('tenant_id', tenantId),
  ]);
  if (tenantErr) throw tenantErr;

  const outletIdByProfile = Object.fromEntries((employeeOutlets || []).map((p) => [p.id, p.outlet_id]));
  const outletById = Object.fromEntries((tenantOutlets || []).map((o) => [o.id, o]));

  // Calculate hours if clock times provided
  let hours = 0;
  if (clockInTime && clockOutTime) {
    hours = Math.round(diffHours(clockInTime, clockOutTime) * 100) / 100;
  }

  // Batch-fetch every existing attendance row in range for these employees in
  // ONE query, instead of one SELECT per (employee, date) pair.
  const { data: existingRows, error: existingErr } = await supabase
    .from('attendance')
    .select('id, profile_id, date, status, total_hours')
    .in('profile_id', employeeIds)
    .gte('date', fromDate)
    .lte('date', toDate);
  if (existingErr) throw existingErr;
  const existingByKey = Object.fromEntries((existingRows || []).map((r) => [`${r.profile_id}_${r.date}`, r]));

  // Build the full (employee x date) payload in memory, then write it in
  // chunked batch calls instead of one round-trip per cell.
  const upsertPayload = [];
  const rowMeta = [];
  for (const empId of employeeIds) {
    const outlet = outletById[outletIdByProfile[empId]] || null;
    const { min_half_day_hours: halfMin, min_full_day_hours: fullMin } = resolveAttendanceSettings(tenantData, outlet);

    // Determine final status based on hours and provided status (per employee, since
    // thresholds can differ by outlet)
    let finalStatus = status;
    if (hours > 0) {
      if (status === 'Present' && hours < fullMin && hours >= halfMin) {
        finalStatus = 'Half Day';
      } else if (status === 'Present' && hours < halfMin) {
        finalStatus = 'Absent';
      }
    }

    for (const dateStr of dates) {
      const existing = existingByKey[`${empId}_${dateStr}`];
      upsertPayload.push({
        tenant_id: tenantId,
        profile_id: empId,
        date: dateStr,
        status: finalStatus,
        total_hours: hours,
        location: 'Office (Regularized)',
      });
      rowMeta.push({
        empId,
        dateStr,
        finalStatus,
        action: existing ? 'update' : 'create',
        oldStatus: existing?.status ?? null,
        oldHours: existing?.total_hours ?? null,
      });
    }
  }

  const CHUNK = 500;
  const chunks = (arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
    return out;
  };

  // Atomic upsert on (profile_id, date) per row — avoids creating a duplicate row
  // if this races with a concurrent clock-in/manual edit for the same day —
  // batched in chunks instead of one upsert per cell.
  const attIdByKey = {};
  for (const part of chunks(upsertPayload)) {
    const { data: saved, error: upsertErr } = await supabase
      .from('attendance')
      .upsert(part, { onConflict: 'profile_id,date' })
      .select('id, profile_id, date');
    if (upsertErr) throw upsertErr;
    for (const r of saved) attIdByKey[`${r.profile_id}_${r.date}`] = r.id;
  }

  const attIds = rowMeta.map((m) => attIdByKey[`${m.empId}_${m.dateStr}`]);

  for (const part of chunks(attIds)) {
    const { error: delErr } = await supabase.from('punches').delete().in('attendance_id', part);
    if (delErr) throw delErr;
  }

  if (clockInTime && clockOutTime) {
    const punchRows = attIds.flatMap((attId) => [
      { attendance_id: attId, punch_time: clockInTime, punch_type: 'in', source: 'manual' },
      { attendance_id: attId, punch_time: clockOutTime, punch_type: 'out', source: 'manual' },
    ]);
    for (const part of chunks(punchRows)) {
      const { error: punchErr } = await supabase.from('punches').insert(part);
      if (punchErr) throw punchErr;
    }
  }

  const auditLogs = rowMeta.map((m) => ({
    tenant_id: tenantId,
    attendance_id: attIdByKey[`${m.empId}_${m.dateStr}`],
    profile_id: m.empId,
    changed_by: changedBy,
    date: m.dateStr,
    action: m.action,
    old_status: m.oldStatus,
    new_status: m.finalStatus,
    old_hours: m.oldHours,
    new_hours: hours,
    reason: reason,
  }));

  for (const part of chunks(auditLogs)) {
    const { error: auditErr } = await supabase.from('attendance_audit_log').insert(part);
    if (auditErr) throw auditErr;
  }

  return {
    success: true,
    recordsUpdated: auditLogs.length,
    auditLogs
  };
}
