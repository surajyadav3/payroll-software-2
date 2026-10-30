import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, CircleDashed, Flag, GitBranch, MessageSquare, Repeat, RotateCcw, Users } from 'lucide-react';
import { useState } from 'react';
import { Avatar, Card, cx, Skeleton } from '@/crew/components/ui';
import { fmtDate, todayIso } from '@/crew/lib/format';
import { COLUMNS, dueTone, isOpenStatus, PRIORITY, PROJECT_COLOR, STATUS_LABEL } from '@/crew/lib/work';
import { useTaskMover } from './TaskMover';
/**
 * A kanban board of tasks (a project's, or one person's across every project). Dropping a card moves it through the
 * task rules: the mover asks for a reason, a due date or a link when a move needs one, and review decides Done.
 */
export function TaskBoard({ tasks, queryKey, loading, onOpen, readOnly, quickAdd, showProject, }) {
    const qc = useQueryClient();
    const mover = useTaskMover();
    const [drag, setDrag] = useState(null);
    const [over, setOver] = useState(null);
    const columns = COLUMNS.map((c) => ({ ...c, cards: tasks.filter((t) => t.status === c.id).sort((a, b) => a.position - b.position) }));
    const dragged = tasks.find((t) => t.id === drag);
    async function drop(status, index) {
        const id = drag;
        setDrag(null);
        setOver(null);
        const t = tasks.find((x) => x.id === id);
        if (!t)
            return;
        if (status !== t.status && !t.can.moves.includes(status))
            return;
        const cards = columns.find((c) => c.id === status).cards.filter((x) => x.id !== t.id);
        const above = cards[index - 1]?.position;
        const below = cards[index]?.position;
        const position = above !== undefined && below !== undefined ? (above + below) / 2 : above !== undefined ? above + 1024 : below !== undefined ? below - 1024 : 0;
        // Optimistic: show the card in its new place straight away; the mover refetches whatever happens.
        qc.setQueryData(queryKey, (old) => old?.map((x) => (x.id === t.id ? { ...x, status, position } : x)));
        await mover.move({ task: { ...t, canApprove: t.can.approve }, to: status, beforeId: cards[index - 1]?.id ?? null, afterId: cards[index]?.id ?? null });
    }
    const indexAt = (e, status) => {
        const cards = [...e.currentTarget.querySelectorAll('[data-card]')];
        const y = e.clientY;
        const i = cards.findIndex((el) => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
        return { status, index: i === -1 ? cards.length : i };
    };
    if (loading)
        return <div className="grid gap-4 lg:grid-cols-6">{COLUMNS.map((c) => <Skeleton key={c.id} className="h-64"/>)}</div>;
    return (<div className="flex gap-4 overflow-x-auto pb-4 scroll-quiet">
      {mover.dialog}
      {columns.map((col) => {
            // While dragging, columns the card cannot go to are dimmed (the rules decide, not the board).
            const allowed = !dragged || dragged.status === col.id || dragged.can.moves.includes(col.id);
            return (<div key={col.id} onDragOver={(e) => { if (!drag || !allowed)
                return; e.preventDefault(); setOver(indexAt(e, col.id)); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget))
                setOver(null); }} onDrop={(e) => { e.preventDefault(); const at = indexAt(e, col.id); void drop(at.status, at.index); }} className={cx('flex w-72 shrink-0 flex-col rounded-2xl border bg-bg-subtle/60 p-2 transition', over?.status === col.id ? 'border-brand' : 'border-border', !allowed && 'opacity-40')}>
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className={cx('size-2.5 rounded-full', col.dot)}/>
              <span className="text-sm font-semibold text-fg">{col.label}</span>
              <span className="text-xs text-fg-subtle">{col.cards.length}</span>
            </div>
            <div className="flex min-h-12 flex-1 flex-col gap-2 p-1">
              {col.cards.map((t, i) => (<div key={t.id}>
                  {over?.status === col.id && over.index === i && drag !== t.id && <div className="mb-2 h-1 rounded-full bg-brand"/>}
                  <Card data-card draggable={!readOnly} onDragStart={(e) => { setDrag(t.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDrag(null); setOver(null); }} onClick={() => onOpen(t.id)} className={cx('cursor-pointer p-3 transition hover:border-border-strong hover:shadow-md', drag === t.id && 'opacity-40', t.flag && 'border-danger-border')}>
                    <CardBody t={t} showProject={showProject}/>
                  </Card>
                </div>))}
              {over?.status === col.id && over.index >= col.cards.length && <div className="h-1 rounded-full bg-brand"/>}
            </div>
            {!readOnly && quickAdd?.(col.id)}
          </div>);
        })}
    </div>);
}
export function CardBody({ t, showProject }) {
    const today = todayIso();
    const due = t.effectiveDueDate;
    return (<>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-semibold text-fg-subtle">{t.key}</span>
        <span className={cx('rounded-md px-1.5 py-0.5 text-[10px] font-semibold', PRIORITY[t.priority].className)}>{PRIORITY[t.priority].label}</span>
      </div>
      <div className={cx('mt-1 text-sm font-medium', t.status === 'done' ? 'text-fg-subtle line-through' : 'text-fg')}>{t.title}</div>
      {showProject && <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-muted">{t.project ? <><span className={cx('size-1.5 rounded-full', PROJECT_COLOR[t.project.color])}/>{t.project.name}</> : 'Personal'}</div>}
      {(t.flag || t.reworkCount > 0 || t.waitingOnOpen > 0 || t.repeats) && (<div className="mt-2 flex flex-wrap gap-1">
          {t.flag && <Chip className="bg-danger-surface text-danger-text"><Flag className="size-2.5"/>Flagged</Chip>}
          {t.reworkCount > 0 && <Chip className="bg-warning-surface text-warning-text"><RotateCcw className="size-2.5"/>Rework</Chip>}
          {t.waitingOnOpen > 0 && <Chip className="bg-bg-subtle text-fg-muted"><GitBranch className="size-2.5"/>Waiting on {t.waitingOnOpen}</Chip>}
          {t.repeats && <Chip className="bg-brand-surface text-brand-text"><Repeat className="size-2.5"/>Repeats</Chip>}
        </div>)}
      {t.labels.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{t.labels.slice(0, 3).map((l) => <span key={l} className="rounded-full bg-surface px-1.5 py-0.5 text-[10px] text-fg-muted ring-1 ring-border">{l}</span>)}</div>}
      <div className="mt-2 flex items-center gap-2 text-xs text-fg-muted">
        {due && <span className={cx('flex items-center gap-1', dueTone(due, t.status, today))} title={t.revisedDueDate ? `Revised from ${fmtDate(t.dueDate, { day: 'numeric', month: 'short' })}` : undefined}><CalendarDays className="size-3"/>{fmtDate(due, { day: 'numeric', month: 'short' })}{t.revisedDueDate && '*'}</span>}
        {t.subtasks.total > 0 && <span>{t.subtasks.done}/{t.subtasks.total}</span>}
        {t.comments > 0 && <span className="flex items-center gap-0.5"><MessageSquare className="size-3"/>{t.comments}</span>}
        <span className="ml-auto">{t.assignee ? <Avatar name={t.assignee.name ?? '?'} size="sm"/> : <span className="flex size-6 items-center justify-center rounded-full border border-dashed border-border-strong"><Users className="size-3"/></span>}</span>
      </div>
    </>);
}
const Chip = ({ className, children }) => <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold', className)}>{children}</span>;
/** One task in a list: tick to complete (through the rules), click to open. */
export function TaskRow({ t, onOpen, showProject, mover }) {
    const col = COLUMNS.find((c) => c.id === t.status);
    const today = todayIso();
    const due = t.effectiveDueDate;
    const canTick = isOpenStatus(t.status) && t.status !== 'in_review' && (t.can.moves.includes('done') || t.can.moves.includes('in_progress'));
    const tick = () => {
        if (t.status === 'in_progress' && t.can.moves.includes('done'))
            void mover.move({ task: { ...t, canApprove: t.can.approve }, to: 'done' });
        else if ((t.status === 'todo' || t.status === 'backlog' || t.status === 'blocked') && t.can.moves.includes('in_progress'))
            void mover.move({ task: { ...t, canApprove: t.can.approve }, to: 'in_progress' });
    };
    return (<div className={cx('group flex items-center gap-3 px-4 py-3 hover:bg-bg-subtle/60', t.flag && 'bg-danger-surface/30')}>
      <button onClick={tick} disabled={!canTick} aria-label={t.status === 'in_progress' ? 'Complete' : 'Start'} title={t.status === 'in_progress' ? 'Complete' : t.status === 'in_review' ? 'Waiting for review' : 'Start'} className="text-fg-subtle hover:text-success-text disabled:hover:text-fg-subtle">
        {t.status === 'done' ? <CheckCircle2 className="size-5 text-success-text"/> : t.status === 'in_review' ? <CheckCircle2 className="size-5 text-amber-500"/> : <CircleDashed className={cx('size-5', t.status === 'in_progress' && 'text-aqua-500')}/>}
      </button>
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="shrink-0 text-xs font-semibold text-fg-subtle">{t.key}</span>
        <span className={cx('min-w-0 flex-1 truncate text-sm', t.status === 'done' ? 'text-fg-subtle line-through' : 'text-fg')}>{t.title}</span>
        {t.flag && <Flag className="size-3.5 shrink-0 text-danger-text"/>}
        {showProject && <span className="hidden items-center gap-1.5 text-xs text-fg-muted sm:flex">{t.project ? <><span className={cx('size-2 rounded-full', PROJECT_COLOR[t.project.color])}/>{t.project.name}</> : 'Personal'}</span>}
        <span className={cx('rounded-md px-1.5 py-0.5 text-[11px] font-semibold', PRIORITY[t.priority].className)}>{PRIORITY[t.priority].label}</span>
        <span className="hidden items-center gap-1 text-xs text-fg-muted md:flex"><span className={cx('size-2 rounded-full', col?.dot ?? 'bg-border-strong')}/>{STATUS_LABEL[t.status]}</span>
        {due && <span className={cx('flex items-center gap-1 text-xs', dueTone(due, t.status, today))}><CalendarDays className="size-3.5"/>{fmtDate(due, { day: 'numeric', month: 'short' })}</span>}
        {t.assignee && !showProject && <Avatar name={t.assignee.name ?? '?'} size="sm"/>}
      </button>
    </div>);
}
