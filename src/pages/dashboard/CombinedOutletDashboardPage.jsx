import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '@/components/Header';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { fetchOutletsOverview } from '@/services/outletDashboardService';
import './CombinedOutletDashboard.css';

// Today's status buckets, in stack order. Every active employee falls in exactly one,
// so the segments of a bar always add up to the outlet's headcount.
const STATUSES = [
  { key: 'on_time',    label: 'On time',      color: 'var(--coc-ontime)' },
  { key: 'on_duty',    label: 'On duty',      color: 'var(--coc-duty)', hint: 'Travel / Show Visit' },
  { key: 'late',       label: 'Late',         color: 'var(--coc-late)' },
  { key: 'half_day',   label: 'Half day',     color: 'var(--coc-half)' },
  { key: 'absent',     label: 'Absent',       color: 'var(--coc-absent)' },
  { key: 'review',     label: 'Needs review', color: 'var(--coc-review)', hint: 'Mispunch / Pending Approval' },
  { key: 'on_leave',   label: 'On leave',     color: 'var(--coc-leave)', hint: 'Leave / Comp Off' },
  { key: 'not_marked', label: 'Not marked',   color: 'var(--coc-unmarked)', hatch: true },
];

const SORTS = {
  rate:      { label: 'Attendance', get: (o) => (o.rate ?? -1) },
  headcount: { label: 'Headcount',  get: (o) => o.employee_count },
  late:      { label: 'Late %',     get: (o) => (o.late_rate ?? -1) },
  absent:    { label: 'Absent',     get: (o) => o.absent_today },
  leaves:    { label: 'Pending',    get: (o) => o.pending_leaves },
  name:      { label: 'Outlet',     get: (o) => o.name?.toLowerCase() || '' },
};

const pct = (n, d) => (d > 0 ? (n / d) * 100 : null);
const fmtPct = (v) => (v == null ? '—' : `${Math.round(v)}%`);
const fmtPts = (v) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)} pts`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// Derives the per-status breakdown + rates from the raw counts the service returns.
// "Attended" = Present + Late + On duty (Travel / Show Visit), the same worked-day
// set payroll uses (FULL_PAID_DAY_STATUSES minus Comp Off, which is a leave).
function analyse(o) {
  const emp = o.employee_count;
  const half = o.half_day_today || 0;
  const leave = o.on_leave_today || 0;
  const duty = o.on_duty_today || 0;
  const review = o.review_today || 0;
  const attended = o.present_today + duty;
  const breakdown = {
    on_time: Math.max(0, o.present_today - o.late_today),
    on_duty: duty,
    late: o.late_today,
    half_day: half,
    absent: o.absent_today,
    review,
    on_leave: leave,
    not_marked: Math.max(0, emp - attended - half - leave - o.absent_today - review),
  };
  return {
    ...o,
    attended,
    breakdown,
    rate: pct(attended, emp),
    late_rate: pct(o.late_today, attended),
  };
}

function StackBar({ breakdown, total, size, onTip, onLeave, title }) {
  return (
    <div className={`coc-stack${size === 'lg' ? ' lg' : ''}`} role="img"
      aria-label={`${title}: ${STATUSES.map((s) => `${breakdown[s.key]} ${s.label.toLowerCase()}`).join(', ')}`}>
      {STATUSES.map((s) => {
        const v = breakdown[s.key];
        if (!v || !total) return null;
        return (
          <div
            key={s.key}
            className={`coc-seg${s.hatch ? ' unmarked' : ''}`}
            style={{ width: `${(v / total) * 100}%`, background: s.hatch ? undefined : s.color }}
            onMouseMove={(e) => onTip(e, (
              <>
                <div style={{ opacity: 0.75, marginBottom: 2 }}>{title}</div>
                <div className="coc-tip-row">
                  <span className={`coc-swatch${s.hatch ? ' unmarked' : ''}`} style={{ marginTop: 0, background: s.hatch ? undefined : s.color }} />
                  <b>{s.label}</b>&nbsp;{v} of {total} ({fmtPct(pct(v, total))})
                </div>
                {s.hint && <div style={{ opacity: 0.75, marginTop: 2 }}>{s.hint}</div>}
              </>
            ))}
            onMouseLeave={onLeave}
          />
        );
      })}
    </div>
  );
}

function Ring({ value }) {
  const r = 78;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value ?? 0));
  const color = v >= 75 ? 'var(--coc-ontime)' : v >= 50 ? 'var(--coc-late)' : 'var(--coc-absent)';
  return (
    <svg width="180" height="180" viewBox="0 0 180 180" aria-hidden="true">
      <circle cx="90" cy="90" r={r} fill="none" stroke="var(--coc-track)" strokeWidth="14" />
      <circle cx="90" cy="90" r={r} fill="none" stroke={color} strokeWidth="14" strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`} style={{ transition: 'stroke-dasharray 0.8s ease' }} />
    </svg>
  );
}

