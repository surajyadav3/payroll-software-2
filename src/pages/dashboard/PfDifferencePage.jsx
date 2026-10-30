import { useEffect, useState, useCallback, useMemo } from 'react';
import Header from '@/components/Header';
import StatCard from '@/components/StatCard';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { fetchPayslipsByMonth } from '@/services/payrollService';
import { listSalaryAdditionsNamed, createSalaryAdditions } from '@/services/salaryAdditionsService';
import { fmt, monthLabel, scopedToOutlet, isRaniwalaTenant } from '@/lib/helpers';
import { parseBreakdown, raniwalaPfDifference, raniwalaSplitFor, RANIWALA_SPLIT_MONTHS } from '@/lib/raniwalaPayroll';
import * as XLSX from 'xlsx';

const muted = { color: 'var(--text-muted)' };
const small = { fontSize: 11, ...muted };

// The latest month HR paid in parts (Sept 2026), and the month after it, when
// the employee's PF difference is paid back.
const [splitYear, splitMonth] = Object.keys(RANIWALA_SPLIT_MONTHS).sort().pop().split('-').map(Number);
const SOURCE = { year: splitYear, month: splitMonth - 1 };
const PAYOUT = splitMonth === 12 ? { year: splitYear + 1, month: 0 } : { year: splitYear, month: splitMonth };
const ITEM = {
  component_name: `PF Difference (${monthLabel(SOURCE.month, SOURCE.year)})`,
  category: 'earning',
  effective_month: PAYOUT.month + 1,
  effective_year: PAYOUT.year,
  reason: `PF taken in ${monthLabel(SOURCE.month, SOURCE.year)} above the new monthly cap, returned`,
};

/**
 * Difference (Raniwala): Sept 2026 was paid in two runs, 1–16 on the old PF
 * rule and 17–30 on the new, so for some employees the two PF deductions add
 * up to more than the new rule's monthly cap (Rs.3,000 employee, Rs.3,250
 * employer). This page shows both differences per employee, from the Sept
 * payslips; "Add to October payroll" stores each employee's difference as an
 * October pay item (salary_additions, earning), which October's run pays back.
 * The employer difference is shown only — it is the company's own share.
 */
