import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, CheckCircle2, CircleDashed, Flag, GitBranch, History, Link2, ListChecks, MessageSquare, Plus, Repeat, RotateCcw, Tag, Trash2, UserRound, UserRoundCheck, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useDismiss } from '@/crew/lib/use-dismiss';
import { Link } from 'react-router-dom';
import { Composer, RichText } from '@/crew/components/work/Composer';
import { PeoplePicker } from '@/crew/components/work/PeoplePicker';
import { useTaskMover } from '@/crew/components/work/TaskMover';
import { Avatar, Badge, Button, cx, Drawer, ErrorState, Input, Select, Skeleton, useToast } from '@/crew/components/ui';
import { DraftNotice } from '@/crew/components/DraftNotice';
import { api, ApiError } from '@/crew/lib/api';
import { useDraft } from '@/crew/lib/use-draft';
import { fmtDate, todayIso } from '@/crew/lib/format';
import { timeAgo } from '@/crew/lib/notifications';
import { COLUMNS, dueTone, moveVerb, PRIORITY, STATUS_LABEL, useTask, useTasks } from '@/crew/lib/work';
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** One task, edited in place: every change saves at once and is recorded in its history. */
export function TaskDrawer({ id, onClose, onOpen }) {
    const task = useTask(id);
    const t = task.data;
    const [undo, setUndo] = useState(null);
    return (<>
      <Drawer open={!!id} onClose={onClose} width="max-w-4xl" title={t ? t.key : 'Task'} subtitle={t ? (t.project?.name ?? 'Personal task') : undefined}>
        {task.error ? <ErrorState error={task.error}/> : !t ? <Skeleton className="h-96"/> : <Body key={t.id} t={t} onOpen={onOpen} onDeleted={() => { setUndo({ id: t.id, key: t.key }); onClose(); }}/>}
      </Drawer>
      <UndoBar undo={undo} onDone={() => setUndo(null)} onRestored={(rid) => onOpen?.(rid)}/>
    </>);
}
function Body({ t, onOpen, onDeleted }) {
    const qc = useQueryClient();
    const toast = useToast();
    const mover = useTaskMover();
    const [title, setTitle] = useState(t.title);
    // An unsaved description edit is kept as a draft (closing, cancelling or reloading never loses it).
    const [desc, setDesc, discardDesc, descRestored] = useDraft(`task-description:${t.id}`, t.description);
    const [editingDesc, setEditingDesc] = useState(descRestored);
    const [label, setLabel] = useState('');
    const [sub, setSub] = useState('');
    const [tab, setTab] = useState('comments');
    // "5 min ago" is relative to when the task was opened.
    const [nowMs] = useState(() => Date.now());
    const today = todayIso();
    const refresh = () => void qc.invalidateQueries({ queryKey: ['work'] });
    async function call(path, method, body, done) {
        try {
            await api(path, { method, body });
            refresh();
            if (done)
                toast('success', done);
            return true;
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not save.');
            return false;
        }
    }
    const save = (patch) => call(`/work/tasks/${t.id}`, 'PATCH', patch);
    const move = (to) => void mover.move({ task: { ...t, canApprove: t.can.approve }, to, offerFollowUp: t.status === 'in_review' && to === 'done' });
    async function addSubtask() {
        if (!sub.trim())
            return;
        if (await call('/work/tasks', 'POST', { projectId: t.project?.id ?? null, title: sub.trim(), parentTaskId: t.id, ...(t.project ? {} : { assigneeEmployeeId: t.assignee?.employeeId ?? null }) }))
            setSub('');
    }
    async function comment(body, mentions) {
        try {
            await api(`/work/tasks/${t.id}/comments`, { method: 'POST', body: { body, mentions } });
            void qc.invalidateQueries({ queryKey: ['work', 'task', t.id] });
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not post the comment.');
            throw e;
        }
    }
    async function remove() {
        if (await call(`/work/tasks/${t.id}`, 'DELETE'))
            onDeleted();
    }
    const moves = t.can.moves.filter((m) => m !== t.status);
    const primary = moves.filter((m) => m !== 'cancelled' && m !== 'backlog' && m !== 'todo');
    const secondary = moves.filter((m) => !primary.includes(m));
    return (<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_240px]">
      {mover.dialog}
      <div className="min-w-0 space-y-5">
        {/* status + actions */}
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={t.status}/>
          {t.flag && <Badge tone="danger"><Flag className="size-3"/>Flagged</Badge>}
          {t.reworkCount > 0 && <Badge tone="warning"><RotateCcw className="size-3"/>Rework ×{t.reworkCount}</Badge>}
          {t.completedLate !== null && t.status !== 'in_progress' && <Badge tone={t.completedLate ? 'warning' : 'success'}>{t.completedLate ? 'Finished late' : 'On time'}</Badge>}
          {t.repeats && <Badge tone="brand"><Repeat className="size-3"/>Repeats</Badge>}
          <div className="ml-auto flex flex-wrap gap-1.5">
            {primary.map((m) => (<Button key={m} size="sm" variant={m === 'done' ? 'primary' : 'secondary'} onClick={() => move(m)}>{moveVerb(t.status, m, t.can.approve)}</Button>))}
            {secondary.length > 0 && (<Select aria-label="More moves" value="" onChange={(e) => e.target.value && move(e.target.value)} className="h-8 w-auto py-0 text-sm">
                <option value="">More…</option>
                {secondary.map((m) => <option key={m} value={m}>{moveVerb(t.status, m, t.can.approve)}</option>)}
              </Select>)}
          </div>
        </div>

        {t.status === 'in_review' && (<div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900/40 dark:bg-amber-950/20">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <UserRoundCheck className="size-4 text-amber-700"/>
              <span className="text-fg">Waiting for <b>{t.approver?.name ?? 'review'}</b>{t.submittedAt ? ` · sent ${timeAgo(t.submittedAt, nowMs)}` : ''}</span>
            </div>
            {t.can.approve && (<div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" icon={<CheckCircle2 className="size-4"/>} onClick={() => move('done')}>Approve</Button>
                <Button size="sm" variant="secondary" icon={<RotateCcw className="size-4"/>} onClick={() => move('in_progress')}>Send back</Button>
                {!t.flag && <FlagButton id={t.id} onDone={refresh}/>}
              </div>)}
          </div>)}
        {t.flag && (<div className="flex items-start gap-2 rounded-2xl bg-danger-surface px-4 py-3 text-sm text-danger-text">
            <AlertTriangle className="mt-0.5 size-4 shrink-0"/>
            <div><b>Flagged as not done</b> {timeAgo(t.flag.at, nowMs)} — {t.flag.reason}. Clears when the task is approved.</div>
          </div>)}

        <textarea value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== t.title && void save({ title })} rows={1} readOnly={!t.can.edit} className="w-full resize-none bg-transparent text-xl font-semibold tracking-tight text-fg outline-none focus:rounded-lg focus:ring-2 focus:ring-focus-ring/30"/>
        {t.source && (<Link to={`/work/chat?c=${t.source.channelId}&m=${t.source.messageId}`} className="flex items-center gap-2 rounded-xl bg-bg-subtle px-3 py-2 text-sm text-fg-muted hover:text-fg">
            <Link2 className="size-4"/>Created from a message in {t.source.channelName} — open the conversation
          </Link>)}
        <section>
          <SectionTitle>Description</SectionTitle>
          {editingDesc ? (<div className="space-y-2">
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={8} autoFocus maxLength={20000} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30 sm:text-sm"/>
              <div className="flex gap-2"><Button size="sm" onClick={() => { void save({ description: desc }).then((ok) => ok && discardDesc({ keep: true })); setEditingDesc(false); }}>Save</Button><Button size="sm" variant="ghost" onClick={() => setEditingDesc(false)}>Close</Button>{desc !== t.description && <Button size="sm" variant="ghost" onClick={() => { discardDesc(); setEditingDesc(false); }}>Discard changes</Button>}</div>
              <DraftNotice show={descRestored && desc !== t.description} onDiscard={() => { discardDesc(); setEditingDesc(false); }}/>
            </div>) : (<button onClick={() => t.can.edit && setEditingDesc(true)} className="w-full rounded-xl px-3 py-2 text-left text-sm text-fg hover:bg-bg-subtle">
              {desc !== t.description ? <span className="whitespace-pre-wrap"><span className="mr-1 rounded bg-info-surface px-1 text-[11px] font-semibold text-info-text">Unsaved draft</span>{desc}</span> : t.description ? <span className="whitespace-pre-wrap">{t.description}</span> : <span className="text-fg-subtle">{t.can.edit ? 'Add details, steps or links…' : 'No description.'}</span>}
            </button>)}
        </section>

        <Links t={t} save={save}/>
        <WaitingOn t={t} onOpen={onOpen} call={call}/>

        {!t.parentTaskId && (<section>
            <SectionTitle icon={ListChecks}>Sub-tasks{t.subtasks.length ? ` · ${t.subtasks.filter((s) => s.status === 'done').length}/${t.subtasks.length}` : ''}</SectionTitle>
            <div className="space-y-1">
              {t.subtasks.map((s) => (<div key={s.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-bg-subtle">
                  {s.status === 'done' ? <CheckCircle2 className="size-4 text-success-text"/> : <CircleDashed className="size-4 text-fg-subtle"/>}
                  <button onClick={() => onOpen?.(s.id)} className={cx('flex-1 truncate text-left text-sm', s.status === 'done' ? 'text-fg-subtle line-through' : 'text-fg')}>{s.title}</button>
                  <span className="text-xs text-fg-subtle">{STATUS_LABEL[s.status]}</span>
                  <span className="text-xs text-fg-subtle">{s.key}</span>
                  {s.assignee && <Avatar name={s.assignee.name ?? '?'} size="sm"/>}
                </div>))}
              {t.can.edit && (<form onSubmit={(e) => { e.preventDefault(); void addSubtask(); }} className="flex gap-2 pt-1">
                  <Input value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Add a sub-task" className="h-8" maxLength={250}/>
                  <Button size="sm" variant="ghost" type="submit" icon={<Plus className="size-4"/>} disabled={!sub.trim()}>Add</Button>
                </form>)}
            </div>
          </section>)}

        <section>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {[['comments', `Comments${t.comments.length ? ` (${t.comments.filter((c) => !c.deleted).length})` : ''}`, MessageSquare], ['timeline', 'Status timeline', GitBranch], ['history', 'All changes', History]].map(([k, l, I]) => (<button key={k} onClick={() => setTab(k)} className={cx('flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm', tab === k ? 'border-brand bg-brand-surface text-brand-text' : 'border-border text-fg-muted')}><I className="size-3.5"/>{l}</button>))}
          </div>
          {tab === 'comments' ? (<div className="space-y-4">
              {t.comments.map((c) => (<div key={c.id} className="group flex gap-3">
                  <Avatar name={c.author ?? '?'} size="sm"/>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs"><span className="font-semibold text-fg">{c.author}</span><span className="text-fg-subtle">{timeAgo(c.createdAt, nowMs)}</span>
                      {c.mine && !c.deleted && <button onClick={() => void call(`/work/tasks/${t.id}/comments/${c.id}`, 'DELETE')} className="ml-auto text-fg-subtle transition hover:text-danger-text focus:opacity-100 [@media(hover:hover)]:opacity-0 group-hover:opacity-100" aria-label="Delete comment"><Trash2 className="size-3.5"/></button>}
                    </div>
                    <div className={cx('mt-0.5 text-sm', c.deleted ? 'italic text-fg-subtle' : 'text-fg')}>{c.deleted ? 'Comment deleted' : <RichText body={c.body} mentioned={[]}/>}</div>
                  </div>
                </div>))}
              <Composer draftKey={`task-comment:${t.id}`} onSend={comment} placeholder="Comment — @ to mention someone" compact/>
            </div>) : tab === 'timeline' ? (<Timeline entries={t.timeline}/>) : (<ol className="relative space-y-3 border-l border-border pl-4">
              {t.activity.map((a) => (<li key={a.id} className="relative text-sm">
                  <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-brand"/>
                  <span className="font-medium text-fg">{a.actor ?? 'CrewCore'}</span> <span className="text-fg-muted">{describe(a)}</span>
                  <div className="text-xs text-fg-subtle">{fmtDate(a.at, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</div>
                </li>))}
            </ol>)}
        </section>
      </div>

      <aside className="space-y-4">
        <Prop label="Assignee" icon={UserRound}>
          <PeoplePicker value={t.assignee ? [{ id: t.assignee.employeeId, name: t.assignee.name ?? '' }] : []} onChange={(v) => void save({ assigneeEmployeeId: v.at(-1)?.id ?? null })} max={1} placeholder={t.can.plan ? 'Unassigned' : 'Unassigned — take it'}/>
        </Prop>
        <Prop label="Reviewer" icon={UserRoundCheck}>
          {t.can.plan ? (<PeoplePicker value={t.reviewer ? [{ id: t.reviewer.employeeId, name: t.reviewer.name ?? '' }] : []} onChange={(v) => void save({ reviewerEmployeeId: v.at(-1)?.id ?? null })} max={1} placeholder="Creator, else the manager"/>) : (<div className="text-sm text-fg">{t.reviewer?.name ?? <span className="text-fg-subtle">Creator, else the manager</span>}</div>)}
        </Prop>
        <Prop label="Priority">
          <div className="flex flex-wrap gap-1">
            {Object.keys(PRIORITY).map((p) => (<button key={p} disabled={!t.can.edit} onClick={() => void save({ priority: p })} className={cx('rounded-lg px-2 py-1 text-xs font-medium transition', t.priority === p ? PRIORITY[p].className + ' ring-2 ring-focus-ring/40' : 'text-fg-muted hover:bg-bg-subtle')}>{PRIORITY[p].label}</button>))}
          </div>
        </Prop>
        <DueProp t={t} today={today} save={save} call={call}/>
        <RepeatProp t={t} call={call}/>
        <Prop label="Labels" icon={Tag}>
          <div className="flex flex-wrap gap-1">
            {t.labels.map((l) => (<button key={l} disabled={!t.can.edit} onClick={() => void save({ labels: t.labels.filter((x) => x !== l) })} className="rounded-full bg-bg-subtle px-2 py-0.5 text-xs text-fg-muted hover:bg-danger-surface hover:text-danger-text" title="Remove">{l} ×</button>))}
          </div>
          {t.can.edit && (<form onSubmit={(e) => { e.preventDefault(); if (label.trim()) {
            void save({ labels: [...t.labels, label.trim()] });
            setLabel('');
        } }}>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add a label" className="mt-1 h-8" maxLength={30}/>
            </form>)}
        </Prop>
        {t.goals.length > 0 && (<Prop label="Goals">
            <ul className="space-y-1 text-sm">{t.goals.map((g) => <li key={g.id}><Link to="/performance" className="text-brand-text hover:underline">{g.title}</Link></li>)}</ul>
          </Prop>)}
        <div className="space-y-1 border-t border-border pt-3 text-xs text-fg-subtle">
          <div>Created by {t.reporter?.name ?? 'CrewCore'} · {fmtDate(t.createdAt, { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          {t.department?.name && <div>{t.department.name}</div>}
          {t.startedAt && <div>Started {fmtDate(t.startedAt, { day: 'numeric', month: 'short' })}</div>}
          {t.approvedAt && <div className="text-success-text">Approved {fmtDate(t.approvedAt, { day: 'numeric', month: 'short' })}</div>}
          {t.completedAt && !t.approvedAt && <div className="text-success-text">Done {fmtDate(t.completedAt, { day: 'numeric', month: 'short' })}</div>}
        </div>
        {t.can.delete && !t.sourceMessageId && (<Button size="sm" variant="ghost" icon={<Trash2 className="size-4"/>} onClick={() => void remove()} className="text-danger-text">Delete task</Button>)}
      </aside>
    </div>);
}
// ───────────────────────────── pieces ─────────────────────────────
export function StatusPill({ status }) {
    const col = COLUMNS.find((c) => c.id === status);
    return (<span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-fg">
      <span className={cx('size-2 rounded-full', col?.dot ?? 'bg-border-strong')}/>{STATUS_LABEL[status]}
    </span>);
}
function DueProp({ t, today, save, call }) {
    const [revising, setRevising] = useState(false);
    const [rev, setRev] = useState({ date: t.revisedDueDate ?? t.dueDate ?? '', reason: '' });
    const frozen = !!t.startedAt && !!t.dueDate;
    return (<Prop label="Due" icon={CalendarDays}>
      {frozen ? (<div className="space-y-1 text-sm">
          <div className={cx(t.revisedDueDate ? 'text-fg-subtle line-through' : dueTone(t.dueDate, t.status, today))} title="The original commitment — fixed once work started">{fmtDate(t.dueDate, { day: 'numeric', month: 'short', year: 'numeric' })}</div>
          {t.revisedDueDate && <div className={dueTone(t.revisedDueDate, t.status, today)}>Revised to {fmtDate(t.revisedDueDate, { day: 'numeric', month: 'short', year: 'numeric' })}</div>}
          {t.can.plan && t.status !== 'done' && t.status !== 'cancelled' && !revising && <button onClick={() => setRevising(true)} className="text-xs text-brand-text hover:underline">Revise due date</button>}
          {revising && (<form className="space-y-2 rounded-xl border border-border p-2" onSubmit={async (e) => { e.preventDefault(); if (await call(`/work/tasks/${t.id}/revise-due`, 'POST', { revisedDueDate: rev.date || null, reason: rev.reason }, 'Due date revised.'))
                setRevising(false); }}>
              <Input type="date" value={rev.date} min={t.dueDate ?? undefined} onChange={(e) => setRev({ ...rev, date: e.target.value })}/>
              <Input value={rev.reason} onChange={(e) => setRev({ ...rev, reason: e.target.value })} placeholder="Why (4–500 characters)" maxLength={500}/>
              <div className="flex gap-1"><Button size="sm" type="submit" disabled={rev.reason.trim().length < 4 || !rev.date}>Save</Button><Button size="sm" variant="ghost" type="button" onClick={() => setRevising(false)}>Cancel</Button></div>
            </form>)}
        </div>) : (<Input type="date" value={t.dueDate ?? ''} disabled={!t.can.edit} onChange={(e) => void save({ dueDate: e.target.value || null })}/>)}
    </Prop>);
}
function RepeatProp({ t, call }) {
    const r = t.recurrence;
    const [f, setF] = useState({ frequency: r?.frequency ?? 'none', weekday: r?.weekday ?? 1, monthDay: r?.monthDay ?? 1, dueOffsetDays: r?.dueOffsetDays ?? 0 });
    if (t.parentTaskId || !t.can.edit) {
        return r ? <Prop label="Repeats" icon={Repeat}><div className="text-sm text-fg">{describeRepeat(r)}</div></Prop> : null;
    }
    const apply = (next) => {
        setF(next);
        if (next.frequency === 'none')
            void call(`/work/tasks/${t.id}/recurrence`, 'DELETE', undefined, 'No longer repeats.');
        else
            void call(`/work/tasks/${t.id}/recurrence`, 'PUT', next.frequency === 'weekly' ? { frequency: 'weekly', weekday: next.weekday, dueOffsetDays: next.dueOffsetDays } : { frequency: 'monthly', monthDay: next.monthDay, dueOffsetDays: next.dueOffsetDays });
    };
    return (<Prop label="Repeat" icon={Repeat}>
      <div className="space-y-1.5">
        <Select value={f.frequency} onChange={(e) => apply({ ...f, frequency: e.target.value })}>
          <option value="none">Does not repeat</option>
          <option value="weekly">Every week</option>
          <option value="monthly">Every month</option>
        </Select>
        {f.frequency === 'weekly' && <Select value={f.weekday} onChange={(e) => apply({ ...f, weekday: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>on {d}</option>)}</Select>}
        {f.frequency === 'monthly' && <Select value={f.monthDay} onChange={(e) => apply({ ...f, monthDay: Number(e.target.value) })}>{Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>on day {i + 1}</option>)}</Select>}
        {f.frequency !== 'none' && (<Select value={f.dueOffsetDays} onChange={(e) => apply({ ...f, dueOffsetDays: Number(e.target.value) })}>
            {[0, 1, 2, 3, 5, 7, 10, 14, 21, 30].map((n) => <option key={n} value={n}>{n === 0 ? 'due the same day' : `due ${n} day${n > 1 ? 's' : ''} later`}</option>)}
          </Select>)}
        {r && <div className="text-xs text-fg-subtle">Next copy {fmtDate(r.nextRunOn, { day: 'numeric', month: 'short' })}</div>}
      </div>
    </Prop>);
}
const describeRepeat = (r) => r.frequency === 'weekly' ? `Every ${WEEKDAYS[r.weekday ?? 1]}` : `Every month on day ${r.monthDay}`;
function Links({ t, save }) {
    const [adding, setAdding] = useState('');
    if (!t.links.length && !t.can.edit)
        return null;
    return (<section>
      <SectionTitle icon={Link2}>Deliverables</SectionTitle>
      <div className="space-y-1">
        {t.links.map((l) => (<div key={l} className="group flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-bg-subtle">
            <Link2 className="size-3.5 shrink-0 text-fg-subtle"/>
            <a href={l} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate text-sm text-brand-text hover:underline">{l.replace(/^https?:\/\//, '')}</a>
            {t.can.edit && <button onClick={() => void save({ links: t.links.filter((x) => x !== l) })} className="text-fg-subtle hover:text-danger-text [@media(hover:hover)]:opacity-0 group-hover:opacity-100" aria-label="Remove link"><X className="size-3.5"/></button>}
          </div>))}
        {t.can.edit && t.links.length < 10 && (<form onSubmit={(e) => { e.preventDefault(); if (adding.trim())
            void save({ links: [...t.links, adding.trim()] }).then((ok) => ok && setAdding('')); }} className="flex gap-2">
            <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Paste a link to the work (https://…)" className="h-8" type="url"/>
            <Button size="sm" variant="ghost" type="submit" disabled={!adding.trim()}>Add</Button>
          </form>)}
      </div>
    </section>);
}
function WaitingOn({ t, onOpen, call }) {
    const [q, setQ] = useState('');
    const [picking, setPicking] = useState(false);
    const found = useTasks({ q: q.trim() || undefined, open: true }, picking && q.trim().length > 1);
    const ids = t.waitingOn.map((w) => w.id);
    const pickRef = useDismiss(picking, () => setPicking(false));
    if (!t.waitingOn.length && !t.blocking.length && !t.can.edit)
        return null;
    return (<section>
      <SectionTitle icon={GitBranch}>Waiting on{t.waitingOn.length ? ` · ${t.waitingOn.filter((w) => w.status !== 'done' && w.status !== 'cancelled').length} open` : ''}</SectionTitle>
      <div className="space-y-1">
        {t.waitingOn.map((w) => (<div key={w.id} className="group flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-bg-subtle">
            {w.status === 'done' ? <CheckCircle2 className="size-4 text-success-text"/> : <CircleDashed className="size-4 text-fg-subtle"/>}
            <button onClick={() => onOpen?.(w.id)} className="min-w-0 flex-1 truncate text-left text-sm text-fg">{w.title}</button>
            <span className="text-xs text-fg-subtle">{w.key} · {STATUS_LABEL[w.status]}</span>
            {t.can.edit && <button onClick={() => void call(`/work/tasks/${t.id}/dependencies`, 'PUT', { taskIds: ids.filter((x) => x !== w.id) })} className="text-fg-subtle hover:text-danger-text [@media(hover:hover)]:opacity-0 group-hover:opacity-100" aria-label="Stop waiting on this"><X className="size-3.5"/></button>}
          </div>))}
        {t.blocking.length > 0 && <div className="px-2 pt-1 text-xs text-fg-subtle">Blocking {t.blocking.map((b) => b.key).join(', ')}</div>}
        {t.can.edit && (picking ? (<div ref={pickRef} className="relative">
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a task by title or key" className="h-8" autoFocus/>
            {(found.data?.length ?? 0) > 0 && (<div className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-2">
                {found.data.filter((x) => x.id !== t.id && !ids.includes(x.id)).slice(0, 8).map((x) => (<button key={x.id} onMouseDown={(e) => e.preventDefault()} onClick={() => { void call(`/work/tasks/${t.id}/dependencies`, 'PUT', { taskIds: [...ids, x.id] }); setQ(''); setPicking(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-bg-subtle">
                    <span className="text-xs font-semibold text-fg-subtle">{x.key}</span><span className="truncate text-fg">{x.title}</span>
                  </button>))}
              </div>)}
          </div>) : (<Button size="sm" variant="ghost" icon={<Plus className="size-4"/>} onClick={() => setPicking(true)}>Wait on a task</Button>))}
      </div>
    </section>);
}
function FlagButton({ id, onDone }) {
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const [reason, setReason] = useState('');
    if (!open)
        return <Button size="sm" variant="ghost" icon={<Flag className="size-4"/>} onClick={() => setOpen(true)}>Flag as not done</Button>;
    return (<form className="flex w-full gap-2" onSubmit={async (e) => {
            e.preventDefault();
            try {
                await api(`/work/tasks/${id}/flag`, { method: 'POST', body: { reason } });
                toast('success', 'Flagged. The assignee has been told.');
                onDone();
            }
            catch (err) {
                toast('danger', err instanceof ApiError ? err.message : 'Could not flag.');
            }
        }}>
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What is wrong? (4–500 characters)" maxLength={500} autoFocus className="h-8"/>
      <Button size="sm" variant="danger" type="submit" disabled={reason.trim().length < 4}>Flag</Button>
    </form>);
}
const KIND_TEXT = {
    move: 'moved it',
    submit: 'completed it',
    approve: 'approved it',
    send_back: 'sent it back',
    flag: 'flagged it as not done',
    reopen: 'reopened it',
    cancel: 'cancelled it',
    restore: 'restored it',
    revise_due: 'changed the due date',
};
function Timeline({ entries }) {
    if (!entries.length)
        return <p className="text-sm text-fg-subtle">No status changes yet.</p>;
    return (<ol className="relative space-y-4 border-l border-border pl-4">
      {entries.map((h) => (<li key={h.id} className="relative text-sm">
          <span className={cx('absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface', h.kind === 'approve' ? 'bg-success-solid' : h.kind === 'send_back' || h.kind === 'flag' || h.kind === 'cancel' ? 'bg-danger-solid' : 'bg-brand')}/>
          <div>
            <span className="font-medium text-fg">{h.actor ?? 'CrewCore'}</span>{' '}
            <span className="text-fg-muted">{h.kind === 'move' && !h.from ? 'created it in' : KIND_TEXT[h.kind]}</span>
            {h.kind === 'revise_due' ? (<span className="text-fg-muted"> {h.fromDue ? `from ${fmtDate(h.fromDue, { day: 'numeric', month: 'short' })} ` : ''}to {h.toDue ? fmtDate(h.toDue, { day: 'numeric', month: 'short' }) : '—'}</span>) : h.to && h.from !== h.to ? (<span className="text-fg-muted"> {h.from ? `${STATUS_LABEL[h.from]} → ` : ''}<b className="font-medium text-fg">{STATUS_LABEL[h.to]}</b></span>) : null}
          </div>
          {h.reason && <div className="mt-1 rounded-lg bg-bg-subtle px-2 py-1 text-fg">“{h.reason}”</div>}
          {h.note && <div className="mt-1 text-fg-muted">{h.note}</div>}
          <div className="text-xs text-fg-subtle">{fmtDate(h.at, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</div>
        </li>))}
    </ol>);
}
/** "Deleted · Undo" for 8 seconds after a delete. */
function UndoBar({ undo, onDone, onRestored }) {
    const qc = useQueryClient();
    const toast = useToast();
    useEffect(() => {
        if (!undo)
            return;
        const t = setTimeout(onDone, 8000);
        return () => clearTimeout(t);
    }, [undo, onDone]);
    return (<AnimatePresence>
      {undo && (<motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }} className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[230] flex -translate-x-1/2 items-center gap-3 rounded-full bg-ink-900 px-4 py-2 text-sm text-white shadow-3">
          <span>{undo.key} deleted</span>
          <button className="font-semibold text-iris-200 hover:text-white" onClick={async () => {
                try {
                    await api(`/work/tasks/${undo.id}/undelete`, { method: 'POST' });
                    void qc.invalidateQueries({ queryKey: ['work'] });
                    onRestored(undo.id);
                }
                catch (e) {
                    toast('danger', e instanceof ApiError ? e.message : 'Could not undo.');
                }
                onDone();
            }}>Undo</button>
        </motion.div>)}
    </AnimatePresence>);
}
function SectionTitle({ children, icon: I }) {
    return <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-fg-subtle">{I && <I className="size-3.5"/>}{children}</div>;
}
function Prop({ label, icon: I, children }) {
    return (<div>
      <div className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-fg-subtle">{I && <I className="size-3"/>}{label}</div>
      {children}
    </div>);
}
function describe(a) {
    if (a.action === 'created')
        return 'created the task';
    if (a.action === 'commented')
        return 'commented';
    if (a.action === 'deleted')
        return 'deleted the task';
    if (a.action === 'restored')
        return 'restored the task';
    const c = a.changes;
    const parts = [];
    if (c.status)
        parts.push(`moved it to ${STATUS_LABEL[c.status.to] ?? c.status.to}`);
    if (c.title)
        parts.push('renamed it');
    if (c.description)
        parts.push('edited the description');
    if (c.priority)
        parts.push(`set priority to ${PRIORITY[c.priority.to]?.label ?? c.priority.to}`);
    if (c.assignee_employee_id)
        parts.push(c.assignee_employee_id.to ? 'changed the assignee' : 'unassigned it');
    if (c.reviewer_employee_id)
        parts.push(c.reviewer_employee_id.to ? 'set the reviewer' : 'removed the reviewer');
    if (c.due_date)
        parts.push(c.due_date.to ? `set the due date to ${fmtDate(String(c.due_date.to))}` : 'removed the due date');
    if (c.revised_due_date)
        parts.push('revised the due date');
    if (c.labels)
        parts.push('changed the labels');
    if (c.links)
        parts.push('changed the deliverable links');
    if (c.waiting_on)
        parts.push('changed what it waits on');
    if (c.repeat)
        parts.push(c.repeat.to ? 'set it to repeat' : 'stopped the repeat');
    if (c.goals)
        parts.push('changed the linked goals');
    if (c.parent_task_id)
        parts.push('changed the parent task');
    return parts.join(', ') || 'updated it';
}
