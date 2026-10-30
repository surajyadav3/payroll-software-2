import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/context/FeatureContext';
import { useOutletView } from '@/context/OutletViewContext';
import { showToast } from '@/components/Toast';
import { usePunchClock } from '@/hooks/usePunchClock';
import { useTodayDate } from '@/hooks/useTodayDate';
import {
  KINDS, listAnnouncements, listMyAcknowledgements, acknowledgeAnnouncement,
  readSeenAnnouncements, markAnnouncementsSeen,
} from '@/services/announcementService';
import { listPolicies, listMyAcknowledgements as listMyPolicyAcks } from '@/services/policyService';
import { listHolidays } from '@/services/tenantService';
import { listCelebrations } from '@/services/profileDetailsService';
import {
  fetchMyRecentDays, fetchOpenLeaveQueue, leavesWaitingFor, countMyPendingRequests,
  fetchMyPeople, fetchStatusToday, fetchOutToday,
} from '@/services/homeService';
import { fullName, getInitials, getAvatarColor, fmtTime12, isRaniwalaTenant, isHrSupport, dateStr } from '@/lib/helpers';
import './HomeDashboard.css';

const RECENT_POLICY_DAYS = 30;
const RANIWALA_HR_CELEBRATION_DAYS = 5;
const OUT_CHIPS = 14;

/**
 * Home: a welcome banner with what needs attention, today's work (clock in,
 * my week, my team / the company), then company updates (announcements,
 * policies, holidays, celebrations). Every section adapts to the person —
 * employee, manager, HOD, management or HR — and switched-off services step aside.
 */
export default function HomeDashboard() {
  const { profile, tenant } = useAuth();
  const { isEnabled } = useFeatures();
  const { needsSelection, outletProfileIds } = useOutletView();
  const role = profile?.role || 'employee';
  const isHr = role === 'admin' || role === 'superadmin';
  const leadsPeople = isHr || ['manager', 'hod', 'management'].includes(role);
  const comms = useComms({ tenant, profile, isEnabled });
  const people = useMyPeople({ tenant, profile, enabled: leadsPeople, outletProfileIds: isHr ? outletProfileIds : null });

  if (isHr && needsSelection) return <Navigate to="/outlets" replace />;
  if (!profile || !tenant) return null;

  return (
    <div className="page-content hd">
      <Welcome profile={profile} tenant={tenant} role={role} isHr={isHr} leadsPeople={leadsPeople} people={people} outletProfileIds={isHr ? outletProfileIds : null} comms={comms} isEnabled={isEnabled} />

      <div className="hd-grid">
        <div className="hd-col hd-col-4">
          {isEnabled('attendance') && <PunchCard profile={profile} tenant={tenant} />}
          <QuickActions role={role} isHr={isHr} hrSupport={isHrSupport(profile)} isEnabled={isEnabled} raniwala={isRaniwalaTenant(tenant)} />
        </div>
        <div className="hd-col hd-col-8">
          {isEnabled('attendance') && <MyWeek profile={profile} />}
          {leadsPeople && <PeopleToday people={people} isHr={isHr} isEnabled={isEnabled} />}
        </div>
      </div>

      <SectionTitle icon="fa-bullhorn" title="Company updates" />
      <div className="hd-grid">
        <div className="hd-col hd-col-7">
          {isEnabled('announcements') && <Announcements comms={comms} profile={profile} tenant={tenant} />}
          <Celebrations tenant={tenant} role={role} />
        </div>
        <div className="hd-col hd-col-5">
          {isEnabled('policies') && <Policies comms={comms} />}
          <UpcomingHolidays tenant={tenant} outletId={profile.outlet_id} />
        </div>
      </div>
    </div>
  );
}

/** The people this person looks after (team, or HR's company / outlet); null while loading. */
function useMyPeople({ tenant, profile, enabled, outletProfileIds }) {
  const [people, setPeople] = useState(null);
  useEffect(() => {
    if (!enabled || !tenant || !profile) return;
    let cancelled = false;
    fetchMyPeople(tenant.id, profile, outletProfileIds).then(({ data }) => { if (!cancelled) setPeople(data); });
    return () => { cancelled = true; };
  }, [tenant, profile, enabled, outletProfileIds]);
  return people;
}

