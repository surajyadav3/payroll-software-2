import { useState } from 'react';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useOutletView } from '@/context/OutletViewContext';
import { fmt, getInitials, getAvatarColor, monthLabel, todayStr, scopedToOutlet, fullName } from '@/lib/helpers';
import {
  RANIWALA_RULES, RANIWALA_LABELS, calcRaniwalaPay, probationEndDate, advanceEligibility,
  raniwalaSlipDetails, parseBreakdown, fmtYmd, monthEndDate,
} from '@/lib/raniwalaPayroll';
import { savePayrollSettings } from '@/services/payrollSettingsService';
import { createSalaryAddition, deleteSalaryAddition } from '@/services/salaryAdditionsService';
import { createAdvance, updateAdvance } from '@/services/advanceService';
import RaniwalaStructureGuide from './RaniwalaStructureGuide';
import RaniwalaPartRun from './RaniwalaPartRun';
import { buildSalaryWorkbook, downloadWorkbook } from '@/lib/salarySheetExport';

const muted = { color: 'var(--text-muted)' };
const small = { fontSize: 11, ...muted };
const money = (n, sign = '') => (n ? sign + fmt(n) : '—');

// Under a leaver's name: their last day, and where it comes from.
const leaverNote = (emp) => {
  if (emp.exit_from_attendance) return `Inactive · last attendance ${fmtYmd(emp.exit_date)}`;
  return emp.exit_date < todayStr() ? `Left · last day ${fmtYmd(emp.exit_date)}` : `Leaving · last day ${fmtYmd(emp.exit_date)}`;
};

// HR's wording for a one-month entry, and which way each one moves pay.
const ARREAR_ITEMS = [
  { name: 'Arrear', category: 'earning' },
  { name: 'Incentive', category: 'earning' },
  { name: 'Previous month due', category: 'earning' },
  { name: 'Previous month deduction', category: 'deduction' },
  { name: 'Other', category: 'earning' },
];

/** One table/register row from a draft (not yet processed) pay calculation. */
const draftView = ({ emp, settings, pay }) => ({
  key: emp.id,
  profileId: emp.id,
  name: fullName(emp),
  dept: emp.department || '',
  designation: emp.designation || '',
  d: raniwalaSlipDetails(pay, { emp, settings }),
  totalEarnings: pay.totalEarnings,
  totalDeductions: pay.totalDeductions + pay.advanceDeduction,
  net: pay.netPay,
});

/** The same row from a processed payslip. */
const slipView = (slip) => ({
  key: slip.id,
  profileId: slip.profile_id,
  name: slip.emp_name,
  dept: slip.department || '',
  designation: slip.designation || '',
  d: parseBreakdown(slip).raniwala || {},
  totalEarnings: slip.gross_earnings,
  totalDeductions: slip.total_deductions + slip.advance_deduction,
  net: slip.net_pay,
  slip,
});

/** The month's cost to the company: everything earned plus the employer's PF and ESIC. */
const ctcOf = (v) => (v.totalEarnings || 0) + (v.d.pfEmployer || 0) + (v.d.esicEmployer || 0);

// Salary sheet column names, in the payslip's wording. The actual-gross
// deduction is "Adj", as on the payslip (HR, 24 Oct 2026).
const TOTAL_EARNINGS_COL = RANIWALA_LABELS.totalEarnings.toUpperCase();
const ADJUSTMENT_COL = 'ADJ (GROSS - ACTUAL GROSS)';

const CTC_COL = 'CTC';
const EARNED_CTC_COL = 'EARNED CTC (THIS MONTH)';
const EARNED_GROSS_COL = 'EARNED GROSS (THIS MONTH)';

// HR, 29 Oct 2026: the All Outlets sheet leaves the Factory out (it has its
// own sheet) and lists HDFC Bank accounts first, then the other banks.
const isFactoryOutlet = (outlet) => /factory/i.test(outlet || '');
const isHdfc = ({ bankName, ifsc }) => /hdfc/i.test(bankName || '') || /^HDFC/i.test(ifsc || '');

const arrearRemark = (d) => (d.arrears || []).map((a) => (a.remark ? `${a.name}: ${a.remark}` : a.name)).join('; ');

/** A two-run month's per-part columns for the salary sheet. */
const partColumns = (d) => Object.fromEntries((d.parts || []).flatMap((p) => [
  [`${p.label} PAID DAYS`, p.paidDays],
  [`${p.label} PF (Y/N)`, p.pfOn ? 'Y' : 'N'],
  [`${p.label} PF EMPLOYEE`, p.pfEmployee],
  [`${p.label} ESIC EMPLOYEE`, p.esicEmployee],
  [`${p.label} PF EMPLOYER`, p.pfEmployer],
  [`${p.label} ESIC EMPLOYER`, p.esicEmployer],
]));

/**
 * HR's salary sheet, one line per employee: payroll figures only. `ctc` is
 * the employee's filled CTC (employee_salaries.ctc), `bank` the account the
 * slip was paid to (breakdown.raniwala, else the employee record).
 */
const registerRow = (v, { division, department, outlet, ctc, bank }) => ({
  'EMP CODE': v.d.empCode || '',
  'EMPLOYEE NAME': v.name,
  'DIVISION': division || '',
  'DEPARTMENT': department || '',
  'OUTLET': outlet,
  'BANK NAME': bank.bankName,
  'BANK ACCOUNT NO': bank.bankAcc,
  [CTC_COL]: Number(ctc) > 0 ? Number(ctc) : '',
  'GROSS SALARY': v.d.grossSalary || 0,
  'ACTUAL GROSS': v.d.actualGross || '',
  'BASIC (FULL MONTH)': v.d.fullBasic ?? '',
  'HRA (FULL MONTH)': v.d.fullHra ?? '',
  [EARNED_CTC_COL]: ctcOf(v),
  [EARNED_GROSS_COL]: v.d.earnedGross ?? ((v.d.basic || 0) + (v.d.hra || 0)),
  'MONTH DAYS': v.d.monthDays || 0,
  'PRESENT DAYS': v.d.presentDays ?? '',
  'LATE DEDUCTION DAYS': v.d.lateDays || 0,
  'PAID DAYS': v.d.paidDays || 0,
  'BASIC': v.d.basic || 0,
  'HRA': v.d.hra || 0,
  'OVERTIME': v.d.overtime || 0,
  'ARREAR / INCENTIVE (+/-)': v.d.arrearNet || 0,
  'ARREAR REMARK': arrearRemark(v.d),
  [TOTAL_EARNINGS_COL]: v.totalEarnings || 0,
  'PF EMPLOYEE': v.d.pfEmployee || 0,
  'ESIC EMPLOYEE': v.d.esicEmployee || 0,
  'ADVANCE DEDUCTED': v.d.advanceDeducted || 0,
  'TDS': v.d.tds || 0,
  'LATE DEDUCTION': v.d.lateDeduction || 0,
  [ADJUSTMENT_COL]: v.d.actualGrossDiff || 0,
  'RETENTION': v.d.retentionAmount || 0,
  'TOTAL DEDUCTIONS': v.totalDeductions || 0,
  'NET PAY': v.net || 0,
  'PF EMPLOYER': v.d.pfEmployer || 0,
  'ESIC EMPLOYER': v.d.esicEmployer || 0,
  'ADVANCE OPENING': v.d.advanceOpening || 0,
  'ADVANCE BALANCE': v.d.advanceBalance || 0,
  ...partColumns(v.d),
});

