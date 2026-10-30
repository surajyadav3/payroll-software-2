import { useState } from 'react';
import * as XLSX from 'xlsx';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { fmt, getInitials, getAvatarColor, fullName } from '@/lib/helpers';
import { RANIWALA_RULES, RANIWALA_LABELS, slipBankDetails } from '@/lib/raniwalaPayroll';
import RaniwalaPayslip from './RaniwalaPayslip';

const muted = { color: 'var(--text-muted)' };
const small = { fontSize: 11, ...muted };
const money = (n, sign = '') => (n ? sign + fmt(n) : '—');

/** What a part pays before the monthly deductions (those come once, on the final slip). */
// The actual-gross difference (staff paid on a lower actual gross) comes off
// each part, like PF.
const partNet = (l) => l.earnedGross + l.otPay - l.pf.employee - l.esic.employee - (Number(l.diff) || 0);

/**
 * The part's own payslip for one employee — what this run pays, before the
 * monthly deductions that only the final payslip takes. Same layout as the
 * real slip (RaniwalaPayslip), built from the part line; nothing is stored.
 */
function partSlip({ emp, settings, line }, monthDays) {
  const earnings = [
    { name: 'Basic Pay', amount: line.basic },
    { name: 'HRA', amount: line.hra },
    ...(line.otPay > 0 ? [{ name: 'Overtime', amount: line.otPay, note: line.otHours ? `${line.otHours} h` : '' }] : []),
  ];
  const deductions = [
    ...(line.pf.employee > 0 ? [{ name: 'PF (Employee)', amount: line.pf.employee, note: line.pf.capped ? 'capped' : `${RANIWALA_RULES.pfEmployeeRate}% of Basic` }] : []),
    ...(line.esic.employee > 0 ? [{ name: 'ESIC (Employee)', amount: line.esic.employee, note: `${RANIWALA_RULES.esicEmployeeRate}% of Basic` }] : []),
    ...(line.diff > 0 ? [{ name: RANIWALA_LABELS.adjustment, amount: line.diff }] : []),
  ];
  const totalEarnings = earnings.reduce((t, e) => t + e.amount, 0);
  const totalDeductions = deductions.reduce((t, d) => t + d.amount, 0);
  return {
    slip: {
      emp_name: fullName(emp), department: emp.department || '', designation: emp.designation || '',
      gross_earnings: totalEarnings, total_deductions: totalDeductions, advance_deduction: 0, net_pay: totalEarnings - totalDeductions,
    },
    breakdown: {
      earnings, deductions,
      raniwala: {
        empCode: emp.employee_id || '', fatherName: settings?.father_name || '', joinDate: emp.join_date || null,
        ...slipBankDetails(emp, line.pfOn, line.esic.applicable),
        paidDays: line.paidDays, monthDays, grossSalary: line.gross, partOfMonth: true,
        pfEmployer: line.pf.employer, pfCapped: line.pf.capped,
        esicApplicable: line.esic.applicable, esicEmployer: line.esic.employer,
      },
    },
  };
}

/**
 * One run of a month HR pays in two parts (Sept 2026: 1–16 on the old PF
 * rule, 17–30 on the new). Before the run HR ticks PF per employee and can
 * correct paid days; Run freezes the figures. Retention, arrears, TDS and the
 * advance are not here — they are taken once, on the final payslip.
 */
