import React from 'react';
import { fmtDuration, raniwalaExtraHours, raniwalaPayableOtHours } from '@/lib/helpers';

// Raniwala: raw time past the 8h 30m day (on the employee's weekly off,
// `offDay`, every hour worked — no shift that day), plus what it earns — OT hours
// (slabbed, only for OT-ticked employees) and/or comp off credited by the
// DB for working a weekly off / holiday, or 4h+ past the shift on a normal
// day (attendance.comp_off_credit, 20261012_4).
export default function ExtraHoursCell({ totalHours, overtime, compOffCredit, offDay = false }) {
  const extra = raniwalaExtraHours(totalHours, offDay);
  const ot = overtime ? raniwalaPayableOtHours(totalHours, offDay) : 0;
  if (!extra && !compOffCredit) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {extra > 0 && <span>+{fmtDuration(extra)}</span>}
      {overtime && extra > 0 && (
        <span
          className={`badge ${ot ? 'badge-success' : 'badge-secondary'}`}
          title={ot ? `Paid as ${ot}h overtime${offDay ? ' (weekly off: every hour counts)' : ''}` : 'Under 2h extra — no overtime'}
        >
          OT {ot}h
        </span>
      )}
      {compOffCredit > 0 && (
        <span className="badge badge-purple" title="Comp off earned — a weekly off / holiday worked, or 4h+ past the shift">
          Comp Off +{compOffCredit}
        </span>
      )}
    </span>
  );
}
