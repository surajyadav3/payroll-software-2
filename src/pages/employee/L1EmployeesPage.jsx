import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Header from '@/components/Header';
import StatCard from '@/components/StatCard';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { fetchMyL1Members, fetchL1Days, fetchL1MemberMonth } from '@/services/l1Service';
import { fetchMyLeaveBalances } from '@/services/leaveLedgerService';
import { listMyLeaveRequests } from '@/services/leaveService';
import { listMyRegularizeRequests } from '@/services/attendanceService';
import { requestHalfDayLabel } from '@/lib/halfDayLeave';
import {
  fmt, fullName, getInitials, getAvatarColor, dateStr, todayStr, monthLabel, comparePunches, fmtPunchTime12,
  getTenantWeeklyOffDays, holidayForEmployee, raniwalaPayableOtHours, regularizeMinDate, isRaniwalaTenant,
} from '@/lib/helpers';
import { LeaveContent } from './MyLeavesPage';
import { RegularizeContent } from './MyRegularizeRequestsPage';

/**
 * L1 SPOC (l1Service): HR names a colleague to look after employees who
 * can't use CrewCore themselves. The L1 sees who is in today, each person's
 * attendance, balances and requests, and applies leave / regularize for them.
 * Requests still route to the employee's own manager / HOD / HR. Same screens
 * as the app's My L1 Employees.
 */

const KIND = {
  present:         { label: 'Present', badge: 'badge-success' },
  late:            { label: 'Late', badge: 'badge-warning' },
  half:            { label: 'Half Day', badge: 'badge-warning' },
  mispunch:        { label: 'Mispunch', badge: 'badge-danger' },
  absent:          { label: 'Absent', badge: 'badge-danger' },
  leave:           { label: 'On Leave', badge: 'badge-info' },
  'leave-pending': { label: 'Leave Pending', badge: 'badge-purple' },
  wfh:             { label: 'WFH', badge: 'badge-teal' },
  off:             { label: 'Weekly Off', badge: 'badge-secondary' },
  holiday:         { label: 'Holiday', badge: 'badge-secondary' },
  none:            { label: 'Not in yet', badge: 'badge-secondary' },
};

// Today's buckets on the list. Late, half and mispunch days are still "in".
const BUCKETS = [
  { key: 'in', label: 'In Today', icon: 'fa-user-check', color: 'green', kinds: ['present', 'late', 'half', 'mispunch', 'wfh'] },
  { key: 'notin', label: 'Not In', icon: 'fa-user-xmark', color: 'red', kinds: ['absent', 'none'] },
  { key: 'leave', label: 'On Leave', icon: 'fa-umbrella-beach', color: 'blue', kinds: ['leave', 'leave-pending'] },
  { key: 'off', label: 'Off / Holiday', icon: 'fa-mug-hot', color: 'purple', kinds: ['off', 'holiday'] },
];
const BUCKET_OF = Object.fromEntries(BUCKETS.flatMap((b) => b.kinds.map((k) => [k, b.key])));

// Month tiles on a member's attendance, in order.
const STAT_KINDS = ['present', 'late', 'half', 'absent', 'mispunch', 'leave', 'wfh', 'off', 'holiday'];

const STATUS_BADGE = { Pending: 'badge-warning', Approved: 'badge-success', Rejected: 'badge-danger' };

const inRange = (ds, from, to) => ds >= from && ds <= to;
const fmtDays = (n) => {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, '');
};

/** Earliest punch-in and latest punch-out of an attendance row. */
function firstInLastOut(att) {
  const punches = [...(att?.punches || [])].sort(comparePunches);
  const ins = punches.filter((p) => p.punch_type === 'in');
  const outs = punches.filter((p) => p.punch_type === 'out');
  return { inP: ins[0] || null, outP: outs[outs.length - 1] || null };
}