export default function RaniwalaPartRun({
  part, run, rows, monthDays, isManager, busy, companyName,
  dayOverrides, setDayOverrides, onTogglePf, onRun, onUndo, onSavePf, onDiscardPf, finalProcessed,
}) {
  const [search, setSearch] = useState('');
  const [slipRow, setSlipRow] = useState(null);
  // Days can be changed until the part is run; PF can be ticked in both parts
  // until the final payroll is processed (a run part saves it with one button).
  const editable = !run && !isManager && !finalProcessed;
  const pfEditable = !isManager && !finalProcessed;
  const pending = rows.filter((r) => r.edited).length;
  const q = search.trim().toLowerCase();
  const shown = q ? rows.filter((r) => `${fullName(r.emp)} ${r.emp.employee_id || ''} ${r.emp.department || ''}`.toLowerCase().includes(q)) : rows;
  const sum = (pick) => rows.reduce((s, r) => s + (Number(pick(r.line)) || 0), 0);
  const ticked = rows.filter((r) => r.line.pfOn).length;
  const allShownTicked = shown.length > 0 && shown.every((r) => r.line.pfOn);
  const ruleText = part.pfRule === 'old'
    ? `PF ${RANIWALA_RULES.pfEmployeeRate}% / ${RANIWALA_RULES.pfEmployerRate}% of Basic, capped at ₹1,800 / ₹1,950 from a Basic of ${fmt(part.rule.basicCeiling)}`
    : `PF ${RANIWALA_RULES.pfEmployeeRate}% / ${RANIWALA_RULES.pfEmployerRate}% of Basic, capped at ₹3,000 / ₹3,250 from a Basic of ${fmt(part.rule.basicCeiling)}`;

  const exportSheet = () => {
    const ws = XLSX.utils.json_to_sheet(rows.map((r) => ({
      'EMP CODE': r.emp.employee_id || '',
      'EMPLOYEE NAME': fullName(r.emp),
      'DEPARTMENT': r.emp.department || '',
      'PF': r.line.pfOn ? 'Yes' : 'No',
      'GROSS SALARY': r.line.gross,
      'PAID DAYS': r.line.paidDays,
      'BASIC': r.line.basic,
      'HRA': r.line.hra,
      'OVERTIME': r.line.otPay,
      'EARNED': r.line.earnedGross + r.line.otPay,
      'PF EMPLOYEE': r.line.pf.employee,
      'ESIC EMPLOYEE': r.line.esic.employee,
      'ACTUAL GROSS': r.line.actualGross || '',
      [RANIWALA_LABELS.adjustment.toUpperCase()]: r.line.diff || 0,
      'NET FOR PART': partNet(r.line),
      'PF EMPLOYER': r.line.pf.employer,
      'ESIC EMPLOYER': r.line.esic.employer,
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Part ${part.part}`);
    XLSX.writeFile(wb, `raniwala_salary_${part.fromDate}_to_${part.toDate}${run ? '' : '_draft'}.xlsx`);
    showToast(`Part ${part.part} sheet exported`, 'success');
  };

  return (
    <>
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border)', fontSize: 13, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px' }}>
          <div>
            <strong>Part {part.part} · {part.label}</strong> <span className={`badge ${part.pfRule === 'old' ? 'badge-warning' : 'badge-info'}`}>{part.rule.label}</span>{' '}
            {run
              ? <span className="badge badge-success"><i className="fas fa-check" /> Run {new Date(run.run_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              : <span className="badge badge-warning">Not run</span>}
          </div>
          <div style={small}>
            {ruleText}. Tick or untick PF for any employee. ESIC is automatic from the Basic (full-month Basic below {fmt(RANIWALA_RULES.esicBasicLimit)}), no switch. Days are out of the month&apos;s {monthDays}.
            Retention, arrear, TDS and advance come off once, on the final payslip.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline btn-sm" onClick={exportSheet}><i className="fas fa-file-excel" /> Part sheet</button>
          {run && pending > 0 && (
            <>
              <button className="btn btn-primary btn-sm" onClick={onSavePf} disabled={busy}>
                <i className="fas fa-save" /> Save PF changes ({pending})
              </button>
              <button className="btn btn-outline btn-sm" onClick={onDiscardPf} disabled={busy}>Discard</button>
            </>
          )}
          {!isManager && (run ? (
            !finalProcessed && pending === 0 && (
              <button className="btn btn-outline btn-sm" style={{ color: 'var(--danger)' }} onClick={onUndo} disabled={busy}
                title="Works the part out again from attendance — figures loaded from HR's sheet would be lost">
                <i className="fas fa-undo" /> Undo run
              </button>
            )
          ) : (
            <button className="btn btn-primary btn-sm" onClick={onRun} disabled={busy || rows.length === 0}>
              {busy ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Running…</> : <><i className="fas fa-play" /> Run part {part.part}</>}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 24, padding: '12px 20px', borderBottom: '1px solid var(--border)', fontSize: 13, flexWrap: 'wrap', alignItems: 'center' }}>
        <span><strong>{rows.length}</strong> <span style={muted}>employees</span></span>
        <span><strong>{ticked}</strong> <span style={muted}>with PF</span></span>
        <span><strong>{fmt(sum((l) => l.earnedGross + l.otPay))}</strong> <span style={muted}>earned</span></span>
        <span><strong>{fmt(sum((l) => l.pf.employee))}</strong> <span style={muted}>PF employee</span></span>
        <span><strong>{fmt(sum((l) => l.esic.employee))}</strong> <span style={muted}>ESIC employee</span></span>
        <span><strong>{fmt(sum((l) => l.pf.employer))}</strong> <span style={muted}>PF employer</span></span>
        <span><strong>{fmt(sum((l) => l.esic.employer))}</strong> <span style={muted}>ESIC employer</span></span>
        <input className="form-input" placeholder="Search name or code" value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ marginLeft: 'auto', width: 200, padding: '6px 10px', fontSize: 12 }} />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 54 }}>
                {pfEditable ? (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} title={allShownTicked ? 'Untick PF for everyone shown' : 'Tick PF for everyone shown'}>
                    <input type="checkbox" checked={allShownTicked} onChange={(e) => onTogglePf(shown.map((r) => r.emp.id), e.target.checked)} /> PF
                  </label>
                ) : 'PF'}
              </th>
              <th>Employee</th>
              <th title="Days paid in this part: present days plus weekly offs, holidays and paid leave. Change the box if HR's sheet says otherwise.">Days Present</th>
              <th>Gross Salary</th>
              <th>Basic</th>
              <th>HRA</th>
              <th>Overtime</th>
              <th>PF</th>
              <th>ESIC</th>
              <th>Net for Part</th>
              <th>PF Employer</th>
              <th>ESIC Employer</th>
              <th>Slip</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={13} style={{ textAlign: 'center', padding: 32, ...muted }}>No employees found</td></tr>
            )}
            {shown.map((r) => { const { emp, line, stored, edited } = r; return (
              <tr key={emp.id} style={edited ? { background: 'var(--warning-light)' } : line.pfOn ? undefined : { background: 'var(--bg)' }}>
                <td>
                  <input type="checkbox" checked={line.pfOn} disabled={!pfEditable || (run && !stored)}
                    title={line.pfOn ? 'PF is deducted in this part' : 'No PF in this part'}
                    onChange={(e) => onTogglePf([emp.id], e.target.checked)} />
                </td>
                <td>
                  <div className="emp-cell">
                    <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(emp.id)})` }}>
                      {getInitials(emp.first_name, emp.last_name)}
                    </div>
                    <div>
                      <div className="emp-name">{fullName(emp)}</div>
                      <div className="emp-role">{[emp.employee_id, emp.department].filter(Boolean).join(' · ')}</div>
                      {run && !stored && <div style={{ ...small, color: 'var(--warning)' }}>Not in this run</div>}
                      {line.sheet && <div style={small}>From HR salary sheet</div>}
                      {edited && <div style={{ ...small, color: 'var(--warning)' }}>PF changed — not saved</div>}
                    </div>
                  </div>
                </td>
                <td>
                  {editable ? (
                    <input
                      className="form-input" type="number" min="0" max={part.days} step="0.5"
                      value={dayOverrides[emp.id] ?? part.days}
                      onChange={(ev) => setDayOverrides(emp.id, Math.min(part.days, Math.max(0, parseFloat(ev.target.value) || 0)))}
                      style={{ width: 65, padding: '5px 8px', fontSize: 12 }}
                    />
                  ) : <span>{line.paidDays}</span>}
                  <span style={small}> / {part.days}</span>
                </td>
                <td>
                  {fmt(line.gross)}
                  {line.diff > 0 && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>actual {fmt(line.actualGross)} · <span style={{ color: 'var(--danger)' }}>-{fmt(line.diff)}</span></div>}
                </td>
                <td>{fmt(line.basic)}</td>
                <td>{fmt(line.hra)}</td>
                <td>{money(line.otPay)}{line.otHours ? <div style={small}>{line.otHours} h</div> : null}</td>
                <td style={{ color: 'var(--danger)' }}>
                  {line.pfOn ? money(line.pf.employee, '-') : <span style={muted}>Off</span>}
                  {line.pf.capped ? <div style={small}>capped</div> : null}
                </td>
                <td style={{ color: 'var(--danger)' }}>{line.esic.applicable ? money(line.esic.employee, '-') : <span style={muted}>N/A</span>}</td>
                <td><strong>{fmt(partNet(line))}</strong></td>
                <td style={{ color: 'var(--success)' }}>{line.pfOn ? money(line.pf.employer, '+') : <span style={muted}>Off</span>}</td>
                <td style={{ color: 'var(--success)' }}>{line.esic.applicable ? money(line.esic.employer, '+') : <span style={muted}>N/A</span>}</td>
                <td>
                  <button className="btn btn-outline btn-sm" title={`Payslip for ${part.label}`} onClick={() => setSlipRow(r)}><i className="fas fa-eye" /></button>
                </td>
              </tr>
            ); })}
          </tbody>
        </table>
      </div>

      {slipRow && (() => {
        const { slip, breakdown } = partSlip(slipRow, monthDays);
        return (
          <Modal show onClose={() => setSlipRow(null)} width="620px"
            title={`Part ${part.part} payslip · ${part.label} (${part.rule.label})`}
            footer={<button className="btn btn-outline" onClick={() => setSlipRow(null)}>Close</button>}>
            <RaniwalaPayslip slip={slip} breakdown={breakdown} ctc={slipRow.emp.salary_ctc} companyName={companyName} monthText={`${part.label} ${part.fromDate.slice(0, 4)} · part ${part.part} of the month`} />
            <div style={{ ...small, marginTop: 10 }}>
              {run ? 'As run.' : 'Not run yet — figures can still change.'} Retention, arrear, TDS and advance are not in a part; they come off once on the final September payslip.
            </div>
          </Modal>
        );
      })()}
    </>
  );
}
