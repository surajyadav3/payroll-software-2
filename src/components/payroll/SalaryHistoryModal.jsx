import React, { useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { fmt, fullName } from '@/lib/helpers';
import { RANIWALA_LABELS, fmtYmd, parseBreakdown } from '@/lib/raniwalaPayroll';
import { fetchSalaryHistory } from '@/services/employeeSalaryService';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const muted = { color: 'var(--text-muted)' };
const small = { fontSize: 11, color: 'var(--text-muted)' };
const money = (v) => (Number(v) ? fmt(v) : '—');
const section = { fontWeight: 700, fontSize: 13, margin: '18px 0 8px' };

/**
 * HR's view of one employee's pay over time (payroll HR only — the DB hides
 * all of it from everyone else): the current gross / CTC / actual gross,
 * every salary change, each month's pay (the two-run months part by part with
 * HR's sheet extras, processed months from the payslip) and their advances.
 */
export default function SalaryHistoryModal({ show, onClose, employee, tenantId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!show || !employee?.id) return;
    setData(null);
    setError('');
    fetchSalaryHistory(tenantId, employee.id).then(({ data: d, error: e }) => {
      setData(d);
      if (e) setError(e.message);
    });
  }, [show, employee?.id, tenantId]);

  // One row per month: processed payslips first, then months known only from
  // their part runs (Sept 2026 before its final payroll).
  const months = [];
  if (data) {
    data.payslips.forEach((s) => {
      const r = parseBreakdown(s).raniwala || {};
      months.push({
        key: `slip-${s.id}`, year: s.payrolls.year, month: s.payrolls.month, label: 'Payslip',
        released: !!s.payrolls.released_at,
        paidDays: r.paidDays ?? s.work_days, gross: r.grossSalary, earned: r.earnedGross ?? s.gross_earnings,
        pf: r.pfEmployee, esic: r.esicEmployee, diff: r.actualGrossDiff, retention: r.retentionAmount,
        arrear: r.arrearNet, tds: r.tds, advance: r.advanceDeducted ?? s.advance_deduction,
        advanceBalance: r.advanceBalance, net: s.net_pay,
      });
    });
    const slipMonths = new Set(data.payslips.map((s) => `${s.payrolls.year}-${s.payrolls.month}`));
    data.parts
      .filter((l) => !slipMonths.has(`${l.year}-${l.month}`))
      .forEach((l) => {
        const sh = l.sheet || {};
        months.push({
          key: `part-${l.year}-${l.month}-${l.part}`, year: l.year, month: l.month,
          label: `Part ${l.part} · ${l.label || ''}${l.pfOn === false ? ' · no PF' : ''}`,
          paidDays: l.paidDays, gross: l.gross, earned: l.earnedGross, pf: l.pfEmployee, esic: l.esicEmployee,
          diff: l.diff, retention: sh.retention, arrear: sh.arrear, tds: sh.tds, advance: sh.advance,
          advanceBalance: sh.advanceBalance, net: null, fromSheet: !!l.sheet,
        });
      });
    months.sort((a, b) => b.year - a.year || b.month - a.month || a.label.localeCompare(b.label));
  }

  const current = data?.revisions[0];

  return (
    <Modal show={show} onClose={onClose} title={`Salary History — ${fullName(employee || {})}`} width="980px"
      footer={<button className="btn btn-outline" onClick={onClose}>Close</button>}
    >
      {!data && !error && (
        <div style={{ padding: 32, textAlign: 'center', ...muted }}><div className="spinner" style={{ margin: '0 auto 12px' }} />Loading…</div>
      )}
      {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}
      {data && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[
              ['Monthly Gross', employee?.ctc],
              ['Monthly CTC', employee?.salary_ctc],
              ['Actual Gross', employee?.actual_gross],
              ...(employee?.actual_gross > 0 ? [[RANIWALA_LABELS.adjustment, employee?.gross_advance]] : []),
            ].map(([label, v]) => (
              <div key={label} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', minWidth: 150 }}>
                <div style={small}>{label}</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{money(v)}</div>
              </div>
            ))}
          </div>
          {employee?.actual_gross > 0 && (
            <div style={{ ...small, marginTop: 6 }}>
              Paid on the actual gross: PF / ESIC are worked out on the monthly gross, and the {RANIWALA_LABELS.adjustment} (monthly gross − actual gross) for the days paid is deducted.
            </div>
          )}
          {current && <div style={{ ...small, marginTop: 6 }}>Last changed {new Date(current.changed_at).toLocaleDateString('en-IN')} · {current.source}</div>}

          <div style={section}>Salary changes</div>
          {data.revisions.length === 0 ? <div style={muted}>No salary recorded yet.</div> : (
            <div className="table-container">
              <table>
                <thead>
                  <tr><th>Effective</th><th>Gross</th><th>CTC</th><th>Actual Gross</th><th>{RANIWALA_LABELS.adjustment}</th><th>Source</th><th>Changed</th></tr>
                </thead>
                <tbody>
                  {data.revisions.map((r) => (
                    <tr key={r.id}>
                      <td>{r.effective_from ? fmtYmd(r.effective_from) : '—'}</td>
                      <td>{money(r.gross)}{r.prev_gross != null && Number(r.prev_gross) !== Number(r.gross) && <div style={small}>was {money(r.prev_gross)}</div>}</td>
                      <td>{money(r.ctc)}{r.prev_ctc != null && Number(r.prev_ctc) !== Number(r.ctc) && <div style={small}>was {money(r.prev_ctc)}</div>}</td>
                      <td>{money(r.actual_gross)}{r.prev_actual_gross != null && Number(r.prev_actual_gross) !== Number(r.actual_gross) && <div style={small}>was {money(r.prev_actual_gross)}</div>}</td>
                      <td>{money(r.gross_advance)}</td>
                      <td>{r.source}{r.note && <div style={small}>{r.note}</div>}</td>
                      <td>
                        {new Date(r.changed_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                        {r.changer && <div style={small}>by {fullName(r.changer)}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={section}>Pay by month</div>
          {months.length === 0 ? <div style={muted}>No payroll yet.</div> : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Month</th><th>Days</th><th>Gross</th><th>Earned</th><th>PF</th><th>ESIC</th>
                    <th>{RANIWALA_LABELS.adjustment}</th><th>Retention</th><th>Arrear</th><th>TDS</th><th>Advance</th><th>Adv. Balance</th><th>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map((m) => (
                    <tr key={m.key}>
                      <td>
                        {MONTHS[m.month - 1]} {m.year}
                        <div style={small}>{m.label}{m.label === 'Payslip' && !m.released ? ' · not released' : ''}{m.fromSheet ? ' · HR sheet' : ''}</div>
                      </td>
                      <td>{m.paidDays ?? '—'}</td>
                      <td>{money(m.gross)}</td>
                      <td>{money(m.earned)}</td>
                      <td>{money(m.pf)}</td>
                      <td>{money(m.esic)}</td>
                      <td>{money(m.diff)}</td>
                      <td>{money(m.retention)}</td>
                      <td>{m.arrear ? `${m.arrear < 0 ? '-' : '+'}${fmt(Math.abs(m.arrear))}` : '—'}</td>
                      <td>{money(m.tds)}</td>
                      <td>{money(m.advance)}</td>
                      <td>{money(m.advanceBalance)}</td>
                      <td>{m.net == null ? <span style={small}>on final slip</span> : <strong>{fmt(m.net)}</strong>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={section}>Advances</div>
          {data.advances.length === 0 ? <div style={muted}>No advances.</div> : (
            <div className="table-container">
              <table>
                <thead><tr><th>Given</th><th>Type</th><th>Amount</th><th>Monthly</th><th>Recovered</th><th>Balance</th><th>Status</th><th>Recoveries</th></tr></thead>
                <tbody>
                  {data.advances.map((a) => (
                    <tr key={a.id}>
                      <td>{new Date(a.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}{a.remarks && <div style={{ ...small, maxWidth: 220, whiteSpace: 'normal' }}>{a.remarks}</div>}</td>
                      <td>{a.type}</td>
                      <td>{money(a.amount)}</td>
                      <td>{money(a.emi)}</td>
                      <td>{money(a.paid)}</td>
                      <td><strong>{fmt(a.balance || 0)}</strong></td>
                      <td>{a.status}</td>
                      <td style={small}>{(a.advance_repayments || []).map((r) => `${MONTHS[r.month - 1]} ${r.year}: ${fmt(r.amount)}`).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