// Column order of the salary sheet, in coloured sections (lib/salarySheetExport).
const SHEET_SECTIONS = [
  { title: 'EMPLOYEE', color: 'FF1F3864', tint: 'FFD9E1F2', keys: ['EMP CODE', 'EMPLOYEE NAME', 'DIVISION', 'DEPARTMENT', 'OUTLET', 'BANK NAME', 'BANK ACCOUNT NO'] },
  // HR, 30 Oct 2026: all full-month figures together, Basic / HRA right
  // after CTC, gross and actual gross; then the month's earned figures.
  { title: 'SALARY (FULL MONTH)', color: 'FF2F5597', tint: 'FFDDEBF7', keys: [CTC_COL, 'GROSS SALARY', 'ACTUAL GROSS', 'BASIC (FULL MONTH)', 'HRA (FULL MONTH)'] },
  { title: 'EARNED (THIS MONTH)', color: 'FF375623', tint: 'FFE2EFDA', keys: [EARNED_CTC_COL, EARNED_GROSS_COL] },
  { title: 'DAYS', color: 'FF595959', tint: 'FFEDEDED', keys: ['MONTH DAYS', 'PRESENT DAYS', 'LATE DEDUCTION DAYS', 'PAID DAYS'] },
  { title: 'EARNINGS (THIS MONTH)', color: 'FF548235', tint: 'FFE2EFDA', keys: ['BASIC', 'HRA', 'OVERTIME', 'ARREAR / INCENTIVE (+/-)', 'ARREAR REMARK', TOTAL_EARNINGS_COL] },
  { title: 'DEDUCTIONS (THIS MONTH)', color: 'FFC00000', tint: 'FFFCE4E4', keys: ['PF EMPLOYEE', 'ESIC EMPLOYEE', 'ADVANCE DEDUCTED', 'TDS', 'LATE DEDUCTION', ADJUSTMENT_COL, 'RETENTION', 'TOTAL DEDUCTIONS'] },
  { title: 'NET PAY', color: 'FF203864', tint: 'FFFFF2CC', keys: ['NET PAY'] },
  { title: 'COMPANY CONTRIBUTION', color: 'FF7030A0', tint: 'FFEADCF4', keys: ['PF EMPLOYER', 'ESIC EMPLOYER'] },
  { title: 'ADVANCE (LOAN)', color: 'FFBF8F00', tint: 'FFFFF2CC', keys: ['ADVANCE OPENING', 'ADVANCE BALANCE'] },
];

const R = RANIWALA_RULES;
const SHEET_NOTES = [
  ['EMP CODE', 'Employee code.'],
  ['EMPLOYEE NAME', 'Employee name.'],
  ['DIVISION', 'Division from the employee record.'],
  ['DEPARTMENT', 'Department from the employee record.'],
  ['OUTLET', 'Outlet the employee works at.'],
  ['BANK NAME', 'Bank the salary is paid into.'],
  ['BANK ACCOUNT NO', 'Bank account number the salary is paid into.'],
  [CTC_COL, 'The employee\'s monthly CTC as filled on the employee record. Blank = no CTC filled.'],
  ['GROSS SALARY', `Monthly gross salary (salary structure). Basic/HRA, PF and ESIC are worked out on this. Gross below ₹${R.splitThreshold.toLocaleString('en-IN')} splits ${R.belowSplit.basic}% Basic / ${R.belowSplit.hra}% HRA; ₹${R.splitThreshold.toLocaleString('en-IN')} or more splits ${R.atOrAboveSplit.basic}/${R.atOrAboveSplit.hra}.`],
  ['ACTUAL GROSS', `Only for staff paid a lower fixed amount than the gross. Blank = paid on the gross. The difference for the days paid is the ${ADJUSTMENT_COL} deduction.`],
  ['BASIC (FULL MONTH)', 'Basic for a full month from the gross salary.'],
  ['HRA (FULL MONTH)', 'HRA for a full month from the gross salary.'],
  [EARNED_CTC_COL, `Cost to the company for this month: ${TOTAL_EARNINGS_COL.toLowerCase()} + PF employer + ESIC employer.`],
  [EARNED_GROSS_COL, 'Gross earned this month = gross salary × paid days (before the late deduction) ÷ month days (Basic + HRA earned).'],
  ['MONTH DAYS', 'Calendar days in the month.'],
  ['PRESENT DAYS', 'Days actually attended (Present, Late, Travel, Show Visit; Half Day = 0.5), weekly offs worked included.'],
  ['LATE DEDUCTION DAYS', 'Days HR took off the paid days for late coming.'],
  ['PAID DAYS', 'Days paid: present days, weekly offs, holidays and paid leave, less the late deduction days.'],
  ['BASIC', 'Basic earned this month = full-month Basic × paid days (before the late deduction) ÷ month days.'],
  ['HRA', 'HRA earned this month = full-month HRA × paid days (before the late deduction) ÷ month days.'],
  ['OVERTIME', 'Overtime pay for approved overtime hours.'],
  ['ARREAR / INCENTIVE (+/-)', 'One-month entries: arrear, incentive or previous-month dues (+), or a previous-month deduction (−).'],
  ['ARREAR REMARK', 'What each arrear / incentive entry is for.'],
  [TOTAL_EARNINGS_COL, 'Basic + HRA + overtime + arrear / incentive.'],
  ['PF EMPLOYEE', `${R.pfEmployeeRate}% of the Basic earned, with Basic above ₹${R.pfBasicCeiling.toLocaleString('en-IN')} ignored (₹15,000 under the old rule before 17 Sep 2026). 0 when PF does not apply.`],
  ['ESIC EMPLOYEE', `${R.esicEmployeeRate}% of the Basic earned, only when the full-month Basic is below ₹${R.esicBasicLimit.toLocaleString('en-IN')}.`],
  ['ADVANCE DEDUCTED', 'This month\'s instalment of the salary advance (loan).'],
  ['TDS', 'Income tax deducted at source, as set by HR.'],
  ['LATE DEDUCTION', 'Pay for the late deduction days: gross (actual gross where set) ÷ month days × late deduction days. Basic / HRA / PF are on the days before this cut.'],
  [ADJUSTMENT_COL, `Adj (${RANIWALA_LABELS.adjustment}): gross minus actual gross, for the days paid. Only for actual-gross staff. PF / ESIC stay on the full gross; this brings take-home pay down to the actual gross.`],
  ['RETENTION', 'Share of gross held back during probation (0, 5 or 10%).'],
  ['TOTAL DEDUCTIONS', 'PF + ESIC + advance + TDS + late deduction + adj + retention (+ any arrear deduction).'],
  ['NET PAY', `Paid to the employee = ${TOTAL_EARNINGS_COL.toLowerCase()} − total deductions.`],
  ['PF EMPLOYER', `Company's PF, ${R.pfEmployerRate}% of the Basic earned (same ceiling). Not deducted from the employee.`],
  ['ESIC EMPLOYER', `Company's ESIC, ${R.esicEmployerRate}% of the Basic earned. Not deducted from the employee.`],
  ['ADVANCE OPENING', 'Advance (loan) balance before this month\'s deduction.'],
  ['ADVANCE BALANCE', 'Advance (loan) balance still to recover after this month.'],
];

