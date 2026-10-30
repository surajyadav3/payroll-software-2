import { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { listSalaryAdditions, createSalaryAddition, deleteSalaryAddition } from '@/services/salaryAdditionsService';
import { listActiveEmployees } from '@/services/employeeService';
import { fmt, fullName, monthLabel, getInitials, getAvatarColor, scopedToOutlet } from '@/lib/helpers';

const PRESETS = ['Arrears', 'Incentive', 'Retention Bonus', 'Leave Encashment', 'Gratuity Payout', 'Other'];

function blankForm() {
  const now = new Date();
  return {
    profile_id: '', component_name: 'Arrears', category: 'earning', amount: '',
    is_recurring: false, effective_month: now.getMonth() + 1, effective_year: now.getFullYear(), reason: '',
  };
}

const STATUS_BADGE = { Pending: 'badge-warning', Approved: 'badge-info', Paid: 'badge-success', Rejected: 'badge-danger' };

export default function SalaryAdditionsPage() {
  const { tenant, profile } = useAuth();
  const isManager = profile?.role === 'manager';
  const { outletProfileIds } = useOutletView();
  const [rows, setRows]           = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm]           = useState(blankForm());

  const fetchData = useCallback(async () => {
    if (!tenant) return;
    setLoading(true);
    try {
      const [rowsRes, empsRes] = await Promise.all([
        listSalaryAdditions(tenant.id),
        listActiveEmployees(tenant.id),
      ]);
      setRows(scopedToOutlet(rowsRes.data, outletProfileIds));
      setEmployees(scopedToOutlet(empsRes.data, outletProfileIds, 'id'));
    } finally {
      setLoading(false);
    }
  }, [tenant, outletProfileIds]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async () => {
    if (!form.profile_id) return showToast('Select an employee', 'error');
    if (!form.amount) return showToast('Enter an amount', 'error');
    const { error } = await createSalaryAddition(tenant.id, profile.id, form);
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast('Added — will apply on the next payroll run for that month', 'success');
    setShowModal(false);
    setForm(blankForm());
    fetchData();
  };

  const handleDelete = async (id) => {
    if (!confirm('Remove this pay item?')) return;
    const { error } = await deleteSalaryAddition(id);
    if (error) return showToast('Delete failed: ' + error.message, 'error');
    showToast('Removed', 'success');
    fetchData();
  };

  return (
    <>
      <Header title="One-Off Pay Items" breadcrumb="Arrears, incentives, retention bonus, leave encashment, gratuity — folded into the payroll run for their effective month" />
      <div className="page-content">
        <div className="filter-bar">
          {!isManager && (
            <div style={{ marginLeft: 'auto' }}>
              <button className="btn btn-primary" onClick={() => setShowModal(true)}>
                <i className="fas fa-plus" /> New Pay Item
              </button>
            </div>
          )}
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Employee</th><th>Item</th><th>Type</th><th>Amount</th><th>Effective</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No pay items yet</td></tr>
                  ) : rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <div className="emp-cell">
                          <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(r.profile_id)})` }}>
                            {getInitials(r.profile?.first_name, r.profile?.last_name)}
                          </div>
                          <div><div className="emp-name">{fullName(r.profile)}</div></div>
                        </div>
                      </td>
                      <td>{r.component_name}{r.reason ? <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.reason}</div> : null}</td>
                      <td><span className={`badge ${r.category === 'earning' ? 'badge-success' : 'badge-danger'}`}>{r.category === 'earning' ? 'Earning' : 'Deduction'}</span></td>
                      <td>{fmt(r.amount)}</td>
                      <td>{monthLabel(r.effective_month - 1, r.effective_year)}</td>
                      <td><span className={`badge ${STATUS_BADGE[r.status]}`}>{r.status}</span></td>
                      <td>
                        {!isManager && r.status !== 'Paid' && (
                          <button className="btn btn-outline btn-icon btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleDelete(r.id)}><i className="fas fa-trash" /></button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Modal show={showModal} onClose={() => setShowModal(false)} title="New Pay Item" width="480px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave}><i className="fas fa-check" /> Save</button>
        </>}
      >
        <div className="form-group">
          <label className="form-label">Employee *</label>
          <select className="form-select" value={form.profile_id} onChange={(e) => setForm({ ...form, profile_id: e.target.value })}>
            <option value="">Select Employee</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{fullName(e)}</option>)}
          </select>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Item</label>
            <select className="form-select" value={form.component_name} onChange={(e) => setForm({ ...form, component_name: e.target.value })}>
              {PRESETS.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Type</label>
            <select className="form-select" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="earning">Earning</option>
              <option value="deduction">Deduction</option>
            </select>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Amount (₹) *</label>
          <input className="form-input" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Effective Month</label>
            <select className="form-select" value={form.effective_month} onChange={(e) => setForm({ ...form, effective_month: parseInt(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{monthLabel(i, 2000).split(' ')[0]}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Effective Year</label>
            <input className="form-input" type="number" value={form.effective_year} onChange={(e) => setForm({ ...form, effective_year: parseInt(e.target.value) })} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Reason / Note</label>
          <input className="form-input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </div>
      </Modal>
    </>
  );
}
