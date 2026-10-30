import { useEffect, useRef } from 'react';

// Something changed this person's attendance on the server: a manager/HR
// decided their punch, regularize or leave request, HR moved a grace, or the
// biometric machine sent a scan. Every one of those sends the employee an
// app_notifications row; NotificationContext sees it arrive and calls
// emitAttendanceChanged(), and open attendance screens reload at once.
export const ATTENDANCE_NOTICE_TYPES = [
  'punch_approval_result',
  'regularize_request_approved',
  'regularize_request_rejected',
  'leave_request_approved',
  'leave_request_rejected',
  'leave_worked_day_result',
  'l1_request_decided',
  'early_late_grace',
  'early_late_counted',
  'clock_in',
  'clock_out',
];

const EVENT = 'crewcore:attendance-changed';

export function emitAttendanceChanged() {
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Runs `onChange` whenever this person's attendance changes server-side. */
export function useOnAttendanceChanged(onChange, enabled = true) {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    if (!enabled) return undefined;
    const fn = () => ref.current();
    window.addEventListener(EVENT, fn);
    return () => window.removeEventListener(EVENT, fn);
  }, [enabled]);
}
