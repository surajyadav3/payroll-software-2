import { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import BulkApproveBar, { BulkHeadCell, BulkRowCell } from '@/components/BulkApproveBar';
import { useBulkApproval } from '@/hooks/useBulkApproval';
import { useAuth } from '@/context/AuthContext';
import {
  listMyExpenseClaims, listTenantExpenseClaims, createExpenseClaim,
  approveExpenseClaim, rejectExpenseClaim, deleteExpenseClaim,
  uploadReceipt, getReceiptUrl, RECEIPT_MAX_BYTES, EXPENSE_CATEGORIES,
} from '@/services/expenseService';
import { listAdvances } from '@/services/advanceService';
import { fmt, fullName } from '@/lib/helpers';
import { exportRequestSheet, fmtExportDateTime } from '@/lib/requestExport';

const STATUS_BADGE = { Pending: 'badge-warning', Approved: 'badge-success', Rejected: 'badge-danger', Paid: 'badge-secondary' };

function blankItem() { return { category: 'Travel', amount: '', description: '', receipt_path: '', uploading: false }; }

export default function ExpenseClaimsPage() {
  const { profile, tenant } = useAuth();
  const canManage = profile?.role === 'admin' || profile?.role === 'manager' || profile?.role === 'superadmin';
  const [rows, setRows]         = useState([]);
  const [advances, setAdvances] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [advanceId, setAdvanceId] = useState('');
  const [items, setItems] = useState([blankItem()]);

  const fetchData = useCallback(async () => {
    if (!profile || !tenant) return;
    setLoading(true);
    try {
      const { data } = canManage ? await listTenantExpenseClaims(tenant.id) : await listMyExpenseClaims(profile.id);
      setRows(data);
      if (!canManage) {
        const { data: myAdv } = await listAdvances(tenant.id);
        setAdvances((myAdv || []).filter((a) => a.profile_id === profile.id && a.status === 'Active'));
      }
    } finally {
      setLoading(false);
    }
  }, [profile, tenant, canManage]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const updateItem = (i, field, val) => setItems((p) => { const n = [...p]; n[i] = { ...n[i], [field]: val }; return n; });
  const addItem = () => setItems((p) => [...p, blankItem()]);
  const removeItem = (i) => setItems((p) => p.filter((_, idx) => idx !== i));

  const handleReceiptUpload = async (i, file) => {
    if (!file) return;
    if (file.size > RECEIPT_MAX_BYTES) return showToast('File too large (max 5MB)', 'error');
    updateItem(i, 'uploading', true);
    const { path, error } = await uploadReceipt(tenant.id, profile.id, file);
    updateItem(i, 'uploading', false);
    if (error) return showToast('Upload failed: ' + error.message, 'error');
    updateItem(i, 'receipt_path', path);
    showToast('Receipt attached', 'success');
  };

  const handleSubmit = async () => {
    const valid = items.filter((i) => i.amount);
    if (!valid.length) return showToast('Add at least one line item with an amount', 'error');
    const { error } = await createExpenseClaim(tenant.id, profile.id, advanceId || null, valid);
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast('Expense claim submitted', 'success');
    setShowModal(false);
    setItems([blankItem()]);
    setAdvanceId('');
    fetchData();
  };

  const handleApprove = async (id) => {
    const now = new Date();
    const { error } = await approveExpenseClaim(id, now.getMonth() + 1, now.getFullYear());
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast('Approved', 'success');
    fetchData();
  };

  const handleReject = async (id) => {
    const { error } = await rejectExpenseClaim(id);
    if (error) return showToast('Failed: ' + error.message, 'error');
    fetchData();
  };

  const bulk = useBulkApproval({
    rows,
    loading,
    canAct: (r) => canManage && r.status === 'Pending',
    noun: 'claim',
    onDone: fetchData,
    decide: (r, approve) => {
      const now = new Date();
      return approve ? approveExpenseClaim(r.id, now.getMonth() + 1, now.getFullYear()) : rejectExpenseClaim(r.id);
    },
  });

  const exportList = () => {
    exportRequestSheet(rows.map((r) => ({
      ...(canManage ? {
        'Emp Code': r.profile?.employee_id || '',
        Employee: fullName(r.profile),
        Department: r.profile?.department || '',
      } : {}),
      Items: (r.items || []).map((i) => `${i.category} ${fmt(i.amount)}${i.description ? ` - ${i.description}` : ''}`).join('; '),
      Total: Number(r.total_amount) || 0,
      Status: r.status,
      'Submitted On': fmtExportDateTime(r.created_at),
    })), {
      sheet: 'Expense Claims',
      file: 'expense claims',
      widths: [...(canManage ? [10, 24, 18] : []), 50, 12, 10, 22],
    });
  };

  const viewReceipt = async (path) => {
    const { url } = await getReceiptUrl(path);
    if (url) window.open(url, '_blank');
  };

  return (
    <>
      <Header title="Expense Claims" breadcrumb="Line-itemed claims with receipts — nets against an advance or adds to payroll as a reimbursement" />
      <div className="page-content">
        <div className="filter-bar">
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" onClick={exportList} disabled={loading || rows.length === 0}>
              <i className="fas fa-file-excel" style={{ marginRight: 6 }} />Export
            </button>
            <button className="btn btn-primary" onClick={() => setShowModal(true)}><i className="fas fa-plus" /> New Claim</button>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>
        ) : (
          <div className="card">
            <BulkApproveBar bulk={bulk} />
            <div className="table-wrap">
              <table>
                <thead><tr><BulkHeadCell bulk={bulk} />{canManage && <th>Employee</th>}<th>Items</th><th>Total</th><th>Status</th>{canManage && <th>Actions</th>}{!canManage && <th>Actions</th>}</tr></thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={canManage ? 5 : 4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No expense claims yet</td></tr>
                  ) : rows.map((r) => (
                    <tr key={r.id}>
                      <BulkRowCell bulk={bulk} row={r} />
                      {canManage && <td>{fullName(r.profile)}</td>}
                      <td style={{ fontSize: 12 }}>
                        {(r.items || []).map((i) => (
                          <div key={i.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span className="badge badge-info" style={{ fontSize: 10 }}>{i.category}</span> {fmt(i.amount)}
                            {i.receipt_path && <button className="btn btn-outline btn-icon btn-sm" onClick={() => viewReceipt(i.receipt_path)} title="View receipt"><i className="fas fa-paperclip" /></button>}
                          </div>
                        ))}
                      </td>
                      <td><strong>{fmt(r.total_amount)}</strong></td>
                      <td><span className={`badge ${STATUS_BADGE[r.status]}`}>{r.status}</span></td>
                      <td>
                        {canManage && r.status === 'Pending' && <>
                          <button className="btn btn-outline btn-sm" disabled={bulk.busy} onClick={() => handleApprove(r.id)}>Approve</button>{' '}
                          <button className="btn btn-outline btn-sm" style={{ color: 'var(--danger)' }} disabled={bulk.busy} onClick={() => handleReject(r.id)}>Reject</button>
                        </>}
                        {!canManage && r.status === 'Pending' && (
                          <button className="btn btn-outline btn-sm" style={{ color: 'var(--danger)' }} onClick={async () => { await deleteExpenseClaim(r.id); fetchData(); }}>Withdraw</button>
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

      <Modal show={showModal} onClose={() => setShowModal(false)} title="New Expense Claim" width="560px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit}>Submit</button>
        </>}
      >
        {advances.length > 0 && (
          <div className="form-group">
            <label className="form-label">Net against advance (optional)</label>
            <select className="form-select" value={advanceId} onChange={(e) => setAdvanceId(e.target.value)}>
              <option value="">None — reimburse via payroll</option>
              {advances.map((a) => <option key={a.id} value={a.id}>{a.type} — balance {fmt(a.balance)}</option>)}
            </select>
          </div>
        )}
        {items.map((it, i) => (
          <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <select className="form-select" value={it.category} onChange={(e) => updateItem(i, 'category', e.target.value)} style={{ maxWidth: 150 }}>
                {EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
              <input className="form-input" type="number" placeholder="Amount" value={it.amount} onChange={(e) => updateItem(i, 'amount', e.target.value)} style={{ width: 110 }} />
              <button className="btn btn-outline btn-icon btn-sm" style={{ color: 'var(--danger)' }} onClick={() => removeItem(i)}><i className="fas fa-trash" /></button>
            </div>
            <input className="form-input" placeholder="Description" value={it.description} onChange={(e) => updateItem(i, 'description', e.target.value)} style={{ marginBottom: 6 }} />
            <input type="file" accept="image/*,.pdf" onChange={(e) => handleReceiptUpload(i, e.target.files[0])} disabled={it.uploading} style={{ fontSize: 12 }} />
            {it.receipt_path && <span style={{ fontSize: 11, color: 'var(--success)', marginLeft: 6 }}><i className="fas fa-check" /> Attached</span>}
          </div>
        ))}
        <button className="btn btn-outline btn-sm" onClick={addItem}><i className="fas fa-plus" /> Add Item</button>
      </Modal>
    </>
  );
}
