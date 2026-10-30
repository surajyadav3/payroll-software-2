import { supabase } from '@/lib/supabase';
import { FEATURE_REGISTRY } from '@/lib/featureRegistry';

/**
 * The full toggle registry, ordered for grouped display. Sorted by
 * sort_order alone (not category) — the seed data's numeric ranges already
 * group categories in the intended order (General, Requests, Hiring,
 * Performance, Payroll, System); sorting by category text would alphabetize
 * them instead.
 */
export async function listFeatures() {
  const { data, error } = await supabase
    .from('features')
    .select('*')
    .order('sort_order');
  return { data: data || [], error };
}

/**
 * Upserts every entry in FEATURE_REGISTRY (src/lib/featureRegistry.js) into
 * the `features` table — the whole registry lives in one array in code, so
 * shipping a new feature is "add one line there," not "also remember to
 * write a migration." Superadmin-only per the "features: superadmin manage"
 * RLS policy; call this before listFeatures() wherever the toggle list is
 * shown so anything newly added to the registry appears without a manual
 * DB step. Never throws — a failed sync just means the newest entries won't
 * show up yet, not that the whole toggle page should break.
 */
export async function syncFeatureRegistry() {
  // Every row in one upsert request needs the same shape — default
  // is_premium: false explicitly so entries that don't set it (everything
  // except premium features like 'live_tracking') don't send a bare null
  // into the NOT NULL is_premium column.
  // `since` is code-only metadata (no DB column) — strip it.
  const rows = FEATURE_REGISTRY.map(({ since: _since, ...f }) => ({ is_premium: false, ...f }));
  const { error } = await supabase.from('features').upsert(rows, { onConflict: 'key' });
  if (error) console.error('syncFeatureRegistry failed:', error.message);
  return { error };
}

/** Every override row (company-wide + all outlets) for one tenant. */
export async function listCompanyFeatureToggles(tenantId) {
  const { data, error } = await supabase
    .from('company_feature_toggles')
    .select('*')
    .eq('tenant_id', tenantId);
  return { data: data || [], error };
}

/**
 * Resolves whether a feature is enabled for a given outlet, falling back to
 * the company-wide override, falling back to `defaultEnabled` — mirrors
 * resolveAttendanceSettings()'s outlet-then-tenant fallback in tenantService.js.
 * `defaultEnabled` is true for every ordinary feature (unchanged behavior —
 * a tenant with zero rows in company_feature_toggles keeps 100% of today's
 * functionality) and false for a premium feature (features.is_premium), so a
 * brand-new premium feature ships off for every existing tenant and has to
 * be explicitly turned on per tenant from Toggle Services.
 */
export function resolveFeatureState(toggles, featureKey, outletId, defaultEnabled = true) {
  if (outletId) {
    const outletRow = toggles.find((t) => t.feature_key === featureKey && t.outlet_id === outletId);
    if (outletRow) return outletRow.enabled;
  }
  const companyRow = toggles.find((t) => t.feature_key === featureKey && t.outlet_id === null);
  if (companyRow) return companyRow.enabled;
  return defaultEnabled;
}

/**
 * Sets the on/off state for a feature at company-wide (outletId=null) or
 * outlet scope. Written as an explicit select-then-write rather than
 * .upsert(onConflict:...) because the uniqueness here is enforced by two
 * *partial* indexes (see the migration) — Postgres can only use a partial
 * index as an ON CONFLICT arbiter when the conflict target's WHERE clause
 * matches exactly, which the Supabase JS client has no way to express.
 */
export async function setFeatureToggle(tenantId, outletId, featureKey, enabled, updatedBy) {
  let findQuery = supabase
    .from('company_feature_toggles')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('feature_key', featureKey);
  findQuery = outletId ? findQuery.eq('outlet_id', outletId) : findQuery.is('outlet_id', null);
  const { data: existing, error: findError } = await findQuery.maybeSingle();
  if (findError) return { error: findError };

  const updatedAt = new Date().toISOString();
  if (existing) {
    const { error } = await supabase
      .from('company_feature_toggles')
      .update({ enabled, updated_at: updatedAt, updated_by: updatedBy || null })
      .eq('id', existing.id);
    return { error };
  }

  const { error } = await supabase.from('company_feature_toggles').insert([{
    tenant_id: tenantId,
    outlet_id: outletId || null,
    feature_key: featureKey,
    enabled,
    updated_at: updatedAt,
    updated_by: updatedBy || null,
  }]);
  return { error };
}

/**
 * One-off lookup of a single feature's enabled state for one outlet, for
 * call sites that only care about that one feature and don't already hold
 * the full toggles list the way Toggle Services / FeatureContext do (e.g.
 * attendanceService.js's clock-in/out geofence check, useGeofenceClock).
 * Same outlet-then-company-then-default fallback as resolveFeatureState().
 * Fails open (returns defaultEnabled) on a query error, same philosophy as
 * "not configured" elsewhere in the geofence code.
 */
export async function isFeatureEnabledForOutlet(tenantId, outletId, featureKey, defaultEnabled = true) {
  if (!tenantId) return defaultEnabled;
  const { data, error } = await supabase
    .from('company_feature_toggles')
    .select('outlet_id, enabled, feature_key')
    .eq('tenant_id', tenantId)
    .eq('feature_key', featureKey);
  if (error) return defaultEnabled;
  return resolveFeatureState(data || [], featureKey, outletId, defaultEnabled);
}

/** Removes an override, resetting that scope back to "inherit". */
export async function clearFeatureOverride(tenantId, outletId, featureKey) {
  let query = supabase
    .from('company_feature_toggles')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('feature_key', featureKey);
  query = outletId ? query.eq('outlet_id', outletId) : query.is('outlet_id', null);
  const { error } = await query;
  return { error };
}