function RetentionPicker({ value, disabled, onPick }) {
  return (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
      {RANIWALA_RULES.retentionOptions.map((p) => {
        const on = value === p;
        return (
          <button
            key={p} type="button" disabled={disabled} onClick={() => onPick(p)}
            style={{
              padding: '4px 10px', fontSize: 12, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
              background: on ? 'var(--primary)' : 'transparent', color: on ? '#fff' : 'var(--text)',
              fontWeight: on ? 700 : 400, opacity: disabled && !on ? 0.5 : 1,
            }}
          >
            {p ? `${p}%` : 'None'}
          </button>
        );
      })}
    </div>
  );
}

/** What the retention choice means for this employee this month, in words. */
function retentionNote(retention) {
  if (retention.state === 'active') return `On probation till ${fmtYmd(retention.probationEnd)}`;
  if (retention.state === 'closed') return `Probation completed ${fmtYmd(retention.probationEnd)} — retention closed`;
  if (retention.state === 'no-date') return 'Set the probation completion date';
  return retention.probationEnd ? `Probation till ${fmtYmd(retention.probationEnd)}` : 'Not on probation';
}

function Section({ title, hint, children }) {
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
      {hint ? <div style={{ ...small, marginBottom: 10 }}>{hint}</div> : <div style={{ height: 8 }} />}
      {children}
    </div>
  );
}

