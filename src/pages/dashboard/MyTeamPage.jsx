import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Header from '@/components/Header';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { fetchTeamMonth, findAncestorWithRole } from '@/services/teamService';
import { requestHalfDayLabel } from '@/lib/halfDayLeave';
import {
  fullName, getInitials, getAvatarColor, dateStr, monthLabel, getTenantWeeklyOffDays, holidayForEmployee,
} from '@/lib/helpers';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Calendar cell kinds, in legend order. A normal worked day is a plain
// number — only exceptions get colour.
const LEGEND = [
  { kind: 'leave', label: 'On leave' },
  { kind: 'leave-pending', label: 'Leave awaiting approval' },
  { kind: 'wfh', label: 'Work from home' },
  { kind: 'late', label: 'Late' },
  { kind: 'half', label: 'Half day' },
  { kind: 'absent', label: 'Absent / no attendance' },
  { kind: 'mispunch', label: 'Mispunch (single punch)' },
  { kind: 'off', label: 'Weekly off' },
  { kind: 'holiday', label: 'Holiday' },
];

// Team Stats columns: per-employee day counts for the month shown in the
// calendar (same kinds/colours). Leave balance is deliberately not shown.
const STAT_COLUMNS = [
  { kind: 'present', label: 'Present' },
  { kind: 'late', label: 'Late' },
  { kind: 'half', label: 'Half Day' },
  { kind: 'absent', label: 'Absent' },
  { kind: 'mispunch', label: 'Mispunch' },
  { kind: 'wfh', label: 'WFH' },
  { kind: 'leave', label: 'On Leave' },
  { kind: 'leave-pending', label: 'Leave Pending' },
  { kind: 'off', label: 'Weekly Off' },
  { kind: 'holiday', label: 'Holiday' },
];

// Day kinds drawn as a plain date number; every other kind gets a mark.
const UNMARKED = new Set(['present', 'none']);

const NO_DEPARTMENT = 'Other';

const inRange = (ds, from, to) => ds >= from && ds <= to;

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

