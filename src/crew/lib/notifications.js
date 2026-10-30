/** Same "3 h ago" wording everywhere. */
export function timeAgo(iso, now) {
    const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
    if (m < 1)
        return 'just now';
    if (m < 60)
        return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24)
        return `${h} h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
