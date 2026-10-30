// Raniwala's payslip template, shared by the screen (components/payroll/
// RaniwalaPayslip.jsx) and the printable page (Payslips page's Print opens
// raniwalaPayslipHtml in a new window). One model, one stylesheet and one
// markup (slipBody), so the two never drift apart. Laid out like HR's sample
// slips (24 Oct 2026): plain black and white boxes that read and print like a
// standard payslip; the wordmark (public/brand/) is drawn in black.
import { escapeHtml } from './helpers.js';
import { RANIWALA_LABELS, fmtYmd, raniwalaStructure } from './raniwalaPayroll.js';

export const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export const RANIWALA_BRAND = {
  wordmark: '/brand/raniwala-wordmark.png',
};

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const upTo99 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const upTo999 = (n) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', upTo99(n % 100)].filter(Boolean).join(' ');

// Indian grouping: crore, lakh, thousand, then hundreds.
function inWords(n) {
  if (n >= 10000000) return [`${inWords(Math.floor(n / 10000000))} Crore`, inWords(n % 10000000)].filter(Boolean).join(' ');
  const parts = [];
  if (n >= 100000) { parts.push(`${upTo99(Math.floor(n / 100000))} Lakh`); n %= 100000; }
  if (n >= 1000) { parts.push(`${upTo99(Math.floor(n / 1000))} Thousand`); n %= 1000; }
  if (n) parts.push(upTo999(n));
  return parts.join(' ');
}

/** 25000 -> 'Rupees Twenty Five Thousand Only'. */
export function rupeesInWords(amount) {
  const n = Math.round(Math.abs(Number(amount) || 0));
  return `Rupees ${n && Number(amount) < 0 ? 'Minus ' : ''}${n ? inWords(n) : 'Zero'} Only`;
}

// The actual-gross deduction is "Adj" on the slip; older slips carry the
// names it had before RANIWALA_LABELS.adjustment.
const SLIP_ADJ = 'Adj';
const ADJ_NAMES = [RANIWALA_LABELS.adjustment, 'Salary Adjustment', 'Actual Gross Difference'];

/**
 * The full-month Basic and HRA of a month paid in parts: each part's own gross
 * for that part's share of the month, the same rounding as raniwalaPartPay.
 * HR's Sept sheet can pay the two parts on different grosses (e.g. 92,217 for
 * 1–16 and 90,917 for 17–30), so one gross for the month would make Earned
 * larger than Actual with every day paid. The part's length is read from its
 * label ('1–16 Sep', raniwalaSplitFor); a part without a gross is on the
 * slip's gross.
 */
function partsActual(parts, r) {
  return parts.reduce((t, p) => {
    const [, from, to] = /^(\d+)–(\d+)/.exec(p.label || '') || [];
    const gross = Number(p.gross) || Number(r.grossSalary) || 0;
    const days = from ? Number(to) - Number(from) + 1 : r.monthDays / parts.length;
    const share = Math.round(gross * Math.min(1, days / r.monthDays));
    const basic = Math.round((share * raniwalaStructure(gross).basicPercent) / 100);
    return { 'Basic Pay': t['Basic Pay'] + basic, HRA: t.HRA + share - basic };
  }, { 'Basic Pay': 0, HRA: 0 });
}

/**
 * Everything the slip shows, from a payslip row and its breakdown. Earnings
 * have two amounts, as on HR's sample slips: the ACTUAL full-month figure of
 * the salary structure, then what was EARNED for the days paid. Overtime and
 * arrears have no full-month figure.
 *
 * `ctc` is the employee's CTC as filled on the employee form
 * (employee_salaries.ctc). A month paid in parts (Sept 2026) shows that CTC
 * and not a CTC worked out from the month's pay (HR, 24 Oct 2026); with no
 * CTC filled (or not readable, e.g. an employee before
 * salary_visible_to_employee) the line is left off.
 *
 * `leave` is the employee's leave balance on the last day of the slip's month
 * ({ asOf: 'YYYY-MM-DD', rows: [{ name, days }] }, see
 * fetchLeaveBalancesAsOf); without it the box is left off.
 *
 * HR, 24 Oct 2026: the slip shows each line's name and amount only (no notes
 * or remarks), the actual-gross deduction is "Adj", and a PF / ESIC / Adj that
 * is 0 or not applicable reads "NA". 29 Oct 2026: the last remarks (net
 * formula, contribution note, retention note) are off the slip too.
 */
