import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock, Plus, Search, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PeoplePicker } from '@/crew/components/work/PeoplePicker';
import { Avatar, Badge, Button, Card, cx, Drawer, ErrorState, Input, Skeleton, Tabs, useToast } from '@/crew/components/ui';
import { api, ApiError } from '@/crew/lib/api';
import { useAuth } from '@/crew/lib/auth';
import { useCrewFeatures } from '@/crew/lib/features';
import { TaskBoard, TaskRow } from '@/crew/components/work/TaskBoard';
import { useTaskMover } from '@/crew/components/work/TaskMover';
import { PRIORITY, PROJECT_COLOR, useProject, useTasks } from '@/crew/lib/work';
import { Conversation } from './Conversation';
import { TaskDrawer } from './TaskDrawer';
export function ProjectPage() {
    const { id = '' } = useParams();
    const project = useProject(id);
    const tasks = useTasks({ projectId: id }, !!id);
    const [params, setParams] = useSearchParams();
    const features = useCrewFeatures();
    const [picked, setView] = useState('board');
    const view = picked === 'chat' && !features.chat ? 'board' : picked;
    const [q, setQ] = useState('');
    const [mine, setMine] = useState(false);
    const { me } = useAuth();
    const mover = useTaskMover();
    const task = params.get('task');
    const openTask = (t) => setParams(t ? { task: t } : {});
    const p = project.data;
    const rows = useMemo(() => (tasks.data ?? []).filter((t) => !t.parentTaskId && (!mine || t.assignee?.employeeId === me?.employee?.id) && (!q || `${t.key} ${t.title} ${t.labels.join(' ')}`.toLowerCase().includes(q.toLowerCase()))), [tasks.data, mine, q, me?.employee?.id]);
    if (project.error)
        return <ErrorState error={project.error} retry={() => project.refetch()}/>;
    if (!p)
        return <Skeleton className="h-96"/>;
    return (<div>
      <Link to="/work" className="mb-4 inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"><ArrowLeft className="size-4"/> Work</Link>
      <div className="mb-5 flex flex-wrap items-center gap-4">
        <span className={cx('flex size-12 items-center justify-center rounded-2xl text-base font-bold text-white', PROJECT_COLOR[p.color])}>{p.key.slice(0, 2)}</span>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">{p.name}{p.visibility === 'private' && <Lock className="size-4 text-fg-subtle"/>}</h1>
          <p className="truncate text-sm text-fg-muted">{p.description || `${p.key} · led by ${p.lead?.name ?? '—'}`}</p>
        </div>
        <div className="flex -space-x-2">{(p.memberList ?? []).slice(0, 6).map((m) => <span key={m.employeeId} className="rounded-full ring-2 ring-bg"><Avatar name={m.name} size="sm"/></span>)}</div>
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Tabs value={view} onChange={setView} tabs={[{ id: 'board', label: 'Board' }, { id: 'list', label: 'List' }, ...(features.chat ? [{ id: 'chat', label: 'Chat' }] : []), { id: 'members', label: `Members (${p.memberList?.length ?? 0})` }]}/>
        {(view === 'board' || view === 'list') && (<div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"/><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tasks" className="h-9 w-48 pl-8"/></div>
            <button onClick={() => setMine((m) => !m)} className={cx('h-9 rounded-xl border px-3 text-sm', mine ? 'border-brand bg-brand-surface text-brand-text' : 'border-border text-fg-muted')}>Only mine</button>
          </div>)}
      </div>
      {tasks.error ? <ErrorState error={tasks.error}/> : view === 'board' ? (<TaskBoard tasks={rows} queryKey={['work', 'tasks', { projectId: id }]} loading={tasks.isLoading} onOpen={openTask} readOnly={p.status === 'archived'} quickAdd={(status) => (status === 'backlog' || status === 'todo' ? <QuickAdd projectId={p.id} status={status}/> : null)}/>) : view === 'list' ? (<Card className="divide-y divide-border">
          {rows.length === 0 ? <p className="px-5 py-6 text-sm text-fg-muted">No tasks match.</p> : [...rows].sort((a, b) => PRIORITY[a.priority].rank - PRIORITY[b.priority].rank || (a.effectiveDueDate ?? '9').localeCompare(b.effectiveDueDate ?? '9')).map((t) => <TaskRow key={t.id} t={t} mover={mover} onOpen={() => openTask(t.id)}/>)}
        </Card>) : view === 'chat' ? (p.channelId ? <Card className="h-[70vh] overflow-hidden"><Conversation channelId={p.channelId} onOpenTask={openTask}/></Card> : null) : (<Members projectId={p.id} canManage={p.myRole === 'admin'} members={p.memberList ?? []}/>)}
      {mover.dialog}
      <TaskDrawer id={task} onClose={() => openTask(null)} onOpen={openTask}/>
    </div>);
}
function QuickAdd({ projectId, status }) {
    const qc = useQueryClient();
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState('');
    async function add(e) {
        e.preventDefault();
        if (!title.trim())
            return;
        try {
            await api('/work/tasks', { method: 'POST', body: { projectId, title: title.trim(), status } });
            setTitle('');
            void qc.invalidateQueries({ queryKey: ['work'] });
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not add the task.');
        }
    }
    return open ? (<form onSubmit={add} className="p-1"><Input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => !title && setOpen(false)} autoFocus placeholder="What needs doing? Enter to add" className="h-9"/></form>) : (<button onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-xl px-2 py-1.5 text-sm text-fg-muted hover:bg-surface hover:text-fg"><Plus className="size-4"/>Add task</button>);
}
function Members({ projectId, canManage, members }) {
    const qc = useQueryClient();
    const toast = useToast();
    const [adding, setAdding] = useState(false);
    const [people, setPeople] = useState([]);
    async function call(path, method, body, ok) {
        try {
            await api(path, { method, body });
            if (ok)
                toast('success', ok);
            void qc.invalidateQueries({ queryKey: ['work'] });
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not update members.');
        }
    }
    return (<Card>
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <span className="font-semibold text-fg">Members</span>
        {canManage && <Button size="sm" icon={<UserPlus className="size-4"/>} onClick={() => setAdding(true)}>Add people</Button>}
      </div>
      <div className="divide-y divide-border">
        {members.map((m) => (<div key={m.employeeId} className="flex items-center gap-3 px-5 py-3">
            <Avatar name={m.name} size="sm"/>
            <span className="flex-1 text-sm font-medium text-fg">{m.name}</span>
            <Badge tone={m.role === 'admin' ? 'brand' : 'neutral'}>{m.role === 'admin' ? 'Admin' : 'Member'}</Badge>
            {canManage && m.role !== 'admin' && <Button size="sm" variant="ghost" onClick={() => void call(`/work/projects/${projectId}/members`, 'POST', { employeeIds: [m.employeeId], role: 'admin' }, `${m.name} is now an admin.`)}>Make admin</Button>}
            {canManage && <Button size="sm" variant="ghost" onClick={() => void call(`/work/projects/${projectId}/members/${m.employeeId}`, 'DELETE', undefined, `${m.name} removed.`)}>Remove</Button>}
          </div>))}
      </div>
      <Drawer open={adding} onClose={() => setAdding(false)} title="Add people" subtitle="They join the project and its channel." footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button disabled={!people.length} onClick={() => void call(`/work/projects/${projectId}/members`, 'POST', { employeeIds: people.map((p) => p.id), role: 'member' }, 'Added.').then(() => { setPeople([]); setAdding(false); })}>Add {people.length || ''}</Button></>}>
        <PeoplePicker value={people} onChange={setPeople} exclude={members.map((m) => m.employeeId)}/>
      </Drawer>
    </Card>);
}
