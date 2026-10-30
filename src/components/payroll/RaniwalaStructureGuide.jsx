import { useState } from 'react';
import { fmt } from '@/lib/helpers';
import { RANIWALA_RULES as R, RANIWALA_PF_RULES, raniwalaBreakup } from '@/lib/raniwalaPayroll';

const muted = { color: 'var(--text-muted)' };
const EXAMPLES = [20000, 30000, 40000, 60000];

// One row per component of the structure: what it is, the rule, and who sets
// it. `ceiling` is the PF Basic ceiling of the structure shown (old / new).
const rulesFor = (ceiling) => [
  {
    name: 'Basic Pay',
    rule: `Gross salary below ${fmt(R.splitThreshold)}: ${R.belowSplit.basic}% of gross. Gross of ${fmt(R.splitThreshold)} or more: ${R.atOrAboveSplit.basic}% of gross.`,
    by: 'Automatic',
  },
  {
    name: 'HRA',
    rule: `The rest of the gross: ${R.belowSplit.hra}% below ${fmt(R.splitThreshold)}, ${R.atOrAboveSplit.hra}% from ${fmt(R.splitThreshold)}.`,
    by: 'Automatic',
  },
  {
    name: 'PF Employee (deduction)',
    rule: `${R.pfEmployeeRate}% of Basic. Once Basic is ${fmt(ceiling)} or more it is capped at ${fmt((ceiling * R.pfEmployeeRate) / 100)}.`,
    by: 'Automatic',
  },
  {
    name: 'ESIC Employee (deduction)',
    rule: `Only when Basic is below ${fmt(R.esicBasicLimit)}: ${R.esicEmployeeRate}% of Basic. Basic of ${fmt(R.esicBasicLimit)} or more: 0.`,
    by: 'Automatic',
  },
  {
    name: 'Retention (deduction)',
    rule: 'None, 5% or 10% of gross, held back only while the employee is on probation. From the month probation completes it goes back to 0 by itself.',
    by: 'HR picks the rate in Run Payroll',
  },
  {
    name: 'PF Employer (contribution)',
    rule: `${R.pfEmployerRate}% of Basic, paid by the company on top of the salary. Once Basic is ${fmt(ceiling)} or more it is capped at ${fmt((ceiling * R.pfEmployerRate) / 100)}.`,
    by: 'Automatic',
  },
  {
    name: 'ESIC Employer (contribution)',
    rule: `Only when Basic is below ${fmt(R.esicBasicLimit)}: ${R.esicEmployerRate}% of Basic, paid by the company on top of the salary. Otherwise 0.`,
    by: 'Automatic',
  },
  {
    name: 'CTC',
    rule: 'Gross salary + PF Employer + ESIC Employer: what the employee costs the company.',
    by: 'Automatic',
  },
  {
    name: 'Advance and advance balance',
    rule: 'An employee can get an advance after completing one year. HR sets how much is deducted every month; it comes off each salary until the balance is 0, and the slip shows the balance left.',
    by: 'HR, in Advances & Loans or Run Payroll',
  },
  {
    name: 'Arrear / incentive',
    rule: 'Any due, last month\'s deduction or incentive for one month, added to or deducted from pay, with a remark that prints on the slip.',
    by: 'HR, in Run Payroll',
  },
  {
    name: 'TDS',
    rule: 'A fixed amount per month for the employee, deducted every month until HR changes it.',
    by: 'HR, in Run Payroll',
  },
];

const band = (bg, color) => ({ background: bg, color, fontWeight: 700 });

/**
 * The salary breakup for one gross salary, laid out like HR's "New Structure"
 * sheet: components, deductions, payable amount, then the company's
 * contribution and the CTC — per month and per annum.
 */