export function raniwalaSlipModel({ slip, breakdown, ctc = null, leave = null }) {
  const r = breakdown.raniwala || {};
  const parts = r.parts || [];
  const inParts = parts.length > 0 || !!r.partOfMonth;
  // Slips processed before fullBasic/fullHra were stored: the same structure again.
  const structure = raniwalaStructure(r.grossSalary);
  const actualOf = parts.length
    ? partsActual(parts, r)
    : { 'Basic Pay': r.fullBasic ?? structure.basic, HRA: r.fullHra ?? structure.hra };
  const earnings = (breakdown.earnings || []).map((e) => ({
    name: e.name, amount: e.amount, actual: e.name in actualOf ? actualOf[e.name] : null,
  }));
  // HR's late deduction (30 Oct 2026): the days it is for, as the paid days are already cut.
  const lateName = r.lateDays > 0 ? `Late Deduction (${r.lateDays} day${r.lateDays === 1 ? '' : 's'})` : 'Late Deduction';
  const deductions = (breakdown.deductions || []).map((d) => ({
    name: ADJ_NAMES.includes(d.name) ? SLIP_ADJ : d.name === 'Late Deduction' ? lateName : d.name, amount: d.amount,
  }));
  if (slip.advance_deduction > 0) deductions.push({ name: 'Advance', amount: slip.advance_deduction });
  const filledCtc = Number(ctc) > 0 ? Number(ctc) : null;
  return {
    // The two columns of the details box: the employee on the left, code and
    // bank (as frozen on the slip) on the right; UAN only in a month PF is deducted.
    left: [
      { label: 'Employee Name', value: slip.emp_name || '—' },
      { label: 'Designation', value: slip.designation || '—' },
      { label: 'Department', value: slip.department || '—' },
      { label: 'Date of Joining', value: fmtYmd(r.joinDate) },
      { label: 'Paid Days', value: `${r.paidDays ?? '—'} of ${r.monthDays ?? '—'}` },
    ],
    right: [
      { label: 'Employee Code', value: r.empCode || '—' },
      { label: 'Bank Name', value: r.bankName || '—' },
      { label: 'Bank A/c No.', value: r.bankAcc || '—' },
      { label: 'IFSC', value: r.ifsc || '—' },
      ...(r.pfOn ? [{ label: 'UAN', value: r.uan || '—' }] : []),
      // Under the UAN, in a month ESIC is deducted (slips from before esicOn: esicApplicable).
      ...((r.esicOn ?? r.esicApplicable) ? [{ label: 'ESIC No.', value: r.esicNo || '—' }] : []),
    ],
    parts,
    partsHaveDiff: parts.some((p) => Number(p.diff) > 0),
    // The parts' gross is shown only when HR paid them on different grosses.
    partsGrossDiffer: new Set(parts.map((p) => Number(p.gross) || 0)).size > 1,
    earnings,
    deductions,
    totalActual: earnings.reduce((t, e) => t + (e.actual || 0), 0),
    totalEarnings: slip.gross_earnings,
    totalDeductions: slip.total_deductions + slip.advance_deduction,
    net: slip.net_pay,
    netWords: rupeesInWords(slip.net_pay),
    advance: r.advanceOpening > 0 ? { opening: r.advanceOpening, deducted: r.advanceDeducted, balance: r.advanceBalance } : null,
    contribution: {
      // Term and amount only, no rate or cap (HR, 24 Oct 2026).
      pfLabel: 'PF (Employer)',
      pf: r.pfEmployer || 0,
      esicLabel: 'ESIC (Employer)',
      esic: r.esicApplicable ? r.esicEmployer : null,
      ctcLabel: inParts ? 'Monthly CTC' : 'CTC for the month',
      ctc: inParts ? filledCtc : slip.gross_earnings + (r.pfEmployer || 0) + (r.esicEmployer || 0),
    },
    leave: leave?.rows?.length ? { asOf: fmtYmd(leave.asOf), rows: leave.rows } : null,
  };
}

