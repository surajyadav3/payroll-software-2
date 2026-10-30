import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useLiveMessages } from './live';
// ───────────────────────────── labels ─────────────────────────────
export const COLUMNS = [
    { id: 'backlog', label: 'Backlog', dot: 'bg-border-strong' },
    { id: 'todo', label: 'To do', dot: 'bg-iris-400' },
    { id: 'in_progress', label: 'In progress', dot: 'bg-aqua-500' },
    { id: 'blocked', label: 'Blocked', dot: 'bg-ember-500' },
    { id: 'in_review', label: 'Pending review', dot: 'bg-amber-400' },
    { id: 'done', label: 'Done', dot: 'bg-success-solid' },
];
export const STATUS_LABEL = {
    backlog: 'Backlog',
    todo: 'To do',
    in_progress: 'In progress',
    blocked: 'Blocked',
    in_review: 'Pending review',
    done: 'Done',
    cancelled: 'Cancelled',
};
/** The verb on a move button, from where the task is to where it goes. */
export function moveVerb(from, to, canApprove) {
    if (to === 'cancelled')
        return 'Cancel task';
    if (from === 'cancelled')
        return to === 'backlog' ? 'Restore to backlog' : 'Restore';
    if (from === 'done')
        return 'Reopen';
    if (from === 'in_review' && to === 'done')
        return 'Approve';
    if (from === 'in_review' && to === 'in_progress')
        return canApprove ? 'Send back' : 'Withdraw';
    if (to === 'done')
        return 'Complete';
    if (to === 'in_progress')
        return from === 'blocked' ? 'Unblock' : 'Start';
    if (to === 'blocked')
        return 'Blocked';
    return `Move to ${STATUS_LABEL[to]}`;
}
export const isOpenStatus = (s) => s !== 'done' && s !== 'cancelled';
/** Health colour of a due date: overdue / due today / later. */
export const dueTone = (due, status, today) => !due || !isOpenStatus(status) || status === 'in_review' ? 'text-fg-muted' : due < today ? 'text-danger-text' : due === today ? 'text-warning-text' : 'text-fg-muted';
export const PRIORITY = {
    urgent: { label: 'Urgent', className: 'bg-ember-100 text-ember-700', rank: 0 },
    high: { label: 'High', className: 'bg-amber-50 text-amber-700', rank: 1 },
    medium: { label: 'Medium', className: 'bg-iris-100 text-iris-700', rank: 2 },
    low: { label: 'Low', className: 'bg-aqua-100 text-aqua-700', rank: 3 },
    none: { label: 'No priority', className: 'bg-bg-subtle text-fg-muted', rank: 4 },
};
export const PROJECT_COLOR = {
    iris: 'bg-iris-500',
    aqua: 'bg-aqua-500',
    ember: 'bg-ember-500',
    emerald: 'bg-emerald-400',
    amber: 'bg-amber-400',
    rose: 'bg-ember-400',
    sky: 'bg-aqua-400',
    ink: 'bg-fg-subtle',
};
// ───────────────────────────── hooks ─────────────────────────────
// Nothing here polls: lists refetch when a change invalidates them (or the window regains
// focus), and messages arrive by live push (lib/live.js).
export const useProjects = () => useQuery({ queryKey: ['work', 'projects'], queryFn: () => api('/work/projects').then((r) => r.data) });
export const useProject = (id) => useQuery({ queryKey: ['work', 'project', id], queryFn: () => api(`/work/projects/${id}`), enabled: !!id });
export const useTasks = (q, enabled = true) => useQuery({ queryKey: ['work', 'tasks', q], queryFn: () => api('/work/tasks', { query: { ...q, limit: 500 } }).then((r) => r.data), enabled, placeholderData: keepPreviousData });
export const useTask = (id) => useQuery({ queryKey: ['work', 'task', id], queryFn: () => api(`/work/tasks/${id}`), enabled: !!id });
export const useWorkSummary = (employeeId) => useQuery({ queryKey: ['work', 'summary', employeeId ?? 'me'], queryFn: () => api('/work/me/summary', { query: { employeeId } }) });
export const useViewAs = () => useQuery({ queryKey: ['work', 'view-as'], queryFn: () => api('/work/me/view-as').then((r) => r.data), staleTime: 300_000 });
export const useWorkload = (q) => useQuery({ queryKey: ['work', 'workload', q], queryFn: () => api('/work/workload', { query: q }), placeholderData: keepPreviousData });
export const useWorkSettings = () => useQuery({ queryKey: ['work', 'settings'], queryFn: () => api('/work/settings'), staleTime: 300_000 });