/** (member, 'YYYY-MM-DD') -> { kind, title, att } — same order as My Team's calendar. */
function makeDayKind(tenant, data, today) {
  const outletById = new Map(data.outlets.map((o) => [o.id, o]));
  const attByKey = new Map(data.attendance.map((a) => [`${a.profile_id}|${a.date}`, a]));
  return (m, ds) => {
    const att = attByKey.get(`${m.id}|${ds}`) || null;
    // The member's outlet holiday (company-wide ones skipped where the outlet
    // has holidays off); none before the joining date.
    const holiday = holidayForEmployee(data.holidays, ds, m, outletById.get(m.outlet_id));
    if (holiday) return { kind: 'holiday', title: holiday.name, att };
    const leave = data.leaves.find((l) => l.profile_id === m.id && inRange(ds, l.start_date, l.end_date));
    if (leave) {
      const half = requestHalfDayLabel(leave);
      return { kind: leave.status === 'Approved' ? 'leave' : 'leave-pending', title: `${leave.leave_type}${half ? ` — ${half}` : ''} (${leave.status})`, att };
    }
    if (data.wfh.some((w) => w.profile_id === m.id && inRange(ds, w.from_date, w.to_date))) return { kind: 'wfh', title: 'Work from home', att };
    const offDays = getTenantWeeklyOffDays(tenant, outletById.get(m.outlet_id), m);
    if (offDays.includes(new Date(`${ds}T00:00:00`).getDay())) return { kind: 'off', title: att ? `Weekly off (worked, ${att.status})` : 'Weekly off', att };
    if (att) {
      if (att.status === 'Late') return { kind: 'late', title: 'Late', att };
      if (att.status === 'Half Day') return { kind: 'half', title: 'Half day', att };
      if (att.status === 'Mispunch') return { kind: 'mispunch', title: 'Mispunch — only one punch recorded', att };
      if (att.status === 'Absent') return { kind: 'absent', title: 'Absent', att };
      if (att.status === 'Leave') return { kind: 'leave', title: 'Leave', att };
      return { kind: 'present', title: att.status, att };
    }
    if (ds < today && (!m.join_date || ds >= m.join_date)) return { kind: 'absent', title: 'No attendance', att };
    return { kind: 'none', title: ds === today ? 'Not punched in yet' : '', att };
  };
}

function Avatar({ person, size = 32 }) {
  return (
    <div
      className="emp-avatar"
      style={{ width: size, height: size, fontSize: size * 0.36, background: `linear-gradient(135deg, ${getAvatarColor(person.id)})` }}
    >
      {getInitials(person.first_name, person.last_name)}
    </div>
  );
}

function InOut({ att }) {
  const { inP, outP } = firstInLastOut(att);
  if (!inP && !outP) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  return (
    <span style={{ fontSize: 12.5 }}>
      {inP ? fmtPunchTime12(inP) : '—'}
      <span style={{ margin: '0 5px', color: 'var(--text-muted)' }}>→</span>
      {outP ? fmtPunchTime12(outP) : '—'}
    </span>
  );
}

const INFO_BANNER = {
  display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 16px', marginBottom: 16, borderRadius: 10,
  background: 'var(--primary-light, #eff6ff)', border: '1px solid var(--primary)', color: 'var(--primary)', fontSize: 13,
};

export default function L1EmployeesPage() {
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();
  const memberId = params.get('id');
  const [members, setMembers] = useState(null);

  useEffect(() => {
    if (!profile?.id) return;
    fetchMyL1Members(profile.id, true).then(({ data, error }) => {
      if (error) showToast('Could not load your L1 employees: ' + error.message, 'error');
      setMembers(data);
    });
  }, [profile?.id]);

  const member = memberId && members ? members.find((m) => m.id === memberId) || null : null;
  const back = () => setParams({});

  if (memberId && members && !member) {
    return (
      <>
        <Header title="My L1 Employees" breadcrumb="Employees HR has put in your care" />
        <div className="page-content">
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            This employee is not assigned to you as L1.
            <div style={{ marginTop: 14 }}><button className="btn btn-outline" onClick={back}><i className="fas fa-arrow-left" /> Back to the list</button></div>
          </div>
        </div>
      </>
    );
  }

  return member
    ? <MemberView member={member} onBack={back} />
    : <ListView members={members} onOpen={(id) => setParams({ id })} />;
}

