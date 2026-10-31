import { useEffect, useState, useCallback, useMemo } from 'react';
import StatCard from '@/components/StatCard';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { listSalaryAdditionsNamed, createSalaryAddition, deleteSalaryAddition } from '@/services/salaryAdditionsService';
import { listPayrollEmployees } from '@/services/employeeService';
import { fetchPayslipProfileIds } from '@/services/payrollService';
import { fmt, fullName, monthLabel, scopedToOutlet, isRaniwalaHrLogin } from '@/lib/helpers';
import * as XLSX from 'xlsx';

const muted = { color: 'var(--text-muted)' };
const small = { fontSize: 11, ...muted };

// The same name the Run Payroll details pop-up uses, so the run folds it in as
// an arrear: ARREAR / INCENTIVE column of the salary sheet + an "Arrear" line
// on the payslip.
const ARREAR = 'Arrear';

const pad = (n) => String(n).padStart(2, '0');
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const blank = { profile_id: '', amount: '', remark: '' };

/**
 * Difference › Arrears (Raniwala): HR picks a payroll month and adds an
 * arrear per employee. Each one is a salary_additions row ("Arrear", earning,
 * Approved) due in that month, so that month's payroll run pays it — it shows
 * in the employee's row of the salary sheet and on their payslip as "Arrear",
 * and is marked Paid once the run is processed. A month already processed for
 * the employee needs its payroll reverted and run again to pick it up.
 */
