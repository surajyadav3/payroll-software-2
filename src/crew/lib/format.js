/** Formatting helpers. Dates from the API are business dates (YYYY-MM-DD) or ISO instants. */
const LOCALE = 'en-IN';
export const todayIso = () => isoDate(new Date());
export function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(date, n) {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + n);
    return isoDate(d);
}
export function monthBounds(month) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}
export const fmtDate = (date, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => date ? new Date(date.length === 10 ? `${date}T00:00:00` : date).toLocaleDateString(LOCALE, opts) : '—';
export const fmtDay = (date) => fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' }) : '—');
export const fmtMonth = (month) => new Date(`${month}-01T00:00:00`).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
/** 485 → "8h 05m"; 0 → "—" */
export function fmtMinutes(min) {
    if (!min)
        return '—';
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
export function initials(name) {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0].toUpperCase())
        .join('');
}
export function greeting(d = new Date()) {
    const h = d.getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
export const titleCase = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
