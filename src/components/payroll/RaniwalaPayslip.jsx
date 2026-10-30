import { RANIWALA_SLIP_CSS, raniwalaSlipInnerHtml } from '@/lib/raniwalaPayslipHtml';

/**
 * Raniwala's payslip: employee code, paid days and every component of the
 * salary structure — full-month Actual beside what was Earned — read from
 * breakdown.raniwala as it was frozen when payroll was processed. The markup
 * is the printed slip's own (lib/raniwalaPayslipHtml, every value escaped).
 * `ctc` is the employee's filled CTC (employee_salaries.ctc), shown in a
 * month paid in parts; `leave` the leave balance on the month's last day
 * (fetchLeaveBalancesAsOf). `mask` hides the amounts (My Payslips, until revealed).
 */
export default function RaniwalaPayslip({ slip, breakdown, ctc = null, leave = null, companyName, monthText, mask = false, action = null }) {
  return (
    <div className="rw-wrap">
      <style>{RANIWALA_SLIP_CSS}</style>
      {action && <div className="rw-tools">{action}</div>}
      <div
        className="rw-slip"
        dangerouslySetInnerHTML={{ __html: raniwalaSlipInnerHtml({ slip, breakdown, ctc, leave, companyName, monthText, mask }) }}
      />
    </div>
  );
}