function SalaryBreakup({ pfRule }) {
  const [gross, setGross] = useState(20822);
  const [retention, setRetention] = useState(5);
  const b = raniwalaBreakup(gross, retention, pfRule);
  const { month: m, annum: y } = b;

  const row = (label, percent, perMonth, perAnnum, style) => (
    <tr style={style}>
      <td>{label}</td>
      <td style={muted}>{percent}</td>
      <td style={{ textAlign: 'right' }}>{perMonth}</td>
      <td style={{ textAlign: 'right' }}>{perAnnum}</td>
    </tr>
  );
  const heading = (label, bg, color) => (
    <tr><td colSpan={4} style={band(bg, color)}>{label}</td></tr>
  );
  const bold = { fontWeight: 700 };
  const pfNote = b.pfCapped ? ', capped' : '';
  const why = [
    `Gross ${fmt(m.gross)} is ${m.gross < R.splitThreshold ? 'below' : 'at or above'} ${fmt(R.splitThreshold)}, so Basic is ${b.basicPercent}% and HRA ${b.hraPercent}%.`,
    b.pfCapped
      ? `Basic ${fmt(m.basic)} is ${fmt(b.pfCeiling)} or more, so PF is capped: ${fmt(m.pfEmployee)} from the employee, ${fmt(m.pfEmployer)} from the company.`
      : `Basic ${fmt(m.basic)} is below ${fmt(b.pfCeiling)}, so PF is ${R.pfEmployeeRate}% = ${fmt(m.pfEmployee)} from the employee and ${R.pfEmployerRate}% = ${fmt(m.pfEmployer)} from the company.`,
    b.esicApplicable
      ? `Basic ${fmt(m.basic)} is below ${fmt(R.esicBasicLimit)}, so ESIC applies: ${fmt(m.esicEmployee)} from the employee, ${fmt(m.esicEmployer)} from the company.`
      : `Basic ${fmt(m.basic)} is ${fmt(R.esicBasicLimit)} or more, so there is no ESIC for the employee or the company.`,
    `CTC is gross ${fmt(m.gross)} + PF Employer ${fmt(m.pfEmployer)} + ESIC Employer ${fmt(m.esicEmployer)} = ${fmt(m.ctc)} per month.`,
  ];

  return (
    <div className="card">
      <div className="card-header">
        <h3>Salary Breakup · {RANIWALA_PF_RULES[pfRule].period}</h3>
        <div className="subtitle">Type any gross salary to see its full structure, with the company&apos;s contribution and CTC</div>
      </div>
      <div className="card-body">
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Gross salary per month (₹)</label>
            <input className="form-input" type="number" min="0" value={gross} onChange={(e) => setGross(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Retention during probation</label>
            <select className="form-select" value={retention} onChange={(e) => setRetention(Number(e.target.value))}>
              {R.retentionOptions.map((p) => <option key={p} value={p}>{p ? `${p}% of gross` : 'None'}</option>)}
            </select>
          </div>
        </div>

        <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: 16 }}>
          <table>
            <thead>
              <tr>
                <th>Components in Salary</th>
                <th>Percentage</th>
                <th style={{ textAlign: 'right' }}>Per Month</th>
                <th style={{ textAlign: 'right' }}>Per Annum</th>
              </tr>
            </thead>
            <tbody>
              {row('Basic', `${b.basicPercent}% (of Gross Salary)`, fmt(m.basic), fmt(y.basic))}
              {row('HRA', `${b.hraPercent}% (of Gross Salary)`, fmt(m.hra), fmt(y.hra))}
              {row('Gross Salary', '', fmt(m.gross), fmt(y.gross), bold)}

              {heading('Deductions', 'var(--danger-light)', 'var(--danger)')}
              {row('PF Employee', `${R.pfEmployeeRate}% (of Basic Salary${pfNote})`, fmt(m.pfEmployee), fmt(y.pfEmployee))}
              {row('ESIC Employee', b.esicApplicable ? `${R.esicEmployeeRate}% (of Basic Salary)` : `Not applicable (Basic not below ${fmt(R.esicBasicLimit)})`, fmt(m.esicEmployee), fmt(y.esicEmployee))}
              {row('Retention', b.retentionPercent ? `${b.retentionPercent}% (of Gross Salary), probation only` : 'None', fmt(m.retention), '—')}
              {row('Payable Amount during probation', '', fmt(m.payableInProbation), '—', bold)}
              {row('Payable Amount after probation', '', fmt(m.payableAfterProbation), fmt(y.payableAfterProbation), bold)}

              {heading('Contribution (paid by the company)', 'var(--success-light)', 'var(--success)')}
              {row('PF Employer', `${R.pfEmployerRate}% (of Basic Salary${pfNote})`, fmt(m.pfEmployer), fmt(y.pfEmployer))}
              {row('ESIC Employer', b.esicApplicable ? `${R.esicEmployerRate}% (of Basic Salary)` : `Not applicable (Basic not below ${fmt(R.esicBasicLimit)})`, fmt(m.esicEmployer), fmt(y.esicEmployer))}
              {row('CTC', 'Gross + PF Employer + ESIC Employer', fmt(m.ctc), fmt(y.ctc), bold)}
            </tbody>
          </table>
        </div>

        <h4 style={{ fontSize: 13, marginBottom: 8 }}>Why these numbers</h4>
        <ol style={{ paddingLeft: 18, fontSize: 13, lineHeight: 1.6, margin: 0 }}>
          {why.map((w) => <li key={w}>{w}</li>)}
        </ol>
        <div style={{ fontSize: 11, ...muted, marginTop: 10 }}>
          For a full month. In Run Payroll the gross is first reduced to the days paid (gross × paid days ÷ days in the month), then the same rules apply.
        </div>
      </div>
    </div>
  );
}

