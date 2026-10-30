import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, FolderKanban, ListTodo, Lock, MessageCircle, Plus, Search, Users } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PeoplePicker } from '@/crew/components/work/PeoplePicker';
import { Badge, Button, Card, cx, Drawer, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton, Tabs, TextField, useToast } from '@/crew/components/ui';
import { api, ApiError } from '@/crew/lib/api';
import { useCrewFeatures } from '@/crew/lib/features';
import { useDraft } from '@/crew/lib/use-draft';
import { todayIso } from '@/crew/lib/format';
import { NewTask } from '@/crew/components/work/NewTask';
import { TaskRow } from '@/crew/components/work/TaskBoard';
import { useTaskMover } from '@/crew/components/work/TaskMover';
import { PROJECT_COLOR, useProjects, useTasks } from '@/crew/lib/work';
import { TaskDrawer } from './TaskDrawer';
/** Work: my tasks across every project, and the projects I can see. */
export function WorkPage() {
    const [params, setParams] = useSearchParams();
    const features = useCrewFeatures();
    const [picked, setTab] = useState('mine');
    const tab = features.projects ? picked : 'mine';
    const [creating, setCreating] = useState(false);
    const [adding, setAdding] = useState(false);
    const task = params.get('task');
    const openTask = (id) => setParams(id ? { task: id } : {});
    return (<div>
      <PageHeader eyebrow="Work" title={features.projects ? 'Tasks & projects' : 'Tasks'} subtitle="Everything you are working on, in one place — and the conversations around it." actions={<><Link to="/work/me"><Button variant="secondary" icon={<ListTodo className="size-4"/>}>My work</Button></Link>{features.chat && <Link to="/work/chat"><Button variant="secondary" icon={<MessageCircle className="size-4"/>}>Messages</Button></Link>}<Button variant={features.projects ? 'secondary' : 'primary'} icon={<Plus className="size-4"/>} onClick={() => setAdding(true)}>New task</Button>{features.projects && <Button icon={<Plus className="size-4"/>} onClick={() => setCreating(true)}>New project</Button>}</>}/>
      {features.projects && <div className="mb-6"><Tabs value={tab} onChange={setTab} tabs={[{ id: 'mine', label: 'My tasks' }, { id: 'projects', label: 'Projects' }]}/></div>}
      {tab === 'mine' ? <MyTasks onOpen={openTask}/> : <Projects onNew={() => setCreating(true)}/>}
      <NewProject open={creating} onClose={() => setCreating(false)}/>
      <NewTask open={adding} onClose={() => setAdding(false)} context="work" onCreated={openTask}/>
      <TaskDrawer id={task} onClose={() => openTask(null)} onOpen={openTask}/>
    </div>);
}
// ───────────────────────────── my tasks ─────────────────────────────
function MyTasks({ onOpen }) {
    const tasks = useTasks({ assignee: 'me', open: true });
    const mover = useTaskMover();
    const today = todayIso();
    if (tasks.error)
        return <ErrorState error={tasks.error} retry={() => tasks.refetch()}/>;
    if (tasks.isLoading)
        return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14"/>)}</div>;
    const all = tasks.data ?? [];
    const groups = [
        { title: 'Waiting for review', tone: 'text-warning-text', rows: all.filter((t) => t.status === 'in_review') },
        { title: 'Overdue', tone: 'text-danger-text', rows: all.filter((t) => t.status !== 'in_review' && t.effectiveDueDate && t.effectiveDueDate < today) },
        { title: 'Due today', tone: 'text-warning-text', rows: all.filter((t) => t.status !== 'in_review' && t.effectiveDueDate === today) },
        { title: 'Coming up', tone: 'text-fg', rows: all.filter((t) => t.status !== 'in_review' && t.effectiveDueDate && t.effectiveDueDate > today) },
        { title: 'No due date', tone: 'text-fg-muted', rows: all.filter((t) => t.status !== 'in_review' && !t.effectiveDueDate) },
    ];
    if (!all.length)
        return <Card><EmptyState icon={<CheckCircle2 className="size-6"/>} title="Nothing assigned to you" body="Tasks assigned to you in any project appear here, soonest due first."/></Card>;
    return (<div className="space-y-6">
      {mover.dialog}
      {groups.filter((g) => g.rows.length).map((g) => (<section key={g.title}>
          <div className={cx('mb-2 text-sm font-semibold', g.tone)}>{g.title} <span className="font-normal text-fg-subtle">· {g.rows.length}</span></div>
          <Card className="divide-y divide-border">{g.rows.map((t) => <TaskRow key={t.id} t={t} mover={mover} onOpen={() => onOpen(t.id)} showProject/>)}</Card>
        </section>))}
    </div>);
}
// ───────────────────────────── projects ─────────────────────────────
function Projects({ onNew }) {
    const projects = useProjects();
    const navigate = useNavigate();
    const [q, setQ] = useState('');
    if (projects.error)
        return <ErrorState error={projects.error} retry={() => projects.refetch()}/>;
    if (projects.isLoading)
        return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40"/>)}</div>;
    const rows = (projects.data ?? []).filter((p) => !q || `${p.key} ${p.name}`.toLowerCase().includes(q.toLowerCase()));
    if (!projects.data?.length)
        return <Card><EmptyState icon={<FolderKanban className="size-6"/>} title="No projects yet" body="A project holds a board of tasks and its own channel. Start one for a team, an outlet launch or anything with several steps." action={<Button icon={<Plus className="size-4"/>} onClick={onNew}>New project</Button>}/></Card>;
    return (<div className="space-y-4">
      <div className="relative w-full sm:w-72"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"/><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a project" className="pl-9"/></div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((p, i) => <ProjectCard key={p.id} p={p} i={i} onOpen={() => navigate(`/work/projects/${p.id}`)}/>)}
      </div>
    </div>);
}
function ProjectCard({ p, i, onOpen }) {
    const total = p.counts.open + p.counts.done;
    const pct = total ? Math.round((p.counts.done / total) * 100) : 0;
    return (<motion.button initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 8) * 0.03 }} onClick={onOpen} className="group flex flex-col rounded-2xl border border-border bg-surface p-5 text-left shadow-1 transition hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md">
      <div className="flex items-start gap-3">
        <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white', PROJECT_COLOR[p.color])}>{p.key.slice(0, 2)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-semibold text-fg group-hover:text-brand-text">{p.name}{p.visibility === 'private' && <Lock className="size-3.5 text-fg-subtle"/>}</div>
          <div className="text-xs text-fg-muted">{p.key} · {p.counts.members} member{p.counts.members === 1 ? '' : 's'}{p.myRole ? ` · you are ${p.myRole === 'admin' ? 'an admin' : 'a member'}` : ''}</div>
        </div>
      </div>
      {p.description && <p className="mt-3 line-clamp-2 text-sm text-fg-muted">{p.description}</p>}
      <div className="mt-auto pt-4">
        <div className="flex justify-between text-xs text-fg-muted"><span>{p.counts.done} done · {p.counts.open} open</span><span className="tabular">{pct}%</span></div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-subtle"><div className="h-full rounded-full bg-success-solid" style={{ width: `${pct}%` }}/></div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p.counts.mine > 0 && <Badge tone="brand">{p.counts.mine} for you</Badge>}
          {p.counts.overdue > 0 && <Badge tone="danger"><AlertCircle className="size-3"/>{p.counts.overdue} overdue</Badge>}
        </div>
      </div>
    </motion.button>);
}
const COLORS = Object.keys(PROJECT_COLOR);
function NewProject({ open, onClose }) {
    const qc = useQueryClient();
    const toast = useToast();
    const navigate = useNavigate();
    const [f, setF, discardFDraft] = useDraft('new-project', { name: '', key: '', description: '', color: 'iris', visibility: 'company' });
    const [keyEdited, setKeyEdited] = useState(false);
    const [people, setPeople] = useState([]);
    const [busy, setBusy] = useState(false);
    const suggest = (name) => {
        const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
        const k = (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 4)).slice(0, 6);
        return /^[A-Z]/.test(k) ? k : k ? `P${k}`.slice(0, 6) : '';
    };
    async function create(e) {
        e.preventDefault();
        setBusy(true);
        try {
            const p = await api('/work/projects', { method: 'POST', body: { ...f, key: f.key.toUpperCase(), memberIds: people.map((x) => x.id) } });
            void qc.invalidateQueries({ queryKey: ['work'] });
            discardFDraft();
            toast('success', `${p.key} created, with its own channel #${p.key.toLowerCase()}.`);
            onClose();
            navigate(`/work/projects/${p.id}`);
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not create the project.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<Drawer open={open} onClose={onClose} title="New project" subtitle="A board of tasks with its own channel." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="new-project" loading={busy} disabled={!f.name.trim() || f.key.length < 2}>Create project</Button></>}>
      <form id="new-project" onSubmit={create} className="space-y-4">
        <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value, key: keyEdited ? f.key : suggest(e.target.value) })} placeholder="e.g. Outlet launch — Jaipur" maxLength={120} required/>
        <TextField label="Key" value={f.key} onChange={(e) => { setKeyEdited(true); setF({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) }); }} hint={f.key ? `Tasks will be numbered ${f.key}-1, ${f.key}-2…` : '2–10 letters or digits'} required/>
        <Field label="Description (optional)">
          <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={3} maxLength={4000} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30"/>
        </Field>
        <Field label="Colour">
          <div className="flex gap-2">{COLORS.map((c) => <button type="button" key={c} onClick={() => setF({ ...f, color: c })} className={cx('size-8 rounded-full transition', PROJECT_COLOR[c], f.color === c ? 'ring-2 ring-focus-ring ring-offset-2 ring-offset-surface' : 'opacity-70 hover:opacity-100')} aria-label={c}/>)}</div>
        </Field>
        <Field label="Who can see it">
          <div className="grid grid-cols-2 gap-2">
            {[['company', 'Everyone', Users, 'The whole company can see and help'], ['private', 'Members only', Lock, 'Only people you add']].map(([k, l, I, d]) => (<button type="button" key={k} onClick={() => setF({ ...f, visibility: k })} className={cx('rounded-xl border p-3 text-left', f.visibility === k ? 'border-brand bg-brand-surface' : 'border-border')}>
                <span className="flex items-center gap-1.5 text-sm font-medium text-fg"><I className="size-4"/>{l}</span>
                <span className="text-xs text-fg-muted">{d}</span>
              </button>))}
          </div>
        </Field>
        <Field label="Members"><PeoplePicker value={people} onChange={setPeople} placeholder="Add your team"/></Field>
      </form>
    </Drawer>);
}