export function EmployeePayrollModal({ row, tenant, profile, month, year, additions, advances, onClose, onSettingsSaved, onAdditionsChanged, onAdvancesChanged }) {
  const { emp, settings, inputs } = row;
  const [form, setForm] = useState({
    father_name: settings?.father_name || '',
    probation_end_date: settings?.probation_end_date || '',
    retention_percent: Number(settings?.retention_percent) || 0,
    tds_monthly: Number(settings?.tds_monthly) || 0,
    pf_applicable: settings?.pf_applicable !== false,
  });
  const [saving, setSaving] = useState(false);
  const [arrear, setArrear] = useState({ item: 'Arrear', other: '', category: 'earning', amount: '', remark: '' });
  const [newAdvance, setNewAdvance] = useState({ amount: '', emi: '', remarks: '' });
  const [emiEdits, setEmiEdits] = useState({});

  const probationEnd = probationEndDate(emp, form);
  const pay = calcRaniwalaPay({ ...inputs, settings: form, probationEnd });
  const eligibility = advanceEligibility(emp.join_date, todayStr());
  const probationOver = !!probationEnd && probationEnd <= monthEndDate(year, month);
  const monthText = monthLabel(month, year);

  const saveDetails = async () => {
    if (form.retention_percent > 0 && !probationEnd) {
      return showToast('Set the probation completion date — retention is only taken during probation', 'error');
    }
    setSaving(true);
    const { data, error } = await savePayrollSettings(tenant.id, emp.id, form);
    setSaving(false);
    if (error) return showToast('Could not save: ' + error.message, 'error');
    onSettingsSaved(data);
    showToast('Payroll details saved', 'success');
    onClose();
  };

  const addArrear = async () => {
    const name = arrear.item === 'Other' ? arrear.other.trim() : arrear.item;
    if (!name) return showToast('Name the item', 'error');
    if (!(Number(arrear.amount) > 0)) return showToast('Enter the amount', 'error');
    const { error } = await createSalaryAddition(tenant.id, profile.id, {
      profile_id: emp.id, component_name: name, category: arrear.category, amount: arrear.amount,
      is_recurring: false, effective_month: month + 1, effective_year: year, reason: arrear.remark.trim(),
    });
    if (error) return showToast('Could not add: ' + error.message, 'error');
    setArrear({ item: 'Arrear', other: '', category: 'earning', amount: '', remark: '' });
    onAdditionsChanged();
  };

  const removeArrear = async (id) => {
    const { error } = await deleteSalaryAddition(id);
    if (error) return showToast('Could not remove: ' + error.message, 'error');
    onAdditionsChanged();
  };

  const giveAdvance = async () => {
    const amount = Number(newAdvance.amount), emi = Number(newAdvance.emi);
    if (!(amount > 0)) return showToast('Enter the advance amount', 'error');
    if (!(emi > 0) || emi > amount) return showToast('The monthly deduction must be between ₹1 and the advance amount', 'error');
    const { error } = await createAdvance({ tenantId: tenant.id, profile_id: emp.id, type: 'Salary Advance', amount, emi, remarks: newAdvance.remarks });
    if (error) return showToast(error.message, 'error');
    setNewAdvance({ amount: '', emi: '', remarks: '' });
    showToast('Advance recorded', 'success');
    onAdvancesChanged();
  };

  const changeEmi = async (adv) => {
    const emi = Number(emiEdits[adv.id]);
    if (!(emi > 0) || emi > adv.amount) return showToast('The monthly deduction must be between ₹1 and the advance amount', 'error');
    const { error } = await updateAdvance(adv.id, { ...adv, emi });
    if (error) return showToast(error.message, 'error');
    showToast('Monthly deduction updated', 'success');
    onAdvancesChanged();
  };

  return (
    <Modal
      show onClose={onClose} width="760px"
      title={`Payroll details — ${fullName(emp)}${emp.employee_id ? ` (${emp.employee_id})` : ''}`}
      footer={<>
        <button className="btn btn-outline" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={saveDetails} disabled={saving}>
          <i className="fas fa-check" /> {saving ? 'Saving…' : 'Save details'}
        </button>
      </>}
    >
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Date of joining</label>
          <input className="form-input" value={fmtYmd(emp.join_date)} readOnly disabled />
        </div>
      </div>

      <Section title="Probation and retention" hint="Retention is a share of gross held back only during probation. From the month probation completes it is 0 again by itself.">
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Probation completion date</label>
            <input className="form-input" type="date" value={form.probation_end_date}
              onChange={(e) => setForm({ ...form, probation_end_date: e.target.value })} />
            <div className="form-hint">
              {form.probation_end_date
                ? (probationOver ? `Probation is complete for ${monthText}.` : `On probation through ${monthText}.`)
                : probationEnd
                  ? `Blank uses joining date + ${emp.probation_months} months: ${fmtYmd(probationEnd)}.`
                  : 'Blank means the employee is not on probation.'}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Retention</label>
            <div><RetentionPicker value={form.retention_percent} onPick={(p) => setForm({ ...form, retention_percent: p })} /></div>
            <div className="form-hint">
              {pay.retention.state === 'active' && `${pay.retention.percent}% of ${fmt(pay.earnedGross)} = ${fmt(pay.retention.amount)} held back for ${monthText}.`}
              {pay.retention.state === 'closed' && `Nothing is held back for ${monthText}: probation completed on ${fmtYmd(probationEnd)}.`}
              {pay.retention.state === 'no-date' && 'Set the probation completion date for retention to apply.'}
              {pay.retention.state === 'none' && 'No retention.'}
            </div>
          </div>
        </div>
      </Section>

      <Section title="PF, ESIC and TDS" hint="PF follows the salary rules; untick only for an employee it does not apply to. ESIC is automatic from the Basic — no switch.">
        <div className="form-row">
          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.pf_applicable} onChange={(e) => setForm({ ...form, pf_applicable: e.target.checked })} />
              <span>PF applies</span>
            </label>
            <div className="form-hint">
              {pay.esic.applicable
                ? `ESIC (automatic): full-month Basic ${fmt(pay.structure.basic)} is below ${fmt(RANIWALA_RULES.esicBasicLimit)}, so ${RANIWALA_RULES.esicEmployeeRate}% / ${RANIWALA_RULES.esicEmployerRate}% of the Basic earned.`
                : `No ESIC (automatic): full-month Basic ${fmt(pay.structure.basic)} is not below ${fmt(RANIWALA_RULES.esicBasicLimit)}.`}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">TDS per month (₹)</label>
            <input className="form-input" type="number" min="0" value={form.tds_monthly}
              onChange={(e) => setForm({ ...form, tds_monthly: e.target.value })} />
            <div className="form-hint">Deducted every month until you change it. 0 means no TDS.</div>
          </div>
        </div>
      </Section>

      <Section title={`Arrear / incentive for ${monthText}`} hint="Any due, last month's deduction or incentive. It is paid or deducted in this month's payroll only; the remark is for HR only and is not printed on the payslip.">
        {additions.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            {additions.map((a) => (
              <div key={a.id} className="payslip-row" style={{ alignItems: 'center' }}>
                <span>
                  {a.component_name}{' '}
                  <span className={`badge ${a.category === 'earning' ? 'badge-success' : 'badge-danger'}`}>{a.category === 'earning' ? 'Added to pay' : 'Deducted'}</span>
                  {a.reason ? <span style={small}> · {a.reason}</span> : null}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <strong>{a.category === 'earning' ? '+' : '-'}{fmt(a.amount)}</strong>
                  <button className="btn btn-outline btn-icon btn-sm" style={{ color: 'var(--danger)' }} title="Remove" onClick={() => removeArrear(a.id)}>
                    <i className="fas fa-trash" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Item</label>
            <select className="form-select" value={arrear.item}
              onChange={(e) => setArrear({ ...arrear, item: e.target.value, category: ARREAR_ITEMS.find((i) => i.name === e.target.value).category })}>
              {ARREAR_ITEMS.map((i) => <option key={i.name}>{i.name}</option>)}
            </select>
          </div>
          {arrear.item === 'Other' && (
            <div className="form-group">
              <label className="form-label">Name</label>
              <input className="form-input" value={arrear.other} onChange={(e) => setArrear({ ...arrear, other: e.target.value })} />
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Effect</label>
            <select className="form-select" value={arrear.category} onChange={(e) => setArrear({ ...arrear, category: e.target.value })}>
              <option value="earning">Add to pay</option>
              <option value="deduction">Deduct from pay</option>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Amount (₹)</label>
            <input className="form-input" type="number" min="0" value={arrear.amount} onChange={(e) => setArrear({ ...arrear, amount: e.target.value })} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
            <label className="form-label">Remark</label>
            <input className="form-input" value={arrear.remark} placeholder="e.g. September short payment"
              onChange={(e) => setArrear({ ...arrear, remark: e.target.value })} />
          </div>
          <button className="btn btn-outline" onClick={addArrear}><i className="fas fa-plus" /> Add</button>
        </div>
      </Section>

      <Section title="Advance" hint="An employee can get an advance after completing one year. The monthly deduction comes off every salary until the balance is 0.">
        {advances.map((a) => (
          <div key={a.id} className="payslip-row" style={{ alignItems: 'center' }}>
            <span>
              {a.type} of <strong>{fmt(a.amount)}</strong> · balance <strong>{fmt(a.balance)}</strong>
              {a.remarks ? <span style={small}> · {a.remarks}</span> : null}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={small}>per month ₹</span>
              <input className="form-input" type="number" min="1" max={a.amount} style={{ width: 90, padding: '5px 8px', fontSize: 12 }}
                value={emiEdits[a.id] ?? a.emi} onChange={(e) => setEmiEdits({ ...emiEdits, [a.id]: e.target.value })} />
              <button className="btn btn-outline btn-sm" disabled={emiEdits[a.id] === undefined || Number(emiEdits[a.id]) === Number(a.emi)} onClick={() => changeEmi(a)}>Update</button>
            </span>
          </div>
        ))}
        {eligibility.eligible ? (
          <>
            <div style={{ ...small, margin: '6px 0 10px' }}>Completed one year on {fmtYmd(eligibility.eligibleOn)} — eligible for an advance.</div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label className="form-label">New advance (₹)</label>
                <input className="form-input" type="number" min="0" value={newAdvance.amount} onChange={(e) => setNewAdvance({ ...newAdvance, amount: e.target.value })} />
              </div>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label className="form-label">Deduct per month (₹)</label>
                <input className="form-input" type="number" min="0" value={newAdvance.emi} onChange={(e) => setNewAdvance({ ...newAdvance, emi: e.target.value })} />
              </div>
              <div className="form-group" style={{ flex: 1.4, marginBottom: 0 }}>
                <label className="form-label">Remark</label>
                <input className="form-input" value={newAdvance.remarks} onChange={(e) => setNewAdvance({ ...newAdvance, remarks: e.target.value })} />
              </div>
              <button className="btn btn-outline" onClick={giveAdvance}><i className="fas fa-plus" /> Give advance</button>
            </div>
            {Number(newAdvance.amount) > 0 && Number(newAdvance.emi) > 0 && (
              <div className="form-hint">Recovered in {Math.ceil(Number(newAdvance.amount) / Number(newAdvance.emi))} month(s).</div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--warning)' }}>
            <i className="fas fa-info-circle" />{' '}
            {eligibility.eligibleOn
              ? `Not eligible for an advance yet — completes one year on ${fmtYmd(eligibility.eligibleOn)}.`
              : 'No date of joining on record, so one year of service cannot be checked.'}
          </div>
        )}
      </Section>

      <Section title={`${monthText} with these details`} hint={`${pay.paidDays} of ${pay.monthDays} days paid · gross salary ${fmt(pay.structure.gross)}`}>
        <div className="grid-2" style={{ marginBottom: 0 }}>
          <div>
            {pay.earnings.map((e, i) => (
              <div className="payslip-row" key={i}><span>{e.name}</span><span>{fmt(e.amount)}</span></div>
            ))}
            <div className="payslip-row" style={{ fontWeight: 600, borderTop: '1px solid var(--border)' }}><span>{RANIWALA_LABELS.totalEarnings}</span><span>{fmt(pay.totalEarnings)}</span></div>
          </div>
          <div>
            {pay.deductions.map((d, i) => (
              <div className="payslip-row" key={i}><span>{d.name}</span><span>-{fmt(d.amount)}</span></div>
            ))}
            {pay.advanceDeduction > 0 && (
              <div className="payslip-row"><span>Advance <span style={small}>· balance after {fmt(pay.advanceBalance)}</span></span><span>-{fmt(pay.advanceDeduction)}</span></div>
            )}
            <div className="payslip-row" style={{ fontWeight: 600, borderTop: '1px solid var(--border)' }}><span>Total deductions</span><span>-{fmt(pay.totalDeductions + pay.advanceDeduction)}</span></div>
          </div>
        </div>
        <div className="payslip-row total"><span>Net pay</span><span style={{ color: pay.netPay < 0 ? 'var(--danger)' : 'var(--success)' }}>{fmt(pay.netPay)}</span></div>
        <div style={{ marginTop: 12, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>Contribution <span style={{ ...small, fontWeight: 400 }}>· paid by the company, not deducted from the employee</span></div>
          <div className="payslip-row"><span>PF Employer <span style={small}>· {pay.pfApplicable ? `${RANIWALA_RULES.pfEmployerRate}% of Basic${pay.pf.capped ? ', capped' : ''}` : 'PF switched off'}</span></span><span>{fmt(pay.pf.employer)}</span></div>
          <div className="payslip-row"><span>ESIC Employer <span style={small}>· {pay.esic.applicable ? `${RANIWALA_RULES.esicEmployerRate}% of Basic` : 'not applicable'}</span></span><span>{fmt(pay.esic.employer)}</span></div>
          <div className="payslip-row" style={{ fontWeight: 600, borderTop: '1px solid var(--border)' }}><span>CTC for the month</span><span>{fmt(pay.totalEarnings + pay.pf.employer + pay.esic.employer)}</span></div>
        </div>
        {(pay.shortfall.tds > 0 || pay.shortfall.advance > 0) && (
          <div style={{ fontSize: 12, color: 'var(--warning)', marginTop: 6 }}>
            Pay for the month is too low to take everything:
            {pay.shortfall.tds > 0 ? ` TDS short by ${fmt(pay.shortfall.tds)}.` : ''}
            {pay.shortfall.advance > 0 ? ` Advance short by ${fmt(pay.shortfall.advance)} — it stays in the balance.` : ''}
          </div>
        )}
      </Section>
    </Modal>
  );
}

/**
 * Run Payroll for Raniwala: one run a month for everyone, with every
 * component of the salary structure in its own column. Before processing the
 * figures are live (paid days, retention and each employee's details can be
 * changed); after processing they are read from the payslips.
 */
export default function RaniwalaPayrollSection({
  tenant, profile, month, year, monthDays, daysSoFar, rows, processed, processing, isManager,
  additions, advances, workDayOverrides, setWorkDayOverrides,
  lateDays = {}, lateCounts = {}, onLateDaysChange,
  onSettingsSaved, onAdditionsChanged, onAdvancesChanged,
  onProcess, onRevert, onExportGL, onExportBank, onViewSlip,
  split = null, partRuns = {}, partRows = {}, partDayOverrides = {}, setPartDayOverrides, partBusy,
  onTogglePartPf, onRunPart, onUndoPart, onSavePartPf, onDiscardPartPf, onRelease, employees = [], leavers = {},
}) {
  const { outletProfileIds, outlets, selectedOutletName } = useOutletView();
  const [search, setSearch] = useState('');
  const [editId, setEditId] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  // Two-run month: which part (1, 2) or 'final' is on screen. Opens on the
  // first part not run yet, else on the final payslip.
  const [tab, setTab] = useState(null);
  const partsRun = (split || []).every((p) => partRuns[p.part]);
  const view = split ? (tab ?? (processed ? 'final' : (split.find((p) => !partRuns[p.part])?.part ?? 'final'))) : 'final';
  const activePart = split?.find((p) => p.part === view) || null;
  const held = processed && !processed.released_at;

  const rowById = Object.fromEntries(rows.map((r) => [r.emp.id, r]));
  const views = processed
    ? scopedToOutlet(processed.payslips || [], outletProfileIds).map(slipView)
    : rows.map(draftView);
  const q = search.trim().toLowerCase();
  const shown = q ? views.filter((v) => `${v.name} ${v.d.empCode || ''} ${v.dept}`.toLowerCase().includes(q)) : views;
  // Left (or leaving) this month: their own table below, same columns.
  const leftViews = views.filter((v) => leavers[v.profileId]);
  const shownActive = shown.filter((v) => !leavers[v.profileId]);
  const shownLeft = shown.filter((v) => leavers[v.profileId]);
  const sumOf = (list, pick) => list.reduce((s, v) => s + (Number(pick(v)) || 0), 0);
  const editRow = editId ? rowById[editId] : null;

  const sum = (pick) => sumOf(views, pick);
  const noGross = processed ? [] : rows.filter((r) => (r.pay.structure.gross || 0) <= 1);
  const negative = processed ? [] : rows.filter((r) => r.pay.netPay < 0);
  const running = !processed && daysSoFar;
  const asOf = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

  const pickRetention = async (row, percent) => {
    if (percent > 0 && !row.pay.retention.probationEnd) {
      setEditId(row.emp.id);
      return showToast('Set the probation completion date first — retention is only taken during probation', 'warning');
    }
    const { data, error } = await savePayrollSettings(tenant.id, row.emp.id, { retention_percent: percent });
    if (error) return showToast('Could not save: ' + error.message, 'error');
    onSettingsSaved(data);
  };

  // Outlet-wise, formatted workbook: Summary + All Outlets + a sheet per
  // outlet (one sheet when a single outlet is selected), with filters on
  // every column header (lib/salarySheetExport). The main sheet holds the
  // working employees only; `onlyLeft` builds the sheet of the inactive ones.
  const exportRegister = async (onlyLeft = false) => {
    const sheetViews = onlyLeft ? leftViews : views.filter((v) => !leavers[v.profileId]);
    if (!sheetViews.length) return showToast(onlyLeft ? 'No inactive employees to export' : 'No employees to export', 'warning');
    try {
      const outletName = Object.fromEntries((outlets || []).map((o) => [o.id, o.name]));
      const empById = Object.fromEntries([...employees, ...rows.map((r) => r.emp)].map((e) => [e.id, e]));
      const byOutlet = new Map();
      const lines = sheetViews
        .map((v) => {
          const emp = empById[v.profileId];
          const outlet = outletName[emp?.outlet_id] || 'No outlet';
          const bank = {
            bankName: (v.d.bankName || emp?.bank_name || '').trim(),
            bankAcc: (v.d.bankAcc || emp?.bank_acc || '').trim(),
            ifsc: (v.d.ifsc || emp?.ifsc_code || '').trim(),
          };
          const record = registerRow(v, {
            division: emp?.division, department: v.dept || emp?.department, outlet, ctc: emp?.salary_ctc, bank,
          });
          return { outlet, hdfc: isHdfc(bank), record };
        })
        .sort((a, b) => a.outlet.localeCompare(b.outlet) || a.record['EMPLOYEE NAME'].localeCompare(b.record['EMPLOYEE NAME']));
      lines.forEach(({ outlet, record }) => {
        if (!byOutlet.has(outlet)) byOutlet.set(outlet, []);
        byOutlet.get(outlet).push(record);
      });
      const groups = [...byOutlet].map(([outlet, records]) => ({ outlet, records }));
      // All Outlets: no Factory, HDFC accounts first (stable, so outlet / name order stays).
      const allRecords = lines
        .filter((l) => !isFactoryOutlet(l.outlet))
        .sort((a, b) => Number(b.hdfc) - Number(a.hdfc))
        .map((l) => l.record);
      // A two-run month adds each part's days / PF / ESIC as a last section.
      const partKeys = [...new Set(groups.flatMap((g) => g.records).flatMap((r) => Object.keys(r)))]
        .filter((k) => !SHEET_SECTIONS.some((s) => s.keys.includes(k)));
      const sections = partKeys.length
        ? [...SHEET_SECTIONS, { title: 'TWO-RUN MONTH (EACH PART)', color: 'FF808080', tint: 'FFF2F2F2', keys: partKeys }]
        : SHEET_SECTIONS;
      const monthText = monthLabel(month, year);
      const { default: ExcelJS } = await import('exceljs');
      const wb = buildSalaryWorkbook(ExcelJS, {
        groups,
        allRecords,
        allNote: 'all outlets except Factory · HDFC Bank first, then other banks (filter the OUTLET column for one)',
        sections,
        title: `${tenant?.company_name || 'Raniwala'} — ${onlyLeft ? 'Inactive Employees Salary Sheet' : 'Salary Sheet'} — ${monthText}`,
        subtitle: `${processed ? 'Processed payroll' : 'DRAFT — payroll not processed yet'} · ${selectedOutletName || 'All outlets'} · generated ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
        summaryKeys: [CTC_COL, 'GROSS SALARY', EARNED_CTC_COL, EARNED_GROSS_COL, 'BASIC', 'HRA', 'OVERTIME', 'ARREAR / INCENTIVE (+/-)', TOTAL_EARNINGS_COL,
          'PF EMPLOYEE', 'ESIC EMPLOYEE', 'ADVANCE DEDUCTED', 'TDS', 'LATE DEDUCTION', ADJUSTMENT_COL, 'RETENTION', 'TOTAL DEDUCTIONS', 'NET PAY',
          'PF EMPLOYER', 'ESIC EMPLOYER', 'ADVANCE BALANCE'],
        strongKeys: ['NET PAY', CTC_COL, EARNED_CTC_COL],
        notes: SHEET_NOTES,
      });
      const outletPart = selectedOutletName ? `_${selectedOutletName.replace(/[^a-z0-9]+/gi, '_')}` : '_all_outlets';
      await downloadWorkbook(wb, `raniwala_${onlyLeft ? 'inactive_' : ''}salary_sheet_${year}-${String(month + 1).padStart(2, '0')}${outletPart}${processed ? '' : '_draft'}.xlsx`);
      showToast(processed ? 'Salary sheet exported' : 'Draft salary sheet exported — payroll is not processed yet', 'success');
    } catch (err) {
      showToast('Could not build the salary sheet: ' + err.message, 'error');
    }
  };

  // One table, used for the working employees and again for those who left.
  const renderTable = (list, emptyText) => (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>{running ? `Paid Days (till ${asOf})` : split ? 'Paid Days (both parts)' : 'Paid Days'}</th>
            <th>Present Days</th>
            <th>Late Deduction</th>
            <th>Gross Salary</th>
            <th>Basic</th>
            <th>HRA</th>
            <th>Overtime</th>
            <th>Arrear</th>
            <th>PF</th>
            <th>ESIC</th>
            <th>Retention</th>
            <th>TDS</th>
            <th>Advance</th>
            <th>Net Pay</th>
            <th>PF Employer</th>
            <th>ESIC Employer</th>
            <th>CTC</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr><td colSpan={19} style={{ textAlign: 'center', padding: 32, ...muted }}>{emptyText}</td></tr>
          )}
          {list.map((v) => {
            const row = processed ? null : rowById[v.profileId];
            const d = v.d;
            return (
              <tr key={v.key}>
                <td>
                  <div className="emp-cell">
                    <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(v.profileId)})` }}>
                      {getInitials(v.name.split(' ')[0], v.name.split(' ')[1])}
                    </div>
                    <div>
                      <div className="emp-name">{v.name}</div>
                      <div className="emp-role">{[d.empCode, v.dept].filter(Boolean).join(' · ')}</div>
                      {leavers[v.profileId] && <div style={{ ...small, color: 'var(--danger)' }}>{leaverNote(leavers[v.profileId])}</div>}
                    </div>
                  </div>
                </td>
                <td>
                  {row && !isManager && !split ? (
                    <input
                      className="form-input" type="number" min="0" max={monthDays} step="0.5"
                      value={workDayOverrides[v.profileId] ?? monthDays}
                      onChange={(ev) => setWorkDayOverrides((prev) => ({ ...prev, [v.profileId]: parseFloat(ev.target.value) || 0 }))}
                      style={{ width: 65, padding: '5px 8px', fontSize: 12 }}
                    />
                  ) : <span>{d.paidDays}</span>}
                  {running && daysSoFar[v.profileId] !== undefined
                    ? <><span style={small}> / {daysSoFar[v.profileId]}</span><div style={small}>days so far of {d.monthDays}</div></>
                    : <span style={small}> / {d.monthDays}</span>}
                  {(d.parts || []).length > 0 && (
                    <div style={small}>{d.parts.map((p) => `${p.paidDays}${p.pfOn ? '' : ' (no PF)'}`).join(' + ')}</div>
                  )}
                  {d.lateDays > 0 && (
                    <div style={{ ...small, color: 'var(--danger)' }} title="Paid days after HR's late deduction">
                      -{d.lateDays} late = <strong>{d.paidDays}</strong> paid
                    </div>
                  )}
                </td>
                <td>
                  {d.presentDays != null ? <span>{d.presentDays}</span> : <span style={muted}>—</span>}
                  {lateCounts[v.profileId] > 0 && !processed && <div style={small}>{lateCounts[v.profileId]} late mark{lateCounts[v.profileId] === 1 ? '' : 's'}</div>}
                </td>
                <td>
                  {row && !isManager && !split ? (
                    <input
                      className="form-input" type="number" min="0" max={monthDays} step="0.5" placeholder="0"
                      title="Days to take off the paid days for late coming"
                      value={lateDays[v.profileId] || ''}
                      onChange={(ev) => onLateDaysChange(v.profileId, Math.max(0, parseFloat(ev.target.value) || 0))}
                      style={{ width: 60, padding: '5px 8px', fontSize: 12 }}
                    />
                  ) : <span>{d.lateDays ? `${d.lateDays} day${d.lateDays === 1 ? '' : 's'}` : '—'}</span>}
                  {d.lateDeduction > 0 && <div style={{ ...small, color: 'var(--danger)' }}>-{fmt(d.lateDeduction)}</div>}
                </td>
                <td>
                  {fmt(d.grossSalary)}
                  {d.actualGrossDiff > 0 && (
                    <div style={small} title={`Paid on the actual gross: PF/ESIC on the gross above, the difference deducted as the ${RANIWALA_LABELS.adjustment}`}>
                      actual {fmt(d.actualGross)} · <span style={{ color: 'var(--danger)' }}>-{fmt(d.actualGrossDiff)}</span>
                    </div>
                  )}
                </td>
                <td>{fmt(d.basic)}<div style={small}>{d.basicPercent}%</div></td>
                <td>{fmt(d.hra)}<div style={small}>{d.hraPercent}%</div></td>
                <td>{money(d.overtime)}{d.overtimeHours ? <div style={small}>{d.overtimeHours} h</div> : null}</td>
                <td title={arrearRemark(d)}>
                  {d.arrearNet ? <span style={{ color: d.arrearNet < 0 ? 'var(--danger)' : 'var(--success)' }}>{d.arrearNet < 0 ? '-' : '+'}{fmt(Math.abs(d.arrearNet))}</span> : '—'}
                  {(d.arrears || []).length > 0 && <div style={{ ...small, maxWidth: 160, whiteSpace: 'normal' }}>{arrearRemark(d)}</div>}
                </td>
                <td style={{ color: 'var(--danger)' }}>{money(d.pfEmployee, '-')}{d.pfCapped ? <div style={small}>capped</div> : null}</td>
                <td style={{ color: 'var(--danger)' }}>{d.esicApplicable ? money(d.esicEmployee, '-') : <span style={muted}>N/A</span>}</td>
                <td>
                  {row && !isManager ? (
                    <>
                      <RetentionPicker value={row.pay.retention.chosen} disabled={row.pay.retention.state === 'closed'} onPick={(p) => pickRetention(row, p)} />
                      <div style={{ ...small, color: row.pay.retention.state === 'no-date' ? 'var(--warning)' : 'var(--text-muted)' }}>
                        {retentionNote(row.pay.retention)}
                        {row.pay.retention.amount > 0 ? ` · -${fmt(row.pay.retention.amount)}` : ''}
                      </div>
                    </>
                  ) : (
                    <>
                      <span style={{ color: d.retentionAmount ? 'var(--danger)' : undefined }}>{money(d.retentionAmount, '-')}</span>
                      {d.retentionPercent ? <div style={small}>{d.retentionPercent}% · till {fmtYmd(d.probationEndDate)}</div> : null}
                    </>
                  )}
                </td>
                <td style={{ color: 'var(--danger)' }}>{money(d.tds, '-')}</td>
                <td style={{ color: 'var(--warning)' }}>
                  {money(d.advanceDeducted, '-')}
                  {d.advanceOpening > 0 && <div style={small}>balance {fmt(d.advanceBalance)}</div>}
                </td>
                <td><strong style={{ color: v.net < 0 ? 'var(--danger)' : undefined }}>{fmt(v.net)}</strong></td>
                <td style={{ color: 'var(--success)' }}>{money(d.pfEmployer, '+')}{d.pfCapped ? <div style={small}>capped</div> : null}</td>
                <td style={{ color: 'var(--success)' }}>{d.esicApplicable ? money(d.esicEmployer, '+') : <span style={muted}>N/A</span>}</td>
                <td>{fmt(ctcOf(v))}</td>
                <td>
                  {v.slip ? (
                    <button className="btn btn-outline btn-sm" title="View payslip" onClick={() => onViewSlip(v.slip)}><i className="fas fa-eye" /></button>
                  ) : !isManager ? (
                    <button className="btn btn-outline btn-sm" title="Probation, retention, PF/ESIC, TDS, arrear, advance" onClick={() => setEditId(v.profileId)}>
                      <i className="fas fa-edit" /> Details
                    </button>
                  ) : <span className="badge badge-warning">Pending</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      {noGross.length > 0 && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger)' }}>
          <div style={{ padding: '12px 20px', fontSize: 13, display: 'flex', gap: 10 }}>
            <i className="fas fa-exclamation-circle" style={{ color: 'var(--danger)', marginTop: 2 }} />
            <span>
              <strong>{noGross.length}</strong> employee(s) have no gross salary yet (₹0 or the ₹1 placeholder), so their pay below is not real.
              Enter each one&apos;s monthly gross salary as <strong>Monthly CTC</strong> on the Employees page before processing.
            </span>
          </div>
        </div>
      )}
      {running && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--primary)' }}>
          <div style={{ padding: '12px 20px', fontSize: 13, display: 'flex', gap: 10 }}>
            <i className="fas fa-calendar-day" style={{ color: 'var(--primary)', marginTop: 2 }} />
            <span>
              {monthLabel(month, year)} is still running, so paid days and pay below are <strong>as of {asOf}</strong>: present days,
              weekly offs, holidays and paid leave up to today. A working day not punched yet today is left out until it is.
              Pay is for those days out of {monthDays}.
            </span>
          </div>
        </div>
      )}
      {negative.length > 0 && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger)' }}>
          <div style={{ padding: '12px 20px', fontSize: 13 }}>
            <i className="fas fa-exclamation-circle" style={{ color: 'var(--danger)', marginRight: 8 }} />
            Deductions are more than the pay for: {negative.map((r) => fullName(r.emp)).join(', ')}. Correct their arrear deductions before processing.
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <div>
            <h3 style={{ margin: 0 }}>Raniwala Payroll</h3>
            <div style={{ fontSize: 12, ...muted, marginTop: 2 }}>
              {split
                ? `${monthLabel(month, year)} is paid in two runs: ${split.map((p) => `${p.label} (${p.rule.label})`).join(' and ')}. Run both parts, then the final payslip adds them up.`
                : <>Basic, HRA, PF and ESIC come from each employee&apos;s gross salary. Retention, advance, arrear and TDS are set per employee.</>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {processed
              ? <span className="badge badge-success"><i className="fas fa-check" /> Processed</span>
              : <span className="badge badge-warning">Not Processed</span>}
            {processed && (held
              ? <span className="badge badge-warning" title="Employees cannot see these payslips on the website or the app"><i className="fas fa-eye-slash" /> Held — not visible to employees</span>
              : <span className="badge badge-info" title={`Released ${new Date(processed.released_at).toLocaleString('en-IN')}`}><i className="fas fa-eye" /> Visible to employees</span>)}
            <button className="btn btn-outline btn-sm" onClick={() => setShowGuide((v) => !v)}>
              <i className="fas fa-question-circle" /> {showGuide ? 'Hide rules' : 'How it is calculated'}
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => exportRegister()} title="Every working employee with every component (inactive employees have their own sheet)">
              <i className="fas fa-file-excel" /> Salary Sheet
            </button>
            {processed && (
              <>
                <button className="btn btn-outline btn-sm" onClick={onExportGL} title="Department-level debit/credit journal">
                  <i className="fas fa-book" /> GL
                </button>
                <button className="btn btn-outline btn-sm" onClick={onExportBank} title="Generic NEFT/RTGS-style bank payout file">
                  <i className="fas fa-university" /> Bank File
                </button>
              </>
            )}
            {!isManager && processed && onRelease && (held ? (
              <button className="btn btn-success btn-sm" onClick={() => onRelease(true)} title="Employees can see their payslip once released">
                <i className="fas fa-paper-plane" /> Release to employees
              </button>
            ) : (
              <button className="btn btn-outline btn-sm" onClick={() => onRelease(false)}><i className="fas fa-eye-slash" /> Hold again</button>
            ))}
            {!isManager && (processed ? (
              <button className="btn btn-danger btn-sm" onClick={onRevert}><i className="fas fa-undo" /> Revert</button>
            ) : view === 'final' && (
              <button className="btn btn-primary btn-sm" onClick={onProcess} disabled={processing || rows.length === 0 || !partsRun}
                title={partsRun ? 'Payslips are held until you release them to employees' : 'Run both parts first'}>
                {processing
                  ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Processing…</>
                  : <><i className="fas fa-play" /> {split ? 'Process final payroll' : 'Process Payroll'}</>}
              </button>
            ))}
          </div>
        </div>

        {showGuide && <div style={{ padding: '16px 20px 0', borderBottom: '1px solid var(--border)' }}><RaniwalaStructureGuide compact /></div>}

        {held && (
          <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)', fontSize: 13, background: 'var(--warning-light)' }}>
            <i className="fas fa-eye-slash" style={{ color: 'var(--warning)', marginRight: 8 }} />
            These payslips are <strong>held</strong>: employees cannot see them on the website, the app or the assistant. Check the figures, then use
            <strong> Release to employees</strong> when they are final.
          </div>
        )}

        {split && (
          <div style={{ display: 'flex', gap: 8, padding: '12px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
            {split.map((p) => (
              <button key={p.part} className={`btn btn-sm ${view === p.part ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab(p.part)}>
                {partRuns[p.part] ? <i className="fas fa-check-circle" /> : <i className="far fa-circle" />} Part {p.part} · {p.label}
                <span style={{ fontSize: 10, opacity: 0.8 }}> ({p.rule.label})</span>
              </button>
            ))}
            <button className={`btn btn-sm ${view === 'final' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('final')}>
              {processed ? <i className="fas fa-check-circle" /> : <i className="far fa-circle" />} Final payslip · both parts
            </button>
          </div>
        )}

        {activePart ? (
          <RaniwalaPartRun
            part={activePart}
            run={partRuns[activePart.part] || null}
            rows={(partRows[activePart.part] || []).filter((r) => !partRuns[activePart.part] || r.stored)}
            monthDays={monthDays}
            companyName={tenant?.company_name}
            isManager={isManager}
            busy={partBusy}
            finalProcessed={!!processed}
            dayOverrides={partDayOverrides[activePart.part] || {}}
            setDayOverrides={(id, days) => setPartDayOverrides((prev) => ({ ...prev, [activePart.part]: { ...(prev[activePart.part] || {}), [id]: days } }))}
            onTogglePf={(ids, on) => onTogglePartPf(activePart.part, ids, on)}
            onRun={() => onRunPart(activePart)}
            onUndo={() => onUndoPart(activePart)}
            onSavePf={() => onSavePartPf(activePart)}
            onDiscardPf={() => onDiscardPartPf(activePart)}
          />
        ) : (
        <>
        {split && !processed && !partsRun && (
          <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border)', fontSize: 13, color: 'var(--warning)' }}>
            <i className="fas fa-info-circle" /> Preview only: {split.filter((p) => !partRuns[p.part]).map((p) => `part ${p.part} (${p.label})`).join(' and ')} not run yet.
            Run both parts to process the final payroll.
          </div>
        )}
        <div style={{ display: 'flex', gap: 24, padding: '12px 20px', borderBottom: '1px solid var(--border)', fontSize: 13, flexWrap: 'wrap', alignItems: 'center' }}>
          <span><strong>{views.length}</strong> <span style={muted}>employees{leftViews.length ? ` (${leftViews.length} inactive, listed below)` : ''}</span></span>
          <span><strong>{fmt(sum((v) => v.totalEarnings))}</strong> <span style={muted}>earnings before deductions</span></span>
          <span><strong>{fmt(sum((v) => v.d.pfEmployee))}</strong> <span style={muted}>PF employee</span></span>
          <span><strong>{fmt(sum((v) => v.d.esicEmployee))}</strong> <span style={muted}>ESIC employee</span></span>
          <span><strong style={{ color: 'var(--success)' }}>{fmt(sum((v) => v.net))}</strong> <span style={muted}>net pay</span></span>
          <span><strong>{fmt(sum((v) => v.d.pfEmployer))}</strong> <span style={muted}>PF employer</span></span>
          <span><strong>{fmt(sum((v) => v.d.esicEmployer))}</strong> <span style={muted}>ESIC employer</span></span>
          <span><strong>{fmt(sum(ctcOf))}</strong> <span style={muted}>CTC</span></span>
          <input className="form-input" placeholder="Search name or code" value={search} onChange={(e) => setSearch(e.target.value)}
            style={{ marginLeft: 'auto', width: 200, padding: '6px 10px', fontSize: 12 }} />
        </div>

        {renderTable(shownActive, leftViews.length ? 'No active employees found' : 'No employees found')}
        </>
        )}
      </div>

      {!activePart && leftViews.length > 0 && (
        <div className="card" style={{ marginTop: 24, borderColor: 'var(--danger)' }}>
          <div className="card-header">
            <div>
              <h3 style={{ margin: 0 }}>Inactive employees · {monthLabel(month, year)}</h3>
              <div style={{ fontSize: 12, ...muted, marginTop: 2 }}>
                Left (or leaving) this month, paid only up to their last day. Check their days before processing; they are paid in the same run as everyone else.
              </div>
            </div>
            <button className="btn btn-outline btn-sm" onClick={() => exportRegister(true)} title="Salary sheet of the inactive employees only">
              <i className="fas fa-file-excel" /> Inactive Salary Sheet
            </button>
          </div>
          <div style={{ display: 'flex', gap: 24, padding: '12px 20px', borderBottom: '1px solid var(--border)', fontSize: 13, flexWrap: 'wrap' }}>
            <span><strong>{leftViews.length}</strong> <span style={muted}>employees</span></span>
            <span><strong>{fmt(sumOf(leftViews, (v) => v.totalEarnings))}</strong> <span style={muted}>earnings before deductions</span></span>
            <span><strong style={{ color: 'var(--success)' }}>{fmt(sumOf(leftViews, (v) => v.net))}</strong> <span style={muted}>net pay</span></span>
          </div>
          {renderTable(shownLeft, 'No inactive employees match the search')}
        </div>
      )}

      {editRow && (
        <EmployeePayrollModal
          key={editRow.emp.id}
          row={editRow} tenant={tenant} profile={profile} month={month} year={year}
          additions={additions.filter((a) => a.profile_id === editRow.emp.id)}
          advances={advances.filter((a) => a.profile_id === editRow.emp.id && a.balance > 0)}
          onClose={() => setEditId(null)}
          onSettingsSaved={onSettingsSaved}
          onAdditionsChanged={onAdditionsChanged}
          onAdvancesChanged={onAdvancesChanged}
        />
      )}
    </>
  );
}