/**
 * Raniwala's salary structure written out: the salary breakup for any gross,
 * every component's rule and worked examples. `compact` leaves out the
 * breakup (Run Payroll shows the rules next to the real figures).
 */
export default function RaniwalaStructureGuide({ compact = false }) {
  // Old = before the 17 Sep 2026 PF rule (ceiling Rs.15,000), new = from it.
  const [pfRule, setPfRule] = useState('new');
  const rule = RANIWALA_PF_RULES[pfRule];
  const RULES = rulesFor(rule.basicCeiling);
  return (
    <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        {['old', 'new'].map((k) => (
          <button key={k} type="button" className={`btn btn-sm ${pfRule === k ? 'btn-primary' : 'btn-outline'}`} onClick={() => setPfRule(k)}>
            <i className={`fas ${k === 'old' ? 'fa-history' : 'fa-check-circle'}`} /> {k === 'old' ? 'Old structure' : 'New structure'}
            <span style={{ fontSize: 11, opacity: 0.85 }}> · {RANIWALA_PF_RULES[k].period}</span>
          </button>
        ))}
        <span style={{ fontSize: 12, ...muted }}>
          {pfRule === 'old'
            ? `PF on Basic up to ${fmt(rule.basicCeiling)}: capped at ${fmt((rule.basicCeiling * R.pfEmployeeRate) / 100)} employee / ${fmt((rule.basicCeiling * R.pfEmployerRate) / 100)} employer. Everything else is the same as the new structure.`
            : `PF on Basic up to ${fmt(rule.basicCeiling)}: capped at ${fmt((rule.basicCeiling * R.pfEmployeeRate) / 100)} employee / ${fmt((rule.basicCeiling * R.pfEmployerRate) / 100)} employer. In use from 17 Sep 2026.`}
        </span>
      </div>

      {!compact && <div style={{ marginBottom: 16 }}><SalaryBreakup pfRule={pfRule} /></div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <div>
            <h3 style={{ margin: 0 }}>How Raniwala salary is worked out · {rule.label}</h3>
            <div style={{ fontSize: 12, ...muted, marginTop: 2 }}>
              Everything starts from the employee&apos;s monthly gross salary. Salary for the month = gross × paid days ÷ days in the month.
            </div>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Component</th><th>Rule</th><th>Set by</th></tr></thead>
            <tbody>
              {RULES.map((r) => (
                <tr key={r.name}>
                  <td style={{ whiteSpace: 'nowrap' }}><strong>{r.name}</strong></td>
                  <td style={{ whiteSpace: 'normal', minWidth: 320 }}>{r.rule}</td>
                  <td><span className={`badge ${r.by === 'Automatic' ? 'badge-success' : 'badge-info'}`}>{r.by}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h3>Examples for a full month</h3>
          <div className="subtitle">Before retention, advance, arrear and TDS</div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Gross salary</th><th>Basic</th><th>HRA</th>
                <th>PF Employee</th><th>ESIC Employee</th><th>Payable</th>
                <th>PF Employer</th><th>ESIC Employer</th><th>CTC</th>
              </tr>
            </thead>
            <tbody>
              {EXAMPLES.map((g) => {
                const b = raniwalaBreakup(g, 0, pfRule);
                const m = b.month;
                return (
                  <tr key={g}>
                    <td><strong>{fmt(g)}</strong></td>
                    <td>{fmt(m.basic)} <span style={{ ...muted, fontSize: 11 }}>({b.basicPercent}%)</span></td>
                    <td>{fmt(m.hra)} <span style={{ ...muted, fontSize: 11 }}>({b.hraPercent}%)</span></td>
                    <td style={{ color: 'var(--danger)' }}>-{fmt(m.pfEmployee)}{b.pfCapped ? <span style={{ ...muted, fontSize: 11 }}> capped</span> : null}</td>
                    <td style={{ color: 'var(--danger)' }}>{b.esicApplicable ? '-' + fmt(m.esicEmployee) : '—'}</td>
                    <td><strong>{fmt(m.payableAfterProbation)}</strong></td>
                    <td style={{ color: 'var(--success)' }}>+{fmt(m.pfEmployer)}</td>
                    <td style={{ color: 'var(--success)' }}>{b.esicApplicable ? '+' + fmt(m.esicEmployer) : '—'}</td>
                    <td><strong>{fmt(m.ctc)}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