export const RANIWALA_SLIP_CSS = `.rw-slip{max-width:780px;margin:0 auto;padding:24px 28px;background:#fff;color:#000;border:1px solid #000;
  font-family:Arial,Helvetica,'Segoe UI',sans-serif;font-size:12.5px;line-height:1.4;text-align:left;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.rw-slip *{box-sizing:border-box}
.rw-head{text-align:center;margin-bottom:16px}
.rw-logo{display:block;height:28px;width:auto;margin:0 auto 6px;filter:brightness(0)}
.rw-co{font-size:17px;font-weight:700}
.rw-title{margin-top:12px;font-size:15px;font-weight:700}
.rw-box{border:1px solid #000;margin-bottom:14px}
.rw-sec{padding:5px 10px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid #000;background:#f2f2f2}
.rw-two{display:grid;grid-template-columns:1fr 1fr}
.rw-two>div+div{border-left:1px solid #000}
.rw-kv{width:100%;border-collapse:collapse}
.rw-kv td{padding:4px 10px;vertical-align:top;overflow-wrap:anywhere}
.rw-kv td:first-child{width:44%;color:#333}
.rw-kv td:last-child{font-weight:600}
.rw-kv td:last-child::before{content:': ';font-weight:400;color:#333}
.rw-pay{display:grid;grid-template-columns:1fr 1fr}
.rw-pay>:nth-child(even){border-left:1px solid #000}
.rw-amt{width:100%;border-collapse:collapse;table-layout:fixed;font-variant-numeric:tabular-nums}
.rw-amt th,.rw-amt td{padding:5px 10px;text-align:right;vertical-align:top;overflow-wrap:anywhere}
.rw-amt th:first-child,.rw-amt td:first-child{text-align:left}
.rw-amt th{font-weight:700;text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid #000;background:#f2f2f2}
.rw-amt td+td,.rw-amt th+th{white-space:nowrap;overflow-wrap:normal}
.rw-amt .rw-n{width:27%}
.rw-amt.rw-total{border-top:1px solid #000}
.rw-amt.rw-total td{font-weight:700}
.rw-empty td{color:#444}
.rw-net{margin-bottom:14px;padding:9px 10px;border:1px solid #000;background:#f2f2f2;text-align:center;font-size:14px}
.rw-net b{font-size:16px;font-variant-numeric:tabular-nums}
.rw-words{font-size:12px}
.rw-cap{font-weight:700;margin:0 0 4px}
.rw-tbl-wrap{margin-bottom:14px;overflow-x:auto}
.rw-tbl{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.rw-tbl th,.rw-tbl td{border:1px solid #000;padding:5px 8px;text-align:right;white-space:nowrap}
.rw-tbl th{background:#f2f2f2;font-weight:700}
.rw-tbl th:first-child,.rw-tbl td:first-child{text-align:left}
.rw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-bottom:14px}
.rw-grid .rw-box{margin:0}
.rw-th,.rw-line{display:flex;justify-content:space-between;gap:12px;padding:5px 10px}
.rw-th{font-weight:700;border-bottom:1px solid #000;background:#f2f2f2}
.rw-a{font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right}
.rw-box>small{display:block;padding:0 10px 6px;font-size:10.5px;color:#444}
.rw-foot{margin-top:18px;padding-top:10px;border-top:1px solid #000;text-align:center;font-size:10.5px;color:#333}
.rw-foot div+div{margin-top:2px;color:#666}
.rw-mask{font-family:monospace;letter-spacing:2px;color:#666}
.rw-wrap{container:rw-slip / inline-size}
.rw-tools{display:flex;justify-content:flex-end;gap:8px;max-width:780px;margin:0 auto 10px}
@container rw-slip (max-width:560px){
  .rw-slip{padding:16px}
  .rw-two{grid-template-columns:1fr}
  .rw-two>div+div{border-left:0;border-top:1px solid #000}
  .rw-pay{grid-template-columns:1fr}
  .rw-pay>:nth-child(even){border-left:0}
  .rw-pay>:nth-child(2){order:3;border-top:1px solid #000}
  .rw-pay>:nth-child(3){order:2}
  .rw-pay>:nth-child(4){order:4}
  .rw-amt th,.rw-amt td{padding:5px 8px}
  .rw-tbl{font-size:11.5px}
  .rw-tbl th,.rw-tbl td{padding:4px 5px}
}
@media print{
  .rw-slip{max-width:none}
  .rw-tools{display:none!important}
}`;