function MembersTable({ members, leaderIds, reportsToName, detailById }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>Employee</th><th>Designation</th><th>Department</th><th>Reports To</th><th>Location</th><th>Phone</th></tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>
                <div className="emp-cell">
                  <Avatar person={m} />
                  <div>
                    <div className="emp-name">
                      {fullName(m)}
                      {leaderIds.has(m.id) && <span className="badge badge-info" style={{ marginLeft: 6, fontSize: 10 }}>Manager</span>}
                    </div>
                    <div className="emp-role">{m.employee_id ? `EMP ${m.employee_id}` : '—'}</div>
                  </div>
                </div>
              </td>
              <td>{m.designation || '—'}</td>
              <td>{m.department || '—'}</td>
              <td>{reportsToName(m)}</td>
              <td>{m.outlet_location || '—'}</td>
              <td>{detailById.get(m.id)?.phone || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MyTeamPage() {
  const { tenant, profile } = useAuth();
  const now = new Date();
  const [ym, setYm] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [collapsed, setCollapsed] = useState({}); // department -> true when its member list is folded

  const load = useCallback(async () => {
    if (!tenant?.id || !profile?.id) return;
    setLoading(true);
    const res = await fetchTeamMonth(tenant.id, profile.id, ym.y, ym.m);
    if (res.error) showToast('Some team data failed to load: ' + res.error.message, 'error');
    setData(res);
    setLoading(false);
  }, [tenant?.id, profile?.id, ym.y, ym.m]);

  useEffect(() => { load(); }, [load]);

  const today = dateStr(new Date());
  const monthDays = useMemo(() => {
    const out = [];
    for (let d = new Date(ym.y, ym.m, 1); d.getMonth() === ym.m; d.setDate(d.getDate() + 1)) out.push(new Date(d));
    return out;
  }, [ym.y, ym.m]);

  const team = data?.team || [];
  const byId = useMemo(() => new Map((data?.directory || []).map((p) => [p.id, p])), [data]);

  // Anyone in the team others report to (plus manager/HOD roles) is a "manager" here.
  const leaderIds = useMemo(() => {
    const ids = new Set(team.filter((m) => m.role === 'manager' || m.role === 'hod').map((m) => m.id));
    team.forEach((m) => { if (m.manager_id && m.manager_id !== profile?.id) ids.add(m.manager_id); });
    return ids;
  }, [team, profile?.id]);

  // Department -> members, managers first then by name. Filtered by search/department.
  const departments = useMemo(() => {
    const q = search.trim().toLowerCase();
    const groups = new Map();
    team.forEach((m) => {
      const dept = m.department || NO_DEPARTMENT;
      if (deptFilter && dept !== deptFilter) return;
      if (q && !`${fullName(m)} ${m.employee_id || ''} ${m.designation || ''}`.toLowerCase().includes(q)) return;
      if (!groups.has(dept)) groups.set(dept, []);
      groups.get(dept).push(m);
    });
    return [...groups.entries()]
      .map(([name, members]) => ({
        name,
        members: members.sort((a, b) => (leaderIds.has(b.id) - leaderIds.has(a.id)) || fullName(a).localeCompare(fullName(b))),
        managers: members.filter((m) => leaderIds.has(m.id)),
      }))
      .sort((a, b) => (a.name === NO_DEPARTMENT) - (b.name === NO_DEPARTMENT) || a.name.localeCompare(b.name));
  }, [team, search, deptFilter, leaderIds]);

  // HOD view of Team Members: one section per manager reporting directly to
  // the HOD, listing everyone under that manager (any depth). Search and the
  // department filter apply to the employees listed.
  const managerGroups = useMemo(() => {
    if (profile?.role !== 'hod') return [];
    const q = search.trim().toLowerCase();
    const matches = (m) => (!deptFilter || (m.department || NO_DEPARTMENT) === deptFilter)
      && (!q || `${fullName(m)} ${m.employee_id || ''} ${m.designation || ''}`.toLowerCase().includes(q));
    const byManager = new Map();
    team.forEach((m) => {
      if (!byManager.has(m.manager_id)) byManager.set(m.manager_id, []);
      byManager.get(m.manager_id).push(m);
    });
    const subtree = (rootId) => {
      const out = [];
      const queue = [...(byManager.get(rootId) || [])];
      while (queue.length) {
        const p = queue.shift();
        out.push(p);
        queue.push(...(byManager.get(p.id) || []));
      }
      return out;
    };
    return team
      .filter((m) => m.manager_id === profile.id && (byManager.get(m.id) || []).length > 0)
      .map((mgr) => ({ manager: mgr, members: subtree(mgr.id).filter(matches) }))
      .filter((g) => matches(g.manager) || g.members.length > 0)
      .sort((a, b) => fullName(a.manager).localeCompare(fullName(b.manager)));
  }, [team, profile?.id, profile?.role, search, deptFilter]);

  const allDepartmentNames = useMemo(
    () => [...new Set(team.map((m) => m.department || NO_DEPARTMENT))].sort(),
    [team],
  );

  const dayKind = useMemo(() => {
    if (!data) return () => ({ kind: 'none', title: '' });
    const { details, attendance, leaves, wfh, holidays, outlets } = data;
    const detailById = new Map(details.map((d) => [d.id, d]));
    const outletById = new Map(outlets.map((o) => [o.id, o]));
    const attByKey = new Map(attendance.map((a) => [`${a.profile_id}|${a.date}`, a]));

    return (m, d) => {
      const ds = dateStr(d);
      // The member's outlet holiday (company-wide ones skipped where the outlet
      // has holidays off); none before the joining date.
      const holiday = holidayForEmployee(holidays, ds,
        { outlet_id: m.outlet_id, join_date: detailById.get(m.id)?.join_date }, outletById.get(m.outlet_id));
      if (holiday) return { kind: 'holiday', title: holiday.name };
      const leave = leaves.find((l) => l.profile_id === m.id && inRange(ds, l.start_date, l.end_date));
      if (leave) {
        const half = requestHalfDayLabel(leave);
        return { kind: leave.status === 'Approved' ? 'leave' : 'leave-pending', title: `${leave.leave_type}${half ? ` — ${half}` : ''} (${leave.status})` };
      }
      if (wfh.some((w) => w.profile_id === m.id && inRange(ds, w.from_date, w.to_date))) return { kind: 'wfh', title: 'Work from home' };
      if (getTenantWeeklyOffDays(tenant, outletById.get(m.outlet_id), detailById.get(m.id)).includes(d.getDay())) return { kind: 'off', title: 'Weekly off' };
      const att = attByKey.get(`${m.id}|${ds}`);
      if (att) {
        if (att.status === 'Late') return { kind: 'late', title: 'Late' };
        if (att.status === 'Half Day') return { kind: 'half', title: 'Half day' };
        if (att.status === 'Mispunch') return { kind: 'mispunch', title: 'Mispunch — only one punch recorded' };
        if (att.status === 'Absent') return { kind: 'absent', title: 'Absent' };
        if (att.status === 'Leave') return { kind: 'leave', title: 'Leave' };
        return { kind: 'present', title: att.status };
      }
      const joined = detailById.get(m.id)?.join_date;
      if (ds < today && (!joined || ds >= joined)) return { kind: 'absent', title: 'No attendance' };
      return { kind: 'none', title: '' };
    };
  }, [data, tenant, today]);

  const detailById = useMemo(() => new Map((data?.details || []).map((d) => [d.id, d])), [data]);

  // Per-employee counts of each day kind across the calendar month. Late and
  // half days are worked days too, so "Present" counts only on-time days.
  const statsById = useMemo(() => {
    const out = new Map();
    team.forEach((m) => {
      const counts = {};
      monthDays.forEach((d) => {
        const { kind } = dayKind(m, d);
        counts[kind] = (counts[kind] || 0) + 1;
      });
      out.set(m.id, counts);
    });
    return out;
  }, [team, monthDays, dayKind]);

  const isHod = profile?.role === 'hod' || profile?.role === 'management';
  const hod = data && !isHod ? findAncestorWithRole(data.directory, profile?.id, 'hod') : null;
  const myManager = data ? byId.get(profile?.manager_id) : null;
  const breadcrumb = isHod
    ? 'Your department — managers under you and their teams'
    : [
      `HOD: ${hod ? fullName(hod) : 'Not assigned'}`,
      myManager && myManager.id !== hod?.id ? `Reports to: ${fullName(myManager)}` : null,
    ].filter(Boolean).join('  ·  ');

  const shiftMonth = (delta) => setYm(({ y, m }) => {
    const d = new Date(y, m + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const reportsToName = (m) => (m.manager_id === profile?.id ? 'You' : byId.get(m.manager_id) ? fullName(byId.get(m.manager_id)) : '—');

  return (
    <>
      <Header title="My Team" breadcrumb={breadcrumb} />
      <div className="page-content">
        {loading && !data ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading your team…</div>
        ) : team.length === 0 ? (
          <div className="card" style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
            <i className="fas fa-users" style={{ fontSize: 28, display: 'block', marginBottom: 10, opacity: 0.5 }} />
            No one reports to you yet. HR sets reporting managers on each employee's profile.
          </div>
        ) : (
          <>
            {/* ── Filters ─────────────────────────────────────────────── */}
            <div className="card team-toolbar">
              <div className="team-search">
                <i className="fas fa-search" />
                <input
                  className="form-input"
                  placeholder="Search by name, code or designation"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {allDepartmentNames.length > 1 && (
                <select className="form-select" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} style={{ maxWidth: 240 }}>
                  <option value="">All departments</option>
                  {allDepartmentNames.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              )}
            </div>

            {/* ── Team calendar ───────────────────────────────────────── */}
            <div className="card">
              <div className="card-header">
                <div>
                  <h3>Team Calendar</h3>
                  <div className="subtitle">Who's in, off or on leave each day — plan work around upcoming leave</div>
                </div>
                <div className="team-month-nav">
                  <button className="btn btn-sm btn-outline" onClick={() => shiftMonth(-1)} aria-label="Previous month"><i className="fas fa-chevron-left" /></button>
                  <span>{monthLabel(ym.m, ym.y)}</span>
                  <button className="btn btn-sm btn-outline" onClick={() => shiftMonth(1)} aria-label="Next month"><i className="fas fa-chevron-right" /></button>
                </div>
              </div>
              <div className="table-wrap">
                <table className="team-cal">
                  <thead>
                    <tr className="team-cal-wd-row">
                      <th className="team-cal-name">Employee</th>
                      {monthDays.map((d, i) => (
                        <th key={i} className={`${dateStr(d) === today ? 'is-today' : ''} ${d.getDay() === 0 ? 'is-sunday' : ''}`}>
                          {WEEKDAY[d.getDay()].slice(0, 2)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {departments.map((dept) => (
                      <React.Fragment key={dept.name}>
                        <tr className="team-cal-group">
                          <td className="team-cal-name">
                            {dept.name} <span>{dept.members.length}</span>
                          </td>
                          <td colSpan={monthDays.length} />
                        </tr>
                        {dept.members.map((m) => (
                          <tr key={m.id}>
                            <td className="team-cal-name">
                              <div className="emp-cell">
                                <Avatar person={m} size={28} />
                                <div style={{ minWidth: 0 }}>
                                  <div className="emp-name team-ellipsis">
                                    {fullName(m)}
                                    {leaderIds.has(m.id) && <i className="fas fa-user-tie team-mgr-icon" title="Manager" />}
                                  </div>
                                  <div className="emp-role team-ellipsis">{m.designation || m.employee_id || ''}</div>
                                </div>
                              </div>
                            </td>
                            {(() => {
                              const days = monthDays.map((d) => dayKind(m, d));
                              return monthDays.map((d, i) => {
                                const { kind, title } = days[i];
                                const marked = !UNMARKED.has(kind);
                                const runL = marked && days[i - 1]?.kind === kind;
                                const runR = marked && days[i + 1]?.kind === kind;
                                const numClass = !marked ? '' : runL && runR ? 'is-mid' : 'is-mark';
                                return (
                                  <td
                                    key={i}
                                    className={`team-cal-cell k-${kind}${runL ? ' run-l' : ''}${runR ? ' run-r' : ''}${dateStr(d) === today ? ' is-today' : ''}`}
                                    title={title}
                                  >
                                    <span className={`team-cal-num ${numClass}`}>{d.getDate()}</span>
                                  </td>
                                );
                              });
                            })()}
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                    {departments.length === 0 && (
                      <tr><td colSpan={monthDays.length + 1} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>No one matches your search.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="team-cal-legend">
                {LEGEND.map((l) => (
                  <span key={l.kind}><span className={`team-cal-swatch k-${l.kind}`} />{l.label}</span>
                ))}
              </div>
            </div>

            {/* ── Team stats: employee-wise, same rows as the calendar ─── */}
            <div className="card">
              <div className="card-header">
                <div>
                  <h3>Team Stats</h3>
                  <div className="subtitle">Day counts per employee for {monthLabel(ym.m, ym.y)}</div>
                </div>
              </div>
              <div className="table-wrap">
                <table className="team-cal team-stats">
                  <thead>
                    <tr>
                      <th className="team-cal-name">Employee</th>
                      {STAT_COLUMNS.map((c) => (
                        <th key={c.kind}><span className={`team-cal-swatch k-${c.kind}`} />{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {departments.map((dept) => (
                      <React.Fragment key={dept.name}>
                        <tr className="team-cal-group">
                          <td className="team-cal-name">
                            {dept.name} <span>{dept.members.length}</span>
                          </td>
                          <td colSpan={STAT_COLUMNS.length} />
                        </tr>
                        {dept.members.map((m) => {
                          const counts = statsById.get(m.id) || {};
                          return (
                            <tr key={m.id}>
                              <td className="team-cal-name">
                                <div className="emp-cell">
                                  <Avatar person={m} size={28} />
                                  <div style={{ minWidth: 0 }}>
                                    <div className="emp-name team-ellipsis">
                                      {fullName(m)}
                                      {leaderIds.has(m.id) && <i className="fas fa-user-tie team-mgr-icon" title="Manager" />}
                                    </div>
                                    <div className="emp-role team-ellipsis">{m.designation || m.employee_id || ''}</div>
                                  </div>
                                </div>
                              </td>
                              {STAT_COLUMNS.map((c) => {
                                const n = counts[c.kind] || 0;
                                return <td key={c.kind} className={n ? 'is-count' : 'is-zero'}>{n || '–'}</td>;
                              })}
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    ))}
                    {departments.length === 0 && (
                      <tr><td colSpan={STAT_COLUMNS.length + 1} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>No one matches your search.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Members: HOD by manager, manager by department ───────── */}
            <h3 className="team-section-title">Team Members</h3>
            {isHod ? (
              managerGroups.length === 0 ? (
                <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
                  {search || deptFilter ? 'No one matches your search.' : 'No managers report to you yet.'}
                </div>
              ) : managerGroups.map(({ manager, members }) => {
                const open = !collapsed[manager.id];
                return (
                  <div key={manager.id} className="card team-dept">
                    <button
                      type="button"
                      className="team-dept-head"
                      onClick={() => setCollapsed((c) => ({ ...c, [manager.id]: open }))}
                      aria-expanded={open}
                    >
                      <Avatar person={manager} size={38} />
                      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <div className="team-dept-name">
                          {fullName(manager)}
                          <span className="badge badge-info" style={{ marginLeft: 8, fontSize: 10 }}>Manager</span>
                        </div>
                        <div className="team-dept-meta">
                          {[manager.designation, manager.department].filter(Boolean).join(' · ')}
                          {' · '}{members.length} team member{members.length === 1 ? '' : 's'}
                        </div>
                      </div>
                      <i className={`fas fa-chevron-down team-dept-caret ${open ? 'open' : ''}`} />
                    </button>
                    {open && (members.length > 0
                      ? <MembersTable members={members} leaderIds={leaderIds} reportsToName={reportsToName} detailById={detailById} />
                      : <div style={{ padding: '14px 20px', fontSize: 13, color: 'var(--text-muted)', borderTop: '1px solid var(--border-light)' }}>No team members match.</div>)}
                  </div>
                );
              })
            ) : departments.map((dept) => {
              const open = !collapsed[dept.name];
              return (
                <div key={dept.name} className="card team-dept">
                  <button
                    type="button"
                    className="team-dept-head"
                    onClick={() => setCollapsed((c) => ({ ...c, [dept.name]: open }))}
                    aria-expanded={open}
                  >
                    <div className="team-dept-icon"><i className="fas fa-sitemap" /></div>
                    <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                      <div className="team-dept-name">{dept.name}</div>
                      <div className="team-dept-meta">
                        {dept.members.length} member{dept.members.length === 1 ? '' : 's'}
                        {dept.managers.length > 0 && <> · Managers: {dept.managers.map((m) => fullName(m)).join(', ')}</>}
                      </div>
                    </div>
                    <i className={`fas fa-chevron-down team-dept-caret ${open ? 'open' : ''}`} />
                  </button>
                  {open && <MembersTable members={dept.members} leaderIds={leaderIds} reportsToName={reportsToName} detailById={detailById} />}
                </div>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}
