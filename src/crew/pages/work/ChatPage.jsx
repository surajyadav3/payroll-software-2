import { useQueryClient } from '@tanstack/react-query';
import { AtSign, Hash, Lock, MessageCircle, Plus, Search, SquarePen, Users } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PeoplePicker } from '@/crew/components/work/PeoplePicker';
import { Avatar, Button, Card, cx, Drawer, EmptyState, ErrorState, Field, Input, Skeleton, TextField, useToast } from '@/crew/components/ui';
import { api, ApiError } from '@/crew/lib/api';
import { useChannels } from '@/crew/lib/work';
import { Conversation } from './Conversation';
import { TaskDrawer } from './TaskDrawer';
/** Company messaging: #general, channels, project channels and direct messages. */
export function ChatPage() {
    const channels = useChannels();
    const [params, setParams] = useSearchParams();
    const navigate = useNavigate();
    const [q, setQ] = useState('');
    const [creating, setCreating] = useState(null);
    const [task, setTask] = useState(null);
    const all = channels.data ?? [];
    const selected = params.get('c') ?? all.find((c) => c.isDefault)?.id ?? all[0]?.id ?? null;
    const focus = params.get('m');
    const filter = (c) => !q || c.title.toLowerCase().includes(q.toLowerCase());
    const named = all.filter((c) => c.kind !== 'direct' && c.kind !== 'project' && (c.member || c.kind === 'public')).filter(filter);
    const projects = all.filter((c) => c.kind === 'project' && c.member).filter(filter);
    const direct = all.filter((c) => c.kind === 'direct').filter(filter);
    const open = (id) => setParams({ c: id }, { replace: false });
    return (<div className="flex h-full min-h-0">
      {/* Phones: the list, or one conversation full width (with a way back). */}
      <aside className={cx('w-full shrink-0 flex-col border-r border-border bg-surface md:flex md:w-72', params.get('c') ? 'hidden' : 'flex')}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="flex-1 font-semibold text-fg">Messages</span>
          <button onClick={() => setCreating('direct')} className="rounded-lg p-1.5 text-fg-muted hover:bg-bg-subtle hover:text-fg" title="New message" aria-label="New message"><SquarePen className="size-4"/></button>
        </div>
        <div className="p-3">
          <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"/><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a conversation" className="h-9 pl-8"/></div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 scroll-quiet">
          <button onClick={() => navigate('/work/mentions')} className="mb-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-fg-muted hover:bg-bg-subtle hover:text-fg"><AtSign className="size-4"/>Mentions</button>
          {channels.isLoading ? <Skeleton className="h-40"/> : (<>
              <Section title="Channels" action={() => setCreating('channel')}>
                {named.map((c) => <Item key={c.id} c={c} active={c.id === selected} onClick={() => open(c.id)}/>)}
              </Section>
              {projects.length > 0 && <Section title="Projects">{projects.map((c) => <Item key={c.id} c={c} active={c.id === selected} onClick={() => open(c.id)}/>)}</Section>}
              <Section title="Direct messages" action={() => setCreating('direct')}>
                {direct.length === 0 ? <p className="px-2 py-1 text-xs text-fg-subtle">No conversations yet.</p> : direct.map((c) => <Item key={c.id} c={c} active={c.id === selected} onClick={() => open(c.id)}/>)}
              </Section>
            </>)}
        </div>
      </aside>
      <main className={cx('min-w-0 flex-1 flex-col bg-bg md:flex', params.get('c') ? 'flex' : 'hidden')}>
        <button onClick={() => setParams({})} className="flex items-center gap-1 border-b border-border px-4 py-2 text-sm text-brand-text md:hidden">← All conversations</button>
        {channels.error ? <div className="p-6"><ErrorState error={channels.error}/></div> : selected ? (<div className="min-h-0 flex-1"><Conversation key={selected} channelId={selected} focusMessageId={focus} onOpenTask={setTask}/></div>) : (<div className="p-6"><Card><EmptyState icon={<MessageCircle className="size-6"/>} title="No conversations yet" body="Start a channel for your team or message a colleague."/></Card></div>)}
      </main>
      <NewChannel open={creating === 'channel'} onClose={() => setCreating(null)} onCreated={open}/>
      <NewDirect open={creating === 'direct'} onClose={() => setCreating(null)} onCreated={open}/>
      <TaskDrawer id={task} onClose={() => setTask(null)} onOpen={setTask}/>
    </div>);
}
function Section({ title, action, children }) {
    return (<div className="mt-3">
      <div className="flex items-center justify-between px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
        {title}
        {action && <button onClick={action} className="rounded p-0.5 hover:bg-bg-subtle hover:text-fg" aria-label={`New in ${title}`}><Plus className="size-3.5"/></button>}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>);
}
function Item({ c, active, onClick }) {
    const unread = c.unread > 0 && !c.muted;
    return (<button onClick={onClick} className={cx('flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition', active ? 'bg-brand-surface text-brand-text' : unread ? 'font-semibold text-fg hover:bg-bg-subtle' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
      {c.kind === 'direct' ? (c.people.length > 1 ? <Users className="size-4 shrink-0"/> : <Avatar name={c.people[0]?.name ?? '?'} size="sm"/>) : c.kind === 'private' ? <Lock className="size-4 shrink-0"/> : <Hash className="size-4 shrink-0"/>}
      <span className={cx('min-w-0 flex-1 truncate', !c.member && 'italic opacity-70')}>{c.kind === 'direct' ? c.title : c.name}</span>
      {c.mentions > 0 ? <span className="rounded-full bg-ember-500 px-1.5 text-[11px] font-bold text-white">@{c.mentions}</span> : unread ? <span className="rounded-full bg-brand px-1.5 text-[11px] font-bold text-on-brand">{c.unread > 99 ? '99+' : c.unread}</span> : null}
    </button>);
}
function NewChannel({ open, onClose, onCreated }) {
    const qc = useQueryClient();
    const toast = useToast();
    const [f, setF] = useState({ name: '', topic: '', kind: 'public' });
    const [people, setPeople] = useState([]);
    const [busy, setBusy] = useState(false);
    async function create(e) {
        e.preventDefault();
        setBusy(true);
        try {
            const c = await api('/work/channels', { method: 'POST', body: { ...f, topic: f.topic || null, memberIds: people.map((p) => p.id) } });
            void qc.invalidateQueries({ queryKey: ['work', 'channels'] });
            onCreated(c.id);
            setF({ name: '', topic: '', kind: 'public' });
            setPeople([]);
            onClose();
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not create the channel.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<Drawer open={open} onClose={onClose} title="New channel" subtitle="A place for a team, a topic or an outlet." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="new-channel" loading={busy} disabled={!f.name.trim()}>Create</Button></>}>
      <form id="new-channel" onSubmit={create} className="space-y-4">
        <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. sales-north" maxLength={80} required hint="Lower-case; spaces become dashes."/>
        <TextField label="What is it about? (optional)" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} maxLength={250}/>
        <Field label="Who can see it">
          <div className="grid grid-cols-2 gap-2">
            {[['public', 'Everyone', Hash, 'Anyone can find and join it'], ['private', 'Invited only', Lock, 'Only the people you add']].map(([k, l, I, d]) => (<button type="button" key={k} onClick={() => setF({ ...f, kind: k })} className={cx('rounded-xl border p-3 text-left', f.kind === k ? 'border-brand bg-brand-surface' : 'border-border')}>
                <span className="flex items-center gap-1.5 text-sm font-medium text-fg"><I className="size-4"/>{l}</span>
                <span className="text-xs text-fg-muted">{d}</span>
              </button>))}
          </div>
        </Field>
        <Field label="Add people"><PeoplePicker value={people} onChange={setPeople}/></Field>
      </form>
    </Drawer>);
}
function NewDirect({ open, onClose, onCreated }) {
    const qc = useQueryClient();
    const toast = useToast();
    const [people, setPeople] = useState([]);
    const [busy, setBusy] = useState(false);
    async function start() {
        setBusy(true);
        try {
            const c = await api('/work/channels/direct', { method: 'POST', body: { employeeIds: people.map((p) => p.id) } });
            void qc.invalidateQueries({ queryKey: ['work', 'channels'] });
            onCreated(c.id);
            setPeople([]);
            onClose();
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not start the conversation.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<Drawer open={open} onClose={onClose} title="New message" subtitle="Message one person, or up to 7 at once." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => void start()} loading={busy} disabled={!people.length}>Start conversation</Button></>}>
      <PeoplePicker value={people} onChange={setPeople} max={7} placeholder="Who do you want to message?"/>
    </Drawer>);
}
