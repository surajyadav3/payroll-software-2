import React from 'react';
import { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { fetchPayslipsByMonth } from '@/services/payrollService';
import { listActiveEmployees } from '@/services/employeeService';
import { withSalaries } from '@/services/employeeSalaryService';
import { fetchLeaveBalancesAsOf } from '@/services/leaveLedgerService';
import { monthEndDate, parseBreakdown } from '@/lib/raniwalaPayroll';
import { fmt, monthLabel, escapeHtml, fullName, scopedToOutlet } from '@/lib/helpers';
import { raniwalaPayslipHtml } from '@/lib/raniwalaPayslipHtml';
import RaniwalaPayslip from '@/components/payroll/RaniwalaPayslip';

export default function PayslipsPage() {
  const { tenant } = useAuth();
  const { outletProfileIds } = useOutletView();
  const [month, setMonth] = useState(new Date().getMonth());
  const [year, setYear] = useState(new Date().getFullYear());
  const [payslips, setPayslips] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [filterEmp, setFilterEmp] = useState('');
  const [leaveMap, setLeaveMap] = useState({});
  const [loading, setLoading] = useState(true);

  const fetchPayslips = useCallback(async () => {
    if (!tenant) return;
    setLoading(true);
    try {
      const [slipsRes, empsRes] = await Promise.all([
        fetchPayslipsByMonth(tenant.id, month, year),
        // Salaries ride along for the CTC on a Raniwala slip (salary-private tenants only).
        listActiveEmployees(tenant.id).then((res) => withSalaries(tenant, res)),
      ]);
      const slips = scopedToOutlet(slipsRes.data, outletProfileIds);
      setPayslips(slips);
      setEmployees(scopedToOutlet(empsRes.data, outletProfileIds, 'id'));
      // Raniwala slips show the leave balance on the month's last day.
      const raniwalaIds = slips.filter((s) => parseBreakdown(s).raniwala).map((s) => s.profile_id);
      const { data: leave } = await fetchLeaveBalancesAsOf(tenant.id, monthEndDate(year, month), raniwalaIds);
      setLeaveMap(leave);
    } finally {
      setLoading(false);
    }
  }, [tenant, month, year, outletProfileIds]);

  useEffect(() => { fetchPayslips(); }, [fetchPayslips]);

  const changeMonth = (delta) => {
    let m = month + delta, y = year;
    if (m > 11) { m = 0; y++; } if (m < 0) { m = 11; y--; }
    setMonth(m); setYear(y);
  };

  const ctcOf = (slip) => employees.find((x) => x.id === slip.profile_id)?.salary_ctc;

  let filtered = payslips;
  if (filterEmp) filtered = filtered.filter((p) => p.profile_id === filterEmp);

  const printPayslip = (slip) => {
    let breakdown = { earnings: [], deductions: [] };
    try { breakdown = typeof slip.breakdown === 'string' ? JSON.parse(slip.breakdown) : slip.breakdown; } catch (_e) { /**/ }

    const w = window.open('', '', 'width=700,height=600');
    if (breakdown.raniwala) {
      // Prints itself once the logos have loaded.
      w.document.write(raniwalaPayslipHtml({
        slip, breakdown, ctc: ctcOf(slip), leave: leaveMap[slip.profile_id], companyName: tenant?.company_name, monthText: monthLabel(month, year),
        assetBase: window.location.origin, autoPrint: true,
      }));
      w.document.close();
      return;
    }
    w.document.write(`<html><head><title>Payslip</title>
    <style>body{font-family:Inter,sans-serif;padding:20px}*{margin:0;box-sizing:border-box}
    .row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px}
    .row.total{font-weight:700;font-size:15px;padding-top:10px;border-top:2px solid #000;margin-top:6px}
    .header{display:flex;justify-content:space-between;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #000}
    .section{font-size:12px;font-weight:700;margin:12px 0 6px;padding:4px 8px;background:#f0f0f0;border-radius:4px}</style></head><body>
    <div class="header"><div><strong style="font-size:16px">${escapeHtml(tenant?.company_name || 'Company')}</strong><br><span style="font-size:11px">Payslip for ${escapeHtml(monthLabel(month, year))}</span></div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:12px;margin-bottom:14px">
      <div>Name: <strong>${escapeHtml(slip.emp_name)}</strong></div>
      <div>Department: <strong>${escapeHtml(slip.department || '—')}</strong></div>
      <div>Days Worked: <strong>${escapeHtml(slip.work_days)}/${escapeHtml(slip.total_work_days)}</strong></div></div>
    <div class="section">Earnings</div>
    ${(breakdown.earnings || []).map((e) => `<div class="row"><span>${escapeHtml(e.name)}</span><span>₹${escapeHtml(e.amount?.toLocaleString('en-IN'))}</span></div>`).join('')}
    <div class="row" style="font-weight:600;border-top:1px solid #ccc;padding-top:6px"><span>Total Earnings</span><span>₹${escapeHtml(slip.gross_earnings?.toLocaleString('en-IN'))}</span></div>
    <div class="section">Deductions</div>
    ${(breakdown.deductions || []).map((d) => `<div class="row"><span>${escapeHtml(d.name)}</span><span>₹${escapeHtml(d.amount?.toLocaleString('en-IN'))}</span></div>`).join('')}
    ${slip.advance_deduction > 0 ? `<div class="row"><span>Advance Recovery</span><span>₹${slip.advance_deduction?.toLocaleString('en-IN')}</span></div>` : ''}
    <div class="row" style="font-weight:600;border-top:1px solid #ccc;padding-top:6px"><span>Total Deductions</span><span>₹${(slip.total_deductions + slip.advance_deduction)?.toLocaleString('en-IN')}</span></div>
    <div class="row total"><span>Net Pay</span><span>₹${slip.net_pay?.toLocaleString('en-IN')}</span></div>
    ${breakdown.pfInfo ? `
    <div style="margin-top:16px;background:#f8f8f8;border:1px solid #ddd;border-radius:6px;padding:10px 14px">
      <div style="font-size:12px;font-weight:700;margin-bottom:6px">Statutory Details (PF)</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:12px">
        <div>PF/UAN Number: <strong>${escapeHtml(breakdown.pfInfo.pfNumber || '—')}</strong></div>
        <div>PF Wage Ceiling: <strong>₹${escapeHtml((breakdown.pfInfo.wageCeiling || 0).toLocaleString('en-IN'))}</strong></div>
        <div>Employee Contribution: <strong>₹${escapeHtml((breakdown.pfInfo.employeeContribution || 0).toLocaleString('en-IN'))}</strong></div>
        <div>Employer Contribution: <strong>₹${escapeHtml((breakdown.pfInfo.employerContribution || 0).toLocaleString('en-IN'))}</strong></div>
      </div>
      <div style="font-size:10px;color:#666;margin-top:6px">Employer contribution is shown for information only — it is not deducted from the employee's pay.</div>
    </div>` : ''}
    </body></html>`);
    w.document.close();
    w.print();
  };

  return (
    <>
      <Header title="Payslips" breadcrumb={monthLabel(month, year)} />
      <div className="page-content">
        <div className="filter-bar">
          <div className="month-selector">
            <button onClick={() => changeMonth(-1)}><i className="fas fa-chevron-left" /></button>
            <span>{monthLabel(month, year)}</span>
            <button onClick={() => changeMonth(1)}><i className="fas fa-chevron-right" /></button>
          </div>
          <select className="form-select" value={filterEmp} onChange={(e) => setFilterEmp(e.target.value)}>
            <option value="">All Employees</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{fullName(e)}</option>
            ))}
          </select>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="card">
            <div className="card-body">
              <div className="empty-state">
                <i className="fas fa-file-invoice empty-icon" />
                <h3>No payslips found</h3>
                <p>No payroll has been processed for {monthLabel(month, year)}</p>
              </div>
            </div>
          </div>
        ) : (
          <>
          {filtered.some((s) => !s.released_at) && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--warning)' }}>
              <div style={{ padding: '12px 20px', fontSize: 13 }}>
                <i className="fas fa-eye-slash" style={{ color: 'var(--warning)', marginRight: 8 }} />
                {filtered.filter((s) => !s.released_at).length} payslip(s) here are <strong>held</strong> — employees cannot see them yet.
                Release them from Run Payroll.
              </div>
            </div>
          )}
          {filtered.map((slip) => {
            let breakdown = { earnings: [], deductions: [] };
            try { breakdown = typeof slip.breakdown === 'string' ? JSON.parse(slip.breakdown) : slip.breakdown; } catch (_e) { /**/ }

            if (breakdown.raniwala) {
              return (
                <div className="card" key={slip.id}>
                  <div className="card-body">
                    <RaniwalaPayslip
                      slip={slip} breakdown={breakdown} ctc={ctcOf(slip)} leave={leaveMap[slip.profile_id]} companyName={tenant?.company_name} monthText={monthLabel(month, year)}
                      action={<button className="btn btn-outline btn-sm" onClick={() => printPayslip(slip)}><i className="fas fa-print" /> Print</button>}
                    />
                  </div>
                </div>
              );
            }

            return (
              <div className="card" key={slip.id}>
                <div className="card-body">
                  <div className="payslip">
                    <div className="payslip-header">
                      <div>
                        <strong style={{ fontSize: 16 }}>{tenant?.company_name || 'Company'}</strong><br />
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Payslip for {monthLabel(month, year)}</span>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <button className="btn btn-outline btn-sm" onClick={() => printPayslip(slip)}>
                          <i className="fas fa-print" /> Print
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 12, marginBottom: 14 }}>
                      <div><span style={{ color: 'var(--text-muted)' }}>Name:</span> <strong>{slip.emp_name}</strong></div>
                      <div><span style={{ color: 'var(--text-muted)' }}>Department:</span> <strong>{slip.department || '—'}</strong></div>
                      <div><span style={{ color: 'var(--text-muted)' }}>Days Worked:</span> <strong>{slip.work_days}/{slip.total_work_days}</strong></div>
                    </div>
                    <div className="payslip-section-title" style={{ background: 'var(--success-light)', color: 'var(--success)' }}>Earnings</div>
                    {(breakdown.earnings || []).map((e, i) => (
                      <div className="payslip-row" key={i}><span>{e.name}</span><span>{fmt(e.amount)}</span></div>
                    ))}
                    <div className="payslip-row" style={{ fontWeight: 600, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                      <span>Total Earnings</span><span>{fmt(slip.gross_earnings)}</span>
                    </div>
                    <div className="payslip-section-title" style={{ background: 'var(--danger-light)', color: 'var(--danger)' }}>Deductions</div>
                    {(breakdown.deductions || []).map((d, i) => (
                      <div className="payslip-row" key={i}><span>{d.name}</span><span>{fmt(d.amount)}</span></div>
                    ))}
                    {slip.advance_deduction > 0 && (
                      <div className="payslip-row"><span>Advance/Loan Recovery</span><span>{fmt(slip.advance_deduction)}</span></div>
                    )}
                    <div className="payslip-row" style={{ fontWeight: 600, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                      <span>Total Deductions</span><span>{fmt(slip.total_deductions + slip.advance_deduction)}</span>
                    </div>
                    <div className="payslip-row total"><span>Net Pay</span><span style={{ color: 'var(--success)' }}>{fmt(slip.net_pay)}</span></div>
                    {breakdown.pfInfo && (
                      <div style={{ marginTop: 16, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Statutory Details (PF)</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 12 }}>
                          <div><span style={{ color: 'var(--text-muted)' }}>PF/UAN Number:</span> <strong>{breakdown.pfInfo.pfNumber || '—'}</strong></div>
                          <div><span style={{ color: 'var(--text-muted)' }}>PF Wage Ceiling:</span> <strong>{fmt(breakdown.pfInfo.wageCeiling)}</strong></div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Employee Contribution:</span> <strong>{fmt(breakdown.pfInfo.employeeContribution)}</strong></div>
                          <div><span style={{ color: 'var(--text-muted)' }}>Employer Contribution:</span> <strong>{fmt(breakdown.pfInfo.employerContribution)}</strong></div>
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                          Employer contribution is shown for information only — it is not deducted from the employee's pay.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          </>
        )}
      </div>
    </>
  );
}
