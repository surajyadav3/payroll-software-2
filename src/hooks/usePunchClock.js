import { useCallback, useEffect, useRef, useState } from 'react';
import { showToast } from '@/components/Toast';
import { fetchMyMonthAttendance, clockIn as svcClockIn, clockOut as svcClockOut } from '@/services/attendanceService';
import { todayStr, timeStr, fmtTime12, fmtDuration, elapsedSecondsToday } from '@/lib/helpers';
import { useGeofenceClock } from '@/hooks/useGeofenceClock';
import { useLiveTrackingCapture } from '@/hooks/useLiveTrackingCapture';
import { useOnAttendanceChanged } from '@/lib/attendanceEvents';

const pad = (n) => String(n).padStart(2, '0');

/**
 * Today's clock in / out for the signed-in person: state, the running
 * worked-time timer, geofence status and the two actions. Same rules as the
 * clock widget on the role dashboards (geofence, approved WFH, live tracking,
 * auto clock-out on leaving the fence).
 */
export function usePunchClock({ profile, tenant }) {
  const [now, setNow] = useState(() => new Date());
  const [today, setToday] = useState({});
  const [isClockedIn, setIsClockedIn] = useState(false);
  const [busy, setBusy] = useState(null); // 'in' | 'out' | null
  const [loaded, setLoaded] = useState(false);
  const isClockedInRef = useRef(false);

  useEffect(() => { isClockedInRef.current = isClockedIn; }, [isClockedIn]);

  const refresh = useCallback(async () => {
    if (!profile || !tenant) return;
    const d = new Date();
    const { data } = await fetchMyMonthAttendance(profile.id, d.getFullYear(), d.getMonth());
    const rec = (data || []).find((r) => r.date === todayStr());
    const ins = (rec?.punches || []).filter((p) => p.punch_type === 'in').length;
    const outs = (rec?.punches || []).filter((p) => p.punch_type === 'out').length;
    setIsClockedIn(!!rec && ins > outs);
    setToday(rec || {});
    setLoaded(true);
  }, [profile, tenant]);

  useEffect(() => { refresh(); }, [refresh]);
  // A machine scan or an approved punch shows up without a page reload.
  useOnAttendanceChanged(refresh);

  // One tick drives both the clock face and the worked-time timer.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const doAutoClockOut = useCallback(async (lat, lng) => {
    if (!isClockedInRef.current || !profile) return;
    setBusy('out');
    try {
      const { total } = await svcClockOut(profile.id, { lat, lng }, { allowOutsideGeofence: true });
      showToast(`Auto clocked out — left office area. Worked ${fmtDuration(total)}`, 'warning');
      await refresh();
    } catch (err) {
      showToast('Auto clock-out failed: ' + err.message, 'error');
    } finally {
      setBusy(null);
    }
  }, [profile, refresh]);

  const { trackingOn } = useLiveTrackingCapture({ profile, tenant, isClockedIn });
  const geo = useGeofenceClock({ profile, tenant, isClockedIn, onAutoClockOut: doAutoClockOut, bypassGeofence: trackingOn });

  const clockIn = async () => {
    if (!profile || !tenant) return showToast('Account setup incomplete. Please re-login.', 'error');
    if (isClockedIn) return showToast('Already clocked in!', 'warning');
    setBusy('in');
    try {
      const location = await geo.resolveClockLocation();
      await svcClockIn(tenant.id, profile.id, tenant, location);
      showToast(`Clocked in at ${fmtTime12(timeStr(new Date()))}`, 'success');
      await refresh();
    } catch (err) {
      showToast('Clock in failed: ' + err.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const clockOut = async () => {
    if (!isClockedIn) return showToast('Not clocked in!', 'warning');
    setBusy('out');
    try {
      const location = await geo.resolveClockLocation();
      const { total } = await svcClockOut(profile.id, location);
      showToast(`Clocked out. Worked ${fmtDuration(total)}`, 'success');
      await refresh();
    } catch (err) {
      showToast('Clock out failed: ' + err.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const secs = today?.punches?.length ? elapsedSecondsToday(today.punches) : 0;
  const punches = [...(today?.punches || [])].sort((a, b) => String(a.punch_time).localeCompare(String(b.punch_time)));
  const firstIn = punches.find((p) => p.punch_type === 'in');
  const lastOut = [...punches].reverse().find((p) => p.punch_type === 'out');

  return {
    now,
    loaded,
    isClockedIn,
    hasPunches: punches.length > 0,
    firstIn: firstIn?.punch_time || null,
    lastOut: !isClockedIn ? lastOut?.punch_time || null : null,
    worked: `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(Math.floor(secs % 60))}`,
    workedSecs: secs,
    busy,
    clockIn,
    clockOut,
    blockedByFence: geo.geofenceEnabled && geo.insideFence === false,
    ...geo,
  };
}