function Kpi({ label, icon, tone, value, unit, sub }) {
  return (
    <div className="coc-kpi">
      <div className="coc-kpi-top">
        <span className="coc-kpi-label">{label}</span>
        <span className="coc-kpi-icon" style={{ background: `var(--${tone}-light)`, color: `var(--${tone})` }}>
          <i className={`fas ${icon}`} />
        </span>
      </div>
      <div className="coc-kpi-value">{value}{unit && <small>{unit}</small>}</div>
      <div className="coc-kpi-sub" title={typeof sub === 'string' ? sub : undefined}>{sub}</div>
    </div>
  );
}

export default function CombinedOutletDashboardPage() {
  const { tenant } = useAuth();
  const navigate = useNavigate();
  const { selectOutlet } = useOutletView();
  const [outlets, setOutlets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [sort, setSort] = useState({ key: 'rate', dir: 'desc' });
  const [tip, setTip] = useState(null);

  const load = useCallback(async () => {
    if (!tenant?.id) return;
    setLoading(true);
    const { data, error } = await fetchOutletsOverview(tenant.id);
    if (error) showToast('Could not load combined data: ' + error.message, 'error');
    setOutlets(data || []); // keep the "unassigned" bucket (id: null) so totals below don't silently exclude anyone
    setUpdatedAt(new Date());
    setLoading(false);
  }, [tenant]);

  useEffect(() => { load(); }, [load]);

  // Real, named outlets only — used for the outlet-vs-outlet comparisons, which
  // can't meaningfully rank an "unassigned" bucket (there's nowhere for it to link to).
  const realOutlets = useMemo(() => outlets.filter((o) => o.id).map(analyse), [outlets]);
  const unassigned  = useMemo(() => {
    const u = outlets.find((o) => !o.id);
    return u ? analyse(u) : null;
  }, [outlets]);

  // Combining fewer than 2 outlets is meaningless — bounce back to the regular dashboard
  // rather than show a "combined" view of a single outlet (this page is reached via a
  // sidebar link that's already hidden in that case, but guard direct/stale navigation too).
  useEffect(() => {
    if (!loading && realOutlets.length <= 1) navigate('/dashboard', { replace: true });
  }, [loading, realOutlets.length, navigate]);

  // Totals include unassigned employees — otherwise "Total Employees" undercounts
  // anyone who hasn't been assigned to an outlet yet.
  const total = useMemo(() => analyse(outlets.reduce((s, o) => ({
      employee_count: s.employee_count + o.employee_count,
      present_today:  s.present_today + o.present_today,
      late_today:     s.late_today + o.late_today,
      absent_today:   s.absent_today + o.absent_today,
      half_day_today: s.half_day_today + (o.half_day_today || 0),
      on_leave_today: s.on_leave_today + (o.on_leave_today || 0),
      on_duty_today: s.on_duty_today + (o.on_duty_today || 0),
      review_today: s.review_today + (o.review_today || 0),
      pending_leaves: s.pending_leaves + o.pending_leaves,
    }), {
      employee_count: 0, present_today: 0, late_today: 0, absent_today: 0, half_day_today: 0,
      on_leave_today: 0, on_duty_today: 0, review_today: 0, pending_leaves: 0,
    })), [outlets]);

  const companyRate = total.rate ?? 0;
  const staffed = realOutlets.filter((o) => o.employee_count > 0);
  const ranked = [...staffed].sort((a, b) => b.rate - a.rate || b.employee_count - a.employee_count);
  // Best / lowest / spread only compare outlets that have reported today — a store
  // that hasn't opened yet (nobody marked) would otherwise always read as "0%, worst".
  const reporting = ranked.filter((o) => o.breakdown.not_marked < o.employee_count);
  const silent = staffed.filter((o) => o.breakdown.not_marked === o.employee_count);
  const best = reporting[0];
  const worst = reporting[reporting.length - 1];
  const spread = best && worst ? best.rate - worst.rate : 0;
  const marked = total.employee_count - total.breakdown.not_marked;
  const coverage = pct(marked, total.employee_count);
  const punctuality = pct(total.breakdown.on_time + total.breakdown.on_duty, total.attended);
  const avgSize = realOutlets.length ? total.employee_count / realOutlets.length : 0;
  const rankById = new Map(ranked.map((o, i) => [o.id, i + 1]));

  const showTip = useCallback((e, content) => setTip({ x: e.clientX, y: e.clientY, content }), []);
  const hideTip = useCallback(() => setTip(null), []);

  const openOutlet = (id) => { selectOutlet(id); navigate('/dashboard'); };

  // ---- Auto insights: plain-language reads of the numbers above ----
  const insights = (() => {
    const out = [];
    if (silent.length) {
      out.push({
        tone: 'info', icon: 'fa-hourglass-half', title: `No attendance yet: ${silent.map((o) => o.name).join(', ')}`,
        text: `Nobody has punched in at ${silent.length === 1 ? 'this outlet' : 'these outlets'} today — left out of the best / lowest comparison until they do.`,
      });
    }
    if (reporting.length < 2) return out;
    out.push({
      tone: 'good', icon: 'fa-trophy', title: `${best.name} leads today`,
      text: `${fmtPct(best.rate)} attendance (${best.attended}/${best.employee_count}), ${fmtPts(best.rate - companyRate)} vs the company rate.`,
    });
    if (worst.id !== best.id) {
      out.push({
        tone: worst.rate < companyRate - 10 ? 'bad' : 'warn', icon: 'fa-arrow-trend-down', title: `${worst.name} needs attention`,
        text: `Lowest attendance at ${fmtPct(worst.rate)} — ${plural(worst.absent_today, 'absent')}${worst.breakdown.not_marked ? `, ${worst.breakdown.not_marked} not marked yet` : ''}.`,
      });
    }
    const below = staffed.filter((o) => o.rate < companyRate);
    if (below.length) {
      out.push({
        tone: 'info', icon: 'fa-scale-unbalanced', title: `${below.length} of ${staffed.length} outlets below company rate`,
        text: spread >= 20
          ? `Wide gap of ${Math.round(spread)} pts between best and worst outlet — attendance is uneven across locations.`
          : `Gap between best and worst outlet is ${Math.round(spread)} pts — performance is fairly consistent.`,
      });
    }
    const lateLeader = [...staffed].filter((o) => o.late_today > 0).sort((a, b) => b.late_rate - a.late_rate)[0];
    if (lateLeader) {
      out.push({
        tone: 'warn', icon: 'fa-clock', title: `Most late arrivals: ${lateLeader.name}`,
        text: `${fmtPct(lateLeader.late_rate)} of those present came in late (${lateLeader.late_today}/${lateLeader.attended}). Company: ${fmtPct(total.late_rate)}.`,
      });
    }
    const reviewLeader = [...staffed].filter((o) => o.breakdown.review > 0).sort((a, b) => b.breakdown.review - a.breakdown.review)[0];
    if (reviewLeader) {
      out.push({
        tone: 'warn', icon: 'fa-fingerprint', title: `${plural(total.breakdown.review, 'punch', 'punches')} waiting for review`,
        text: `Mispunch / pending approval — ${reviewLeader.name} has the most (${reviewLeader.breakdown.review}). These count as not present until approved.`,
      });
    }
    const leaveLeader = [...realOutlets].sort((a, b) => b.pending_leaves - a.pending_leaves)[0];
    if (leaveLeader && leaveLeader.pending_leaves > 0 && total.pending_leaves > 0) {
      out.push({
        tone: 'info', icon: 'fa-inbox', title: `Leave backlog: ${plural(total.pending_leaves, 'request')} pending`,
        text: `${leaveLeader.name} holds ${leaveLeader.pending_leaves} (${fmtPct(pct(leaveLeader.pending_leaves, total.pending_leaves))} of the queue).`,
      });
    }
    return out.slice(0, 6);
  })();

  const tableRows = useMemo(() => {
    const { get } = SORTS[sort.key];
    return [...realOutlets].sort((a, b) => {
      const av = get(a), bv = get(b);
      const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [realOutlets, sort]);

  const toggleSort = (key) => setSort((s) => (s.key === key
    ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' }
    : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  const sortTh = (k, children, num) => (
    <th className={`sortable${num ? ' num' : ''}${sort.key === k ? ' active' : ''}`} onClick={() => toggleSort(k)}>
      {children}{' '}
      <i className={`fas ${sort.key !== k ? 'fa-sort' : sort.dir === 'desc' ? 'fa-sort-down' : 'fa-sort-up'}`} style={{ opacity: sort.key === k ? 1 : 0.35 }} />
    </th>
  );

  const divMax = Math.max(10, ...staffed.map((o) => Math.abs(o.rate - companyRate)));

  return (
    <>
      <Header
        title={`Combined Dashboard — ${tenant?.company_name || ''}`}
        breadcrumb={`${realOutlets.length} outlets combined${updatedAt ? ` · updated ${updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-outline btn-sm" onClick={() => navigate('/outlets')}>
              <i className="fas fa-store" /> All Outlets
            </button>
            <button className="btn btn-outline btn-sm" onClick={load} disabled={loading}>
              <i className={`fas fa-sync-alt${loading ? ' fa-spin' : ''}`} /> Refresh
            </button>
          </div>
        }
      />

      <div className="page-content coc-root">
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div className="spinner" style={{ margin: '0 auto 16px' }} />Loading combined data…
          </div>
        ) : (
          <>
            {/* ---- KPI strip ---- */}
            <div className="coc-kpis">
              <Kpi label="Workforce" icon="fa-users" tone="primary" value={total.employee_count}
                sub={`${realOutlets.length} outlets · avg ${Math.round(avgSize)} per outlet`} />
              <Kpi label="Attendance" icon="fa-user-check" tone="success" value={Math.round(companyRate)} unit="%"
                sub={`${total.attended} present of ${total.employee_count}`} />
              <Kpi label="Punctuality" icon="fa-stopwatch" tone="warning" value={punctuality == null ? '—' : Math.round(punctuality)} unit={punctuality == null ? '' : '%'}
                sub={`${plural(total.late_today, 'late arrival')}`} />
              <Kpi label="Absent" icon="fa-user-xmark" tone="danger" value={total.absent_today}
                sub={`${fmtPct(pct(total.absent_today, total.employee_count))} of workforce`} />
              <Kpi label="Marked" icon="fa-clipboard-check" tone="primary" value={coverage == null ? '—' : Math.round(coverage)} unit={coverage == null ? '' : '%'}
                sub={`${total.breakdown.not_marked} not marked yet`} />
              <Kpi label="Pending Leaves" icon="fa-calendar-days" tone="warning" value={total.pending_leaves}
                sub={total.pending_leaves ? 'awaiting a decision' : 'queue is clear'} />
            </div>

            {/* ---- Hero: company-wide status ---- */}
            <div className="card">
              <div className="coc-hero">
                <div className="coc-ring">
                  <Ring value={companyRate} />
                  <div className="coc-ring-center">
                    <div className="coc-ring-pct">{Math.round(companyRate)}%</div>
                    <div className="coc-ring-cap">Attendance</div>
                    <div className="coc-ring-frac">{total.attended} / {total.employee_count}</div>
                  </div>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="coc-section-title">
                    <h3>Workforce status today</h3>
                    <span>All {total.employee_count} active employees, across every outlet</span>
                  </div>
                  <StackBar breakdown={total.breakdown} total={total.employee_count} size="lg" title="All outlets" onTip={showTip} onLeave={hideTip} />
                  <div className="coc-legend">
                    {STATUSES.map((s) => (
                      <div key={s.key} className="coc-legend-item" title={s.hint}>
                        <span className={`coc-swatch${s.hatch ? ' unmarked' : ''}`} style={{ background: s.hatch ? undefined : s.color }} />
                        <div>
                          <div className="coc-legend-name">{s.label}{s.hint && <i className="fas fa-circle-info coc-legend-hint" />}</div>
                          <div className="coc-legend-val">
                            {total.breakdown[s.key]}
                            <small>{fmtPct(pct(total.breakdown[s.key], total.employee_count))}</small>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="coc-ratios">
                    <div>
                      <div className="coc-ratio-label">Best outlet</div>
                      <div className="coc-ratio-value">{best ? fmtPct(best.rate) : '—'}</div>
                      <div className="coc-ratio-hint">{best?.name || 'No staffed outlets'}</div>
                    </div>
                    <div>
                      <div className="coc-ratio-label">Lowest outlet</div>
                      <div className="coc-ratio-value">{worst ? fmtPct(worst.rate) : '—'}</div>
                      <div className="coc-ratio-hint">{worst?.name || '—'}</div>
                    </div>
                    <div>
                      <div className="coc-ratio-label">Spread</div>
                      <div className="coc-ratio-value">{Math.round(spread)} pts</div>
                      <div className="coc-ratio-hint">best − lowest</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {unassigned && unassigned.employee_count > 0 && (
              <div className="card" style={{ padding: '12px 16px', background: 'var(--warning-light)', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <i className="fas fa-exclamation-triangle" />
                <span style={{ flex: 1, fontSize: 13 }}>
                  {unassigned.employee_count} active employee{unassigned.employee_count !== 1 ? 's are' : ' is'} not yet assigned to an outlet — included in the company totals, but not ranked against outlets.
                </span>
                <button className="btn btn-sm btn-outline" onClick={() => navigate('/employees')}>
                  Assign Now
                </button>
              </div>
            )}

            {/* ---- Variance vs company + insights ---- */}
            <div className="coc-grid2">
              <div className="card">
                <div className="card-header">
                  <div>
                    <h3>Attendance vs company rate</h3>
                    <div className="subtitle">Percentage points above / below the company's {fmtPct(companyRate)} — click an outlet to open it</div>
                  </div>
                </div>
                {staffed.length === 0 ? (
                  <div className="coc-empty">No outlet has active employees yet.</div>
                ) : (
                  <div className="coc-div">
                    {ranked.map((o) => {
                      const d = o.rate - companyRate;
                      const w = (Math.abs(d) / divMax) * 50;
                      return (
                        <div key={o.id} className="coc-div-row" onClick={() => openOutlet(o.id)}
                          onMouseMove={(e) => showTip(e, (
                            <>
                              <b>{o.name}</b>
                              <div>Attendance {fmtPct(o.rate)} ({o.attended}/{o.employee_count})</div>
                              <div>{fmtPts(d)} vs company {fmtPct(companyRate)}</div>
                            </>
                          ))}
                          onMouseLeave={hideTip}>
                          <div className="coc-div-name" title={o.name}>{o.name}</div>
                          <div className="coc-div-track">
                            {Math.abs(d) >= 0.05 && <div className={`coc-div-bar ${d > 0 ? 'pos' : 'neg'}`} style={{ width: `${w}%` }} />}
                          </div>
                          <div className="coc-div-val">{fmtPts(d).replace(' pts', '')}</div>
                        </div>
                      );
                    })}
                    <div className="coc-div-axis">
                      <span />
                      <div className="coc-div-axis-inner">
                        <span>−{Math.round(divMax)}</span>
                        <span>company {fmtPct(companyRate)}</span>
                        <span>+{Math.round(divMax)}</span>
                      </div>
                      <span />
                    </div>
                  </div>
                )}
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <h3>Key insights</h3>
                    <div className="subtitle">Generated from today's numbers</div>
                  </div>
                </div>
                {insights.length === 0 ? (
                  <div className="coc-empty">Insights appear once at least two outlets have staff.</div>
                ) : (
                  <div className="coc-insights">
                    {insights.map((it, i) => (
                      <div key={i} className="coc-insight">
                        <div className={`coc-insight-icon ${it.tone}`}><i className={`fas ${it.icon}`} /></div>
                        <div style={{ minWidth: 0 }}>
                          <div className="coc-insight-title">{it.title}</div>
                          <div className="coc-insight-text">{it.text}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ---- Outlet comparison table ---- */}
            <div className="card">
              <div className="card-header">
                <div>
                  <h3>Outlet comparison</h3>
                  <div className="subtitle">Today's breakdown per outlet — click a column to sort, a row to open that outlet</div>
                </div>
              </div>
              <div className="coc-table-wrap">
                <table className="coc-table">
                  <thead>
                    <tr>
                      {sortTh('name', 'Outlet')}
                      {sortTh('headcount', 'Headcount', true)}
                      <th style={{ width: '28%' }}>Status today</th>
                      {sortTh('rate', 'Attendance', true)}
                      {sortTh('late', 'Late %', true)}
                      {sortTh('absent', 'Absent', true)}
                      {sortTh('leaves', 'Pending leaves', true)}
                    </tr>
                  </thead>
                  <tbody>
                    {[...tableRows, ...(unassigned && unassigned.employee_count > 0 ? [unassigned] : [])].map((o) => {
                      const d = o.rate == null ? null : o.rate - companyRate;
                      const rank = o.id ? rankById.get(o.id) : null;
                      return (
                        <tr key={o.id || 'unassigned'} className={o.id ? 'clickable' : 'muted'} onClick={o.id ? () => openOutlet(o.id) : undefined}>
                          <td>
                            <div className="coc-outlet-cell">
                              <span className={`coc-rank${rank === 1 ? ' top' : ''}`}>{rank || '–'}</span>
                              <div style={{ minWidth: 0 }}>
                                <div className="coc-outlet-name">{o.name}</div>
                                {(o.city || !o.id) && <div className="coc-outlet-city">{o.id ? o.city : 'No outlet assigned'}</div>}
                              </div>
                            </div>
                          </td>
                          <td className="num">
                            <div className="coc-headcount">
                              <div className="coc-share-bar" title={`${fmtPct(pct(o.employee_count, total.employee_count))} of workforce`}>
                                <div style={{ width: `${pct(o.employee_count, total.employee_count) || 0}%` }} />
                              </div>
                              <span>{o.employee_count}</span>
                            </div>
                          </td>
                          <td>
                            {o.employee_count > 0
                              ? <StackBar breakdown={o.breakdown} total={o.employee_count} title={o.name} onTip={showTip} onLeave={hideTip} />
                              : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No active staff</span>}
                          </td>
                          <td className="num">
                            <span className="coc-rate">{fmtPct(o.rate)}</span>
                            {d != null && o.id && (
                              <span className={`coc-delta ${Math.abs(d) < 0.5 ? 'zero' : d > 0 ? 'pos' : 'neg'}`}>
                                {Math.abs(d) < 0.5 ? '±0' : `${d > 0 ? '▲' : '▼'}${Math.abs(Math.round(d))}`}
                              </span>
                            )}
                          </td>
                          <td className="num">{fmtPct(o.late_rate)}</td>
                          <td className="num">
                            <span className={`coc-pill ${o.absent_today ? 'bad' : 'none'}`}>{o.absent_today}</span>
                          </td>
                          <td className="num">
                            <span className={`coc-pill ${o.pending_leaves ? 'warn' : 'none'}`}>{o.pending_leaves}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="coc-legend" style={{ padding: '0 20px 16px', marginTop: 14 }}>
                {STATUSES.map((s) => (
                  <div key={s.key} className="coc-legend-item" style={{ alignItems: 'center' }} title={s.hint}>
                    <span className={`coc-swatch${s.hatch ? ' unmarked' : ''}`} style={{ marginTop: 0, background: s.hatch ? undefined : s.color }} />
                    <span className="coc-legend-name">{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {tip && (
        <div className="coc-tip" style={{ left: tip.x, top: tip.y }}>{tip.content}</div>
      )}
    </>
  );
}