/**
 * The slip's markup, shared by the screen and the printable page. Every value
 * is escaped; `show` formats an amount (the screen masks it until revealed).
 */
function slipBody(m, { companyName, monthText, logoSrc, show = rupees, mask = false }) {
  const e = escapeHtml;
  const kv = (rows) => `<table class="rw-kv">${rows.map((i) => `<tr><td>${e(i.label)}</td><td>${i.money ? show(i.value) : e(i.value)}</td></tr>`).join('')}</table>`;
  // PF, ESIC and Adj: the amount, or NA when it is 0 or does not apply.
  const na = (amount, applies = true) => (applies && Number(amount) > 0 ? show(amount) : 'NA');
  const days = (n) => e(String(Math.round(Number(n || 0) * 100) / 100));
  const row = (label, value) => `<div class="rw-line"><span>${e(label)}</span><span class="rw-a">${value}</span></div>`;
  // Earnings and deductions are a 2 x 2 grid — the two item tables, then the
  // two total rows — so the totals line up; the same column widths keep each
  // total under its amounts.
  const cols = (n) => `<colgroup><col>${'<col class="rw-n">'.repeat(n)}</colgroup>`;
  const c = m.contribution;
  return `<div class="rw-head">
      <img class="rw-logo" src="${e(logoSrc)}" alt="Raniwala 1881">
      <div class="rw-co">${e(companyName || 'Raniwala Jewellers')}</div>
      <div class="rw-title">Payslip for the month of ${e(monthText)}</div>
    </div>
    <div class="rw-box"><div class="rw-sec">Employee Pay Summary</div><div class="rw-two"><div>${kv(m.left)}</div><div>${kv(m.right)}</div></div></div>
    <div class="rw-box rw-pay">
      <div><table class="rw-amt">${cols(2)}<thead><tr><th>Earnings</th><th>Actual</th><th>Earned</th></tr></thead><tbody>
        ${m.earnings.map((l) => `<tr><td>${e(l.name)}</td><td>${l.actual == null ? '—' : show(l.actual)}</td><td>${show(l.amount)}</td></tr>`).join('')}
      </tbody></table></div>
      <div><table class="rw-amt">${cols(1)}<thead><tr><th>Deductions</th><th>Amount</th></tr></thead><tbody>
        ${m.deductions.length ? m.deductions.map((l) => `<tr><td>${e(l.name)}</td><td>${show(l.amount)}</td></tr>`).join('')
          : `<tr class="rw-empty"><td>No deductions this month</td><td>${show(0)}</td></tr>`}
      </tbody></table></div>
      <table class="rw-amt rw-total">${cols(2)}<tr><td>${e(RANIWALA_LABELS.totalEarnings)}</td><td>${show(m.totalActual)}</td><td>${show(m.totalEarnings)}</td></tr></table>
      <table class="rw-amt rw-total">${cols(1)}<tr><td>Total Deductions</td><td>${show(m.totalDeductions)}</td></tr></table>
    </div>
    <div class="rw-net">Total Net Payable <b>${show(m.net)}</b>${mask ? '' : ` <span class="rw-words">(${e(m.netWords)})</span>`}</div>
    ${m.parts.length ? `<div class="rw-cap">Salary Breakup</div><div class="rw-tbl-wrap"><table class="rw-tbl">
      <tr><th>Period</th><th>Days</th>${m.partsGrossDiffer ? '<th>Monthly Gross</th>' : ''}<th>Basic</th><th>HRA</th><th>PF</th><th>ESIC</th>${m.partsHaveDiff ? `<th>${SLIP_ADJ}</th>` : ''}</tr>
      ${m.parts.map((p) => `<tr><td>${e(p.label)}</td><td>${e(p.paidDays)}</td>
        ${m.partsGrossDiffer ? `<td>${show(p.gross)}</td>` : ''}<td>${show(p.basic)}</td><td>${show(p.hra)}</td><td>${na(p.pfEmployee, p.pfOn)}</td>
        <td>${na(p.esicEmployee, p.esicApplicable)}</td>${m.partsHaveDiff ? `<td>${na(p.diff)}</td>` : ''}</tr>`).join('')}
    </table></div>` : ''}
    <div class="rw-grid">
      ${m.leave ? `<div class="rw-box"><div class="rw-th"><span>Leave Balance</span><span>Days</span></div>
        ${m.leave.rows.map((l) => row(l.name, days(l.days))).join('')}
        <small>As on ${e(m.leave.asOf)}</small></div>` : ''}
      ${m.advance ? `<div class="rw-box"><div class="rw-th"><span>Advance</span><span>Amount</span></div>
        ${row('Balance before', show(m.advance.opening))}${row('Deducted this month', show(m.advance.deducted))}${row('Advance balance', show(m.advance.balance))}</div>` : ''}
      <div class="rw-box"><div class="rw-th"><span>Contribution</span><span>Amount</span></div>
        ${row(c.pfLabel, na(c.pf))}
        ${row(c.esicLabel, na(c.esic, c.esic != null))}
        ${c.ctc == null ? '' : row(c.ctcLabel, show(c.ctc))}</div>
    </div>
    <div class="rw-foot"><div>This is a computer-generated payslip and does not require a signature.</div><div>Generated on CrewCore HRMS</div></div>`;
}

