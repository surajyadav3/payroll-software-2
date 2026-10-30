import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fullName } from '@/lib/helpers';
import { fmtYmd } from '@/lib/raniwalaPayroll';

const muted = { color: 'var(--text-muted)' };

/**
 * Raniwala Run Payroll: everyone in this month's run whose record would make
 * the pay come out wrong, before HR processes it. Each line says what the
 * payroll does with it today. `gaps` comes from raniwalaSetupGaps().
 */
export default function RaniwalaSetupCheck({ gaps }) {
  const [open, setOpen] = useState(false);
  const groups = gaps.filter((g) => g.items.length);
  if (!groups.length) return null;
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className="card" style={{ marginBottom: 16, borderColor: 'var(--warning)' }}>
      <div style={{ padding: '12px 20px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
        <i className="fas fa-clipboard-check" style={{ color: 'var(--warning)' }} />
        <span style={{ flex: 1 }}>
          <strong>Setup check:</strong> {groups.map((g) => `${g.items.length} ${g.short}`).join(' · ')}. Fix these before processing.
        </span>
        <span style={muted}>{open ? 'Hide' : `Show ${total}`} <i className={`fas fa-chevron-${open ? 'up' : 'down'}`} /></span>
      </div>
      {open && (
        <div style={{ padding: '0 20px 14px', fontSize: 12 }}>
          {groups.map((g) => (
            <div key={g.key} style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 600 }}>{g.title}</div>
              <div style={{ ...muted, marginBottom: 4 }}>{g.effect}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {g.items.map((it) => (it.emp
                  ? <Link key={it.key} to={`/employees?edit=${it.emp.id}`} className="badge badge-warning" title="Open the employee">{it.emp.employee_id ? `${it.emp.employee_id} · ` : ''}{fullName(it.emp)}{it.note ? ` (${it.note})` : ''}</Link>
                  : <Link key={it.key} to={`/employees?newEssl=${encodeURIComponent(it.code)}`} className="badge badge-warning" title="Add as a new employee">{it.code}{it.name && it.name !== it.code ? ` · ${it.name}` : ''} (last {fmtYmd(it.lastDate)})</Link>))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The setup gaps for a Raniwala payroll month. `employees` are the run's
 * (with salaries merged: ctc = monthly gross), `attendance` the month's
 * rows, `esslCodes` from listEsslCodes() (null while loading / no access).
 */
export function raniwalaSetupGaps({ employees, attendance, esslCodes, monthStart, monthEnd, today }) {
  // HR's own logins (no EMP code, role admin) are not staff to be paid.
  const staff = employees.filter((e) => !(e.role === 'admin' && !e.employee_id));
  const withAtt = new Set(attendance.map((a) => a.profile_id));
  const started = monthStart <= today;
  const inMonth = (e) => (!e.join_date || e.join_date <= monthEnd) && (!e.exit_date || e.exit_date >= monthStart);
  const item = (emp, note = '') => ({ key: emp.id, emp, note });
  return [
    {
      key: 'salary', short: 'no salary', title: 'No monthly gross salary',
      effect: 'Paid ₹0. Set the gross (and CTC) on the employee form.',
      items: staff.filter((e) => inMonth(e) && !(Number(e.ctc) > 0)).map((e) => item(e)),
    },
    {
      key: 'join', short: 'no join date', title: 'No joining date',
      effect: 'Paid from the 1st, and their leave credit does not start. Set the joining date.',
      items: staff.filter((e) => !e.join_date).map((e) => item(e)),
    },
    {
      key: 'outlet', short: 'no outlet', title: 'No outlet',
      effect: 'Weekly off, holidays and shift times fall back to company defaults. Transfer them to their outlet.',
      items: staff.filter((e) => !e.outlet_id).map((e) => item(e)),
    },
    {
      key: 'essl', short: 'no ESSL code', title: 'No ESSL machine code',
      effect: 'Machine punches never reach them; only app punches count. Set the EMP code (it is the ESSL code).',
      items: staff.filter((e) => inMonth(e) && !e.essl_employee_code).map((e) => item(e)),
    },
    {
      key: 'att', short: 'no attendance', title: 'No attendance this month',
      effect: 'Paid the full month (from the joining date) as if attendance is not tracked for them. If they should be punching, check their ESSL code and the machine.',
      items: started ? staff.filter((e) => inMonth(e) && !withAtt.has(e.id) && !(e.join_date && e.join_date > today)).map((e) => item(e)) : [],
    },
    {
      key: 'unlinked', short: 'machine codes with no employee', title: 'Machine codes punching with no employee',
      effect: 'Someone is scanning on the ESSL machine but is not in CrewCore, so they have no attendance and no pay. Add them (click a code) or tell IT to remove the code.',
      items: (esslCodes || [])
        .filter((c) => !c.profile && c.stats?.last_date >= monthStart && c.stats?.first_date <= monthEnd)
        .map((c) => ({ key: c.code, code: c.code, name: c.machine?.name || '', lastDate: c.stats.last_date })),
    },
  ];
}
