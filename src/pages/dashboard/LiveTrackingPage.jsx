import { useEffect, useState, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import Header from '@/components/Header';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import {
  listTenantEmployeesWithTrackingState, setEmployeeTracking, listPingsForEmployeeDate, listLastPings, getTrackedAttendanceDay,
  listAttendanceStatusForDate,
} from '@/services/trackingService';
import { fullName, todayStr, timeAgo, fmtDuration, distanceMeters, isRaniwalaTenant, isTenantWeeklyOff } from '@/lib/helpers';

// A pair of consecutive pings closer together than this counts as "standing"
// for that time gap rather than "moving" — GPS drift alone is usually a few
// meters, so this comfortably absorbs jitter from someone stood still.
const STANDING_RADIUS_M = 30;

// Points not trusted for route/distance/stops:
//  - accuracy worse than MAX_ACCURACY_M — a Wi-Fi/mobile-network estimate, not
//    GPS (punch points carry no accuracy and are kept);
//  - a lone jump — a point that is > JUMP_MIN_M and faster than JUMP_SPEED_MS
//    from BOTH its neighbours (for the first/last point: from its only one),
//    e.g. one stale or network fix far from an otherwise consistent track.
const MAX_ACCURACY_M = 100;
const JUMP_MIN_M = 1000;
const JUMP_SPEED_MS = 42; // ~150 km/h

function cleanTrack(pings) {
  const accurate = pings.filter((p) => p.accuracy == null || p.accuracy <= MAX_ACCURACY_M);
  const isJump = (a, b) => {
    const d = distanceMeters(a.lat, a.lng, b.lat, b.lng);
    const dt = Math.max(1, Math.abs(new Date(b.recorded_at) - new Date(a.recorded_at)) / 1000);
    return d > JUMP_MIN_M && d / dt > JUMP_SPEED_MS;
  };
  const n = accurate.length;
  return accurate.filter((p, i) => {
    if (n < 2) return true;
    const prev = i > 0 && isJump(accurate[i - 1], p);
    const next = i < n - 1 && isJump(p, accurate[i + 1]);
    if (i === 0) return !next;
    if (i === n - 1) return !prev;
    return !(prev && next);
  });
}

function computeTrackStats(pings) {
  if (!pings.length) return { standingSec: 0, movingSec: 0, distanceM: 0, first: null, last: null };
  let standingSec = 0, movingSec = 0, distanceM = 0;
  for (let i = 1; i < pings.length; i++) {
    const prev = pings[i - 1], cur = pings[i];
    const dt = (new Date(cur.recorded_at) - new Date(prev.recorded_at)) / 1000;
    if (dt <= 0) continue;
    const d = distanceMeters(prev.lat, prev.lng, cur.lat, cur.lng);
    distanceM += d;
    if (d < STANDING_RADIUS_M) standingSec += dt; else movingSec += dt;
  }
  return { standingSec, movingSec, distanceM, first: pings[0].recorded_at, last: pings[pings.length - 1].recorded_at };
}

// A stop = consecutive pings all within STOP_RADIUS_M of where the stop began,
// lasting at least MIN_STOP_SEC. Wider than STANDING_RADIUS_M because a
// standing phone only writes a heartbeat every 5 min and each fix can drift a
// few tens of meters indoors. It ends at the next ping away from it (the phone
// writes one within ~45 s of moving 30 m), or at the last ping if they're
// still there.
const STOP_RADIUS_M = 75;
const MIN_STOP_SEC = 5 * 60;

function computeStops(pings) {
  const stops = [];
  let i = 0;
  while (i < pings.length) {
    const anchor = pings[i];
    let j = i;
    while (j + 1 < pings.length && distanceMeters(anchor.lat, anchor.lng, pings[j + 1].lat, pings[j + 1].lng) <= STOP_RADIUS_M) j++;
    const from = pings[i].recorded_at;
    const to = j + 1 < pings.length ? pings[j + 1].recorded_at : pings[j].recorded_at;
    const sec = (new Date(to) - new Date(from)) / 1000;
    if (sec >= MIN_STOP_SEC) {
      const group = pings.slice(i, j + 1);
      stops.push({
        from, to, sec,
        ongoing: j + 1 === pings.length,
        lat: group.reduce((s, p) => s + p.lat, 0) / group.length,
        lng: group.reduce((s, p) => s + p.lng, 0) / group.length,
      });
    }
    i = j + 1;
  }
  return stops;
}

const validPoint = (lat, lng) => lat != null && lng != null && !(Number(lat) === 0 && Number(lng) === 0);

// Clock in = first 'in' punch, clock out = last 'out' punch once they've
// clocked out (as many outs as ins). Hours = the DB's total_hours after
// clock-out, or running time since clock-in while still out on the road.
function summarizeAttendance(att, date) {
  if (!att) return null;
  const punches = [...(att.punches || [])].sort((a, b) => a.punch_time.localeCompare(b.punch_time));
  const ins = punches.filter((p) => p.punch_type === 'in');
  const outs = punches.filter((p) => p.punch_type === 'out');
  const clockIn = ins[0]?.punch_time || null;
  const clockedOut = outs.length > 0 && outs.length >= ins.length;
  const clockOut = clockedOut ? outs[outs.length - 1].punch_time : null;
  let hours = Number(att.total_hours) || 0;
  if (!clockedOut && clockIn && date === todayStr()) {
    const [h, m] = clockIn.split(':').map(Number);
    const start = new Date(); start.setHours(h, m, 0, 0);
    hours = Math.max(0, (Date.now() - start.getTime()) / 3600000);
  }
  return {
    status: att.status,
    clockIn, clockOut, clockedOut, hours,
    inPoint: validPoint(att.punch_in_lat, att.punch_in_lng) ? { lat: att.punch_in_lat, lng: att.punch_in_lng } : null,
    outPoint: validPoint(att.punch_out_lat, att.punch_out_lng) ? { lat: att.punch_out_lat, lng: att.punch_out_lng } : null,
  };
}

const fmtPunch = (t) => {
  if (!t) return '—';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

// The phone writes a fix at least every 5 min while clocked in (more often
// while moving — see CrewCore lib/liveTrackingTask.ts), so a gap past these
// means the phone went offline, was force-stopped/switched off, or the
// employee clocked out.
const LIVE_WITHIN_MS = 7 * 60 * 1000;
const DELAYED_WITHIN_MS = 20 * 60 * 1000;
// Auto-refresh while the page is open in a visible tab; paused when hidden.
const REFRESH_MS = 60000;

function liveStatus(lastPing) {
  if (!lastPing) return null;
  const age = Date.now() - new Date(lastPing.recorded_at).getTime();
  // mapColor: Leaflet writes colours as SVG attributes, which can't read CSS vars.
  if (age <= LIVE_WITHIN_MS) return { label: 'Live', color: 'var(--success)', mapColor: '#10B981' };
  if (age <= DELAYED_WITHIN_MS) return { label: 'Delayed', color: 'var(--warning)', mapColor: '#F59E0B' };
  return { label: 'Offline', color: 'var(--text-muted)', mapColor: '#94A3B8' };
}

// Fits the team map to everyone's position — on first load and when someone
// appears / disappears, not on every minute's refresh, so a zoom the viewer
// chose isn't thrown away while they're looking.
function FitToPoints({ points, fitKey }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 1) map.setView(points[0], 14);
    else if (points.length > 1) map.fitBounds(points, { padding: [40, 40], maxZoom: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey]);
  return null;
}

// Today's Present / Absent for the Employees table, from the attendance row
// (same status → colour grouping as the Attendance page). No row: weekly off
// if it is one for the employee's outlet / tenant, otherwise Absent.
const PRESENT_STATUSES = ['Present', 'Late', 'Half Day', 'Travel', 'Show Visit', 'Mispunch'];

function todayStatus(att, tenant, outlet, employee) {
  if (!att) {
    return isTenantWeeklyOff(new Date(), tenant, outlet, employee)
      ? { label: 'Weekly Off', cls: 'badge-info' }
      : { label: 'Absent', cls: 'badge-danger' };
  }
  const status = att.status || 'Present';
  const punches = [...(att.punches || [])].sort((a, b) => a.punch_time.localeCompare(b.punch_time));
  const ins = punches.filter((p) => p.punch_type === 'in');
  const outs = punches.filter((p) => p.punch_type === 'out');
  const clockIn = ins[0]?.punch_time || null;
  const clockOut = outs.length > 0 && outs.length >= ins.length ? outs[outs.length - 1].punch_time : null;
  if (PRESENT_STATUSES.includes(status)) {
    return { label: 'Present', cls: 'badge-success', detail: status === 'Present' ? null : status, clockIn, clockOut };
  }
  if (status === 'Absent') return { label: 'Absent', cls: 'badge-danger' };
  if (status === 'Leave') return { label: 'On Leave', cls: 'badge-purple' };
  if (status === 'Comp Off') return { label: 'Comp Off', cls: 'badge-purple' };
  return { label: status, cls: 'badge-warning', clockIn, clockOut }; // Pending Approval
}

const mapsLink = (p) => `https://www.google.com/maps?q=${p.lat},${p.lng}`;

const fmtSecs = (secs) => (secs > 0 ? fmtDuration(secs / 3600) : '0 hr 0 min');
const fmtClockTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—');

export default function LiveTrackingPage() {
  const { profile, tenant } = useAuth();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [date, setDate] = useState(todayStr());
  const [pings, setPings] = useState([]);
  const [pingsLoading, setPingsLoading] = useState(false);
  const [attendance, setAttendance] = useState(null);
  const [todayAtt, setTodayAtt] = useState(() => new Map()); // profile_id → today's attendance row

  const raniwala = isRaniwalaTenant(tenant);
  // Raniwala only wants Live Tracking scoped to their B2B Sales outlet
  // staff — the field team this feature was actually turned on for — not
  // the whole roster. Every other tenant keeps seeing everyone, unchanged.
  const visibleEmployees = useMemo(
    () => raniwala ? employees.filter((e) => (e.outlets?.name || '').toUpperCase() === 'B2B SALES') : employees,
    [employees, raniwala],
  );

  const load = useCallback(() => {
    if (!tenant?.id) return;
    setLoading(true);
    listTenantEmployeesWithTrackingState(tenant.id).then(({ data, error }) => {
      if (error) showToast('Could not load employees: ' + error.message, 'error');
      setEmployees(data || []);
      setLoading(false);
    });
  }, [tenant?.id]);

  useEffect(() => { load(); }, [load]);

  // Today's Present / Absent for just the listed employees (one query),
  // re-read by the live refresh below.
  const visibleIdsKey = visibleEmployees.map((e) => e.id).join(',');
  const loadTodayAttendance = useCallback(() => {
    if (!tenant?.id) return;
    const ids = visibleIdsKey ? visibleIdsKey.split(',') : [];
    listAttendanceStatusForDate(tenant.id, ids, todayStr()).then(({ data }) => {
      setTodayAtt(new Map(data.map((a) => [a.profile_id, a])));
    });
  }, [tenant?.id, visibleIdsKey]);

  useEffect(() => { loadTodayAttendance(); }, [loadTodayAttendance]);

  useEffect(() => {
    if (!selectedId || !tenant?.id) { setPings([]); setAttendance(null); return; }
    setPingsLoading(true);
    Promise.all([
      listPingsForEmployeeDate(tenant.id, selectedId, date),
      getTrackedAttendanceDay(tenant.id, selectedId, date),
    ]).then(([{ data }, { data: att }]) => {
      setPings(data || []);
      setAttendance(att || null);
      setPingsLoading(false);
    });
  }, [selectedId, date, tenant?.id]);

  // Live refresh: each minute, only while this tab is visible, re-read
  // everyone's latest position (one query) and — when viewing today — the
  // selected employee's track. Nothing polls from a background tab.
  useEffect(() => {
    if (!tenant?.id) return;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      listLastPings(tenant.id).then(({ data }) => {
        const byEmployee = new Map(data.map((p) => [p.employee_id, p]));
        setEmployees((prev) => prev.map((e) => ({ ...e, last_ping: byEmployee.get(e.id) || e.last_ping })));
      });
      loadTodayAttendance();
      if (selectedId && date === todayStr()) {
        listPingsForEmployeeDate(tenant.id, selectedId, date).then(({ data }) => setPings(data || []));
        getTrackedAttendanceDay(tenant.id, selectedId, date).then(({ data }) => setAttendance(data || null));
      }
    };
    const id = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [tenant?.id, selectedId, date, loadTodayAttendance]);

  const handleToggle = async (emp) => {
    setSavingId(emp.id);
    const { error } = await setEmployeeTracking(tenant.id, emp.id, !emp.tracking_enabled, profile?.id);
    setSavingId(null);
    if (error) return showToast('Failed to update: ' + error.message, 'error');
    showToast(`Live Tracking ${!emp.tracking_enabled ? 'enabled' : 'disabled'} for ${fullName(emp)}`, 'success');
    load();
  };

  const selectedEmployee = visibleEmployees.find((e) => e.id === selectedId) || null;
  const track = useMemo(() => cleanTrack(pings), [pings]);
  const stats = useMemo(() => computeTrackStats(track), [track]);
  const stops = useMemo(() => computeStops(track), [track]);
  const day = useMemo(() => summarizeAttendance(attendance, date), [attendance, date]);
  const routePositions = useMemo(() => track.map((p) => [p.lat, p.lng]), [track]);
  const mapCenter = routePositions[0] || [20.5937, 78.9629]; // falls back to India's centroid when there's no track yet
  // Everyone listed who has ever sent a position, for the team map.
  const teamOnMap = visibleEmployees.filter((e) => e.last_ping && validPoint(e.last_ping.lat, e.last_ping.lng));
  const teamPoints = teamOnMap.map((e) => [e.last_ping.lat, e.last_ping.lng]);
  const teamLive = teamOnMap.filter((e) => liveStatus(e.last_ping).label === 'Live').length;

  return (
    <>
      <Header title="Live Tracking" breadcrumb="Premium — monitor selected field employees' movement, on the clock" />
      <div className="page-content">
        <div className="premium-hero">
          <h1><i className="fas fa-crown" /> Live Tracking</h1>
          <p>
            Switch tracking on for individual employees below. From clock-in to clock-out in the CrewCore app, their
            location is recorded — also with the app in the background — and this page refreshes every minute.
            Pick anyone to see where they clocked in and out, hours worked, distance, every stop and how long, and
            their route on the map.
          </p>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>
        ) : (
          <>
            {raniwala && (
              <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-header" style={{ flexWrap: 'wrap', gap: 12 }}>
                  <h3>B2B Sales Team — Live Location</h3>
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                    {teamLive} live now · {teamOnMap.length} of {visibleEmployees.length} on the map · refreshes every minute
                  </span>
                </div>
                <div style={{ padding: 16 }}>
                  {teamOnMap.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No one in the team has sent a location yet.</div>
                  ) : (
                    <>
                      <MapContainer center={teamPoints[0]} zoom={5} style={{ height: 420, borderRadius: 10 }} scrollWheelZoom>
                        <TileLayer
                          attribution='&copy; OpenStreetMap contributors'
                          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        />
                        <FitToPoints points={teamPoints} fitKey={teamOnMap.map((e) => e.id).join(',')} />
                        {teamOnMap.map((e) => {
                          const status = liveStatus(e.last_ping);
                          return (
                            <CircleMarker
                              key={e.id}
                              center={[e.last_ping.lat, e.last_ping.lng]}
                              radius={selectedId === e.id ? 10 : 8}
                              pathOptions={{ color: '#fff', weight: 2, fillColor: status.mapColor, fillOpacity: 1 }}
                              eventHandlers={{ click: () => setSelectedId(e.id) }}
                            >
                              <Tooltip permanent direction="top" offset={[0, -6]}>
                                {fullName(e)} · {status.label === 'Live' ? 'Live' : timeAgo(e.last_ping.recorded_at)}
                              </Tooltip>
                            </CircleMarker>
                          );
                        })}
                      </MapContainer>
                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                        <span><i className="fas fa-circle" style={{ color: '#10B981', marginRight: 4 }} />Live (last 7 min)</span>
                        <span><i className="fas fa-circle" style={{ color: '#F59E0B', marginRight: 4 }} />Delayed (7–20 min)</span>
                        <span><i className="fas fa-circle" style={{ color: '#94A3B8', marginRight: 4 }} />Offline / last known position</span>
                        <span>Click a dot to see that person's track below.</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-header"><h3>Employees</h3></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Employee</th><th>Outlet</th><th>Tracking</th><th>Today</th><th>Current Location</th><th></th></tr></thead>
                  <tbody>
                    {visibleEmployees.map((e) => {
                      const status = liveStatus(e.last_ping);
                      const today = todayStatus(todayAtt.get(e.id), tenant, e.outlets, e);
                      return (
                      <tr key={e.id} style={selectedId === e.id ? { background: 'var(--surface-hover)' } : undefined}>
                        <td>{fullName(e)}</td>
                        <td>{e.outlets?.name || '—'}</td>
                        <td>
                          <button
                            className="btn btn-outline btn-icon btn-sm"
                            disabled={savingId === e.id}
                            onClick={() => handleToggle(e)}
                            title={e.tracking_enabled ? 'Disable tracking' : 'Enable tracking'}
                          >
                            <i className={`fas ${e.tracking_enabled ? 'fa-toggle-on' : 'fa-toggle-off'}`} style={{ color: e.tracking_enabled ? 'var(--success)' : 'var(--text-muted)' }} />
                          </button>
                        </td>
                        <td>
                          <span className={`badge ${today.cls}`}>{today.label}</span>
                          {today.detail && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}> · {today.detail}</span>}
                          {today.clockIn && (
                            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                              In {fmtPunch(today.clockIn)}{today.clockOut ? ` · Out ${fmtPunch(today.clockOut)}` : ''}
                            </div>
                          )}
                        </td>
                        <td>
                          {e.last_ping ? (
                            <>
                              <i className="fas fa-circle" style={{ fontSize: 8, color: status.color, marginRight: 6 }} />
                              <span style={{ color: status.color, fontWeight: 600 }}>{status.label}</span>
                              <span style={{ color: 'var(--text-muted)' }}> · {timeAgo(e.last_ping.recorded_at)}</span>
                              <div style={{ fontSize: 12, marginTop: 2 }}>
                                <a href={mapsLink(e.last_ping)} target="_blank" rel="noreferrer" title="Open latest position in Google Maps">
                                  <i className="fas fa-location-dot" /> Open in Maps
                                </a>
                              </div>
                            </>
                          ) : '—'}
                        </td>
                        <td>
                          <button
                            className={`btn btn-sm ${selectedId === e.id ? 'btn-primary' : 'btn-outline'}`}
                            disabled={!e.tracking_enabled && !e.last_ping}
                            onClick={() => setSelectedId(e.id)}
                          >
                            View Map
                          </button>
                        </td>
                      </tr>
                      );
                    })}
                    {visibleEmployees.length === 0 && (
                      <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                        {raniwala ? 'No B2B Sales outlet employees found.' : 'No employees found.'}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {selectedEmployee && (
              <div className="card">
                <div className="card-header" style={{ flexWrap: 'wrap', gap: 12 }}>
                  <h3>{fullName(selectedEmployee)}'s Track</h3>
                  <div className="form-group" style={{ margin: 0 }}>
                    <input className="form-input" type="date" max={todayStr()} value={date} onChange={(e) => setDate(e.target.value)} />
                  </div>
                </div>
                <div style={{ padding: 16 }}>
                  {!pingsLoading && (
                    <div className="premium-stat-grid" style={{ marginBottom: 16 }}>
                      <div className="premium-stat-tile">
                        <div className="stat-label">Clock In</div>
                        <div className="stat-value" style={{ fontSize: 15 }}>{fmtPunch(day?.clockIn)}</div>
                        {day?.inPoint && (
                          <a href={mapsLink(day.inPoint)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                            <i className="fas fa-location-dot" /> {Number(day.inPoint.lat).toFixed(5)}, {Number(day.inPoint.lng).toFixed(5)}
                          </a>
                        )}
                        {day?.clockIn && !day.inPoint && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No location</div>}
                      </div>
                      <div className="premium-stat-tile">
                        <div className="stat-label">Clock Out</div>
                        <div className="stat-value" style={{ fontSize: 15 }}>{day?.clockedOut ? fmtPunch(day.clockOut) : (day?.clockIn ? 'Still clocked in' : '—')}</div>
                        {day?.clockedOut && day.outPoint && (
                          <a href={mapsLink(day.outPoint)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                            <i className="fas fa-location-dot" /> {Number(day.outPoint.lat).toFixed(5)}, {Number(day.outPoint.lng).toFixed(5)}
                          </a>
                        )}
                        {day?.clockedOut && !day.outPoint && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No location</div>}
                      </div>
                      <div className="premium-stat-tile">
                        <div className="stat-label">{day && !day.clockedOut && day.clockIn ? 'Hours So Far' : 'Hours Worked'}</div>
                        <div className="stat-value">{day ? fmtSecs(day.hours * 3600) : '—'}</div>
                      </div>
                      <div className="premium-stat-tile">
                        <div className="stat-label">Stops (5 min+)</div>
                        <div className="stat-value">{stops.length}</div>
                      </div>
                    </div>
                  )}
                  {pingsLoading ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading track…</div>
                  ) : track.length === 0 ? (
                    <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>No location data recorded for this date.</div>
                  ) : (
                    <>
                      <div className="premium-stat-grid">
                        <div className="premium-stat-tile standing">
                          <div className="stat-label">Standing / Waiting</div>
                          <div className="stat-value">{fmtSecs(stats.standingSec)}</div>
                        </div>
                        <div className="premium-stat-tile moving">
                          <div className="stat-label">Moving / Travel</div>
                          <div className="stat-value">{fmtSecs(stats.movingSec)}</div>
                        </div>
                        <div className="premium-stat-tile">
                          <div className="stat-label">Distance Covered</div>
                          <div className="stat-value">{(stats.distanceM / 1000).toFixed(2)} km</div>
                        </div>
                        <div className="premium-stat-tile">
                          <div className="stat-label">First → Last Seen</div>
                          <div className="stat-value" style={{ fontSize: 15 }}>{fmtClockTime(stats.first)} – {fmtClockTime(stats.last)}</div>
                        </div>
                      </div>

                      <MapContainer center={mapCenter} zoom={15} style={{ height: 420, borderRadius: 10 }} scrollWheelZoom>
                        <TileLayer
                          attribution='&copy; OpenStreetMap contributors'
                          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        />
                        <Polyline positions={routePositions} pathOptions={{ color: '#6C5CE7', weight: 4 }} />
                        {stops.map((s, idx) => (
                          <CircleMarker key={s.from} center={[s.lat, s.lng]} radius={7} pathOptions={{ color: '#F59E0B', fillColor: '#F59E0B', fillOpacity: 0.9 }}>
                            <Tooltip direction="top">Stop {idx + 1} · {fmtClockTime(s.from)} – {s.ongoing ? 'now' : fmtClockTime(s.to)} · {fmtSecs(s.sec)}</Tooltip>
                          </CircleMarker>
                        ))}
                        <CircleMarker center={routePositions[0]} radius={8} pathOptions={{ color: '#10B981', fillColor: '#10B981', fillOpacity: 1 }}>
                          <Tooltip permanent direction="top">Start · {fmtClockTime(stats.first)}</Tooltip>
                        </CircleMarker>
                        <CircleMarker center={routePositions[routePositions.length - 1]} radius={8} pathOptions={{ color: '#EF4444', fillColor: '#EF4444', fillOpacity: 1 }}>
                          <Tooltip permanent direction="top">{date === todayStr() ? 'Now' : 'Last'} · {fmtClockTime(stats.last)}</Tooltip>
                        </CircleMarker>
                      </MapContainer>

                      <h4 style={{ margin: '20px 0 8px' }}>Stops</h4>
                      {stops.length === 0 ? (
                        <div style={{ color: 'var(--text-muted)' }}>No stops of 5 minutes or more.</div>
                      ) : (
                        <div className="table-wrap">
                          <table>
                            <thead><tr><th>#</th><th>From</th><th>To</th><th>Stopped For</th><th>Location</th></tr></thead>
                            <tbody>
                              {stops.map((s, idx) => (
                                <tr key={s.from}>
                                  <td>{idx + 1}</td>
                                  <td>{fmtClockTime(s.from)}</td>
                                  <td>{s.ongoing && date === todayStr() ? 'Still there' : fmtClockTime(s.to)}</td>
                                  <td>{fmtSecs(s.sec)}</td>
                                  <td>
                                    <a href={mapsLink(s)} target="_blank" rel="noreferrer">
                                      <i className="fas fa-location-dot" /> {s.lat.toFixed(5)}, {s.lng.toFixed(5)}
                                    </a>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
