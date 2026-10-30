import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, ArrowRight, CalendarRange, Check, Lock, Pencil, Plus, Rocket, Share2, Stamp, Trash2, Unlock, Users } from 'lucide-react';
import { useState } from 'react';
import { Avatar, Badge, Button, Card, CardHeader, cx, Drawer, EmptyState, ErrorState, Field, Input, Select, Skeleton, TextField, useToast } from '@/crew/components/ui';
import { api, ApiError } from '@/crew/lib/api';
import { useDraft } from '@/crew/lib/use-draft';
import { fmtDate, todayIso } from '@/crew/lib/format';
import { CYCLE_TYPE_LABEL, PHASES, PLAN_STATUS, REVIEW_STATUS, useCycleReviews, useCycles, useDeletedCycles, useOutcomes, usePlans, useScales } from '@/crew/lib/pms';
import { ReviewSheet } from './ReviewSheet';
/** HR: run review cycles end to end — create, open, add people, move through the stages, finalise, share. */
export function Cycles() {
    const cycles = useCycles();
    const [selected, setSelected] = useState(null);
    const [creating, setCreating] = useState(false);
    const list = [...(cycles.data ?? [])].sort((a, b) => b.startDate.localeCompare(a.startDate));
    const current = list.find((c) => c.id === selected) ?? list.find((c) => c.status === 'open') ?? list[0];
    if (cycles.error)
        return <ErrorState error={cycles.error} retry={() => cycles.refetch()}/>;
    if (cycles.isLoading)
        return <Skeleton className="h-64"/>;
    return (<div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {list.map((c) => (<button key={c.id} onClick={() => setSelected(c.id)} className={cx('rounded-2xl border px-4 py-2 text-left transition', current?.id === c.id ? 'border-brand bg-brand-surface' : 'border-border bg-surface hover:border-border-strong')}>
            <div className="text-sm font-medium text-fg">{c.name}</div>
            <div className="text-xs text-fg-muted">{CYCLE_TYPE_LABEL[c.type]} · {c.status === 'open' ? PHASES.find((p) => p.id === c.phase)?.label : c.status}</div>
          </button>))}
        <Button variant="secondary" icon={<Plus className="size-4"/>} onClick={() => setCreating(true)}>New cycle</Button>
      </div>
      {!current ? (<Card><EmptyState icon={<CalendarRange className="size-6"/>} title="No review cycles yet" body="Create a cycle (for example “Annual review 2026–27”). People then set goals, review themselves, get their manager's review and see their result." action={<Button icon={<Plus className="size-4"/>} onClick={() => setCreating(true)}>New cycle</Button>}/></Card>) : (<CycleDetail key={current.id} c={current} onDeleted={() => setSelected(null)}/>)}
      <DeletedCycles onRestored={(id) => setSelected(id)}/>
      <NewCycle open={creating} onClose={() => setCreating(false)} onCreated={(id) => setSelected(id)}/>
    </div>);
}
/** HR: deleted cycles stay recoverable (performance records are never removed). */
function DeletedCycles({ onRestored }) {
    const [open, setOpen] = useState(false);
    const deleted = useDeletedCycles(open);
    const qc = useQueryClient();
    const toast = useToast();
    async function restore(c) {
        try {
            await api(`/pms/cycles/${c.id}/restore`, { method: 'POST', body: {}, headers: { 'if-match': `"${c.version}"` } });
            toast('success', `${c.name} restored.`);
            void qc.invalidateQueries({ queryKey: ['pms'] });
            onRestored(c.id);
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not restore the cycle.');
        }
    }
    return (<div>
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg"><ArchiveRestore className="size-4"/>{open ? 'Hide deleted cycles' : 'Deleted cycles'}</button>
      {open && (<Card className="mt-3 divide-y divide-border">
          {deleted.isLoading ? <div className="p-4"><Skeleton className="h-10"/></div> : !(deleted.data ?? []).length ? <p className="px-5 py-4 text-sm text-fg-muted">No deleted cycles.</p> : deleted.data.map((c) => (<div key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">{c.name}</div>
                <div className="text-xs text-fg-muted">Deleted {c.deleted ? fmtDate(c.deleted.at, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}{c.deleted?.reason ? ` — “${c.deleted.reason}”` : ''} · was {c.deleted?.fromStatus}</div>
              </div>
              <Button size="sm" variant="secondary" icon={<ArchiveRestore className="size-4"/>} onClick={() => void restore(c)}>Restore</Button>
            </div>))}
        </Card>)}
    </div>);
}
/** Edit what the cycle's state allows: draft — everything; open — name, end, goal-setting freeze date and review due dates. */
function EditCycle({ c, open, onClose }) {
    const qc = useQueryClient();
    const toast = useToast();
    const draft = c.status === 'draft';
    const reviewsClosed = c.phase === 'reviews_closed' || c.phase === 'results';
    const templates = useQuery({ queryKey: ['pms', 'templates'], queryFn: () => api('/pms/templates').then((r) => r.data.filter((t) => t.status === 'active')), enabled: open && draft });
    const initial = { name: c.name, type: c.type, startDate: c.startDate, endDate: c.endDate, templateId: c.templateId, goalFreezeDate: c.goalFreezeDate ?? '', selfReviewDue: c.selfReviewDue ?? '', managerReviewDue: c.managerReviewDue ?? '' };
    const [f, setF, discardFDraft] = useDraft(`cycle-edit:${c.id}`, initial);
    const [busy, setBusy] = useState(false);
    const close = () => { setF(initial); onClose(); };
    async function save(e) {
        e.preventDefault();
        setBusy(true);
        const body = { name: f.name, endDate: f.endDate, goalFreezeDate: f.goalFreezeDate || null };
        if (draft)
            Object.assign(body, { type: f.type, startDate: f.startDate, templateId: f.templateId });
        if (!reviewsClosed)
            Object.assign(body, { selfReviewDue: f.selfReviewDue || null, managerReviewDue: f.managerReviewDue || null });
        try {
            await api(`/pms/cycles/${c.id}`, { method: 'PATCH', body, headers: { 'if-match': `"${c.version}"` } });
            discardFDraft();
            toast('success', 'Cycle updated.');
            void qc.invalidateQueries({ queryKey: ['pms'] });
            onClose();
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not save the cycle.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<Drawer open={open} onClose={close} title="Edit cycle" subtitle={draft ? 'Draft: everything can change.' : 'Open: the type, start date and review form are locked.'} footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button type="submit" form="edit-cycle" loading={busy}>Save</Button></>}>
      <form id="edit-cycle" onSubmit={save} className="space-y-4">
        <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120}/>
        {draft && (<Field label="Type">
            <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              {Object.entries(CYCLE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>)}
        <div className="grid grid-cols-2 gap-4">
          <TextField label="Starts" type="date" value={f.startDate} disabled={!draft} onChange={(e) => setF({ ...f, startDate: e.target.value })} required/>
          <TextField label="Ends" type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} required/>
        </div>
        <TextField label="Goal setting closes on" hint="After this day goals can only be updated with progress; nothing new can be set or changed. Leave empty to keep goal setting open." type="date" value={f.goalFreezeDate} min={f.startDate} max={f.endDate} onChange={(e) => setF({ ...f, goalFreezeDate: e.target.value })}/>
        {!reviewsClosed && (<div className="grid grid-cols-2 gap-4">
            <TextField label="Self-review due" type="date" value={f.selfReviewDue} min={f.startDate} max={f.endDate} onChange={(e) => setF({ ...f, selfReviewDue: e.target.value })}/>
            <TextField label="Manager review due" type="date" value={f.managerReviewDue} min={f.startDate} max={f.endDate} onChange={(e) => setF({ ...f, managerReviewDue: e.target.value })}/>
          </div>)}
        {draft && (<Field label="Review form">
            <Select value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}>
              {(templates.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>)}
      </form>
    </Drawer>);
}
/** Delete = archive + hide, restorable from "Deleted cycles" (nothing is removed). */
function DeleteCycle({ c, open, onClose, onDeleted, counts }) {
    const qc = useQueryClient();
    const toast = useToast();
    const [reason, setReason, discardReasonDraft] = useDraft(`cycle-delete:${c.id}`, '');
    const [busy, setBusy] = useState(false);
    async function remove() {
        setBusy(true);
        try {
            await api(`/pms/cycles/${c.id}/delete`, { method: 'POST', body: { reason }, headers: { 'if-match': `"${c.version}"` } });
            discardReasonDraft();
            toast('success', `${c.name} deleted. You can restore it from "Deleted cycles".`);
            void qc.invalidateQueries({ queryKey: ['pms'] });
            discardReasonDraft();
            onClose();
            onDeleted();
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not delete the cycle.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<Drawer open={open} onClose={onClose} title={`Delete “${c.name}”?`} subtitle="It disappears for everyone. Nothing is erased: HR can restore it." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" icon={<Trash2 className="size-4"/>} loading={busy} disabled={reason.trim().length < 4} onClick={() => void remove()}>Delete cycle</Button></>}>
      <div className="space-y-4">
        <div className="rounded-2xl border border-border p-4 text-sm text-fg">
          <div className="mb-2 font-medium">This cycle has</div>
          <ul className="space-y-1 text-fg-muted">
            <li>{counts.plans} goal plan{counts.plans === 1 ? '' : 's'}</li>
            <li>{counts.reviews} review{counts.reviews === 1 ? '' : 's'}</li>
          </ul>
          <p className="mt-3 text-xs text-fg-subtle">They become read-only and are hidden with the cycle. Its name can be used again for a new cycle.</p>
        </div>
        <Field label="Why delete it?" hint="4–500 characters. Kept in the audit log.">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoFocus className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30 sm:text-sm" placeholder="e.g. Created by mistake; the 2026–27 review will be set up again"/>
        </Field>
      </div>
    </Drawer>);
}
function CycleDetail({ c, onDeleted }) {
    const qc = useQueryClient();
    const toast = useToast();
    const reviews = useCycleReviews(c.id, !!c.launchedAt);
    const plans = usePlans(c.id, c.status !== 'draft');
    const [busy, setBusy] = useState(null);
    const [launching, setLaunching] = useState(false);
    const [open, setOpen] = useState(null);
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const frozen = !!c.goalFreezeDate && c.goalFreezeDate < todayIso() && c.status === 'open';
    const idx = PHASES.findIndex((p) => p.id === c.phase);
    const next = PHASES[idx + 1];
    const ifMatch = { 'if-match': `"${c.version}"` };
    async function act(name, path, body, ok, headers) {
        setBusy(name);
        try {
            const r = await api(`/pms/${path}`, { method: 'POST', body, headers });
            toast('success', typeof r.finalised === 'number' ? `${r.finalised} finalised${r.skipped?.length ? `, ${r.skipped.length} not ready yet` : ''}.` : typeof r.shared === 'number' ? `${r.shared} results shared${r.skipped?.length ? `, ${r.skipped.length} not ready yet` : ''}.` : ok);
            void qc.invalidateQueries({ queryKey: ['pms'] });
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not do that.');
        }
        finally {
            setBusy(null);
        }
    }
    const counts = new Map();
    for (const r of reviews.data ?? [])
        counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    const planCounts = new Map();
    for (const p of plans.data ?? [])
        planCounts.set(p.status, (planCounts.get(p.status) ?? 0) + 1);
    return (<div className="space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-fg">{c.name}</h2>
            <p className="text-sm text-fg-muted">{CYCLE_TYPE_LABEL[c.type]} · {fmtDate(c.startDate)} – {fmtDate(c.endDate)}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
              {c.goalFreezeDate ? <>Goal setting {frozen ? 'closed on' : 'open until'} {fmtDate(c.goalFreezeDate)}</> : 'Goal setting has no end date'}
              {frozen && <Badge tone="warning"><Lock className="size-3"/>Goals frozen — only progress can change</Badge>}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(c.status === 'draft' || c.status === 'open') && <Button variant="secondary" icon={<Pencil className="size-4"/>} onClick={() => setEditing(true)}>Edit</Button>}
            <Button variant="ghost" icon={<Trash2 className="size-4"/>} onClick={() => setDeleting(true)} className="text-danger-text">Delete</Button>
            {c.status === 'draft' && <Button icon={<Rocket className="size-4"/>} loading={busy === 'open'} onClick={() => void act('open', `cycles/${c.id}/open`, {}, 'Cycle opened. Add participants next.', ifMatch)}>Open cycle</Button>}
            {c.status === 'open' && !c.launchedAt && <Button icon={<Users className="size-4"/>} onClick={() => setLaunching(true)}>Add participants</Button>}
            {c.status === 'open' && c.launchedAt && next && <Button icon={<ArrowRight className="size-4"/>} loading={busy === 'advance'} onClick={() => void act('advance', `cycles/${c.id}/advance`, {}, `Moved to ${next.label}. Everyone involved is notified.`, ifMatch)}>Move to {next.label}</Button>}
            {c.status === 'open' && (c.phase === 'self_review' || c.phase === 'manager_review') && (<Button variant="secondary" icon={c.phaseLocked ? <Unlock className="size-4"/> : <Lock className="size-4"/>} loading={busy === 'lock'} onClick={() => void act('lock', `cycles/${c.id}/lock-phase`, { locked: !c.phaseLocked, reason: null }, c.phaseLocked ? 'Unlocked: people can edit again.' : 'Locked: no more edits in this stage.', ifMatch)}>{c.phaseLocked ? 'Unlock' : 'Lock'} stage</Button>)}
            {(c.phase === 'reviews_closed' || c.phase === 'results') && <Button variant="secondary" icon={<Stamp className="size-4"/>} loading={busy === 'finalise'} onClick={() => void act('finalise', `cycles/${c.id}/finalise`, {}, 'Finalised.')}>Finalise all</Button>}
            {c.phase === 'results' && <Button icon={<Share2 className="size-4"/>} loading={busy === 'share'} onClick={() => void act('share', `cycles/${c.id}/share`, {}, 'Shared.')}>Share all results</Button>}
            {c.status === 'open' && c.phase === 'results' && <Button variant="ghost" loading={busy === 'close'} onClick={() => void act('close', `cycles/${c.id}/close`, {}, 'Cycle closed.', ifMatch)}>Close cycle</Button>}
          </div>
        </div>

        <ol className="mt-6 grid gap-2 sm:grid-cols-5">
          {PHASES.map((p, i) => {
            const done = c.status === 'closed' || (c.status === 'open' && i < idx);
            const now = c.status === 'open' && i === idx;
            return (<li key={p.id} className={cx('rounded-2xl border p-3', now ? 'border-brand bg-brand-surface' : done ? 'border-success-border bg-success-surface' : 'border-border')}>
                <div className="flex items-center gap-2">
                  <span className={cx('flex size-6 items-center justify-center rounded-full text-xs font-bold', now ? 'bg-brand text-on-brand' : done ? 'bg-success-solid text-white' : 'bg-bg-subtle text-fg-subtle')}>{done ? <Check className="size-3.5"/> : i + 1}</span>
                  <span className={cx('text-sm font-medium', now ? 'text-brand-text' : done ? 'text-success-text' : 'text-fg-muted')}>{p.label}</span>
                  {now && c.phaseLocked && <Lock className="size-3.5 text-brand-text"/>}
                </div>
                <div className="mt-1 text-xs text-fg-subtle">{p.who}</div>
              </li>);
        })}
        </ol>
        {c.status === 'draft' && <p className="mt-4 text-sm text-fg-muted">Step 1: open the cycle. Step 2: add participants (everyone eligible by default). Then move through the stages.</p>}
      </Card>

      {c.status !== 'draft' && (<div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Goal plans" subtitle={plans.data ? `${plans.data.length} people` : undefined}/>
            <div className="flex flex-wrap gap-2 px-5 pb-5">
              {plans.isLoading ? <Skeleton className="h-10 w-full"/> : ['draft', 'submitted', 'returned', 'approved', 'rejected'].map((s) => (<Badge key={s} tone={PLAN_STATUS[s].tone}>{PLAN_STATUS[s].label}: {planCounts.get(s) ?? 0}</Badge>))}
            </div>
          </Card>
          <Card>
            <CardHeader title="Reviews" subtitle={reviews.data ? `${reviews.data.length} reviews` : c.launchedAt ? undefined : 'Add participants to start reviews'}/>
            <div className="space-y-2 px-5 pb-5">
              {reviews.data && reviews.data.length > 0 && (<div className="flex h-3 overflow-hidden rounded-full bg-bg-subtle">
                  {['blocked', 'not_started', 'self_in_progress', 'self_submitted', 'manager_in_progress', 'manager_submitted', 'finalised', 'shared'].map((s, i) => {
                    const n = counts.get(s) ?? 0;
                    const colors = ['bg-danger-solid', 'bg-border-strong', 'bg-info-solid', 'bg-iris-400', 'bg-aqua-400', 'bg-iris-600', 'bg-success-solid', 'bg-emerald-700'];
                    return n ? <div key={s} className={colors[i]} style={{ width: `${(n / reviews.data.length) * 100}%` }} title={`${REVIEW_STATUS[s].label}: ${n}`}/> : null;
                })}
                </div>)}
              <div className="flex flex-wrap gap-1.5">
                {[...counts.entries()].map(([s, n]) => <Badge key={s} tone={REVIEW_STATUS[s].tone}>{REVIEW_STATUS[s].label}: {n}</Badge>)}
              </div>
            </div>
          </Card>
        </div>)}

      {c.launchedAt && <Outcomes c={c} onOpen={setOpen}/>}
      {c.launchedAt && <ReviewTable c={c} onOpen={setOpen}/>}
      <Launch c={c} open={launching} onClose={() => setLaunching(false)}/>
      <EditCycle key={c.version} c={c} open={editing} onClose={() => setEditing(false)}/>
      <DeleteCycle c={c} open={deleting} onClose={() => setDeleting(false)} onDeleted={onDeleted} counts={{ plans: plans.data?.length ?? 0, reviews: reviews.data?.length ?? 0 }}/>
      <ReviewSheet id={open} onClose={() => setOpen(null)}/>
    </div>);
}
function ReviewTable({ c, onOpen }) {
    const reviews = useCycleReviews(c.id, true);
    const [q, setQ] = useState('');
    const rows = (reviews.data ?? []).filter((r) => !q || (r.employeeName ?? '').toLowerCase().includes(q.toLowerCase()));
    return (<Card>
      <CardHeader title="Everyone in this cycle" action={<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" className="w-56"/>}/>
      <div className="max-h-[28rem] divide-y divide-border overflow-y-auto border-t border-border scroll-quiet">
        {rows.map((r) => (<button key={r.id} onClick={() => onOpen(r.id)} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-bg-subtle">
            <Avatar name={r.employeeName ?? '?'} size="sm"/>
            <span className="flex-1 truncate text-sm font-medium text-fg">{r.employeeName}</span>
            {r.blockedReason && <span className="text-xs text-danger-text">{r.blockedReason.replace(/_/g, ' ').toLowerCase()}</span>}
            <Badge tone={REVIEW_STATUS[r.status].tone}>{REVIEW_STATUS[r.status].label}</Badge>
          </button>))}
      </div>
    </Card>);
}
const STATES = [
    { id: 'unfinalised', label: 'Not finalised' },
    { id: 'unshared', label: 'Not shared' },
    { id: 'unacknowledged', label: 'Not acknowledged' },
    { id: 'disagreements', label: 'Disagreements' },
];
function Outcomes({ c, onOpen }) {
    const [state, setState] = useState(c.phase === 'results' ? 'disagreements' : 'unfinalised');
    const list = useOutcomes(c.id, state, true);
    const scales = useScales();
    const qc = useQueryClient();
    const toast = useToast();
    const [note, setNote] = useState({});
    const label = (id) => scales.data?.flatMap((s) => s.levels).find((l) => l.id === id)?.label ?? '—';
    async function resolve(ackId, action) {
        try {
            await api(`/pms/acknowledgements/${ackId}/resolve`, { method: 'POST', body: { action, note: note[ackId] ?? '' } });
            toast('success', action === 'reopen' ? 'Review reopened for the manager.' : 'Closed with your note.');
            void qc.invalidateQueries({ queryKey: ['pms'] });
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not resolve.');
        }
    }
    return (<Card>
      <CardHeader title="Results" subtitle="What still needs attention." action={<div className="flex flex-wrap gap-1.5">{STATES.map((s) => <button key={s.id} onClick={() => setState(s.id)} className={cx('rounded-full border px-3 py-1 text-xs font-medium', state === s.id ? 'border-brand bg-brand-surface text-brand-text' : 'border-border text-fg-muted')}>{s.label}</button>)}</div>}/>
      <div className="divide-y divide-border border-t border-border">
        {list.isLoading ? <div className="p-5"><Skeleton className="h-16"/></div> : !(list.data ?? []).length ? <p className="px-5 py-6 text-sm text-fg-muted">Nothing here.</p> : (list.data ?? []).map((o) => (<div key={o.reviewId} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <Avatar name={o.name ?? '?'} size="sm"/>
            <button onClick={() => onOpen(o.reviewId)} className="min-w-0 flex-1 text-left">
              <div className="truncate text-sm font-medium text-fg hover:underline">{o.name}</div>
              <div className="text-xs text-fg-muted">{REVIEW_STATUS[o.status].label}{o.finalLevelId ? ` · ${label(o.finalLevelId)}` : ''}{o.acknowledgedAt ? ` · acknowledged ${fmtDate(o.acknowledgedAt, { day: 'numeric', month: 'short' })}` : ''}</div>
            </button>
            {state === 'disagreements' && o.acknowledgementId && (!o.resolution || o.resolution === 'open') && (<div className="flex w-full flex-wrap gap-2 sm:w-auto">
                <Input placeholder="Your note (required)" value={note[o.acknowledgementId] ?? ''} onChange={(e) => setNote({ ...note, [o.acknowledgementId]: e.target.value })} className="w-56"/>
                <Button size="sm" variant="secondary" disabled={(note[o.acknowledgementId] ?? '').trim().length < 3} onClick={() => void resolve(o.acknowledgementId, 'close_with_note')}>Close</Button>
                <Button size="sm" disabled={(note[o.acknowledgementId] ?? '').trim().length < 3} onClick={() => void resolve(o.acknowledgementId, 'reopen')}>Reopen review</Button>
              </div>)}
            {o.resolution && o.resolution !== 'open' && <Badge tone="success">{o.resolution === 'reopened' ? 'Reopened' : 'Closed'}</Badge>}
          </div>))}
      </div>
    </Card>);
}
function Launch({ c, open, onClose }) {
    const qc = useQueryClient();
    const toast = useToast();
    const preview = useQuery({
        queryKey: ['pms', 'preview', c.id],
        queryFn: () => api(`/pms/cycles/${c.id}/participants/preview`, { method: 'POST', body: {} }),
        enabled: open,
    });
    const [busy, setBusy] = useState(false);
    async function launch() {
        setBusy(true);
        try {
            const r = await api(`/pms/cycles/${c.id}/launch`, { method: 'POST', body: {} });
            toast('success', `${r.added} people added. Everyone can now set goals.`);
            void qc.invalidateQueries({ queryKey: ['pms'] });
            onClose();
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not add participants.');
        }
        finally {
            setBusy(false);
        }
    }
    const p = preview.data;
    return (<Drawer open={open} onClose={onClose} title="Add participants" subtitle="Everyone eligible joins this cycle. You can include or exclude people later." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!p?.eligible.length} icon={<Users className="size-4"/>} onClick={() => void launch()}>Add {p?.eligible.filter((e) => !e.alreadyIncluded).length ?? ''} people</Button></>}>
      {preview.error ? <ErrorState error={preview.error}/> : !p ? <Skeleton className="h-40"/> : (<div className="space-y-5">
          <Group title={`Joining (${p.eligible.length})`} names={p.eligible.map((e) => e.name ?? '?')} tone="success"/>
          {p.conflicts.length > 0 && <Group title={`Already in another cycle (${p.conflicts.length})`} names={p.conflicts.map((x) => `${x.name} — ${x.cycleName}`)} tone="warning"/>}
          {p.ineligible.length > 0 && <Group title={`Not eligible (${p.ineligible.length})`} names={p.ineligible.map((x) => `${x.name} — ${x.reasons.join(', ')}`)} tone="neutral"/>}
        </div>)}
    </Drawer>);
}
function Group({ title, names, tone }) {
    return (<div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">{title}</div>
      <div className="flex flex-wrap gap-1.5">{names.slice(0, 200).map((n, i) => <Badge key={i} tone={tone}>{n}</Badge>)}</div>
    </div>);
}
function NewCycle({ open, onClose, onCreated }) {
    const qc = useQueryClient();
    const toast = useToast();
    const templates = useQuery({ queryKey: ['pms', 'templates'], queryFn: () => api('/pms/templates').then((r) => r.data.filter((t) => t.status === 'active')), enabled: open });
    const year = new Date().getFullYear();
    const [f, setF, discardFDraft] = useDraft('new-cycle', { name: `Annual review ${year}–${String(year + 1).slice(2)}`, type: 'annual', startDate: `${year}-04-01`, endDate: `${year + 1}-03-31`, templateId: '' });
    const [busy, setBusy] = useState(false);
    async function create(e) {
        e.preventDefault();
        setBusy(true);
        try {
            const c = await api('/pms/cycles', { method: 'POST', idempotent: true, body: { ...f, templateId: f.templateId || templates.data?.[0]?.id } });
            discardFDraft();
            toast('success', 'Cycle created as a draft. Open it when you are ready.');
            void qc.invalidateQueries({ queryKey: ['pms'] });
            onCreated(c.id);
            onClose();
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not create the cycle.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<Drawer open={open} onClose={onClose} title="New review cycle" subtitle="Nobody sees it until you open it." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="cycle-form" loading={busy}>Create cycle</Button></>}>
      <form id="cycle-form" onSubmit={create} className="space-y-4">
        <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120}/>
        <Field label="Type">
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {Object.entries(CYCLE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <TextField label="Starts" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} required/>
          <TextField label="Ends" type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} required/>
        </div>
        <Field label="Review form" hint="Which goals, competencies and questions people are rated on.">
          <Select value={f.templateId || templates.data?.[0]?.id || ''} onChange={(e) => setF({ ...f, templateId: e.target.value })}>
            {(templates.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
      </form>
    </Drawer>);
}