// ───────────────────────────── shared bits ─────────────────────────────

/** Announcements + policies (and my acknowledgements), loaded once for the banner and the cards. */
function useComms({ tenant, profile, isEnabled }) {
  const [state, setState] = useState({ loading: true, announcements: [], annAcks: {}, policies: [], policyAcks: {}, loadedAt: Date.now() });
  const [seen, setSeen] = useState(readSeenAnnouncements);
  const annOn = isEnabled('announcements');
  const polOn = isEnabled('policies');

  useEffect(() => {
    if (!tenant || !profile) return;
    let cancelled = false;
    const none = Promise.resolve({ data: [] });
    const noneMap = Promise.resolve({ data: {} });
    Promise.all([
      annOn ? listAnnouncements(tenant.id, { limit: 6 }) : none,
      annOn ? listMyAcknowledgements(tenant.id, profile.id) : noneMap,
      polOn ? listPolicies(tenant.id) : none,
      polOn ? listMyPolicyAcks(tenant.id, profile.id) : noneMap,
    ]).then(([a, ak, p, pk]) => {
      if (cancelled) return;
      setState({
        loading: false,
        announcements: a.data || [],
        annAcks: ak.data || {},
        policies: p.data || [],
        policyAcks: pk.data || {},
        loadedAt: Date.now(),
      });
    });
    return () => { cancelled = true; };
  }, [tenant, profile, annOn, polOn]);

  const isUnread = (a) => !state.annAcks[a.id] && !seen.has(a.id);
  const unread = state.announcements.filter(isUnread).length;
  const toAck = state.policies.filter((p) => p.requires_ack && !state.policyAcks[p.id]);

  return {
    ...state,
    annOn,
    polOn,
    isUnread,
    unread,
    toAck,
    markSeen: (id) => { markAnnouncementsSeen([id]); setSeen(readSeenAnnouncements()); },
    setAcked: (id) => setState((s) => ({ ...s, annAcks: { ...s.annAcks, [id]: new Date().toISOString() } })),
  };
}