const MASKED = '<span class="rw-mask">₹ ••••••</span>';

/** The slip for the screen; `mask` hides every amount (My Payslips, until revealed). */
export function raniwalaSlipInnerHtml({ slip, breakdown, ctc = null, leave = null, companyName, monthText, mask = false }) {
  return slipBody(raniwalaSlipModel({ slip, breakdown, ctc, leave }), {
    companyName, monthText, logoSrc: RANIWALA_BRAND.wordmark, mask, show: mask ? () => MASKED : rupees,
  });
}

/** The printable page: the same slip as the screen, on its own. */
export function raniwalaPayslipHtml({ slip, breakdown, ctc = null, leave = null, companyName, monthText, assetBase = '', autoPrint = false }) {
  const m = raniwalaSlipModel({ slip, breakdown, ctc, leave });
  const e = escapeHtml;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Payslip · ${e(slip.emp_name)} · ${e(monthText)}</title>
    <style>${RANIWALA_SLIP_CSS}
    @page{size:A4;margin:12mm}html,body{margin:0;background:#fff}body{padding:16px}</style></head><body>
    <div class="rw-wrap"><div class="rw-slip">${slipBody(m, { companyName, monthText, logoSrc: assetBase + RANIWALA_BRAND.wordmark })}</div></div>
    ${autoPrint ? '<script>window.addEventListener("load",function(){window.focus();window.print();});</script>' : ''}
    </body></html>`;
}
