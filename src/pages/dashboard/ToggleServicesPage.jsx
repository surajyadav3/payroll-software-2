import { useEffect, useState, useCallback, useMemo } from 'react';
import Header from '@/components/Header';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { listAllTenants, listOutlets, updateTenant } from '@/services/tenantService';
import {
  listFeatures, listCompanyFeatureToggles, resolveFeatureState, setFeatureToggle, clearFeatureOverride,
  syncFeatureRegistry,
} from '@/services/featureService';
import { isNewFeature } from '@/lib/featureRegistry';

// Keka-style default: 3 self-approvals/month, matches the prior hardcoded
// requestQuotaService.SELF_LIMIT — shown here only as the input's placeholder
// when a tenant hasn't set anything yet.
const DEFAULT_AUTO_APPROVAL_LIMIT = 3;

// Generic per-tenant "N self-approvals/month, or off entirely" control —
// backs both Leave Auto-Approval (leave_auto_approval_*) and Attendance
// Regularization Auto-Approval (regularize_auto_approval_*), which are
// independent tenant columns so a company can auto-approve one and not the
// other (e.g. Indwell wants 3 for leave but every regularize request reviewed).
function AutoApprovalCard({ tenant, onSaved, title, description, enabledField, limitField }) {
  const [enabled, setEnabled] = useState(true);
  const [limit, setLimit] = useState(DEFAULT_AUTO_APPROVAL_LIMIT);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!tenant) return;
    setEnabled(tenant[enabledField] !== false);
    setLimit(tenant[limitField] ?? DEFAULT_AUTO_APPROVAL_LIMIT);
  }, [tenant?.id, enabledField, limitField]);

  if (!tenant) return null;

  const dirty = enabled !== (tenant[enabledField] !== false)
    || Number(limit) !== (tenant[limitField] ?? DEFAULT_AUTO_APPROVAL_LIMIT);

  const handleSave = async () => {
    setSaving(true);
    const { error } = await updateTenant(tenant.id, {
      [enabledField]: enabled,
      [limitField]: Math.max(0, parseInt(limit, 10) || 0),
    });
    setSaving(false);
    if (error) return showToast('Failed to update: ' + error.message, 'error');
    showToast(`${title} settings saved`, 'success');
    onSaved();
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header"><h3>{title}</h3></div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{description}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className="btn btn-outline btn-icon btn-sm"
            onClick={() => setEnabled((v) => !v)}
            title={enabled ? 'Disable auto-approval' : 'Enable auto-approval'}
          >
            <i className={`fas ${enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`} style={{ color: enabled ? 'var(--success)' : 'var(--text-muted)' }} />
          </button>
          <span className={`badge ${enabled ? 'badge-success' : 'badge-secondary'}`}>{enabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        {enabled && (
          <div className="form-group" style={{ maxWidth: 260, marginBottom: 0 }}>
            <label className="form-label">Auto-approvals per employee / month</label>
            <input
              className="form-input"
              type="number"
              min="0"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </div>
        )}
        <div>
          <button className="btn btn-primary btn-sm" disabled={saving || !dirty} onClick={handleSave}>
            {saving ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Simple on/off tenant setting — no per-employee limit, just enabled/disabled.
// When an employee clocked in inside a geofence later leaves it, this
// automatically clocks them out after a grace period. Off by default: leave
// it off for companies whose staff legitimately work outside the office
// during a shift (field sales, delivery, site visits) — it's meant for
// companies that want on-site staff confined to the premises. Manual
// clock-in/out is blocked from outside the geofence either way — this only
// controls the automatic force-clock-out while already clocked in.
function AutoClockoutCard({ tenant, onSaved }) {
  const [saving, setSaving] = useState(false);
  if (!tenant) return null;
  const enabled = !!tenant.auto_clockout_enabled;

  const toggle = async () => {
    setSaving(true);
    const { error } = await updateTenant(tenant.id, { auto_clockout_enabled: !enabled });
    setSaving(false);
    if (error) return showToast('Failed to update: ' + error.message, 'error');
    showToast(`Auto clock-out ${!enabled ? 'enabled' : 'disabled'}`, 'success');
    onSaved();
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header"><h3>Auto Clock-Out on Geofence Exit</h3></div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          When an employee clocked in inside a geofence later leaves it for longer than the grace
          period, this automatically clocks them out. Leave this off for companies whose staff
          legitimately work outside the office during a shift (field sales, delivery, site visits) —
          it's meant for companies that want on-site staff confined to the premises. Manual
          clock-in/out is still blocked from outside the geofence either way.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className="btn btn-outline btn-icon btn-sm"
            disabled={saving}
            onClick={toggle}
            title={enabled ? 'Disable auto clock-out' : 'Enable auto clock-out'}
          >
            <i className={`fas ${enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`} style={{ color: enabled ? 'var(--success)' : 'var(--text-muted)' }} />
          </button>
          <span className={`badge ${enabled ? 'badge-success' : 'badge-secondary'}`}>{enabled ? 'Enabled' : 'Disabled'}</span>
          {saving && <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}
        </div>
      </div>
    </div>
  );
}

// Shift from punch-in (tenants.auto_shift_from_punch, 20261024_8): the DB
// picks each day's shift from the company's list — the one starting nearest
// the first punch — and judges Late from it. For companies whose staff work
// many shifts with none assigned (IndWell Hotel).
function AutoShiftCard({ tenant, onSaved }) {
  const [saving, setSaving] = useState(false);
  if (!tenant) return null;
  const enabled = !!tenant.auto_shift_from_punch;

  const toggle = async () => {
    setSaving(true);
    const { error } = await updateTenant(tenant.id, { auto_shift_from_punch: !enabled });
    setSaving(false);
    if (error) return showToast('Failed to update: ' + error.message, 'error');
    showToast(`Shift from punch-in ${!enabled ? 'enabled' : 'disabled'}`, 'success');
    onSaved();
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header"><h3>Shift from Punch-In Time</h3></div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Each day's shift is picked from the company's shift list (Settings &gt; Shifts): the one
          that starts nearest the employee's first punch — clocking in at 11:00 AM gives the
          11:00 AM shift, and Late is judged from that start. Where two shifts start at the same
          time, the one kept for the employee's designation wins, then the one whose end is
          nearest their clock-out.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className="btn btn-outline btn-icon btn-sm"
            disabled={saving}
            onClick={toggle}
            title={enabled ? 'Disable shift from punch-in' : 'Enable shift from punch-in'}
          >
            <i className={`fas ${enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`} style={{ color: enabled ? 'var(--success)' : 'var(--text-muted)' }} />
          </button>
          <span className={`badge ${enabled ? 'badge-success' : 'badge-secondary'}`}>{enabled ? 'Enabled' : 'Disabled'}</span>
          {saving && <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}
        </div>
      </div>
    </div>
  );
}

// Comp-off "gain type" — how an employee earns a Comp Off for working a
// weekly off day. Off (default) = month-end settlement, reviewed in batch
// during payroll (compOffService.js / PayrollPage). On = real-time grant the
// instant they punch in on that weekly off (attendanceService.js), per
// 20260917_1_realtime_comp_off_grant.sql. Mirrors the same control exposed
// to HR/admin directly on the Settings page — this is the superadmin's view
// of the same tenant column.
function CompOffGainTypeCard({ tenant, onSaved }) {
  const [saving, setSaving] = useState(false);
  if (!tenant) return null;
  const realtime = !!tenant.auto_comp_off_on_weekly_off_worked;

  const setMode = async (value) => {
    if (value === realtime) return;
    setSaving(true);
    const { error } = await updateTenant(tenant.id, { auto_comp_off_on_weekly_off_worked: value });
    setSaving(false);
    if (error) return showToast('Failed to update: ' + error.message, 'error');
    showToast(`Comp-off gain type set to ${value ? 'Real-time grant' : 'Month-end settlement'}`, 'success');
    onSaved();
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header"><h3>Comp-Off Gain Type</h3></div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          How employees earn a Comp Off for working on a weekly off day.
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className={`btn btn-sm ${!realtime ? 'btn-primary' : 'btn-outline'}`} disabled={saving} onClick={() => setMode(false)}>
            Month-end settlement
          </button>
          <button className={`btn btn-sm ${realtime ? 'btn-primary' : 'btn-outline'}`} disabled={saving} onClick={() => setMode(true)}>
            Real-time grant
          </button>
          {saving && <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}
        </div>
      </div>
    </div>
  );
}

export default function ToggleServicesPage() {
  const { profile } = useAuth();
  const [tenants, setTenants] = useState([]);
  const [tenantId, setTenantId] = useState('');
  const [outlets, setOutlets] = useState([]);
  const [scopeOutletId, setScopeOutletId] = useState(''); // '' = company-wide
  const [features, setFeatures] = useState([]);
  const [toggles, setToggles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);
  const [search, setSearch] = useState('');
  const [newOnly, setNewOnly] = useState(false);

  const refreshTenants = useCallback(() => {
    listAllTenants().then(({ data }) => setTenants(data || []));
  }, []);

  const currentTenant = tenants.find((t) => t.id === tenantId) || null;

  useEffect(() => {
    listAllTenants().then(({ data }) => {
      setTenants(data || []);
      if (data?.length) setTenantId((prev) => prev || data[0].id);
    });
    // Bring the DB's feature list up to date with the code registry first —
    // any feature added to FEATURE_REGISTRY since this page was last opened
    // shows up right away, with no separate migration step required.
    syncFeatureRegistry().finally(() => {
      listFeatures().then(({ data }) => setFeatures(data || []));
    });
  }, []);

  const loadTenantScoped = useCallback(async () => {
    if (!tenantId) { setLoading(false); return; }
    setLoading(true);
    const [{ data: outletData }, { data: toggleData }] = await Promise.all([
      listOutlets(tenantId),
      listCompanyFeatureToggles(tenantId),
    ]);
    setOutlets(outletData || []);
    setToggles(toggleData || []);
    setScopeOutletId('');
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { loadTenantScoped(); }, [loadTenantScoped]);

  const currentOutletId = scopeOutletId || null;

  const newCount = useMemo(() => features.filter((f) => isNewFeature(f.key)).length, [features]);

  // Grouped in the order listFeatures() already returns (sort_order) —
  // categories fall out in that same order as a side effect of Map insertion.
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byCategory = new Map();
    for (const f of features) {
      if (newOnly && !isNewFeature(f.key)) continue;
      if (q && !`${f.name} ${f.description || ''} ${f.category}`.toLowerCase().includes(q)) continue;
      if (!byCategory.has(f.category)) byCategory.set(f.category, []);
      byCategory.get(f.category).push(f);
    }
    return Array.from(byCategory.entries());
  }, [features, search, newOnly]);

  const handleToggle = async (f) => {
    const effective = resolveFeatureState(toggles, f.key, currentOutletId, !f.is_premium);
    setSavingKey(f.key);
    const { error } = await setFeatureToggle(tenantId, currentOutletId, f.key, !effective, profile?.id);
    setSavingKey(null);
    if (error) return showToast('Failed to update: ' + error.message, 'error');
    loadTenantScoped();
  };

  const handleReset = async (f) => {
    setSavingKey(f.key);
    const { error } = await clearFeatureOverride(tenantId, currentOutletId, f.key);
    setSavingKey(null);
    if (error) return showToast('Failed to reset: ' + error.message, 'error');
    loadTenantScoped();
  };

  return (
    <>
      <Header title="Toggle Services" breadcrumb="Platform administration — enable or disable individual features per company, or per branch" />
      <div className="page-content">
        <div className="filter-bar">
          <div className="form-group" style={{ minWidth: 240 }}>
            <label className="form-label">Company</label>
            <select className="form-select" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.company_name}</option>)}
            </select>
          </div>
          {outlets.length > 0 && (
            <div className="form-group" style={{ minWidth: 220 }}>
              <label className="form-label">Scope</label>
              <select className="form-select" value={scopeOutletId} onChange={(e) => setScopeOutletId(e.target.value)}>
                <option value="">Company-wide (all branches)</option>
                {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
          )}
          <div className="form-group" style={{ minWidth: 220, flex: 1 }}>
            <label className="form-label">Find a feature</label>
            <input
              className="form-input"
              type="search"
              placeholder="e.g. task, careers, AI…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {newCount > 0 && (
            <div className="form-group" style={{ alignSelf: 'flex-end' }}>
              <button
                className={`btn btn-sm ${newOnly ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setNewOnly((v) => !v)}
                title="Features added in the last two months"
              >
                <i className="fas fa-wand-magic-sparkles" /> New features ({newCount})
              </button>
            </div>
          )}
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>
        ) : !tenantId ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No companies registered yet.</div>
        ) : (
          <>
          {/* Company settings cards step aside while searching, so matches show first. */}
          {!scopeOutletId && !search.trim() && !newOnly && (
            <>
              <AutoApprovalCard
                tenant={currentTenant}
                onSaved={refreshTenants}
                title="Leave Auto-Approval"
                description={'Employees can self-approve their own leave requests instantly, up to a monthly limit, before requests start routing to their manager and then HR. Some companies want a few auto-approvals a month; others want every leave request reviewed by a human — turn this off for those.'}
                enabledField="leave_auto_approval_enabled"
                limitField="leave_auto_approval_limit"
              />
              <AutoApprovalCard
                tenant={currentTenant}
                onSaved={refreshTenants}
                title="Attendance Regularization Auto-Approval"
                description={'Employees can self-approve their own attendance-correction requests instantly, up to a monthly limit, before requests start routing to their manager and then HR. Independent of the leave setting above — a company can auto-approve one and not the other.'}
                enabledField="regularize_auto_approval_enabled"
                limitField="regularize_auto_approval_limit"
              />
              <AutoApprovalCard
                tenant={currentTenant}
                onSaved={refreshTenants}
                title="Special Requests Auto-Approval"
                description={'Employees can self-approve their own special requests (overtime, salary overtime, late arrival) instantly, up to a monthly limit, before requests start routing to their manager and then HR. Independent of the leave/regularization settings above.'}
                enabledField="special_auto_approval_enabled"
                limitField="special_auto_approval_limit"
              />
              <AutoClockoutCard tenant={currentTenant} onSaved={refreshTenants} />
              <AutoShiftCard tenant={currentTenant} onSaved={refreshTenants} />
              <CompOffGainTypeCard tenant={currentTenant} onSaved={refreshTenants} />
            </>
          )}
          {grouped.length === 0 && (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
              No features match{search ? ` "${search}"` : ''}.
            </div>
          )}
          {grouped.map(([category, items]) => (
            <div className="card" key={category} style={{ marginBottom: 16 }}>
              <div className="card-header"><h3>{category}</h3></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Feature</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {items.map((f) => {
                      const explicitRow = toggles.find((t) => t.feature_key === f.key && (t.outlet_id || null) === currentOutletId);
                      const effective = resolveFeatureState(toggles, f.key, currentOutletId, !f.is_premium);
                      return (
                        <tr key={f.key}>
                          <td>
                            <strong>{f.name}</strong>
                            {isNewFeature(f.key) && (
                              <span className="badge badge-info" style={{ marginLeft: 8, fontSize: 10 }}>New</span>
                            )}
                            {f.is_premium && (
                              <span className="premium-badge" style={{ marginLeft: 8 }}>
                                <i className="fas fa-crown" /> Premium
                              </span>
                            )}
                            {f.description && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{f.description}</div>}
                          </td>
                          <td>
                            <span className={`badge ${effective ? 'badge-success' : 'badge-danger'}`}>{effective ? 'Enabled' : 'Disabled'}</span>
                            {!explicitRow && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-muted)' }}>(inherited)</span>}
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                              <button
                                className="btn btn-outline btn-icon btn-sm"
                                disabled={savingKey === f.key}
                                onClick={() => handleToggle(f)}
                                title={effective ? 'Disable' : 'Enable'}
                              >
                                <i className={`fas ${effective ? 'fa-toggle-on' : 'fa-toggle-off'}`} style={{ color: effective ? 'var(--success)' : 'var(--text-muted)' }} />
                              </button>
                              {explicitRow && (
                                <button className="btn btn-outline btn-sm" disabled={savingKey === f.key} onClick={() => handleReset(f)} title="Reset to default (inherit)">
                                  Reset
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          </>
        )}
      </div>
    </>
  );
}