export default function ArrearsTab() {
  const { tenant, profile } = useAuth();
  const { outletProfileIds } = useOutletView();
  const [ym, setYm] = useState(thisMonth());
  const [year, month] = [Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1];
  const [employees, setEmployees] = useState([]);
  const [rows, setRows] = useState([]);
  const [processed, setProcessed] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(blank);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const monthText = monthLabel(month, year);

  const fetchData = useCallback(async () => {
    if (!tenant || !year) return;
    setLoading(true);
    try {
      const [empRes, addRes, slipRes] = await Promise.all([
        listPayrollEmployees(tenant.id, `${year}-${pad(month + 1)}-01`),
        listSalaryAdditionsNamed(tenant.id, ARREAR, month + 1, year),
        fetchPayslipProfileIds(tenant.id, month, year),
      ]);
      if (empRes.error || addRes.error) showToast('Could not load: ' + (empRes.error || addRes.error).message, 'error');
      setEmployees(scopedToOutlet(empRes.data, outletProfileIds, 'id').filter((e) => !isRaniwalaHrLogin(e)));
      setRows(scopedToOutlet(addRes.data, outletProfileIds));
      setProcessed(slipRes.data);
    } finally {
      setLoading(false);
    }
  }, [tenant, outletProfileIds, year, month]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const byId = useMemo(() => Object.fromEntries(employees.map((e) => [e.id, e])), [employees]);
  const label = (e) => [e.employee_id, fullName(e)].filter(Boolean).join(' · ');
  const options = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q ? employees.filter((e) => label(e).toLowerCase().includes(q)) : employees;
    return [...list].sort((a, b) => String(a.employee_id || '').localeCompare(String(b.employee_id || ''), undefined, { numeric: true }));
  }, [employees, search]);

  const shown = useMemo(() => [...rows].sort((a, b) =>
    String(byId[a.profile_id]?.employee_id || '').localeCompare(String(byId[b.profile_id]?.employee_id || ''), undefined, { numeric: true })
    || String(a.created_at).localeCompare(String(b.created_at))), [rows, byId]);
  const total = rows.reduce((t, r) => t + Number(r.amount || 0), 0);
  const people = new Set(rows.map((r) => r.profile_id)).size;
  const pickedProcessed = form.profile_id && processed.has(form.profile_id);

  const add = async () => {
    if (!form.profile_id) return showToast('Select the employee', 'error');
    const amount = Math.round(Number(form.amount));
    if (!(amount > 0)) return showToast('Enter the arrear amount', 'error');
    setSaving(true);
    const { error } = await createSalaryAddition(tenant.id, profile.id, {
      profile_id: form.profile_id, component_name: ARREAR, category: 'earning', amount,
      is_recurring: false, effective_month: month + 1, effective_year: year, reason: form.remark.trim(),
    });
    setSaving(false);
    if (error) return showToast('Could not add: ' + error.message, 'error');
    showToast(processed.has(form.profile_id)
      ? `Added — ${monthText} is already processed for this employee, revert and process it again to pay it`
      : `Added — ${monthText} payroll pays it as Arrear`, 'success');
    setForm(blank);
    setSearch('');
    fetchData();
  };

  const remove = async (r) => {
    const e = byId[r.profile_id];
    if (!confirm(`Remove the ${fmt(r.amount)} arrear${e ? ` of ${fullName(e)}` : ''} for ${monthText}?`)) return;
    const { error } = await deleteSalaryAddition(r.id);
    if (error) return showToast('Could not remove: ' + error.message, 'error');
    showToast('Removed', 'success');
    fetchData();
  };

  const exportExcel = () => {
    const ws = XLSX.utils.json_to_sheet(shown.map((r) => {
      const e = byId[r.profile_id] || {};
      return {
        'EMP CODE': e.employee_id || '',
        NAME: fullName(e),
        DEPARTMENT: e.department || '',
        ARREAR: Number(r.amount),
        REMARK: r.reason || '',
        STATUS: r.status === 'Paid' ? 'Paid' : 'Due',
      };
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Arrears');
    XLSX.writeFile(wb, `arrears_${ym}.xlsx`);
  };

  return (
    <>
      <div className="stats-row" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <StatCard icon="fa-users" iconColor="blue" value={people} label={`Employees with an arrear in ${monthText}`} />
        <StatCard icon="fa-indian-rupee-sign" iconColor="green" value={fmt(total)} label={`Arrears paid in ${monthText}`} />
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ padding: '12px 20px', fontSize: 13 }}>
          An arrear added here is paid in the picked month&apos;s payroll: it shows in the employee&apos;s
          ARREAR / INCENTIVE column of the salary sheet and as &quot;Arrear&quot; on their payslip. The remark is for HR only.
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ padding: '16px 20px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label className="form-label">Payroll month</label>
            <input className="form-input" type="month" value={ym} onChange={(e) => e.target.value && setYm(e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0, flex: '2 1 260px' }}>
            <label className="form-label">Employee</label>
            <input className="form-input" placeholder="Search code or name" value={search}
              onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 6 }} />
            <select className="form-select" value={form.profile_id} onChange={(e) => setForm({ ...form, profile_id: e.target.value })}>
              <option value="">Select employee ({options.length})</option>
              {options.map((e) => <option key={e.id} value={e.id}>{label(e)}{e.inactive ? ' (left)' : ''}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ margin: 0, flex: '1 1 120px' }}>
            <label className="form-label">Arrear (₹)</label>
            <input className="form-input" type="number" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div className="form-group" style={{ margin: 0, flex: '2 1 200px' }}>
            <label className="form-label">Remark (HR only)</label>
            <input className="form-input" placeholder="e.g. September short payment" value={form.remark}
              onChange={(e) => setForm({ ...form, remark: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
          </div>
          <button className="btn btn-primary" onClick={add} disabled={saving}><i className="fas fa-plus" /> Add arrear</button>
        </div>
        {pickedProcessed && (
          <div style={{ padding: '0 20px 12px', fontSize: 12, color: 'var(--warning)' }}>
            {monthText} payroll is already processed for this employee — after adding, revert that payroll and process it again so the arrear is paid.
          </div>
        )}
      </div>

      <div className="filter-bar">
        <div style={{ fontSize: 13, ...muted }}>Arrears for {monthText}</div>
        <div style={{ marginLeft: 'auto' }}>
          <button className="btn btn-outline" onClick={exportExcel} disabled={!shown.length}><i className="fas fa-file-excel" /> Export</button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', ...muted }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Employee</th><th>Arrear</th><th>Remark</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: 'center', padding: 40, ...muted }}>No arrears for {monthText} yet</td></tr>
                ) : shown.map((r) => {
                  const e = byId[r.profile_id];
                  const paid = r.status === 'Paid';
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="emp-name">{e ? fullName(e) : 'Employee not in this month'}</div>
                        <div style={small}>{[e?.employee_id, e?.department].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td style={{ fontWeight: 700, color: 'var(--success)' }}>+{fmt(r.amount)}</td>
                      <td style={{ whiteSpace: 'normal', maxWidth: 280 }}>{r.reason || <span style={small}>—</span>}</td>
                      <td>
                        {paid
                          ? <span className="badge badge-success">Paid</span>
                          : processed.has(r.profile_id)
                            ? <><span className="badge badge-warning">Not in slip</span><div style={small}>revert + process {monthText} again</div></>
                            : <span className="badge badge-info">Due in {monthText}</span>}
                      </td>
                      <td>
                        {!paid && (
                          <button className="btn btn-outline btn-icon btn-sm" style={{ color: 'var(--danger)' }} title="Remove" onClick={() => remove(r)}>
                            <i className="fas fa-trash" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {shown.length > 0 && (
                <tfoot>
                  <tr style={{ fontWeight: 700 }}><td>Total</td><td>{fmt(total)}</td><td colSpan={3} /></tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}
    </>
  );
}
