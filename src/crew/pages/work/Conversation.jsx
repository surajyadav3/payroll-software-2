import { useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, CheckSquare, Hash, Lock, MessageSquareReply, MoreHorizontal, Pencil, Trash2, Users, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDismiss } from '@/crew/lib/use-dismiss';
import { Composer, RichText } from '@/crew/components/work/Composer';
import { PeoplePicker } from '@/crew/components/work/PeoplePicker';
import { Avatar, Button, cx, Drawer, Field, Select, Skeleton, TextField, useToast } from '@/crew/components/ui';
import { api, ApiError } from '@/crew/lib/api';
import { useCrewFeatures } from '@/crew/lib/features';
import { fmtDate } from '@/crew/lib/format';
import { COLUMNS, PRIORITY, STATUS_LABEL, useChannel, useMessages, useProjects, useThread } from '@/crew/lib/work';
const QUICK = ['👍', '❤️', '😂', '🎉', '✅', '👀'];
const fmtClock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dayOf = (iso) => iso.slice(0, 10);
/** One conversation: messages (live), composer, threads, reactions, and turning messages into tasks. */
export function Conversation({ channelId, onOpenTask, focusMessageId, hideHeader }) {
    const channel = useChannel(channelId);
    const msgs = useMessages(channelId);
    const qc = useQueryClient();
    const toast = useToast();
    const [thread, setThread] = useState(null);
    const [toTask, setToTask] = useState(null);
    const features = useCrewFeatures();
    const scroller = useRef(null);
    const atBottom = useRef(true);
    const c = channel.data;
    const count = msgs.messages.length;
    // Open a thread when arriving from a notification about a reply (the focus message's thread root).
    const [opened, setOpened] = useState(null);
    if (focusMessageId && focusMessageId !== opened && msgs.messages.length) {
        setOpened(focusMessageId);
        const m = msgs.messages.find((x) => x.id === focusMessageId);
        if (m && m.replyCount > 0)
            setThread(m.id);
    }
    // Stay at the bottom as messages arrive, unless the person scrolled up to read history.
    useLayoutEffect(() => {
        const el = scroller.current;
        if (el && atBottom.current)
            el.scrollTop = el.scrollHeight;
    }, [count, channelId]);
    useEffect(() => {
        atBottom.current = true;
    }, [channelId]);
    // Reading the channel clears its unread count.
    useEffect(() => {
        if (!c?.member || !count)
            return;
        void api(`/work/channels/${channelId}/read`, { method: 'POST', body: {} }).then(() => qc.invalidateQueries({ queryKey: ['work', 'channels'] }));
    }, [channelId, count, c?.member, qc]);
    async function send(body, mentions, threadRootId = null) {
        try {
            await api(`/work/channels/${channelId}/messages`, { method: 'POST', body: { body, mentions, threadRootId, clientKey: crypto.randomUUID() } });
            atBottom.current = true;
            // Our own change is read back at once (the live push would bring it a moment later).
            void msgs.pull();
            void qc.invalidateQueries({ queryKey: ['work', 'channels'] });
            if (threadRootId)
                void qc.invalidateQueries({ queryKey: ['work', 'thread', threadRootId] });
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not send.');
            throw e;
        }
    }
    async function act(path, method, body) {
        try {
            await api(path, { method, body });
            // Our own change is read back at once (the live push would bring it a moment later).
            void msgs.pull();
            if (thread)
                void qc.invalidateQueries({ queryKey: ['work', 'thread', thread] });
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not do that.');
        }
    }
    async function setMuted(muted) {
        await act(`/work/channels/${channelId}`, 'PATCH', { muted });
        void qc.invalidateQueries({ queryKey: ['work', 'channel', channelId] });
    }
    return (<div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {!hideHeader && (<div className="flex items-center gap-3 border-b border-border px-5 py-3">
            {c ? (<>
                <span className="rounded-lg bg-bg-subtle p-1.5 text-fg-muted">{c.kind === 'direct' ? <Users className="size-4"/> : c.kind === 'private' ? <Lock className="size-4"/> : <Hash className="size-4"/>}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-fg">{c.title}</div>
                  <div className="truncate text-xs text-fg-muted">{c.topic ?? (c.kind === 'direct' ? 'Direct message' : `${c.memberCount} members`)}{c.project ? ` · project ${c.project.key}` : ''}</div>
                </div>
                {c.member && <button onClick={() => void setMuted(!c.muted)} className="rounded-lg p-2 text-fg-muted hover:bg-bg-subtle" title={c.muted ? 'Unmute' : 'Mute notifications'}>{c.muted ? <BellOff className="size-4"/> : <Bell className="size-4"/>}</button>}
              </>) : <Skeleton className="h-8 w-48"/>}
          </div>)}
        <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 scroll-quiet">
          {msgs.hasNextPage && <div className="mb-3 text-center"><Button size="sm" variant="ghost" onClick={() => { atBottom.current = false; void msgs.fetchNextPage(); }} loading={msgs.isFetchingNextPage}>Load earlier messages</Button></div>}
          {msgs.isLoading ? <div className="space-y-3 px-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12"/>)}</div> : count === 0 ? (<div className="flex h-full flex-col items-center justify-center text-center">
              <span className="rounded-2xl bg-iris-100 p-3 text-iris-700"><Hash className="size-6"/></span>
              <div className="mt-3 font-semibold text-fg">This is the start of {c?.title ?? 'the conversation'}</div>
              <div className="text-sm text-fg-muted">Say hello — @ mentions notify people.</div>
            </div>) : msgs.messages.map((m, i) => {
            const prev = msgs.messages[i - 1];
            const newDay = !prev || dayOf(prev.createdAt) !== dayOf(m.createdAt);
            const grouped = !newDay && prev && prev.kind === 'text' && m.kind === 'text' && prev.author?.employeeId === m.author?.employeeId && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000;
            return (<div key={m.id}>
                {newDay && <DaySeparator iso={m.createdAt}/>}
                <MessageRow m={m} grouped={!!grouped} focused={m.id === focusMessageId} onOpenTask={onOpenTask} onThread={() => setThread(m.id)} onTask={features.tasks ? () => setToTask(m) : undefined} onAct={act}/>
              </div>);
        })}
        </div>
        <div className="border-t border-border p-3">
          {c && !c.member && c.kind === 'public' && <div className="mb-2 text-center text-xs text-fg-muted">You are viewing #{c.name}. Sending a message joins it.</div>}
          {c?.archived ? <div className="rounded-xl bg-bg-subtle p-3 text-center text-sm text-fg-muted">This channel is archived.</div> : <Composer key={channelId} draftKey={`channel:${channelId}`} onSend={(b, m) => send(b, m)} placeholder={c ? `Message ${c.title}` : undefined}/>}
        </div>
      </div>
      {thread && <ThreadPanel rootId={thread} onClose={() => setThread(null)} onSend={(b, m) => send(b, m, thread)} onOpenTask={onOpenTask} onAct={act}/>}
      <MakeTask message={toTask} onClose={() => setToTask(null)} onCreated={(id) => { setToTask(null); onOpenTask(id); void qc.invalidateQueries({ queryKey: ['work'] }); }}/>
    </div>);
}
function DaySeparator({ iso }) {
    const d = dayOf(iso);
    const today = new Date().toISOString().slice(0, 10);
    const label = d === today ? 'Today' : fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' });
    return (<div className="my-4 flex items-center gap-3 px-2"><span className="h-px flex-1 bg-border"/><span className="rounded-full border border-border bg-surface px-3 py-0.5 text-xs font-medium text-fg-muted">{label}</span><span className="h-px flex-1 bg-border"/></div>);
}
function TaskChip({ task, onOpen }) {
    const col = COLUMNS.find((c) => c.id === task.status);
    return (<button onClick={onOpen} className="mt-1.5 flex max-w-md items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-left text-sm shadow-1 transition hover:border-brand">
      <CheckSquare className="size-4 shrink-0 text-brand-text"/>
      <span className="shrink-0 text-xs font-semibold text-fg-muted">{task.key}</span>
      <span className="min-w-0 flex-1 truncate text-fg">{task.title}</span>
      <span className="flex shrink-0 items-center gap-1 text-xs text-fg-muted"><span className={cx('size-2 rounded-full', col?.dot ?? 'bg-border-strong')}/>{STATUS_LABEL[task.status]}</span>
    </button>);
}
function MessageRow({ m, grouped, focused, onOpenTask, onThread, onTask, onAct, inThread }) {
    const [menu, setMenu] = useState(false);
    const menuRef = useDismiss(menu, () => setMenu(false));
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(m.body);
    if (m.kind === 'system') {
        return (<div className="my-1.5 flex flex-col items-center px-2 text-center">
        <span className="rounded-full bg-bg-subtle px-3 py-1 text-xs text-fg-muted">{m.body} · {fmtClock(m.createdAt)}</span>
        {m.task && !inThread && <TaskChip task={m.task} onOpen={() => onOpenTask(m.task.id)}/>}
      </div>);
    }
    return (
    // tabIndex: on touch screens, tapping a message focuses it and reveals its actions (no hover there).
    <div tabIndex={0} className={cx('group relative flex gap-3 rounded-xl px-2 py-1 outline-none transition hover:bg-bg-subtle/60 focus-within:bg-bg-subtle/60', !grouped && 'mt-2', focused && 'bg-brand-surface/60 ring-1 ring-brand/30')}>
      <div className="w-9 shrink-0">{!grouped ? <Avatar name={m.author?.name ?? '?'}/> : <span className="hidden pt-0.5 text-[10px] text-fg-subtle group-hover:block">{fmtClock(m.createdAt)}</span>}</div>
      <div className="min-w-0 flex-1">
        {!grouped && <div className="flex items-baseline gap-2"><span className="text-sm font-semibold text-fg">{m.author?.name}</span><span className="text-xs text-fg-subtle">{fmtClock(m.createdAt)}</span></div>}
        {m.deleted ? <div className="text-sm italic text-fg-subtle">Message deleted</div> : editing ? (<form onSubmit={(e) => { e.preventDefault(); void onAct(`/work/messages/${m.id}`, 'PATCH', { body: text }).then(() => setEditing(false)); }} className="space-y-1">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} autoFocus className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand"/>
            <div className="flex gap-2"><Button size="sm" type="submit">Save</Button><Button size="sm" variant="ghost" type="button" onClick={() => { setEditing(false); setText(m.body); }}>Cancel</Button></div>
          </form>) : (<div className="text-sm leading-relaxed text-fg"><RichText body={m.body} mentioned={m.mentioned}/>{m.editedAt && <span className="ml-1 text-[11px] text-fg-subtle">(edited)</span>}</div>)}
        {m.task && <TaskChip task={m.task} onOpen={() => onOpenTask(m.task.id)}/>}
        {m.reactions.length > 0 && (<div className="mt-1 flex flex-wrap gap-1">
            {m.reactions.map((r) => (<button key={r.emoji} onClick={() => void onAct(`/work/messages/${m.id}/reactions`, 'POST', { emoji: r.emoji })} className={cx('flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition', r.mine ? 'border-brand bg-brand-surface text-brand-text' : 'border-border text-fg-muted hover:border-border-strong')}>
                <span>{r.emoji}</span><span className="tabular">{r.count}</span>
              </button>))}
          </div>)}
        {!inThread && m.replyCount > 0 && (<button onClick={onThread} className="mt-1 flex items-center gap-1.5 text-xs font-medium text-brand-text hover:underline"><MessageSquareReply className="size-3.5"/>{m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}{m.lastReplyAt ? ` · last ${fmtClock(m.lastReplyAt)}` : ''}</button>)}
      </div>
      {!m.deleted && !editing && (<div className="absolute -top-3 right-2 hidden items-center gap-0.5 rounded-xl border border-border bg-surface p-0.5 shadow-2 group-focus-within:flex group-hover:flex">
          {QUICK.slice(0, 3).map((e) => <button key={e} onClick={() => void onAct(`/work/messages/${m.id}/reactions`, 'POST', { emoji: e })} className="rounded-lg px-1.5 py-1 text-sm hover:bg-bg-subtle" aria-label={`React ${e}`}>{e}</button>)}
          <div ref={menuRef} className="relative">
            <button onClick={() => setMenu((o) => !o)} aria-expanded={menu} className="rounded-lg p-1.5 text-fg-muted hover:bg-bg-subtle" aria-label="More"><MoreHorizontal className="size-4"/></button>
            {menu && (<>
                <div className="absolute right-0 z-40 mt-1 w-52 rounded-xl border border-border bg-surface p-1 shadow-3">
                  <div className="flex gap-0.5 border-b border-border px-1 pb-1">{QUICK.map((e) => <button key={e} onClick={() => { setMenu(false); void onAct(`/work/messages/${m.id}/reactions`, 'POST', { emoji: e }); }} className="rounded-lg px-1.5 py-1 hover:bg-bg-subtle">{e}</button>)}</div>
                  {!inThread && onThread && <MenuItem icon={MessageSquareReply} onClick={() => { setMenu(false); onThread(); }}>Reply in thread</MenuItem>}
                  {!m.task && onTask && <MenuItem icon={CheckSquare} onClick={() => { setMenu(false); onTask(); }}>Make it a task</MenuItem>}
                  {m.mine && <MenuItem icon={Pencil} onClick={() => { setMenu(false); setEditing(true); }}>Edit</MenuItem>}
                  {m.mine && <MenuItem icon={Trash2} danger onClick={() => { setMenu(false); void onAct(`/work/messages/${m.id}`, 'DELETE'); }}>Delete</MenuItem>}
                </div>
              </>)}
          </div>
        </div>)}
    </div>);
}
function MenuItem({ icon: I, children, onClick, danger }) {
    return <button onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm', danger ? 'text-danger-text hover:bg-danger-surface' : 'text-fg hover:bg-bg-subtle')}><I className="size-4"/>{children}</button>;
}
function ThreadPanel({ rootId, onClose, onSend, onOpenTask, onAct }) {
    const t = useThread(rootId);
    return (<aside className="flex w-full max-w-sm shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-3"><span className="font-semibold text-fg">Thread</span><button onClick={onClose} className="rounded-lg p-1.5 text-fg-muted hover:bg-bg-subtle" aria-label="Close thread"><X className="size-4"/></button></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3 scroll-quiet">
        {!t.data ? <Skeleton className="h-24"/> : (<>
            <MessageRow m={t.data.root} grouped={false} onOpenTask={onOpenTask} onAct={onAct} inThread/>
            <div className="my-3 flex items-center gap-2 px-2 text-xs text-fg-subtle"><span>{t.data.replies.length} {t.data.replies.length === 1 ? 'reply' : 'replies'}</span><span className="h-px flex-1 bg-border"/></div>
            {t.data.replies.map((r, i) => <MessageRow key={r.id} m={r} grouped={i > 0 && t.data.replies[i - 1].author?.employeeId === r.author?.employeeId && r.kind === 'text' && t.data.replies[i - 1].kind === 'text'} onOpenTask={onOpenTask} onAct={onAct} inThread/>)}
          </>)}
      </div>
      <div className="border-t border-border p-3"><Composer key={rootId} draftKey={`thread:${rootId}`} onSend={onSend} placeholder="Reply…" compact autoFocus/></div>
    </aside>);
}
function MakeTask({ message, onClose, onCreated }) {
    const projects = useProjects();
    const toast = useToast();
    const [f, setF] = useState({ projectId: '', title: '', priority: 'medium', dueDate: '' });
    const [assignee, setAssignee] = useState([]);
    const [busy, setBusy] = useState(false);
    const [was, setWas] = useState(null);
    const active = (projects.data ?? []).filter((p) => p.status === 'active');
    if ((message?.id ?? null) !== was) {
        setWas(message?.id ?? null);
        if (message) {
            setF({ projectId: active[0]?.id ?? '', title: message.body.split('\n')[0].slice(0, 200), priority: 'medium', dueDate: '' });
            setAssignee([]);
        }
    }
    async function create(e) {
        e.preventDefault();
        if (!message)
            return;
        setBusy(true);
        try {
            const t = await api(`/work/messages/${message.id}/task`, { method: 'POST', body: { projectId: f.projectId || active[0]?.id, title: f.title, priority: f.priority, assigneeEmployeeId: assignee[0]?.id ?? null, dueDate: f.dueDate || null } });
            toast('success', `${t.key} created and linked to the message.`);
            onCreated(t.id);
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not create the task.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<Drawer open={!!message} onClose={onClose} title="Make it a task" subtitle="The task links back to this message, and the thread follows its progress." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="msg-task" loading={busy} disabled={!active.length || !f.title.trim()}>Create task</Button></>}>
      {!active.length ? <p className="text-sm text-fg-muted">Create a project first (Work → Projects).</p> : (<form id="msg-task" onSubmit={create} className="space-y-4">
          {message && <blockquote className="rounded-xl border-l-4 border-brand bg-bg-subtle px-3 py-2 text-sm text-fg-muted">{message.body.slice(0, 400)}</blockquote>}
          <Field label="Project"><Select value={f.projectId || active[0]?.id} onChange={(e) => setF({ ...f, projectId: e.target.value })}>{active.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}</Select></Field>
          <TextField label="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={250} required/>
          <Field label="Assign to"><PeoplePicker value={assignee} onChange={(v) => setAssignee(v.slice(-1))} max={1} placeholder="Nobody yet"/></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Priority"><Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{Object.keys(PRIORITY).map((p) => <option key={p} value={p}>{PRIORITY[p].label}</option>)}</Select></Field>
            <TextField label="Due" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })}/>
          </div>
        </form>)}
    </Drawer>);
}