export default function PfDifferencePage() {
  const { tenant, profile } = useAuth();
  const { outletProfileIds } = useOutletView();
  const [slips, setSlips] = useState([]);
  const [stored, setStored] = useState({});
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const parts = raniwalaSplitFor(SOURCE.year, SOURCE.month);

  const fetchData = useCallback(async () => {
    if (!tenant) return;
    setLoading(true);
    try {
      const [slipsRes, storedRes] = await Promise.all([
        fetchPayslipsByMonth(tenant.id, SOURCE.month, SOURCE.year),
        listSalaryAdditionsNamed(tenant.id, ITEM.component_name, ITEM.effective_month, ITEM.effective_year),
      ]);
      setSlips(scopedToOutlet(slipsRes.data, outletProfileIds));
      setStored(Object.fromEntries(storedRes.data.map((a) => [a.profile_id, a])));
    } finally {
      setLoading(false);
    }
  }, [tenant, outletProfileIds]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const rows = useMemo(() => slips
    .map((s) => {
      const r = parseBreakdown(s).raniwala;
      if (!r?.parts?.length) return null;
      return { slip: s, code: r.empCode || '', ...raniwalaPfDifference(r.parts) };
    })
    .filter(Boolean)
    .sort((a, b) => b.employee.diff - a.employee.diff || a.slip.emp_name.localeCompare(b.slip.emp_name)), [slips]);

  const withDiff = rows.filter((r) => r.employee.diff > 0 || r.employer.diff > 0);
  const shown = onlyDiff ? withDiff : rows;
  const toStore = rows.filter((r) => r.employee.diff > 0 && !stored[r.slip.profile_id]);
  const sum = (list, pick) => list.reduce((t, r) => t + pick(r), 0);

  const addToPayroll = async () => {
    if (!toStore.length) return;
    const total = sum(toStore, (r) => r.employee.diff);
    if (!confirm(`Add ${ITEM.component_name} for ${toStore.length} employee(s), ${fmt(total)} in all, to the ${monthLabel(PAYOUT.month, PAYOUT.year)} payroll?`)) return;
    setSaving(true);
    const { error } = await createSalaryAdditions(tenant.id, profile.id, ITEM,
      toStore.map((r) => ({ profile_id: r.slip.profile_id, amount: r.employee.diff })));
    setSaving(false);
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast(`Stored — ${monthLabel(PAYOUT.month, PAYOUT.year)} payroll will add it to their pay`, 'success');
    fetchData();
  };

  const exportExcel = () => {
    const label = (i) => parts?.[i]?.label || `Part ${i + 1}`;
    const ws = XLSX.utils.json_to_sheet(shown.map((r) => ({
      'EMP CODE': r.code,
      NAME: r.slip.emp_name,
      DEPARTMENT: r.slip.department || '',
      ...Object.fromEntries(r.employee.byPart.map((v, i) => [`PF ${label(i)}`, v])),
      'PF TOTAL': r.employee.total,
      'PF CAP': r.employee.cap,
      'PF DIFFERENCE': r.employee.diff,
      ...Object.fromEntries(r.employer.byPart.map((v, i) => [`EMPLOYER PF ${label(i)}`, v])),
      'EMPLOYER PF TOTAL': r.employer.total,
      'EMPLOYER PF CAP': r.employer.cap,
      'EMPLOYER PF DIFFERENCE': r.employer.diff,
      [`ADDED TO ${monthLabel(PAYOUT.month, PAYOUT.year).toUpperCase()}`]: stored[r.slip.profile_id]?.amount ?? '',
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'PF Difference');
    XLSX.writeFile(wb, `pf_difference_${SOURCE.year}-${String(SOURCE.month + 1).padStart(2, '0')}.xlsx`);
  };

  if (!isRaniwalaTenant(tenant)) {
    return (
      <>
        <Header title="Difference" />
        <div className="page-content"><div className="card"><div className="card-body" style={muted}>This page is for Raniwala's two-run months only.</div></div></div>
      </>
    );
  }

  const partCols = parts?.length || 2;
  const status = (r) => {
    const a = stored[r.slip.profile_id];
    if (a) {
      const off = Number(a.amount) !== r.employee.diff;
      return (
        <>
          <span className={`badge ${a.status === 'Paid' ? 'badge-success' : 'badge-info'}`}>{a.status === 'Paid' ? 'Paid' : 'Added'} {fmt(a.amount)}</span>
          {off && <div style={{ fontSize: 11, color: 'var(--danger)' }}>now {fmt(r.employee.diff)}</div>}
        </>
      );
    }
    return r.employee.diff > 0 ? <span className="badge badge-warning">Not added</span> : <span style={small}>—</span>;
  };

  return (
    <>
      <Header title="Difference" breadcrumb={`PF taken in ${monthLabel(SOURCE.month, SOURCE.year)} above the new monthly cap`} />
      <div className="page-content">
        <div className="stats-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <StatCard icon="fa-users" iconColor="blue" value={sum(rows, (r) => (r.employee.diff > 0 ? 1 : 0))} label="Employees with a PF difference" />
          <StatCard icon="fa-user" iconColor="orange" value={fmt(sum(rows, (r) => r.employee.diff))} label={`Employee PF difference (returned in ${monthLabel(PAYOUT.month, PAYOUT.year)})`} />
          <StatCard icon="fa-building" iconColor="purple" value={fmt(sum(rows, (r) => r.employer.diff))} label="Employer PF difference" />
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ padding: '12px 20px', fontSize: 13 }}>
            {monthLabel(SOURCE.month, SOURCE.year)} was paid in two runs ({(parts || []).map((p) => `${p.label} on the ${p.rule.label.toLowerCase()}`).join(', ')}).
            Under the new rule a whole month's PF is at most <strong>{fmt(rows[0]?.employee.cap ?? 3000)}</strong> (employee)
            and <strong>{fmt(rows[0]?.employer.cap ?? 3250)}</strong> (employer). Difference = the two runs' PF added up, less that cap.
            The employee difference is paid back in {monthLabel(PAYOUT.month, PAYOUT.year)}'s payroll as "{ITEM.component_name}".
          </div>
        </div>

        <div className="filter-bar">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
            Only employees with a difference ({withDiff.length} of {rows.length})
          </label>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" onClick={exportExcel} disabled={!shown.length}><i className="fas fa-file-excel" /> Export</button>
            <button className="btn btn-primary" onClick={addToPayroll} disabled={saving || !toStore.length}>
              <i className="fas fa-plus" /> {toStore.length
                ? `Add to ${monthLabel(PAYOUT.month, PAYOUT.year)} payroll (${toStore.length})`
                : `All added to ${monthLabel(PAYOUT.month, PAYOUT.year)}`}
            </button>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', ...muted }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th rowSpan={2}>Employee</th>
                    <th colSpan={partCols + 2} style={{ textAlign: 'center' }}>Employee PF</th>
                    <th colSpan={partCols + 2} style={{ textAlign: 'center' }}>Employer PF</th>
                    <th rowSpan={2}>{monthLabel(PAYOUT.month, PAYOUT.year)}</th>
                  </tr>
                  <tr>
                    {[0, 1].map((side) => (
                      <SideHeads key={side} parts={parts} partCols={partCols} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 ? (
                    <tr><td colSpan={2 * partCols + 6} style={{ textAlign: 'center', padding: 40, ...muted }}>
                      {rows.length ? 'No employee paid PF above the cap' : `No ${monthLabel(SOURCE.month, SOURCE.year)} payslips yet`}
                    </td></tr>
                  ) : shown.map((r) => (
                    <tr key={r.slip.id}>
                      <td>
                        <div className="emp-name">{r.slip.emp_name}</div>
                        <div style={small}>{[r.code, r.slip.department].filter(Boolean).join(' · ')}</div>
                      </td>
                      <SideCells side={r.employee} />
                      <SideCells side={r.employer} />
                      <td>{status(r)}</td>
                    </tr>
                  ))}
                </tbody>
                {shown.length > 0 && (
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td>Total</td>
                      {['employee', 'employer'].map((k) => (
                        <SideCells key={k} total side={{
                          byPart: Array.from({ length: partCols }, (_, i) => sum(shown, (r) => r[k].byPart[i] || 0)),
                          total: sum(shown, (r) => r[k].total),
                          diff: sum(shown, (r) => r[k].diff),
                        }} />
                      ))}
                      <td>{fmt(sum(shown, (r) => Number(stored[r.slip.profile_id]?.amount || 0)))}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function SideHeads({ parts, partCols }) {
  return (
    <>
      {Array.from({ length: partCols }, (_, i) => <th key={i}>{parts?.[i]?.label || `Part ${i + 1}`}</th>)}
      <th>Total</th>
      <th>Difference</th>
    </>
  );
}

function SideCells({ side, total = false }) {
  return (
    <>
      {side.byPart.map((v, i) => <td key={i}>{fmt(v)}</td>)}
      <td>{fmt(side.total)}{!total && <div style={small}>cap {fmt(side.cap)}</div>}</td>
      <td style={{ fontWeight: 700, color: side.diff > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>{side.diff > 0 ? fmt(side.diff) : '—'}</td>
    </>
  );
}