function Card({ title, subtitle, action, className = '', children }) {
  return (
    <section className={`hd-card ${className}`}>
      {(title || action) && (
        <header className="hd-card-head">
          <div className="hd-card-titles">
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

function SeeAll({ to, label = 'See all' }) {
  return <Link to={to} className="hd-seeall">{label} <i className="fas fa-arrow-right" /></Link>;
}

function SectionTitle({ icon, title }) {
  return (
    <div className="hd-section-title">
      <i className={`fas ${icon}`} />
      <h2>{title}</h2>
      <span />
    </div>
  );
}

function Avatar({ person, size = 32 }) {
  return (
    <span className="hd-avatar" style={{ width: size, height: size, fontSize: size * 0.36, background: `linear-gradient(135deg, ${getAvatarColor(person?.id)})` }}>
      {getInitials(person?.first_name, person?.last_name)}
    </span>
  );
}

const Skeleton = ({ h = 56 }) => <div className="hd-skel" style={{ height: h }} />;

function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const ROLE_LABEL = { admin: 'HR', superadmin: 'Super Admin', manager: 'Manager', hod: 'HOD', management: 'Management', employee: 'Employee' };

const fmtDay = (iso, opts = { day: 'numeric', month: 'short' }) => new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-IN', opts);

// ───────────────────────────── welcome banner ─────────────────────────────

function Welcome({ profile, tenant, role, isHr, leadsPeople, people, outletProfileIds, comms, isEnabled }) {
  const [queue, setQueue] = useState(null);
  const [mine, setMine] = useState(null);
  const leaveOn = isEnabled('leave_requests');
  const regOn = isEnabled('regularize_attendance');

  useEffect(() => {
    if (!leaveOn) return;
    let cancelled = false;
    if (leadsPeople) fetchOpenLeaveQueue(tenant.id).then(({ data, error }) => { if (!cancelled) setQueue(error ? null : data); });
    if (!isHr) countMyPendingRequests(profile.id).then((r) => { if (!cancelled) setMine(r.error ? null : r); });
    return () => { cancelled = true; };
  }, [tenant, profile, leadsPeople, isHr, leaveOn]);

  // HR: every open leave request in the company (or the selected outlet) —
  // HR can decide at any stage. Manager / HOD / Management: only the ones
  // that are theirs to decide, within their own team.
  const leaveTile = useMemo(() => {
    if (!leadsPeople || !leaveOn) return null;
    if (isHr) {
      const open = queue && (outletProfileIds ? queue.filter((r) => outletProfileIds.has(r.profile_id)) : queue);
      const atHr = open ? open.filter((r) => r.current_stage === 'hr').length : 0;
      return {
        to: '/leaves', icon: 'fa-inbox', label: 'Leave requests pending', value: open ? open.length : '–', alert: open?.length > 0,
        hint: atHr > 0 && atHr !== open.length ? `${atHr} at the HR stage` : '',
      };
    }
    const waiting = queue && people ? leavesWaitingFor(queue, profile, new Set(people.map((p) => p.id))).length : null;
    return { to: '/manager-leaves', icon: 'fa-inbox', label: 'Team leave waiting for you', value: waiting ?? '–', alert: waiting > 0 };
  }, [leadsPeople, leaveOn, isHr, queue, people, profile, outletProfileIds]);

  // My own requests (not my team's) — pointed at whichever list has them.
  let mineTile = null;
  if (!isHr && leaveOn) {
    const reg = regOn && mine ? mine.regularize : 0;
    const parts = mine ? [mine.leave && `${mine.leave} leave`, reg && `${reg} regularize`].filter(Boolean) : [];
    mineTile = {
      to: mine && !mine.leave && reg ? '/my-regularize' : '/my-leaves', icon: 'fa-clipboard-list', label: 'My own requests pending',
      value: mine ? mine.leave + reg : '–', hint: parts.join(' · '),
    };
  }

  const tiles = [
    leaveTile,
    comms.annOn && { to: '/announcements', label: 'Unread announcements', value: comms.loading ? '–' : comms.unread, icon: 'fa-bullhorn', alert: comms.unread > 0 },
    comms.polOn && { to: '/policies', label: 'Policies to acknowledge', value: comms.loading ? '–' : comms.toAck.length, icon: 'fa-shield-halved', alert: comms.toAck.length > 0 },
    mineTile,
  ].filter(Boolean);

  const firstName = (profile.first_name || '').split(' ')[0];
  const sub = [ROLE_LABEL[role] || role, profile.designation, tenant.company_name].filter(Boolean).join(' · ');

  return (
    <div className="hd-welcome">
      <span className="hd-glow g1" aria-hidden="true" />
      <span className="hd-glow g2" aria-hidden="true" />
      <div className="hd-welcome-top">
        <p className="hd-welcome-date">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
        <h1>{greeting()}, <span className="nowrap">{firstName} <span className="hd-wave">👋</span></span></h1>
        <p className="hd-welcome-sub">{sub}</p>
      </div>
      {tiles.length > 0 && (
        <div className={`hd-tiles n${tiles.length}`}>
          {tiles.map((t) => (
            <Link key={t.label} to={t.to} className={`hd-tile ${t.alert ? 'alert' : ''}`}>
              <span className="hd-tile-icon"><i className={`fas ${t.icon}`} /></span>
              <span className="hd-tile-text">
                <span className="hd-tile-value">{t.value}</span>
                <span className="hd-tile-label">{t.label}</span>
                {t.hint && <span className="hd-tile-hint">{t.hint}</span>}
              </span>
              <i className="fas fa-arrow-right hd-tile-go" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── today ─────────────────────────────

function PunchCard({ profile, tenant }) {
  const c = usePunchClock({ profile, tenant });
  const status = c.isClockedIn ? 'Working' : c.hasPunches ? 'Clocked out' : 'Not clocked in';
  const tone = c.isClockedIn ? 'in' : c.hasPunches ? 'done' : 'idle';

  let where = null;
  if (c.isWfhToday) where = { icon: 'fa-house-laptop', text: 'Approved WFH today — clock in from anywhere', tone: 'ok' };
  else if (c.geofenceEnabled) where = { icon: 'fa-location-dot', text: c.locationStatus, tone: c.insideFence === true ? 'ok' : c.insideFence === false ? 'bad' : '' };

  return (
    <Card className="hd-punch">
      <div className="hd-punch-top">
        <div>
          <div className="hd-punch-time">{c.now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}</div>
          <div className="hd-punch-date">{c.now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}</div>
        </div>
        <span className={`hd-status ${tone}`}><span className="dot" />{status}</span>
      </div>

      <div className="hd-punch-worked">
        <span className="hd-punch-timer">{c.worked}</span>
        <span className="hd-punch-label">worked today</span>
      </div>
      <div className="hd-punch-meta">
        <span><i className="fas fa-right-to-bracket" /> In {c.firstIn ? fmtTime12(c.firstIn) : '—'}</span>
        <span><i className="fas fa-right-from-bracket" /> Out {c.lastOut ? fmtTime12(c.lastOut) : '—'}</span>
      </div>

      {where && <div className={`hd-punch-where ${where.tone}`}><i className={`fas ${where.icon}`} /> {where.text}</div>}

      {c.isClockedIn ? (
        <button className="hd-punch-btn out" onClick={c.clockOut} disabled={!!c.busy || c.blockedByFence}>
          {c.busy === 'out' ? <><span className="spinner hd-btn-spin" /> Clocking out…</> : <><i className="fas fa-right-from-bracket" /> Clock out</>}
        </button>
      ) : (
        <button className="hd-punch-btn in" onClick={c.clockIn} disabled={!!c.busy || !c.loaded || c.blockedByFence}>
          {c.busy === 'in' ? <><span className="spinner hd-btn-spin" /> Clocking in…</> : <><i className="fas fa-right-to-bracket" /> Clock in</>}
        </button>
      )}
    </Card>
  );
}

function QuickActions({ role, isHr, hrSupport, isEnabled, raniwala }) {
  const lead = ['manager', 'hod', 'management'].includes(role);
  const all = [
    // Everyone (their own requests)
    !isHr && { to: '/my-leaves', label: 'Apply leave', icon: 'fa-umbrella-beach', tone: 'aqua', feature: 'leave_requests' },
    !isHr && { to: '/my-regularize', label: 'Regularize', icon: 'fa-clock-rotate-left', tone: 'iris', feature: 'regularize_attendance' },
    !isHr && { to: '/my-attendance', label: 'My attendance', icon: 'fa-calendar-check', tone: 'emerald', feature: 'attendance' },
    !isHr && !lead && { to: '/my-wfh', label: 'Work from home', icon: 'fa-house-laptop', tone: 'sky', feature: 'wfh_requests' },
    !isHr && !lead && !hrSupport && { to: '/my-payslips', label: 'Payslips', icon: 'fa-file-invoice-dollar', tone: 'amber', feature: 'payslips' },
    // Managers / HODs / Management
    lead && { to: '/manager-leaves', label: 'Approve leave', icon: 'fa-inbox', tone: 'rose', feature: 'leave_requests' },
    lead && { to: '/manager-employees', label: 'My team', icon: 'fa-users', tone: 'amber', feature: 'employees' },
    lead && raniwala && { to: '/manager-punch-approvals', label: 'Punch approvals', icon: 'fa-fingerprint', tone: 'sky', feature: 'attendance' },
    // HR
    isHr && { to: '/employees', label: 'Employees', icon: 'fa-users', tone: 'iris', feature: 'employees' },
    isHr && { to: '/attendance', label: 'Attendance', icon: 'fa-fingerprint', tone: 'emerald', feature: 'attendance' },
    isHr && { to: '/leaves', label: 'Leave requests', icon: 'fa-inbox', tone: 'aqua', feature: 'leave_requests' },
    isHr && !hrSupport && { to: '/payroll', label: 'Run payroll', icon: 'fa-wallet', tone: 'amber', feature: 'run_payroll' },
    isHr && hrSupport && { to: '/regularize', label: 'Regularize', icon: 'fa-clock-rotate-left', tone: 'amber', feature: 'regularize_attendance' },
    // Everyone
    { to: '/me', label: 'My profile', icon: 'fa-user', tone: 'violet' },
  ].filter((a) => a && (!a.feature || isEnabled(a.feature)));
  const actions = all.slice(0, 6);
  if (actions.length % 2) actions.pop(); // keep the 2-column grid even

  return (
    <Card title="Quick actions" className="hd-quick">
      <div className="hd-quick-grid">
        {actions.map((a) => (
          <Link key={a.to} to={a.to} className="hd-quick-item">
            <span className={`hd-quick-icon t-${a.tone}`}><i className={`fas ${a.icon}`} /></span>
            <span>{a.label}</span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

const DAY_STATUS = {
  Present: { label: 'Present', tone: 'ok' },
  Late: { label: 'Late', tone: 'warn' },
  'Half Day': { label: 'Half day', tone: 'warn' },
  Leave: { label: 'Leave', tone: 'info' },
  Absent: { label: 'Absent', tone: 'bad' },
  Mispunch: { label: 'Mispunch', tone: 'bad' },
  'Pending Approval': { label: 'Pending', tone: 'warn' },
};

const fmtHours = (h) => {
  if (!h) return null;
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
};

function MyWeek({ profile }) {
  const today = useTodayDate();
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchMyRecentDays(profile.id, 7).then(({ data }) => { if (!cancelled) setRows(data); });
    return () => { cancelled = true; };
  }, [profile.id, today]);

  const dates = useMemo(() => Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${today}T00:00:00`);
    d.setDate(d.getDate() - 6 + i);
    return dateStr(d);
  }), [today]);
  const byDate = new Map((rows || []).map((r) => [r.date, r]));
  const worked = (rows || []).reduce((a, r) => a + (Number(r.total_hours) || 0), 0);
  const present = (rows || []).filter((r) => r.status === 'Present' || r.status === 'Late').length;

  return (
    <Card
      title="My last 7 days"
      subtitle={rows === null ? 'Loading…' : worked ? `${fmtHours(worked)} worked · ${present} day${present === 1 ? '' : 's'} present` : 'No time recorded yet'}
      action={<SeeAll to="/my-attendance" label="Details" />}
    >
      <div className="hd-week">
        {dates.map((d) => {
          const r = byDate.get(d);
          const s = r ? DAY_STATUS[r.status] || { label: r.status, tone: '' } : null;
          return (
            <div key={d} className={`hd-day ${d === today ? 'today' : ''}`}>
              <div className="hd-day-wd">{fmtDay(d, { weekday: 'short' })}</div>
              <div className="hd-day-n">{Number(d.slice(8))}</div>
              {rows === null ? <div className="hd-day-bar" /> : <div className={`hd-day-bar ${s ? s.tone : ''}`} title={s?.label} />}
              <div className="hd-day-sub">{fmtHours(Number(r?.total_hours)) || s?.label || '—'}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function PeopleToday({ people, isHr, isEnabled }) {
  const [state, setState] = useState(null);
  const attOn = isEnabled('attendance');

  useEffect(() => {
    if (!people) return;
    let cancelled = false;
    (async () => {
      const ids = people.map((p) => p.id);
      const [att, out] = await Promise.all([
        attOn ? fetchStatusToday(ids) : Promise.resolve({ data: [] }),
        fetchOutToday(ids),
      ]);
      if (!cancelled) setState({ people, att: att.data || [], leave: out.leave, wfh: out.wfh });
    })();
    return () => { cancelled = true; };
  }, [people, attOn]);

  const title = isHr ? 'Company today' : 'My team today';
  if (!state) {
    return <Card title={title} subtitle="Loading…"><div className="hd-pad"><Skeleton h={84} /></div></Card>;
  }

  const total = state.people.length;
  if (!total) {
    return (
      <Card title={title}>
        <div className="hd-pad"><div className="hd-note"><i className="fas fa-users" /> {isHr ? 'No active employees yet.' : 'No one reports to you yet.'}</div></div>
      </Card>
    );
  }

  const byStatus = state.att.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  const present = (byStatus.Present || 0) + (byStatus.Late || 0);
  const markedIds = new Set(state.att.map((a) => a.profile_id));
  const onLeave = new Set(state.leave.map((l) => l.profile_id));
  const leaveUnmarked = [...onLeave].filter((id) => !markedIds.has(id)).length;
  const tiles = [
    { label: 'Present', value: present, tone: 'ok', icon: 'fa-user-check' },
    { label: 'Late', value: byStatus.Late || 0, tone: 'warn', icon: 'fa-clock' },
    { label: 'On leave', value: onLeave.size, tone: 'info', icon: 'fa-umbrella-beach' },
    { label: 'Not in yet', value: Math.max(0, total - markedIds.size - leaveUnmarked), tone: 'muted', icon: 'fa-user-clock' },
  ];
  const attLink = isHr ? '/attendance' : '/manager-employees';

  const byId = new Map(state.people.map((p) => [p.id, p]));
  const out = [
    ...state.leave.map((l) => ({ key: `l-${l.id}`, person: byId.get(l.profile_id), tag: l.leave_type || 'Leave', kind: 'leave' })),
    ...state.wfh.map((w) => ({ key: `w-${w.id}`, person: byId.get(w.profile_id), tag: 'WFH', kind: 'wfh' })),
  ].filter((o) => o.person);

  return (
    <>
      {attOn && (
        <Card
          title={title}
          subtitle={`${total} ${total === 1 ? 'person' : 'people'} · ${markedIds.size} marked so far`}
          action={<SeeAll to={attLink} label={isHr ? 'Open attendance' : 'Open my team'} />}
        >
          <div className="hd-pad">
            <div className="hd-stat-row">
              {tiles.map((t) => (
                <div key={t.label} className={`hd-stat ${t.tone}`}>
                  <span className="hd-stat-icon"><i className={`fas ${t.icon}`} /></span>
                  <span className="hd-stat-value">{t.value}</span>
                  <span className="hd-stat-label">{t.label}</span>
                </div>
              ))}
            </div>
            <div className="hd-progress" title={`${present} of ${total} present`}>
              <span style={{ width: `${Math.round((present / total) * 100)}%` }} />
            </div>
            <p className="hd-fine">Absences are finalised after the day ends; until then only people who have punched are counted.</p>
          </div>
        </Card>
      )}

      <Card
        title="Who's out today"
        subtitle={out.length ? `${state.leave.length} on leave · ${state.wfh.length} working from home` : 'Everyone is in'}
        action={isEnabled('leave_requests') && <SeeAll to={isHr ? '/leaves' : '/manager-leaves'} label="Leave requests" />}
      >
        <div className="hd-pad">
          {out.length === 0 ? (
            <p className="hd-muted">{isHr ? 'Nobody is on leave or working remotely today.' : 'Nobody in your team is on leave or working remotely today.'}</p>
          ) : (
            <ul className="hd-chips">
              {out.slice(0, OUT_CHIPS).map((o) => (
                <li key={o.key} className="hd-chip">
                  <Avatar person={o.person} size={24} />
                  <span className="hd-chip-name">{fullName(o.person)}</span>
                  <span className={`hd-chip-tag ${o.kind}`}><i className={`fas ${o.kind === 'wfh' ? 'fa-house-laptop' : 'fa-umbrella-beach'}`} />{o.tag}</span>
                </li>
              ))}
              {out.length > OUT_CHIPS && <li className="hd-chip more">+{out.length - OUT_CHIPS} more</li>}
            </ul>
          )}
        </div>
      </Card>
    </>
  );
}

// ───────────────────────────── company updates ─────────────────────────────

function Announcements({ comms, profile, tenant }) {
  const items = comms.announcements.slice(0, 5);
  const unread = comms.unread;
  return (
    <Card
      title="Announcements"
      subtitle={comms.loading ? 'Loading…' : unread ? `${unread} new for you` : 'You are all caught up'}
      action={<SeeAll to="/announcements" />}
    >
      <div className="hd-pad hd-stack">
        {comms.loading ? [0, 1, 2].map((i) => <Skeleton key={i} h={78} />)
          : items.length === 0 ? (
            <div className="hd-note"><i className="fas fa-bullhorn" /> No announcements yet. Company news will appear here.</div>
          ) : items.map((a) => <AnnouncementItem key={a.id} a={a} comms={comms} profile={profile} tenant={tenant} />)}
      </div>
    </Card>
  );
}

function AnnouncementItem({ a, comms, profile, tenant }) {
  const [busy, setBusy] = useState(false);
  const K = KINDS[a.kind] || KINDS.update;
  const ackedAt = comms.annAcks[a.id];
  const unread = comms.isUnread(a);
  const body = a.body || a.message || '';

  const acknowledge = async (e) => {
    e.preventDefault();
    setBusy(true);
    const { error } = await acknowledgeAnnouncement(a.id, profile.id, tenant.id);
    setBusy(false);
    if (error) return showToast('Could not save: ' + error.message, 'error');
    comms.setAcked(a.id);
    comms.markSeen(a.id);
    showToast('Thanks — acknowledged.', 'success');
  };

  return (
    <Link to={`/announcements?item=${a.id}`} className="hd-ann" style={{ '--k': K.accent }} onClick={() => comms.markSeen(a.id)}>
      <span className="hd-ann-icon"><i className={`fas ${K.icon}`} /></span>
      <span className="hd-ann-main">
        <span className="hd-ann-meta">
          <b>{K.label}</b>
          {a.pinned && <span><i className="fas fa-thumbtack" /> Pinned</span>}
          <span>{fmtDay(a.publish_at || a.created_at)}</span>
          {unread && <span className="hd-new">New</span>}
        </span>
        <span className="hd-ann-title">{a.title}</span>
        {body && <span className="hd-ann-body">{body}</span>}
        {a.requires_ack && (
          <span className="hd-ann-ack">
            {ackedAt
              ? <span className="hd-pill ok"><i className="fas fa-circle-check" /> Acknowledged</span>
              : <button type="button" className="btn btn-primary btn-sm" onClick={acknowledge} disabled={busy}><i className="fas fa-check" /> {busy ? 'Saving…' : 'I have read this'}</button>}
          </span>
        )}
      </span>
    </Link>
  );
}

function Policies({ comms }) {
  const since = comms.loadedAt - RECENT_POLICY_DAYS * 86400000;
  const toAck = comms.toAck;
  const recent = comms.policies
    .filter((p) => !toAck.includes(p) && p.published_at && Date.parse(p.published_at) >= since)
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
  const rows = [
    ...toAck.map((p) => ({ p, tag: <span className="hd-pill warn">Please acknowledge</span>, urgent: true })),
    ...recent.map((p) => ({ p, tag: <span className="hd-pill info">{p.version_no > 1 ? `Updated · v${p.version_no}` : 'New'}</span> })),
  ].slice(0, 4);

  return (
    <Card
      title="Policies"
      subtitle={comms.loading ? 'Loading…' : toAck.length ? `${toAck.length} need${toAck.length === 1 ? 's' : ''} your acknowledgement` : `${comms.policies.length} in the library`}
      action={<SeeAll to="/policies" />}
    >
      <div className="hd-pad hd-stack sm">
        {comms.loading ? <Skeleton h={96} /> : rows.length === 0 ? (
          <div className="hd-note ok"><i className="fas fa-circle-check" /> All acknowledged — nothing new in the last {RECENT_POLICY_DAYS} days.</div>
        ) : rows.map(({ p, tag, urgent }) => (
          <Link key={p.id} to={`/policies?item=${p.id}`} className={`hd-row ${urgent ? 'urgent' : ''}`}>
            <span className="hd-row-icon"><i className={`fas ${p.pdf_url ? 'fa-file-pdf' : 'fa-book-open'}`} /></span>
            <span className="hd-row-main">
              <span className="hd-row-title">{p.title}</span>
              <span className="hd-row-sub">
                {p.published_at ? fmtDay(p.published_at) : ''}
                {p.version_no > 1 && p.change_note ? ` · ${p.change_note}` : ''}
              </span>
            </span>
            {tag}
          </Link>
        ))}
      </div>
    </Card>
  );
}

function UpcomingHolidays({ tenant, outletId }) {
  const today = useTodayDate();
  const [all, setAll] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listHolidays(tenant.id, outletId).then(({ data }) => { if (!cancelled) setAll(data || []); });
    return () => { cancelled = true; };
  }, [tenant, outletId]);

  const upcoming = (all || []).filter((h) => h.status === 'Approved' && h.date >= today).slice(0, 4);

  return (
    <Card title="Upcoming holidays">
      <div className="hd-pad hd-stack sm">
        {all === null ? [0, 1].map((i) => <Skeleton key={i} h={56} />)
          : upcoming.length === 0 ? <p className="hd-muted">No holidays scheduled yet.</p>
          : upcoming.map((h) => {
            const inDays = Math.round((Date.parse(`${h.date}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86400000);
            return (
              <div key={h.id} className="hd-row static">
                <span className="hd-cal">
                  <span>{fmtDay(h.date, { month: 'short' })}</span>
                  <b>{Number(h.date.slice(8))}</b>
                </span>
                <span className="hd-row-main">
                  <span className="hd-row-title">{h.name}</span>
                  <span className="hd-row-sub">{fmtDay(h.date, { weekday: 'long' })}{h.type && h.type !== 'Public Holiday' ? ` · ${h.type}` : ''}</span>
                </span>
                <span className="hd-when">{inDays === 0 ? 'Today' : inDays === 1 ? 'Tomorrow' : `in ${inDays} days`}</span>
              </div>
            );
          })}
      </div>
    </Card>
  );
}

/**
 * Birthdays + work anniversaries (one RPC). Raniwala: HR sees everyone's
 * for the next 5 days, managers / HODs / employees today only (the RPC
 * enforces scope), management gets no card. Other companies: next 5 days.
 */
function Celebrations({ tenant, role }) {
  const raniwala = isRaniwalaTenant(tenant);
  const days = !raniwala ? 5
    : role === 'admin' ? RANIWALA_HR_CELEBRATION_DAYS
    : ['manager', 'hod', 'employee'].includes(role) ? 0
    : null;
  const [rows, setRows] = useState(null);

  useEffect(() => {
    if (days === null) return;
    let cancelled = false;
    listCelebrations(days).then(({ data }) => {
      if (cancelled) return;
      setRows([
        ...data.birthdays.map((b) => ({ ...b, kind: 'birthday' })),
        ...data.anniversaries.map((a) => ({ ...a, kind: 'anniversary' })),
      ].sort((x, y) => x.diffDays - y.diffDays));
    });
    return () => { cancelled = true; };
  }, [tenant, days]);

  if (days === null) return null;
  const whenLabel = (n) => {
    if (n === 0) return 'Today';
    if (n === 1) return 'Tomorrow';
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  return (
    <Card title="Celebrations" subtitle={days ? `Birthdays and work anniversaries · next ${days} days` : 'Birthdays and work anniversaries today'}>
      <div className="hd-pad">
        {rows === null ? <Skeleton h={56} /> : rows.length === 0 ? (
          <p className="hd-muted">{days ? `No birthdays or work anniversaries in the next ${days} days.` : 'No birthdays or work anniversaries today.'}</p>
        ) : (
          <div className="hd-celebs">
            {rows.map((r) => (
              <div key={`${r.kind}-${r.profile?.id}`} className={`hd-celeb ${r.diffDays === 0 ? 'today' : ''}`}>
                <Avatar person={r.profile} size={36} />
                <span className="hd-row-main">
                  <span className="hd-row-title">{fullName(r.profile)}</span>
                  <span className="hd-row-sub">
                    {r.kind === 'birthday' ? '🎂 Birthday' : `🎊 ${r.years} yr${r.years === 1 ? '' : 's'} at work`}
                    {r.profile?.outlet_location ? ` · ${r.profile.outlet_location}` : ''}
                  </span>
                </span>
                <span className={`hd-when ${r.diffDays === 0 ? 'hot' : ''}`}>{whenLabel(r.diffDays)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