/** The conversation list (unread counts, last message). Any message this person can see refreshes it, at most twice a second. */
export function useChannels() {
    const qc = useQueryClient();
    const timer = useRef(null);
    useLiveMessages(() => {
        if (timer.current)
            return;
        timer.current = setTimeout(() => {
            timer.current = null;
            void qc.invalidateQueries({ queryKey: ['work', 'channels'] });
        }, 500);
    });
    useEffect(() => () => clearTimeout(timer.current), []);
    return useQuery({ queryKey: ['work', 'channels'], queryFn: () => api('/work/channels').then((r) => r.data) });
}
export const useChannel = (id) => useQuery({ queryKey: ['work', 'channel', id], queryFn: () => api(`/work/channels/${id}`), enabled: !!id });

/** A channel's messages: older pages on demand; new and changed ones pushed live, then read (merged by id). */
export function useMessages(channelId) {
    const qc = useQueryClient();
    const q = useInfiniteQuery({
        queryKey: ['work', 'messages', channelId],
        queryFn: ({ pageParam }) => api(`/work/channels/${channelId}/messages`, { query: { before: pageParam, limit: 50 } }),
        initialPageParam: undefined,
        getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
        enabled: !!channelId,
        // History is not refetched behind the reader's back; the live pull below keeps it current.
        staleTime: Infinity,
        refetchOnWindowFocus: false,
    });
    const since = q.data?.pages[0]?.serverTime;
    const pulling = useRef(false);
    const again = useRef(false);
    // Reads whatever is new or changed since the newest page was read, and folds it into that page.
    const pull = useCallback(async () => {
        const key = ['work', 'messages', channelId];
        if (!channelId || !qc.getQueryData(key)?.pages[0]?.serverTime)
            return;
        if (pulling.current) {
            again.current = true;
            return;
        }
        pulling.current = true;
        try {
            do {
                again.current = false;
                const after = qc.getQueryData(key)?.pages[0]?.serverTime;
                if (!after)
                    return;
                const r = await api(`/work/channels/${channelId}/messages`, { query: { after, limit: 100 } });
                qc.setQueryData(key, (old) => {
                    if (!old)
                        return old;
                    const [first, ...rest] = old.pages;
                    // A changed message from an older page is updated in place; anything else belongs to the newest page.
                    const inOlder = new Set(rest.flatMap((p) => p.data.map((m) => m.id)));
                    const older = rest.map((p) => ({ ...p, data: p.data.map((m) => r.data.find((x) => x.id === m.id) ?? m) }));
                    const byId = new Map(first.data.map((m) => [m.id, m]));
                    for (const m of r.data)
                        if (!inOlder.has(m.id))
                            byId.set(m.id, m);
                    const merged = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
                    return { ...old, pages: [{ ...first, data: merged, serverTime: r.serverTime }, ...older] };
                });
            } while (again.current);
        }
        catch {
            // the next event (or coming back to the window) tries again
        }
        finally {
            pulling.current = false;
        }
    }, [channelId, qc]);
    useLiveMessages((row, type) => {
        if (type === 'RESYNC' || row.channel_id === channelId)
            void pull();
    }, !!channelId && !!since);
    // Back on this tab after a while (a sleeping laptop, a phone in a pocket): catch up once.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === 'visible')
                void pull();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [pull]);
    /** Oldest first, across every loaded page. */
    const messages = (q.data?.pages ?? []).slice().reverse().flatMap((p) => p.data);
    return { ...q, messages, pull };
}

/** One thread, refreshed live when its first message or one of its replies changes. */
export function useThread(id) {
    const qc = useQueryClient();
    useLiveMessages((row, type) => {
        if (type === 'RESYNC' || row.id === id || row.thread_root_id === id)
            void qc.invalidateQueries({ queryKey: ['work', 'thread', id] });
    }, !!id);
    return useQuery({ queryKey: ['work', 'thread', id], queryFn: () => api(`/work/messages/${id}/thread`), enabled: !!id });
}

/** Colleague search (the directory every employee may use): pickers and @mentions. */
export function useColleagues(q) {
    const [debounced, setDebounced] = useState(q);
    useEffect(() => {
        const t = setTimeout(() => setDebounced(q.trim()), 150);
        return () => clearTimeout(t);
    }, [q]);
    return useQuery({
        queryKey: ['directory', debounced],
        queryFn: () => api('/directory', { query: { q: debounced || undefined, limit: 8 } }).then((r) => r.data),
        staleTime: 60_000,
        placeholderData: keepPreviousData,
    });
}