// ── List: who is in today ─────────────────────────────────────────────────
function ListView({ members, onOpen }) {
  const { tenant } = useAuth();
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const [bucket, setBucket] = useState('');
  const today = todayStr();

  useEffect(() => {
    if (!tenant?.id || !members) return;
    fetchL1Days(tenant.id, members.map((m) => m.id), today, today).then((res) => {
      if (res.error) showToast('Some attendance data failed to load: ' + res.error.message, 'error');
      setData(res);
    });
  }, [tenant?.id, members, today]);

  const statusById = useMemo(() => {
    const out = new Map();
    if (!data || !members) return out;
    const dayKind = makeDayKind(tenant, data, today);
    members.forEach((m) => out.set(m.id, dayKind(m, today)));
    return out;
  }, [data, members, tenant, today]);

  const counts = useMemo(() => {
    const c = { in: 0, notin: 0, leave: 0, off: 0 };
    statusById.forEach((st) => { c[BUCKET_OF[st.kind]]++; });
    return c;
  }, [statusById]);

  const departments = useMemo(() => {
    const q = search.trim().toLowerCase();
    const groups = new Map();
    (members || []).forEach((m) => {
      const st = statusById.get(m.id);
      if (bucket && (!st || BUCKET_OF[st.kind] !== bucket)) return;
      if (q && !`${fullName(m)} ${m.employee_id || ''} ${m.department || ''} ${m.designation || ''}`.toLowerCase().includes(q)) return;
      const dept = m.department || 'Other';
      if (!groups.has(dept)) groups.set(dept, []);
      groups.get(dept).push(m);
    });
    return [...groups.entries()].sort(([a], [b]) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  }, [members, statusById, search, bucket]);

  return (
    <>
      <Header title="My L1 Employees" breadcrumb={members ? `${members.length} employee${members.length === 1 ? '' : 's'} HR has put in your care` : 'Employees HR has put in your care'} />
      <div className="page-content">
        {!members ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>
        ) : members.length === 0 ? (
          <div className="card" style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
            <i className="fas fa-people-group" style={{ fontSize: 28, display: 'block', marginBottom: 10, opacity: 0.5 }} />
            No employees are assigned to you as L1.
          </div>
        ) : (
          <>
            <div style={INFO_BANNER}>
              <i className="fas fa-circle-info" style={{ marginTop: 2 }} />
              <span>
                HR has made you L1 for these employees. Open someone to see their attendance and balances, or to apply
                leave / regularize for them. Requests still go to their own manager for approval.
              </span>
            </div>

            <div className="stats-row">
              {BUCKETS.map((b) => (
                <div
                  key={b.key} role="button" tabIndex={0}
                  onClick={() => setBucket(bucket === b.key ? '' : b.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter') setBucket(bucket === b.key ? '' : b.key); }}
                  style={{ cursor: 'pointer', borderRadius: 14, outline: bucket === b.key ? '2px solid var(--primary)' : 'none' }}
                  title={bucket === b.key ? 'Show everyone' : `Show only ${b.label.toLowerCase()}`}
                >
                  <StatCard icon={b.icon} iconColor={b.color} value={data ? counts[b.key] : '—'} label={b.label} />
                </div>
              ))}
            </div>

            <div className="card team-toolbar">
              <div className="team-search">
                <i className="fas fa-search" />
                <input className="form-input" placeholder="Search name, EMP code or department" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              {bucket && (
                <button className="btn btn-sm btn-outline" onClick={() => setBucket('')}>
                  <i className="fas fa-xmark" /> {BUCKETS.find((b) => b.key === bucket)?.label}
                </button>
              )}
            </div>

            <div className="card">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Employee</th><th>Designation</th><th>Manager</th><th>Today</th><th>In → Out</th><th /></tr>
                  </thead>
                  <tbody>
                    {departments.map(([dept, list]) => (
                      <React.Fragment key={dept}>
                        <tr>
                          <td colSpan={6} style={{ background: 'var(--surface-hover)', fontWeight: 700, fontSize: 12.5 }}>
                            {dept} <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>{list.length}</span>
                          </td>
                        </tr>
                        {list.map((m) => {
                          const st = statusById.get(m.id);
                          const k = KIND[st?.kind || 'none'];
                          return (
                            <tr key={m.id} onClick={() => onOpen(m.id)} style={{ cursor: 'pointer' }}>
                              <td>
                                <div className="emp-cell">
                                  <Avatar person={m} />
                                  <div>
                                    <div className="emp-name">{fullName(m)}</div>
                                    <div className="emp-role">{m.employee_id ? `EMP ${m.employee_id}` : '—'}</div>
                                  </div>
                                </div>
                              </td>
                              <td>{m.designation || '—'}</td>
                              <td>{m.manager_name || <span style={{ color: 'var(--text-muted)' }}>HR</span>}</td>
                              <td>{data ? <span className={`badge ${k.badge}`} title={st?.title}>{k.label}</span> : '…'}</td>
                              <td><InOut att={st?.att} /></td>
                              <td style={{ textAlign: 'right' }}>
                                <button className="btn btn-sm btn-outline" onClick={(e) => { e.stopPropagation(); onOpen(m.id); }}>
                                  Open <i className="fas fa-chevron-right" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    ))}
                    {departments.length === 0 && (
                      <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>No one matches this filter.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ── One member: attendance, balances, leave + regularize for them ─────────
function MemberView({ member, onBack }) {
  const { tenant } = useAuth();
  const raniwala = isRaniwalaTenant(tenant);
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [month, setMonth] = useState(null);
  const [extra, setExtra] = useState(null); // { earned, pendingLeaves, regs }
  const [tab, setTab] = useState('attendance');
  const [leaveOpenKey, setLeaveOpenKey] = useState(0);
  const [regOpenFor, setRegOpenFor] = useState(null);
  const today = todayStr();

  const loadMonth = useCallback(async () => {
    if (!tenant?.id) return;
    const res = await fetchL1MemberMonth(tenant.id, member.id, ym.y, ym.m);
    if (res.error) showToast('Some attendance data failed to load: ' + res.error.message, 'error');
    setMonth(res);
  }, [tenant?.id, member.id, ym.y, ym.m]);

  const loadExtra = useCallback(async () => {
    const [bal, leaves, regs] = await Promise.all([
      fetchMyLeaveBalances(member.id),
      listMyLeaveRequests(member.id),
      listMyRegularizeRequests(member.id),
    ]);
    const earned = bal.data.find((b) => /earned/i.test(b.leave_type?.name || ''));
    setExtra({
      earned: earned ? earned.balance : null,
      pendingLeaves: leaves.data.filter((l) => l.status === 'Pending').length,
      regs: regs.data,
    });
  }, [member.id]);

  useEffect(() => { loadMonth(); }, [loadMonth]);
  useEffect(() => { loadExtra(); }, [loadExtra]);

  // A plain tab click never reopens a form. Back on Attendance after filing
  // something: show the new pending request.
  const switchTab = (t) => {
    setLeaveOpenKey(0);
    setRegOpenFor(null);
    if (t === 'attendance' && tab !== 'attendance') { loadMonth(); loadExtra(); }
    setTab(t);
  };

  const days = useMemo(() => {
    const out = [];
    for (let d = new Date(ym.y, ym.m, 1); d.getMonth() === ym.m; d.setDate(d.getDate() + 1)) out.push(dateStr(d));
    return out;
  }, [ym.y, ym.m]);

  const cells = useMemo(() => {
    if (!month) return [];
    const dayKind = makeDayKind(tenant, month, today);
    return days.map((ds) => ({ ds, ...dayKind(member, ds) }));
  }, [month, days, member, tenant, today]);

  const stats = useMemo(() => {
    const c = {};
    cells.forEach((cell) => { if (cell.ds <= today) c[cell.kind] = (c[cell.kind] || 0) + 1; });
    return c;
  }, [cells, today]);

  // Raniwala OT for the month, per-day slabs (only for overtime staff).
  const otHours = useMemo(() => {
    if (!raniwala || !member.overtime_applicable || !month) return null;
    const outlet = month.outlets.find((o) => o.id === member.outlet_id);
    const offDays = getTenantWeeklyOffDays(tenant, outlet, member);
    return month.attendance.reduce((sum, a) =>
      sum + raniwalaPayableOtHours(a.total_hours, offDays.includes(new Date(`${a.date}T00:00:00`).getDay())), 0);
  }, [raniwala, member, month, tenant]);

  const minRegDate = regularizeMinDate(tenant);
  const regOn = (ds) => (extra?.regs || []).find((r) => r.date === ds && (r.status === 'Pending' || r.status === 'Approved'));
  const pendingRegs = (extra?.regs || []).filter((r) => r.status === 'Pending').length;

  const openRegularize = (ds, att) => {
    const { inP, outP } = firstInLastOut(att);
    setRegOpenFor({ date: ds, clockInTime: inP?.punch_time?.slice(0, 5) || '', clockOutTime: outP?.punch_time?.slice(0, 5) || '' });
    setTab('regularize');
  };
  const openLeave = () => { setTab('leave'); setLeaveOpenKey((k) => k + 1); };

  const shiftMonth = (delta) => setYm(({ y, m }) => {
    const d = new Date(y, m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const phone = member.phone ? String(member.phone).replace(/\D/g, '').slice(-10) : '';
  const info = [
    ['EMP Code', member.employee_id],
    ['Designation', member.designation],
    ['Department', member.department],
    ['Location', member.outlet_location],
    ['Joined', member.join_date ? fmt.date(member.join_date) : null],
    ['Phone', phone ? <a href={`tel:${phone}`}>{phone}</a> : null],
    ['Manager', member.manager_name],
    ['HOD', member.hod_name],
  ];

  return (
    <>
      <Header
        title={fullName(member)}
        breadcrumb={<><Link to="/l1-employees" onClick={(e) => { e.preventDefault(); onBack(); }}>My L1 Employees</Link> / {fullName(member)}</>}
        actions={(
          <div className="flex gap-1">
            <button className="btn btn-outline" onClick={onBack}><i className="fas fa-arrow-left" /> All employees</button>
            <button className="btn btn-primary" onClick={openLeave}><i className="fas fa-calendar-plus" /> Apply Leave</button>
            <button className="btn btn-outline" onClick={() => openRegularize(today, cells.find((c) => c.ds === today)?.att)}>
              <i className="fas fa-pen" /> Regularize
            </button>
          </div>
        )}
      />
      <div className="page-content">
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div className="emp-cell" style={{ marginBottom: 14 }}>
            <Avatar person={member} size={44} />
            <div>
              <div className="emp-name" style={{ fontSize: 15 }}>{fullName(member)}</div>
              <div className="emp-role">You are this employee's L1 — you can apply leave and regularize for them.</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px 16px' }}>
            {info.map(([label, value]) => (
              <div key={label} style={{ minWidth: 0 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value || '—'}</div>
              </div>
            ))}
          </div>
          <div className="form-hint" style={{ marginTop: 12 }}>
            <i className="fas fa-info-circle" style={{ marginRight: 4 }} />
            Requests you send go to {member.manager_name || 'HR'} for approval, as if {member.first_name} sent them. You'll get a notification when they're decided.
          </div>
        </div>

        <div className="stats-row">
          <StatCard icon="fa-umbrella-beach" iconColor="green" value={extra?.earned == null ? '—' : `${fmtDays(extra.earned)} days`} label="Earned Leave Balance" />
          <StatCard icon="fa-gift" iconColor="purple" value={`${fmtDays(member.comp_off_balance)} days`} label="Comp Off Balance" />
          <StatCard
            icon="fa-business-time" iconColor="orange"
            value={otHours == null ? '—' : `${otHours}h`}
            label={otHours == null ? 'No overtime' : `Overtime ${monthLabel(ym.m, ym.y)}`}
          />
          <StatCard icon="fa-hourglass-half" iconColor="blue" value={extra ? extra.pendingLeaves + pendingRegs : '—'} label="Pending Requests" />
        </div>

        <div className="tabs">
          {[['attendance', 'Attendance'], ['leave', 'Leave'], ['regularize', 'Regularize']].map(([k, label]) => (
            <button key={k} className={`tab-btn ${tab === k ? 'active' : ''}`} onClick={() => switchTab(k)}>{label}</button>
          ))}
        </div>

        {tab === 'leave' && <LeaveContent member={member} openKey={leaveOpenKey} />}
        {tab === 'regularize' && <RegularizeContent member={member} openFor={regOpenFor} />}

        {tab === 'attendance' && (
          <div className="card">
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <h3 style={{ margin: 0 }}>Attendance</h3>
                <div className="subtitle">Pick a day to regularize it ({tenant?.regularize_current_month ? 'this month' : 'inside the regularize window'})</div>
              </div>
              <div className="team-month-nav">
                <button className="btn btn-sm btn-outline" onClick={() => shiftMonth(-1)} aria-label="Previous month"><i className="fas fa-chevron-left" /></button>
                <span>{monthLabel(ym.m, ym.y)}</span>
                <button className="btn btn-sm btn-outline" onClick={() => shiftMonth(1)} aria-label="Next month"><i className="fas fa-chevron-right" /></button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--border-light)' }}>
              {STAT_KINDS.map((k) => (
                <span key={k} className={`badge ${KIND[k].badge}`} style={{ fontSize: 11.5 }}>
                  {KIND[k].label}: <strong style={{ marginLeft: 3 }}>{stats[k] || 0}</strong>
                </span>
              ))}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Date</th><th>Status</th><th>In → Out</th><th>Hours</th><th /></tr>
                </thead>
                <tbody>
                  {!month ? (
                    <tr><td colSpan={5} style={{ textAlign: 'center', padding: 40 }}><div className="spinner" /></td></tr>
                  ) : cells.map((cell) => {
                    const future = cell.ds > today;
                    const reg = regOn(cell.ds);
                    const canReg = !future && cell.ds >= minRegDate && !reg;
                    return (
                      <tr key={cell.ds} style={cell.ds === today ? { background: 'var(--primary-light, #eff6ff)' } : undefined}>
                        <td style={{ whiteSpace: 'nowrap', fontWeight: cell.ds === today ? 700 : 500 }}>
                          {new Date(`${cell.ds}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}
                        </td>
                        <td>
                          {cell.kind === 'none' && cell.ds !== today ? <span style={{ color: 'var(--text-muted)' }}>—</span> : (
                            <span className={`badge ${KIND[cell.kind].badge}`} title={cell.title}>{KIND[cell.kind].label}</span>
                          )}
                          {cell.title && !['present', 'none', 'absent', 'late', 'off'].includes(cell.kind) && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{cell.title}</div>
                          )}
                        </td>
                        <td><InOut att={cell.att} /></td>
                        <td>{cell.att?.total_hours ? `${Number(cell.att.total_hours).toFixed(1)}h` : '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          {reg ? (
                            <span className={`badge ${STATUS_BADGE[reg.status]}`}>Regularize {reg.status.toLowerCase()}</span>
                          ) : canReg ? (
                            <button className="btn btn-sm btn-outline" onClick={() => openRegularize(cell.ds, cell.att)}>
                              <i className="fas fa-pen" /> Regularize
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
