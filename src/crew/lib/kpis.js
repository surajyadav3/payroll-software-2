import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';
// ───────────────────────────── labels ─────────────────────────────
export const KIND_LABEL = {
    volume: { label: 'Count / amount', hint: 'A number for the month (orders, revenue, hires…)' },
    rate: { label: 'Rate (%)', hint: 'Successful ÷ eligible × 100 (on-time %, conversion…)' },
    average: { label: 'Average', hint: 'Total ÷ count (average order value, handle time…)' },
    snapshot: { label: 'Snapshot', hint: 'A level at month end (headcount, stock days…)' },
    milestone: { label: 'Milestones', hint: 'A weighted checklist; done milestones add up to 100' },
    rubric: { label: 'Rating 1–5', hint: 'A judged rating from 1 to 5' },
    zero_incidents: { label: 'Zero incidents', hint: 'Incidents in the month; the target is none' },
};
export const STATUS_LABEL = {
    draft: { label: 'Draft', tone: 'neutral' },
    submitted: { label: 'Submitted', tone: 'info' },
    confirmed: { label: 'Confirmed', tone: 'success' },
    returned: { label: 'Returned', tone: 'danger' },
};
/** Health colours: green ≥ 100 %, amber 70–99 %, red < 70 %. */
export const HEALTH = {
    green: { bar: 'bg-success-solid', text: 'text-success-text' },
    amber: { bar: 'bg-amber-400', text: 'text-warning-text' },
    red: { bar: 'bg-danger-solid', text: 'text-danger-text' },
};
export const monthLabel = (period) => new Date(`${period.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
export const shiftMonth = (ym, n) => {
    const d = new Date(`${ym}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 7);
};
export const fmtNum = (n, unit = '') => (n === null ? '—' : `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit && unit !== '%' ? ` ${unit}` : unit === '%' ? '%' : ''}`);
// ───────────────────────────── hooks ─────────────────────────────
export const useKpiRegister = (q) => useQuery({ queryKey: ['pms', 'kpi-register', q], queryFn: () => api('/pms/kpi-register', { query: q }), placeholderData: keepPreviousData });
export const useKpi = (id, period) => useQuery({ queryKey: ['pms', 'kpi', id, period], queryFn: () => api(`/pms/kpis/${id}`, { query: { period } }), enabled: !!id });
