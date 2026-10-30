import { useQuery } from '@tanstack/react-query';
import { api } from './api';
// ───────────────────────────── labels ─────────────────────────────
export const PHASES = [
    { id: 'goal_setting', label: 'Goal setting', who: 'Everyone sets goals; managers approve' },
    { id: 'self_review', label: 'Self review', who: 'Each person rates themselves' },
    { id: 'manager_review', label: 'Manager review', who: 'Managers rate their team' },
    { id: 'reviews_closed', label: 'Calibration', who: 'HR finalises results' },
    { id: 'results', label: 'Results', who: 'People see and acknowledge results' },
];
export const CYCLE_TYPE_LABEL = { annual: 'Annual', half_yearly: 'Half-yearly', quarterly: 'Quarterly', probation: 'Probation' };
export const PLAN_STATUS = {
    draft: { label: 'Draft', tone: 'neutral' },
    submitted: { label: 'Waiting for approval', tone: 'warning' },
    returned: { label: 'Sent back', tone: 'info' },
    approved: { label: 'Approved', tone: 'success' },
    rejected: { label: 'Rejected', tone: 'danger' },
};
export const REVIEW_STATUS = {
    blocked: { label: 'Waiting for goals', tone: 'danger' },
    not_started: { label: 'Not started', tone: 'neutral' },
    self_in_progress: { label: 'Self review in progress', tone: 'info' },
    self_submitted: { label: 'Self review done', tone: 'brand' },
    manager_in_progress: { label: 'Manager reviewing', tone: 'info' },
    manager_submitted: { label: 'Manager review done', tone: 'brand' },
    finalised: { label: 'Finalised', tone: 'success' },
    shared: { label: 'Result shared', tone: 'success' },
    void: { label: 'Void', tone: 'neutral' },
};
export const pct = (v) => (v === null || v === undefined ? null : Math.max(0, Math.min(100, Math.round(Number(v)))));
// ───────────────────────────── hooks ─────────────────────────────
export const useCycles = () => useQuery({ queryKey: ['pms', 'cycles'], queryFn: () => api('/pms/cycles').then((r) => r.data), staleTime: 60_000 });
export const useDeletedCycles = (enabled) => useQuery({ queryKey: ['pms', 'cycles', 'deleted'], queryFn: () => api('/pms/cycles', { query: { deleted: true } }).then((r) => r.data), enabled });
export const usePlan = (cycleId, employeeId) => useQuery({ queryKey: ['pms', 'plan', cycleId, employeeId], queryFn: () => api(`/pms/cycles/${cycleId}/plans/${employeeId}`), enabled: !!cycleId && !!employeeId });
export const usePlans = (cycleId, enabled) => useQuery({ queryKey: ['pms', 'plans', cycleId], queryFn: () => api(`/pms/cycles/${cycleId}/plans`).then((r) => r.data), enabled: !!cycleId && enabled });
export const useScales = () => useQuery({ queryKey: ['pms', 'scales'], queryFn: () => api('/pms/scales').then((r) => r.data), staleTime: 5 * 60_000 });
export const useMyReviews = () => useQuery({ queryKey: ['pms', 'reviews', 'mine'], queryFn: () => api('/pms/me/reviews') });
export const useReview = (id) => useQuery({ queryKey: ['pms', 'review', id], queryFn: () => api(`/pms/reviews/${id}`), enabled: !!id });
export const useCheckIns = (goalId) => useQuery({ queryKey: ['pms', 'checkins', goalId], queryFn: () => api(`/pms/goals/${goalId}/check-ins`).then((r) => r.data), enabled: !!goalId });
export const useCycleReviews = (cycleId, enabled) => useQuery({ queryKey: ['pms', 'cycle-reviews', cycleId], queryFn: () => api('/pms/reviews', { query: { cycleId } }).then((r) => r.data), enabled: !!cycleId && enabled });
export const useOutcomes = (cycleId, state, enabled) => useQuery({ queryKey: ['pms', 'outcomes', cycleId, state], queryFn: () => api(`/pms/cycles/${cycleId}/outcomes`, { query: { state } }).then((r) => r.data), enabled: !!cycleId && enabled });
/** The cycle people work in now: the open one (newest first), else the newest. */
export function currentCycle(cycles) {
    const list = [...(cycles ?? [])].filter((c) => c.status !== 'archived').sort((a, b) => b.startDate.localeCompare(a.startDate));
    return list.find((c) => c.status === 'open') ?? list[0];
}
