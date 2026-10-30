import { useEffect, useRef, useState } from 'react';
import { useFeatures } from '@/context/FeatureContext';
import { getMyTrackingToggle, insertPing } from '@/services/trackingService';
import { todayStr, distanceMeters } from '@/lib/helpers';

// Roughly one ping per interval — throttled inside the watchPosition
// callback rather than polling, so it still benefits from the OS/browser's
// own position cache instead of forcing a fresh GPS/WiFi fix every time.
const PING_INTERVAL_MS = 45000;

// How often an already-open tab re-checks whether an admin just turned
// tracking on/off for this employee. Without this, an employee who was
// already clocked in and had the app open before the admin flipped their
// toggle would never start capturing — the toggle was only ever read once,
// on mount, so a same-session admin action was invisible until the
// employee happened to reload the page. Read once on load (trackingOn also
// decides the geofence bypass at clock-in), then re-read only while clocked
// in and the tab is visible, every 5 min — the feature is tenant-wide, so
// every Raniwala user with a dashboard open runs this.
const TOGGLE_POLL_MS = 5 * 60 * 1000;

// A new fix is only written once the employee has moved this far, or as a
// heartbeat after HEARTBEAT_MS standing still — same rule as the CrewCore
// app (lib/liveTrackingTask.ts), so a desk-bound tab doesn't write a row
// every 45 s.
const MIN_MOVE_M = 30;
const HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * Records this employee's location while Live Tracking is on for them
 * (employee_tracking_toggles) and they're clocked in — same on-the-clock
 * lifecycle as useGeofenceClock's watcher, so tracking never runs off-hours.
 * Silently does nothing for every tenant/employee this premium feature
 * hasn't been turned on for (the common case) — mount alongside
 * useGeofenceClock() in any dashboard shell that already tracks isClockedIn.
 *
 * NOTE: like any browser geolocation, this only runs while the tab is open
 * (foreground or a not-yet-suspended background tab) — there's no native
 * background service, so a closed tab means a gap in the trail.
 */
export function useLiveTrackingCapture({ profile, tenant, isClockedIn }) {
  const { isEnabled } = useFeatures();
  const [trackingOn, setTrackingOn] = useState(false);
  const watchRef = useRef(null);
  const lastPingAtRef = useRef(0);
  const lastFixRef = useRef(null);

  const featureOn = isEnabled('live_tracking');

  useEffect(() => {
    if (!profile?.id || !featureOn) {
      setTrackingOn(false);
      return;
    }
    let cancelled = false;
    const checkToggle = () => {
      getMyTrackingToggle(profile.id).then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error('[live-tracking] toggle check failed:', error.message);
        setTrackingOn(!!data);
      });
    };
    checkToggle();
    return () => { cancelled = true; };
  }, [profile?.id, featureOn]);

  useEffect(() => {
    if (!profile?.id || !featureOn || !isClockedIn) return;
    let cancelled = false;
    const recheck = () => {
      if (document.visibilityState !== 'visible') return;
      getMyTrackingToggle(profile.id).then(({ data, error }) => {
        if (cancelled || error) return;
        setTrackingOn(!!data);
      });
    };
    const intervalId = setInterval(recheck, TOGGLE_POLL_MS);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [profile?.id, featureOn, isClockedIn]);

  useEffect(() => {
    if (!trackingOn || !isClockedIn || !profile?.id || !tenant?.id || !navigator.geolocation) return;

    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - lastPingAtRef.current < PING_INTERVAL_MS) return;
        const { latitude, longitude } = pos.coords;
        const last = lastFixRef.current;
        if (last && now - lastPingAtRef.current < HEARTBEAT_MS
            && distanceMeters(last.lat, last.lng, latitude, longitude) < MIN_MOVE_M) return;
        lastPingAtRef.current = now;
        lastFixRef.current = { lat: latitude, lng: longitude };
        insertPing(
          tenant.id, profile.id, profile.outlet_id,
          pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy,
          todayStr()
        ).then(({ error }) => {
          // Best-effort — a denied/failed fix or a rejected write is just a
          // gap in the trail, never blocks the employee's work — but log it
          // so a silent RLS/permission issue is still visible for debugging.
          if (error) console.error('[live-tracking] ping insert failed:', error.message);
        });
      },
      (err) => console.error('[live-tracking] geolocation error:', err.code, err.message),
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 20000 }
    );

    return () => {
      if (watchRef.current != null) navigator.geolocation.clearWatch(watchRef.current);
    };
  }, [trackingOn, isClockedIn, profile?.id, profile?.outlet_id, tenant?.id]);

  // Exposed so callers can bypass geofence enforcement for a tracked
  // employee (see useGeofenceClock's bypassGeofence) — a field employee
  // whose movement is already monitored shouldn't also be confined to a
  // fixed radius.
  return { trackingOn };
}
