import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Eye, Flag, Gauge, Hourglass, Inbox, Link2, ListTodo, Plus, UserRoundCheck } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { NewTask } from '@/crew/components/work/NewTask';
import { TaskBoard, TaskRow } from '@/crew/components/work/TaskBoard';
import { useTaskMover } from '@/crew/components/work/TaskMover';
import { Avatar, Button, Card, cx, EmptyState, ErrorState, PageHeader, Select, Skeleton, Tabs, useToast } from '@/crew/components/ui';
import { api, ApiError } from '@/crew/lib/api';
import { useAuth } from '@/crew/lib/auth';
import { fmtDate, todayIso } from '@/crew/lib/format';
import { isOpenStatus, PRIORITY, PROJECT_COLOR, STATUS_LABEL, useTasks, useViewAs, useWorkload, useWorkSummary } from '@/crew/lib/work';
import { TaskDrawer } from './TaskDrawer';
/**
 * My work — the personal dashboard: today's tiles, my board across every project, the review queue, my calendar
 * and my team's workload. Managers can look at a team member's dashboard ("view as", read-only for their counts).
 */
export function MyWorkPage() {
    const [params, setParams] = useSearchParams();
    const tab = params.get('tab') ?? 'today';
    const as = params.get('as') ?? undefined;
    const task = params.get('task');
    const { me } = useAuth();
    const set = (patch) => {
        const next = new URLSearchParams(params);
        for (const [k, v] of Object.entries(patch)) {
            if (v === null)
                next.delete(k);
            else
                next.set(k, v);
        }
        setParams(next, { replace: true });
    };
    const openTask = (id) => set({ task: id });
    const summary = useWorkSummary(as);
    const viewAs = useViewAs();
    const [adding, setAdding] = useState(false);
    const subject = as ?? me?.employee?.id;
    const team = (viewAs.data?.length ?? 0) > 0;
    const s = summary.data;
    return (<div>
      <PageHeader eyebrow="Work" title={as && s?.name ? `${s.name}'s work` : 'My work'} subtitle={as ? 'You are looking at a team member’s work. Counts include only tasks you can see.' : 'What is due, what is stuck and what waits for you — across every project.'} actions={<>
            {team && (<Select aria-label="View as" value={as ?? ''} onChange={(e) => set({ as: e.target.value || null, tab: tab === 'review' || tab === 'team' ? 'today' : tab })} className="w-48">
                <option value="">Me</option>
                {viewAs.data.map((p) => <option key={p.employeeId} value={p.employeeId}>{p.name}</option>)}
              </Select>)}
            {!as && <Button icon={<Plus className="size-4"/>} onClick={() => setAdding(true)}>New task</Button>}
          </>}/>
      <div className="mb-6">
        <Tabs value={tab} onChange={(v) => set({ tab: v })} tabs={[
            { id: 'today', label: 'Today' },
            { id: 'board', label: 'Board' },
            ...(!as ? [{ id: 'review', label: 'To review', count: s?.toReview || undefined }] : []),
            { id: 'calendar', label: 'Calendar' },
            ...(team && !as ? [{ id: 'team', label: 'Team workload' }] : []),
        ]}/>
      </div>
      {summary.error ? (<ErrorState error={summary.error} retry={() => summary.refetch()}/>) : tab === 'today' ? (<Today s={s} subject={subject} onOpen={openTask} onReview={() => set({ tab: 'review' })}/>) : tab === 'board' ? (<MyBoard subject={subject} onOpen={openTask} readOnly={!!as}/>) : tab === 'review' ? (<ReviewQueue onOpen={openTask}/>) : tab === 'calendar' ? (<MyCalendar subject={subject} onOpen={openTask} readOnly={!!as}/>) : (<TeamWorkload onViewAs={(id) => set({ as: id, tab: 'today' })}/>)}
      <NewTask open={adding} onClose={() => setAdding(false)} context="me" onCreated={openTask}/>
      <TaskDrawer id={task} onClose={() => openTask(null)} onOpen={openTask}/>
    </div>);
}
// ───────────────────────────── today ─────────────────────────────
function Today({ s, subject, onOpen, onReview }) {
    const [focus, setFocus] = useState('all');
    const tasks = useTasks({ assignee: subject, open: true }, !!subject);
    const mover = useTaskMover();
    const today = todayIso();
    const tiles = [
        { id: 'dueToday', label: 'Due today', value: s?.dueToday, icon: CalendarClock, tone: 'text-warning-text' },
        { id: 'overdue', label: 'Overdue', value: s?.overdue, icon: AlertTriangle, tone: 'text-danger-text' },
        { id: 'blocked', label: 'Blocked', value: s?.blocked, icon: Hourglass, tone: 'text-ember-600' },
        { id: 'awaitingReview', label: 'Waiting for review', value: s?.awaitingReview, icon: UserRoundCheck, tone: 'text-amber-600' },
        { id: 'review', label: 'For me to review', value: s?.toReview, icon: Inbox, tone: 'text-brand-text' },
        { id: 'done', label: 'Done this week', value: s?.done7d, icon: CheckCircle2, tone: 'text-success-text' },
        { id: 'ontime', label: 'On time (30 days)', value: s?.onTimeRate30d === null || s?.onTimeRate30d === undefined ? '—' : `${s.onTimeRate30d}%`, icon: Gauge, tone: s?.onTimeRate30d !== null && (s?.onTimeRate30d ?? 100) < 70 ? 'text-danger-text' : (s?.onTimeRate30d ?? 100) < 100 ? 'text-warning-text' : 'text-success-text', hint: 'Finished by the due date (green 100%, amber 70–99%, red below 70%)' },
    ];
    const rows = useMemo(() => {
        const all = tasks.data ?? [];
        const due = (t) => t.effectiveDueDate;
        switch (focus) {
            case 'dueToday': return all.filter((t) => due(t) === today && t.status !== 'in_review');
            case 'overdue': return all.filter((t) => due(t) && due(t) < today && t.status !== 'in_review');
            case 'blocked': return all.filter((t) => t.status === 'blocked');
            case 'awaitingReview': return all.filter((t) => t.status === 'in_review');
            case 'flagged': return all.filter((t) => t.flag);
            case 'noDueDate': return all.filter((t) => !due(t));
            default: return all;
        }
    }, [tasks.data, focus, today]);
    const groups = focus !== 'all'
        ? [{ title: tiles.find((x) => x.id === focus)?.label ?? 'Tasks', tone: 'text-fg', rows }]
        : [
            { title: 'Overdue', tone: 'text-danger-text', rows: rows.filter((t) => t.status !== 'in_review' && t.effectiveDueDate && t.effectiveDueDate < today) },
            { title: 'Due today', tone: 'text-warning-text', rows: rows.filter((t) => t.status !== 'in_review' && t.effectiveDueDate === today) },
            { title: 'In progress', tone: 'text-fg', rows: rows.filter((t) => (t.status === 'in_progress' || t.status === 'blocked') && (!t.effectiveDueDate || t.effectiveDueDate > today)) },
            { title: 'Coming up', tone: 'text-fg', rows: rows.filter((t) => (t.status === 'todo' || t.status === 'backlog') && t.effectiveDueDate && t.effectiveDueDate > today) },
            { title: 'Waiting for review', tone: 'text-warning-text', rows: rows.filter((t) => t.status === 'in_review') },
            { title: 'No due date', tone: 'text-fg-muted', rows: rows.filter((t) => (t.status === 'todo' || t.status === 'backlog') && !t.effectiveDueDate) },
        ];
    return (<div className="space-y-6">
      {mover.dialog}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        {tiles.map((x, i) => {
            const active = focus === x.id;
            const clickable = x.id !== 'done' && x.id !== 'ontime';
            return (<motion.button key={x.label} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }} onClick={() => (x.id === 'review' ? onReview() : clickable && setFocus(active ? 'all' : x.id))} title={x.hint} className={cx('flex min-h-[88px] flex-col justify-between rounded-2xl border bg-surface p-4 text-left shadow-1 transition', active ? 'border-brand ring-2 ring-focus-ring/30' : 'border-border hover:border-border-strong', !clickable && x.id !== 'review' && 'cursor-default')}>
              <div className="flex items-center gap-1.5 text-xs font-medium text-fg-muted"><x.icon className={cx('size-3.5', x.tone)}/>{x.label}</div>
              <div className={cx('text-2xl font-semibold tabular-nums', x.value ? x.tone : 'text-fg')}>{s ? (x.value ?? 0) : <Skeleton className="h-7 w-10"/>}</div>
            </motion.button>);
        })}
      </div>
      {s && s.flagged > 0 && focus !== 'flagged' && (<button onClick={() => setFocus('flagged')} className="flex w-full items-center gap-2 rounded-2xl bg-danger-surface px-4 py-3 text-left text-sm text-danger-text">
          <Flag className="size-4"/>{s.flagged} task{s.flagged > 1 ? 's were' : ' was'} flagged as not done — see what the reviewer said.
        </button>)}
      {focus !== 'all' && <button onClick={() => setFocus('all')} className="text-sm text-brand-text hover:underline">Show everything</button>}
      {tasks.isLoading ? (<div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14"/>)}</div>) : !rows.length ? (<Card><EmptyState icon={<CheckCircle2 className="size-6"/>} title={focus === 'all' ? 'Nothing open' : 'Nothing here'} body="Tasks assigned to you in any project, and your personal tasks, appear here — soonest due first."/></Card>) : (groups.filter((g) => g.rows.length).map((g) => (<section key={g.title}>
            <div className={cx('mb-2 text-sm font-semibold', g.tone)}>{g.title} <span className="font-normal text-fg-subtle">· {g.rows.length}</span></div>
            <Card className="divide-y divide-border">{g.rows.map((t) => <TaskRow key={t.id} t={t} mover={mover} onOpen={() => onOpen(t.id)} showProject/>)}</Card>
          </section>)))}
    </div>);
}
// ───────────────────────────── board ─────────────────────────────
function MyBoard({ subject, onOpen, readOnly }) {
    const q = { assignee: subject };
    const tasks = useTasks(q, !!subject);
    // Finished work older than two weeks leaves the board (it stays in the project and in search).
    const [cutoff] = useState(() => new Date(Date.now() - 14 * 86_400_000).toISOString());
    const rows = (tasks.data ?? []).filter((t) => !t.parentTaskId && (isOpenStatus(t.status) || (t.completedAt ?? t.updatedAt) > cutoff) && t.status !== 'cancelled');
    if (tasks.error)
        return <ErrorState error={tasks.error} retry={() => tasks.refetch()}/>;
    return <TaskBoard tasks={rows} queryKey={['work', 'tasks', q]} loading={tasks.isLoading} onOpen={onOpen} readOnly={readOnly} showProject/>;
}
// ───────────────────────────── review queue ─────────────────────────────
/** Tasks waiting for my decision. Keys: J / K move, A approve, R send back, Enter open. */
function ReviewQueue({ onOpen }) {
    const tasks = useTasks({ scope: 'review' });
    const mover = useTaskMover();
    const [i, setI] = useState(0);
    const rows = tasks.data ?? [];
    const cur = rows[Math.min(i, Math.max(rows.length - 1, 0))];
    useEffect(() => {
        const onKey = (e) => {
            const el = e.target;
            if (el.closest('input, textarea, select, [role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey || !cur)
                return;
            const k = e.key.toLowerCase();
            if (k === 'j')
                setI((x) => Math.min(x + 1, rows.length - 1));
            else if (k === 'k')
                setI((x) => Math.max(x - 1, 0));
            else if (k === 'a')
                void mover.move({ task: { ...cur, canApprove: true }, to: 'done', offerFollowUp: true });
            else if (k === 'r')
                void mover.move({ task: { ...cur, canApprove: true }, to: 'in_progress' });
            else if (k === 'enter')
                onOpen(cur.id);
            else
                return;
            e.preventDefault();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [cur, rows.length, mover, onOpen]);
    if (tasks.error)
        return <ErrorState error={tasks.error} retry={() => tasks.refetch()}/>;
    if (tasks.isLoading)
        return <div className="space-y-2">{[0, 1].map((x) => <Skeleton key={x} className="h-24"/>)}</div>;
    if (!rows.length)
        return <Card><EmptyState icon={<Inbox className="size-6"/>} title="Nothing to review" body="When someone sends you finished work — or someone in your team completes a task — it waits here for your decision."/></Card>;
    return (<div className="space-y-3">
      {mover.dialog}
      <p className="hidden text-xs text-fg-subtle sm:block">Keys: <Kbd>J</Kbd>/<Kbd>K</Kbd> next / previous · <Kbd>A</Kbd> approve · <Kbd>R</Kbd> send back · <Kbd>Enter</Kbd> open</p>
      {rows.map((t, n) => (<Card key={t.id} onClick={() => setI(n)} className={cx('p-4 transition', cur?.id === t.id ? 'border-brand ring-2 ring-focus-ring/20' : 'hover:border-border-strong')}>
          <div className="flex flex-wrap items-start gap-3">
            <Avatar name={t.assignee?.name ?? '?'}/>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                <span className="font-semibold text-fg-subtle">{t.key}</span>
                {t.project ? <span className="flex items-center gap-1"><span className={cx('size-1.5 rounded-full', PROJECT_COLOR[t.project.color])}/>{t.project.name}</span> : <span>Personal</span>}
                <span>· {t.assignee?.name}</span>
                {t.submittedAt && <span>· sent {fmtDate(t.submittedAt, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>}
                {t.completedLate && <span className="font-medium text-warning-text">· finished late</span>}
                {t.reworkCount > 0 && <span className="font-medium text-warning-text">· rework ×{t.reworkCount}</span>}
              </div>
              <button onClick={() => onOpen(t.id)} className="mt-0.5 text-left text-base font-medium text-fg hover:text-brand-text">{t.title}</button>
              {t.links.length > 0 && (<div className="mt-1.5 flex flex-wrap gap-2">
                  {t.links.map((l) => <a key={l} href={l} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-xs items-center gap-1 truncate rounded-lg bg-bg-subtle px-2 py-1 text-xs text-brand-text hover:underline"><Link2 className="size-3"/>{l.replace(/^https?:\/\//, '')}</a>)}
                </div>)}
            </div>
            <div className="flex gap-1.5">
              <Button size="sm" icon={<CheckCircle2 className="size-4"/>} onClick={(e) => { e.stopPropagation(); void mover.move({ task: { ...t, canApprove: true }, to: 'done', offerFollowUp: true }); }}>Approve</Button>
              <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); void mover.move({ task: { ...t, canApprove: true }, to: 'in_progress' }); }}>Send back</Button>
              <Button size="sm" variant="ghost" icon={<Eye className="size-4"/>} onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} aria-label="Open"/>
            </div>
          </div>
        </Card>))}
    </div>);
}
const Kbd = ({ children }) => <kbd className="rounded border border-border bg-bg-subtle px-1 font-mono text-[10px] text-fg-muted">{children}</kbd>;
// ───────────────────────────── calendar ─────────────────────────────
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Month view of my tasks by effective due date; drag an undated task onto a day to give it its first due date. */
function MyCalendar({ subject, onOpen, readOnly }) {
    const qc = useQueryClient();
    const toast = useToast();
    const today = todayIso();
    const [month, setMonth] = useState(() => today.slice(0, 7));
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7)); // back to Monday
    const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
    const from = iso(days[0]);
    const to = iso(days[41]);
    const dated = useTasks({ assignee: subject, dueFrom: from, dueTo: to }, !!subject);
    const all = useTasks({ assignee: subject, open: true }, !!subject);
    const undated = (all.data ?? []).filter((t) => !t.effectiveDueDate && (t.status === 'backlog' || t.status === 'todo' || t.status === 'in_progress' || t.status === 'blocked'));
    const byDay = useMemo(() => {
        const map = new Map();
        for (const t of dated.data ?? []) {
            if (!t.effectiveDueDate || t.status === 'cancelled')
                continue;
            map.set(t.effectiveDueDate, [...(map.get(t.effectiveDueDate) ?? []), t]);
        }
        return map;
    }, [dated.data]);
    const [drag, setDrag] = useState(null);
    const shift = (n) => { const d = new Date(y, m - 1 + n, 1); setMonth(iso(d).slice(0, 7)); };
    async function dropOn(day, e) {
        e.preventDefault();
        const id = drag;
        setDrag(null);
        if (!id)
            return;
        try {
            await api(`/work/tasks/${id}`, { method: 'PATCH', body: { dueDate: day } });
            void qc.invalidateQueries({ queryKey: ['work'] });
            toast('success', `Due ${fmtDate(day, { day: 'numeric', month: 'short' })}.`);
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not set the due date.');
        }
    }
    return (<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-base font-semibold text-fg">{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => shift(-1)} aria-label="Previous month" icon={<ChevronLeft className="size-4"/>}/>
            <Button size="sm" variant="secondary" onClick={() => setMonth(today.slice(0, 7))}>Today</Button>
            <Button size="sm" variant="ghost" onClick={() => shift(1)} aria-label="Next month" icon={<ChevronRight className="size-4"/>}/>
          </div>
        </div>
        <div className="grid grid-cols-7 border-b border-border bg-bg-subtle/60 text-center text-xs font-medium text-fg-muted">{DOW.map((d) => <div key={d} className="py-2">{d}</div>)}</div>
        <div className="grid grid-cols-7">
          {days.map((d) => {
            const key = iso(d);
            const items = byDay.get(key) ?? [];
            const inMonth = d.getMonth() === m - 1;
            return (<div key={key} onDragOver={(e) => { if (drag && !readOnly)
                e.preventDefault(); }} onDrop={(e) => void dropOn(key, e)} className={cx('min-h-24 border-b border-r border-border p-1.5 last:border-r-0 sm:min-h-28', !inMonth && 'bg-bg-subtle/40')}>
                <div className={cx('mb-1 inline-flex size-6 items-center justify-center rounded-full text-xs', key === today ? 'bg-brand font-semibold text-on-brand' : inMonth ? 'text-fg' : 'text-fg-subtle')}>{d.getDate()}</div>
                <div className="space-y-1">
                  {items.slice(0, 3).map((t) => (<button key={t.id} onClick={() => onOpen(t.id)} className={cx('block w-full truncate rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium', t.status === 'done' ? 'bg-success-surface text-success-text line-through' : t.status === 'in_review' ? 'bg-warning-surface text-warning-text' : key < today ? 'bg-danger-surface text-danger-text' : 'bg-brand-surface text-brand-text')} title={`${t.key} · ${t.title} · ${STATUS_LABEL[t.status]}${t.revisedDueDate ? ' · revised' : ''}`}>
                      {t.title}
                    </button>))}
                  {items.length > 3 && <div className="px-1 text-[11px] text-fg-subtle">+{items.length - 3} more</div>}
                </div>
              </div>);
        })}
        </div>
      </Card>
      <Card className="p-4">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-fg"><CalendarDays className="size-4"/>No due date <span className="font-normal text-fg-subtle">· {undated.length}</span></div>
        <p className="mb-3 text-xs text-fg-muted">{readOnly ? 'Open tasks without a due date.' : 'Drag one onto a day to set its due date.'}</p>
        <div className="space-y-1.5">
          {undated.map((t) => (<div key={t.id} draggable={!readOnly} onDragStart={() => setDrag(t.id)} onDragEnd={() => setDrag(null)} onClick={() => onOpen(t.id)} className="cursor-grab rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg hover:border-border-strong active:cursor-grabbing">
              <div className="truncate">{t.title}</div>
              <div className="text-[11px] text-fg-subtle">{t.key} · {PRIORITY[t.priority].label}</div>
            </div>))}
          {!undated.length && <p className="text-sm text-fg-subtle">Every open task has a date.</p>}
        </div>
      </Card>
    </div>);
}
// ───────────────────────────── team workload ─────────────────────────────
function TeamWorkload({ onViewAs }) {
    const wl = useWorkload({});
    if (wl.error)
        return <ErrorState error={wl.error} retry={() => wl.refetch()}/>;
    if (wl.isLoading)
        return <Skeleton className="h-64"/>;
    const people = wl.data?.people ?? [];
    const max = Math.max(1, ...people.map((p) => p.open));
    const cols = [
        { k: 'overdue', label: 'Overdue', tone: 'text-danger-text' },
        { k: 'thisWeek', label: 'This week', tone: 'text-fg' },
        { k: 'nextWeek', label: 'Next week', tone: 'text-fg' },
        { k: 'later', label: 'Later', tone: 'text-fg-muted' },
        { k: 'noDueDate', label: 'No date', tone: 'text-fg-muted' },
        { k: 'blocked', label: 'Blocked', tone: 'text-ember-600' },
        { k: 'inReview', label: 'In review', tone: 'text-amber-600' },
    ];
    return (<Card className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium text-fg-muted">
            <th className="px-4 py-3">Person</th>
            <th className="px-2 py-3">Load</th>
            {cols.map((c) => <th key={c.k} className="px-2 py-3 text-right">{c.label}</th>)}
            <th />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {people.map((p) => (<tr key={p.employeeId} className="hover:bg-bg-subtle/60">
              <td className="px-4 py-2.5"><div className="flex items-center gap-2"><Avatar name={p.name} size="sm"/><span className="font-medium text-fg">{p.name}</span></div></td>
              <td className="w-40 px-2"><div className="h-2 overflow-hidden rounded-full bg-bg-subtle"><div className={cx('h-full rounded-full', p.overdue ? 'bg-danger-solid' : 'bg-brand')} style={{ width: `${(p.open / max) * 100}%` }}/></div><div className="mt-0.5 text-[11px] text-fg-subtle">{p.open} open</div></td>
              {cols.map((c) => <td key={c.k} className={cx('px-2 text-right tabular-nums', p[c.k] ? c.tone : 'text-fg-subtle')}>{p[c.k]}</td>)}
              <td className="px-4 text-right"><Button size="sm" variant="ghost" icon={<ListTodo className="size-4"/>} onClick={() => onViewAs(p.employeeId)}>Open</Button></td>
            </tr>))}
        </tbody>
      </table>
      {!people.length && <EmptyState title="No team yet" body="People who report to you appear here with their open work."/>}
    </Card>);
}
