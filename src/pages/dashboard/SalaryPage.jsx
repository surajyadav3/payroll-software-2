import React from 'react';
import { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { listComponents, saveComponent, deleteComponent } from '@/services/salaryService';
import { updateTenant } from '@/services/tenantService';
import { fmt, calcSalary, isRaniwalaTenant } from '@/lib/helpers';
import RaniwalaStructureGuide from '@/components/payroll/RaniwalaStructureGuide';

// PF is a per-employee toggle (Employees page) but the *formula* — wage
// ceiling and contribution rate — is a tenant-wide policy. Defaults match
// the statutory Rs.15,000 ceiling / 12% used before this became configurable
// (see 20260903_3_tenant_pf_settings.sql) so an untouched tenant sees no change.
function PfSettingsCard({ tenant, onSaved }) {
  const [wageCeiling, setWageCeiling] = useState(15000);
  const [rate, setRate]               = useState(12);
  const [saving, setSaving]           = useState(false);

  useEffect(() => {
    if (!tenant) return;
    setWageCeiling(tenant.pf_wage_ceiling ?? 15000);
    setRate(tenant.pf_employee_rate ?? 12);
  }, [tenant?.id, tenant?.pf_wage_ceiling, tenant?.pf_employee_rate]);

  if (!tenant) return null;

  const dirty = Number(wageCeiling) !== (tenant.pf_wage_ceiling ?? 15000)
    || Number(rate) !== (tenant.pf_employee_rate ?? 12);

  const handleSave = async () => {
    const ceilingNum = parseFloat(wageCeiling);
    const rateNum    = parseFloat(rate);
    if (!(ceilingNum > 0)) return showToast('Wage ceiling must be greater than 0', 'error');
    if (!(rateNum > 0 && rateNum <= 100)) return showToast('Rate must be between 0 and 100', 'error');

    setSaving(true);
    const { error } = await updateTenant(tenant.id, { pf_wage_ceiling: ceilingNum, pf_employee_rate: rateNum });
    setSaving(false);
    if (error) return showToast('Failed to update: ' + error.message, 'error');
    showToast('PF settings saved', 'success');
    onSaved();
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header"><h3>Statutory (PF) Settings</h3></div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Applies only to employees with PF enabled (Employees page). PF is deducted at{' '}
          <strong>{rate || 0}%</strong> of CTC, capped at the wage ceiling once CTC exceeds it — so
          every employee above the ceiling pays the same flat amount. The payslip also shows an
          info-only employer contribution at the same rate — it isn't deducted from the employee.
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">PF Wage Ceiling (₹)</label>
            <input className="form-input" type="number" min="1" value={wageCeiling} onChange={(e) => setWageCeiling(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Employee PF Rate (%)</label>
            <input className="form-input" type="number" min="0.01" max="100" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
        </div>
        <div>
          <button className="btn btn-primary btn-sm" disabled={saving || !dirty} onClick={handleSave}>
            {saving ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Saving…</> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SalaryStructurePage() {
  const { tenant, refreshProfile } = useAuth();
  const [components, setComponents] = useState([]);
  const [loading, setLoading]       = useState(true);
  const [showModal, setShowModal]   = useState(false);
  const [editComp, setEditComp]     = useState(null);
  const [form, setForm]             = useState({ name: '', category: 'earning', calc_type: 'percent_ctc', percent: '', fixed: '', formula: '', depends_on: '' });

  const fetchComponents = useCallback(async () => {
    // Raniwala's page shows the fixed rules, not components — nothing to load.
    if (!tenant || isRaniwalaTenant(tenant)) return;
    setLoading(true);
    try {
      const { data, error } = await listComponents(tenant.id);
      if (error) console.error(error);
      setComponents(data);
    } finally {
      setLoading(false);
    }
  }, [tenant]);

  useEffect(() => { fetchComponents(); }, [fetchComponents]);

  const openModal = (category, comp = null) => {
    setEditComp(comp);
    setForm({
      name:       comp?.name      || '',
      category:   comp?.category  || category,
      calc_type:  comp?.calc_type || 'percent_ctc',
      percent:    comp?.percent   || '',
      fixed:      comp?.fixed     || '',
      formula:    comp?.formula   || '',
      depends_on: (comp?.depends_on || []).join(', '),
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return showToast('Name is required', 'error');
    if (form.calc_type === 'formula' && !form.formula.trim()) return showToast('Formula is required', 'error');
    const { error } = await saveComponent(tenant.id, form, editComp?.id);
    if (error) return showToast((editComp ? 'Update' : 'Add') + ' failed: ' + error.message, 'error');
    showToast(editComp ? 'Component updated' : 'Component added', 'success');
    setShowModal(false);
    fetchComponents();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this salary component?')) return;
    const { error } = await deleteComponent(id);
    if (error) return showToast('Delete failed: ' + error.message, 'error');
    showToast('Deleted', 'success');
    fetchComponents();
  };

  // Raniwala's structure is fixed rules on the gross salary (lib/raniwalaPayroll.js),
  // so there are no components to configure — the page explains the rules instead.
  if (isRaniwalaTenant(tenant)) {
    return (
      <>
        <Header title="Salary Structure" breadcrumb="How every salary is worked out from the gross" />
        <div className="page-content"><RaniwalaStructureGuide /></div>
      </>
    );
  }

  const previewSalary = calcSalary(30000, components, tenant?.work_days || 30, tenant?.work_days || 30);

  // Validate that earning % components roughly cover CTC
  const earningPct = components
    .filter(c => c.category === 'earning' && c.calc_type === 'percent_ctc')
    .reduce((sum, c) => sum + (parseFloat(c.percent) || 0), 0);
  const hasFixedEarnings = components.some(c => c.category === 'earning' && c.calc_type === 'fixed');
  const earningCoverage  = Math.round((previewSalary.totalEarning / 30000) * 100); // % of sample CTC covered

  const renderTable = (category, label) => {
    const items = components.filter((c) => c.category === category);
    return (
      <div className="card">
        <div className="card-header">
          <h3>{label}</h3>
          <button className="btn btn-primary btn-sm" onClick={() => openModal(category)}>
            <i className="fas fa-plus" /> Add
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Component</th><th>Type</th><th>Value</th><th>Actions</th></tr></thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>No components configured</td></tr>
              ) : items.map((c) => {
                const typeLabel = c.calc_type === 'percent_ctc' ? '% of CTC' : c.calc_type === 'percent_basic' ? '% of Basic' : c.calc_type === 'formula' ? 'Formula' : 'Fixed';
                const valLabel  = c.calc_type === 'formula' ? <code style={{ fontSize: 11 }}>{c.formula}</code> : c.calc_type === 'fixed' ? fmt(c.fixed) : c.percent + '%';
                return (
                  <tr key={c.id}>
                    <td><strong>{c.name}</strong></td>
                    <td><span className={`badge ${category === 'earning' ? 'badge-success' : 'badge-danger'}`}>{typeLabel}</span></td>
                    <td>{valLabel}</td>
                    <td>
                      <button className="btn btn-outline btn-icon btn-sm" onClick={() => openModal(category, c)}><i className="fas fa-edit" /></button>{' '}
                      <button className="btn btn-outline btn-icon btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleDelete(c.id)}><i className="fas fa-trash" /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <>
      <Header title="Salary Structure" breadcrumb="Configure earning and deduction components" />
      <div className="page-content">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading components…</div>
        ) : (
          <>
            <PfSettingsCard tenant={tenant} onSaved={refreshProfile} />
            {components.length > 0 && (
              <div style={{
                background: earningCoverage === 100 ? 'var(--success-light, #d1fae5)' : earningCoverage > 100 ? 'var(--danger-light, #fee2e2)' : 'var(--warning-light, #fffbeb)',
                border: `1px solid ${earningCoverage === 100 ? 'var(--success)' : earningCoverage > 100 ? 'var(--danger)' : 'var(--warning)'}`,
                borderRadius: 8, padding: '10px 16px', marginBottom: 16,
                fontSize: 13, display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <i className={`fas ${earningCoverage === 100 ? 'fa-check-circle' : earningCoverage > 100 ? 'fa-exclamation-circle' : 'fa-exclamation-triangle'}`}
                   style={{ color: earningCoverage === 100 ? 'var(--success)' : earningCoverage > 100 ? 'var(--danger)' : 'var(--warning-dark, #92400e)' }} />
                <span style={{ color: earningCoverage === 100 ? 'var(--success)' : earningCoverage > 100 ? 'var(--danger)' : 'var(--warning-dark, #92400e)' }}>
                  {earningCoverage === 100
                    ? 'Salary structure is correctly configured — earnings cover 100% of CTC.'
                    : earningCoverage > 100
                    ? `Earnings exceed CTC by ${earningCoverage - 100}%. Reduce component percentages.`
                    : `Earnings cover only ${earningCoverage}% of CTC. Add more components or increase percentages${hasFixedEarnings ? ' (fixed amounts counted in preview)' : ''}.`}
                </span>
              </div>
            )}

            <div className="grid-2">
              {renderTable('earning', 'Earning Components')}
              {renderTable('deduction', 'Deduction Components')}
            </div>

            <div className="card">
              <div className="card-header">
                <h3>Salary Preview</h3>
                <div className="subtitle">See how a sample ₹30,000 CTC breaks down</div>
              </div>
              <div className="card-body">
                <div style={{ maxWidth: 420 }}>
                  <h4 style={{ fontSize: 13, color: 'var(--success)', marginBottom: 8 }}>Earnings</h4>
                  {previewSalary.earnings.map((e, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                      <span>{e.name}</span><span>{fmt(e.amount)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, fontSize: 13 }}>
                    <span>Total Earnings</span><span>{fmt(previewSalary.totalEarning)}</span>
                  </div>
                  <h4 style={{ fontSize: 13, color: 'var(--danger)', margin: '14px 0 8px' }}>Deductions</h4>
                  {previewSalary.deductions.map((d, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                      <span>{d.name}</span><span>{fmt(d.amount)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, fontSize: 13 }}>
                    <span>Total Deductions</span><span>{fmt(previewSalary.totalDeduction)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', fontWeight: 800, fontSize: 16, borderTop: '2px solid var(--text)', marginTop: 8 }}>
                    <span>Net Salary</span><span style={{ color: 'var(--success)' }}>{fmt(previewSalary.net)}</span>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      <Modal show={showModal} onClose={() => setShowModal(false)} title={editComp ? 'Edit Component' : 'Add Component'} width="420px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}><i className="fas fa-check" /> Save</button>
        </>}
      >
        <div className="form-group">
          <label className="form-label">Component Name *</label>
          <input className="form-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label">Calculation Type</label>
          <select className="form-select" value={form.calc_type} onChange={(e) => setForm({ ...form, calc_type: e.target.value })}>
            <option value="percent_ctc">% of CTC</option>
            <option value="percent_basic">% of Basic</option>
            <option value="fixed">Fixed Amount</option>
            <option value="formula">Formula</option>
          </select>
        </div>
        {form.calc_type === 'formula' ? (
          <>
            <div className="form-group">
              <label className="form-label">Formula *</label>
              <input className="form-input" placeholder="e.g. min(basic * 0.0833, 7000)" value={form.formula} onChange={(e) => setForm({ ...form, formula: e.target.value })} />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Use <code>ctc</code>, <code>basic</code>, other component names in snake_case (e.g. a component named "Special Allowance" is <code>special_allowance</code>), <code>+ - * /</code>, <code>()</code>, and <code>min()</code>/<code>max()</code>/<code>round()</code>.
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Depends on (comma-separated component keys)</label>
              <input className="form-input" placeholder="e.g. basic, special_allowance" value={form.depends_on} onChange={(e) => setForm({ ...form, depends_on: e.target.value })} />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                List any other formula-type components this one references, so they're computed first. Leave blank if this formula only uses <code>ctc</code>/<code>basic</code>.
              </div>
            </div>
          </>
        ) : form.calc_type !== 'fixed' ? (
          <div className="form-group">
            <label className="form-label">Percentage (%)</label>
            <input className="form-input" type="number" step="0.01" value={form.percent} onChange={(e) => setForm({ ...form, percent: e.target.value })} />
          </div>
        ) : (
          <div className="form-group">
            <label className="form-label">Fixed Amount (₹)</label>
            <input className="form-input" type="number" value={form.fixed} onChange={(e) => setForm({ ...form, fixed: e.target.value })} />
          </div>
        )}
      </Modal>
    </>
  );
}
