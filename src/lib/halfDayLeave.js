// Half-day leave (migration 20261013_2): leave_requests.half_day is
// 'first_half' / 'second_half' for half of one date, NULL for whole days.
// half_day_from / half_day_to are that half of the employee's shift, stamped
// by the DB when they applied.

export const HALF_DAY_OPTIONS = [
  { value: '', label: 'Full day' },
  { value: 'first_half', label: 'First half' },
  { value: 'second_half', label: 'Second half' },
];

const HALF_NAMES = { first_half: 'First half', second_half: 'Second half' };

/** '14:47' / '14:47:00' -> '2:47 PM'. */
export function clock12(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** 'First half · 10:20 AM – 2:47 PM' (times left out when unknown). */
export function halfDayLabel(half, from, to) {
  const name = HALF_NAMES[half];
  if (!name) return '';
  return from && to ? `${name} · ${clock12(from)} – ${clock12(to)}` : name;
}

/** A request's own label, or '' for a full-day request. */
export const requestHalfDayLabel = (req) => halfDayLabel(req?.half_day, req?.half_day_from, req?.half_day_to);

/** Calendar days from start to end, both included. */
function spanDays(start, end) {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000) + 1;
}

/** Leave days a request takes: 0.5 for a half day. */
export function leaveDays(req) {
  if (!req?.start_date || !req?.end_date) return 0;
  return req.half_day ? 0.5 : spanDays(req.start_date, req.end_date);
}

/** '½' for a half day, else the whole number. */
export const daysText = (n) => (n === 0.5 ? '½' : Number.isInteger(n) ? String(n) : String(n).replace('.5', '½'));
