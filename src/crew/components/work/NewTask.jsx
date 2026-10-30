import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileClock, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, cx, Drawer, Field, Input, Select, TextField, useToast } from '@/crew/components/ui';
import { DraftNotice } from '@/crew/components/DraftNotice';
import { api, ApiError } from '@/crew/lib/api';
import { useDraft } from '@/crew/lib/use-draft';
import { fmtDate } from '@/crew/lib/format';
import { PRIORITY, useProjects } from '@/crew/lib/work';
import { PeoplePicker } from './PeoplePicker';
const blank = (projectId = '') => ({ title: '', description: '', projectId, status: 'todo', priority: 'medium', dueDate: '', assignee: [], reviewer: [] });
/**
 * Add a task: personal (no project — for yourself or your team) or in a project. "Save as draft" keeps it on the
 * server, private, resumable from any device.
 */
export function NewTask({ open, onClose, projectId, context, onCreated }) {
    const qc = useQueryClient();
    const toast = useToast();
    const projects = useProjects();
    // What is typed is kept (in this browser) when the drawer is closed or cancelled, until the task is created.
    const [f, setF, discardLocal, restored] = useDraft(`new-task:${context}:${projectId ?? 'any'}`, blank(projectId));
    const [draftId, setDraftId] = useState(null);
    // This drawer stays mounted: note at each opening whether it opens on unsaved text (to offer "Discard").
    const [wasOpen, setWasOpen] = useState(open);
    const [openedWithDraft, setOpenedWithDraft] = useState(restored);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open)
            setOpenedWithDraft(!!(f.title || f.description));
    }
    const [busy, setBusy] = useState(false);
    const drafts = useQuery({
        queryKey: ['work', 'drafts', context],
        queryFn: () => api('/work/drafts', { query: { context } }).then((r) => r.data),
        enabled: open,
    });
    // The form starts empty each time: it is cleared whenever the drawer closes.
    const close = () => {
        setDraftId(null);
        onClose();
    };
    const finished = () => {
        discardLocal();
        close();
    };
    async function create(e) {
        e.preventDefault();
        setBusy(true);
        try {
            const t = await api('/work/tasks', {
                method: 'POST',
                body: {
                    title: f.title.trim(),
                    description: f.description,
                    projectId: f.projectId || null,
                    status: f.status,
                    priority: f.priority,
                    dueDate: f.dueDate || null,
                    ...(f.assignee.length ? { assigneeEmployeeId: f.assignee[0].id } : {}),
                    reviewerEmployeeId: f.reviewer[0]?.id ?? null,
                },
            });
            if (draftId)
                await api(`/work/drafts/${draftId}`, { method: 'DELETE' }).catch(() => undefined);
            void qc.invalidateQueries({ queryKey: ['work'] });
            toast('success', `${t.key} added.`);
            finished();
            onCreated?.(t.id);
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not add the task.');
        }
        finally {
            setBusy(false);
        }
    }
    async function saveDraft() {
        try {
            const r = await api('/work/drafts', { method: 'POST', body: { id: draftId, context, payload: f } });
            setDraftId(r.id);
            void qc.invalidateQueries({ queryKey: ['work', 'drafts'] });
            toast('success', 'Draft saved. Only you can see it.');
            finished();
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not save the draft.');
        }
    }
    const personal = !f.projectId;
    return (<Drawer open={open} onClose={close} title="New task" subtitle={personal ? 'A personal task — for you or someone in your team.' : 'A task on the project board.'} footer={<><Button variant="ghost" onClick={() => void saveDraft()} disabled={!f.title.trim()}>Save as draft</Button><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" form="new-task" loading={busy} disabled={!f.title.trim()}>Add task</Button></>}>
      {(drafts.data?.length ?? 0) > 0 && !draftId && (<div className="mb-5 rounded-2xl border border-border p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-fg-subtle"><FileClock className="size-3.5"/>Your drafts</div>
          <div className="space-y-1">
            {drafts.data.slice(0, 5).map((d) => (<div key={d.id} className="group flex items-center gap-2">
                <button onClick={() => { setF({ ...blank(projectId), ...d.payload }); setDraftId(d.id); }} className="min-w-0 flex-1 truncate rounded-lg px-2 py-1 text-left text-sm text-fg hover:bg-bg-subtle">{d.payload.title || 'Untitled'} <span className="text-xs text-fg-subtle">· {fmtDate(d.updatedAt, { day: 'numeric', month: 'short' })}</span></button>
                <button onClick={() => void api(`/work/drafts/${d.id}`, { method: 'DELETE' }).then(() => drafts.refetch())} className="text-fg-subtle hover:text-danger-text" aria-label="Delete draft"><Trash2 className="size-3.5"/></button>
              </div>))}
          </div>
        </div>)}
      <DraftNotice show={openedWithDraft && !!(f.title || f.description)} onDiscard={() => { discardLocal(); setOpenedWithDraft(false); }} className="mb-4"/>
      <form id="new-task" onSubmit={create} className="space-y-4">
        <TextField label="Task" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="What needs doing?" maxLength={250} required autoFocus/>
        {!projectId && (<Field label="Project">
            <Select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}>
              <option value="">No project — personal task</option>
              {(projects.data ?? []).filter((p) => p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
            </Select>
          </Field>)}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Assignee" hint={personal && !f.assignee.length ? 'Leave empty for yourself.' : undefined}><PeoplePicker value={f.assignee} onChange={(v) => setF({ ...f, assignee: v.slice(-1) })} max={1} placeholder={personal ? 'Me' : 'Unassigned'}/></Field>
          <Field label="Reviewer" hint="Optional. Otherwise the creator, else the manager."><PeoplePicker value={f.reviewer} onChange={(v) => setF({ ...f, reviewer: v.slice(-1) })} max={1} placeholder="Default"/></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Due date" hint="Needed to start. Fixed once work starts."><Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })}/></Field>
          <Field label="Stage">
            <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="todo">To do</option>
              <option value="backlog">Backlog</option>
            </Select>
          </Field>
        </div>
        <Field label="Priority">
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(PRIORITY).map((p) => (<button type="button" key={p} onClick={() => setF({ ...f, priority: p })} className={cx('rounded-lg px-2.5 py-1.5 text-xs font-medium transition', f.priority === p ? PRIORITY[p].className + ' ring-2 ring-focus-ring/40' : 'border border-border text-fg-muted hover:bg-bg-subtle')}>{PRIORITY[p].label}</button>))}
          </div>
        </Field>
        <Field label="Details (optional)">
          <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={4} maxLength={20000} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30 sm:text-sm"/>
        </Field>
      </form>
    </Drawer>);
}
