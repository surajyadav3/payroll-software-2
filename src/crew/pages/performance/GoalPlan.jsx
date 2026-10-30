import { useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, CircleDashed, Flag, MessageSquareText, Pencil, Plus, Send, Target, Trash2, TrendingUp, Undo2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { Badge, Button, Card, cx, Drawer, EmptyState, ErrorState, Field, Input, Select, Skeleton, TextField, useToast } from '@/crew/components/ui';
import { api, ApiError } from '@/crew/lib/api';
import { useDraft } from '@/crew/lib/use-draft';
import { fmtDate } from '@/crew/lib/format';
import { PLAN_STATUS, pct, useCheckIns, usePlan } from '@/crew/lib/pms';
/** A progress ring (0–100). */
export function Ring({ value, size = 56, stroke = 6, tone = 'text-brand' }) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const v = value ?? 0;
    return (<div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="fill-none stroke-bg-subtle"/>
        <motion.circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} strokeLinecap="round" className={cx('fill-none stroke-current', tone)} strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c - (c * v) / 100 }} transition={{ duration: 0.8, ease: 'easeOut' }}/>
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular text-fg">{value === null ? '—' : `${v}%`}</span>
    </div>);
}
// A plan waiting for its approver is locked; any other plan can change (a change to an approved goal is sent for approval again).
const editable = (status) => status !== 'submitted';
const proposal = (g) => g.status === 'draft' || g.status === 'returned';
/**
 * One person's goal plan for a cycle: weights adding up to 100, goals with measures and progress, check-ins, and
 * submitting the plan for approval. `mode` = self (my own plan) or manager (a report's plan: assign goals).
 */
export function GoalPlan({ cycle, employeeId, mode }) {
    const plan = usePlan(cycle.id, employeeId);
    const qc = useQueryClient();
    const toast = useToast();
    const [editing, setEditing] = useState(null);
    const [checkIn, setCheckIn] = useState(null);
    const [busy, setBusy] = useState(false);
    const p = plan.data;
    if (plan.error)
        return <ErrorState error={plan.error} retry={() => plan.refetch()}/>;
    if (!p)
        return <div className="space-y-3"><Skeleton className="h-24"/><Skeleton className="h-40"/></div>;
    const goals = p.goals.filter((g) => g.status !== 'archived' && g.status !== 'rejected');
    const total = Number(p.totalWeight);
    const overall = goals.length ? Math.round(goals.reduce((a, g) => a + (pct(g.progressPercent) ?? 0) * (Number(g.weight ?? 0) / Math.max(total, 1)), 0)) : null;
    const canChange = mode !== 'view' && cycle.status !== 'closed' && editable(p.status);
    // Something to send: a new proposal, or a change to an approved goal.
    const canSubmit = mode === 'self' && cycle.status !== 'closed' && editable(p.status) && goals.some((g) => proposal(g) || g.pendingChange);
    async function submit() {
        setBusy(true);
        try {
            await api(`/pms/cycles/${cycle.id}/plans/${employeeId}/submit`, { method: 'POST', body: {} });
            toast('success', 'Sent for approval.');
            void qc.invalidateQueries({ queryKey: ['pms'] });
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not submit.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-5 p-5">
        <Ring value={overall} size={64}/>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-fg">{goals.length} goal{goals.length === 1 ? '' : 's'}</span>
            <Badge tone={PLAN_STATUS[p.status].tone} dot>{PLAN_STATUS[p.status].label}</Badge>
          </div>
          <div className="mt-2 max-w-md">
            <div className="flex justify-between text-xs text-fg-muted"><span>Weights</span><span className={cx('tabular', p.weightsComplete ? 'text-success-text' : 'text-warning-text')}>{total}% of 100%</span></div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-bg-subtle"><div className={cx('h-full rounded-full transition-all', p.weightsComplete ? 'bg-success-solid' : total > 100 ? 'bg-danger-solid' : 'bg-warning-solid')} style={{ width: `${Math.min(100, total)}%` }}/></div>
          </div>
        </div>
        <div className="flex gap-2">
          {canChange && <Button variant="secondary" icon={<Plus className="size-4"/>} onClick={() => setEditing('new')}>{mode === 'manager' ? 'Assign goal' : 'Add goal'}</Button>}
          {canSubmit && <Button icon={<Send className="size-4"/>} loading={busy} disabled={!p.weightsComplete} title={p.weightsComplete ? undefined : 'Weights must add up to 100%'} onClick={() => void submit()}>Submit for approval</Button>}
        </div>
      </Card>
      {p.status === 'submitted' && !p.canDecide && <Note tone="warning" title={`Waiting for ${p.approver?.name ?? 'HR'} to approve`} body="Goals are locked until the plan is approved or sent back."/>}
      {p.decisionComment && (p.status === 'returned' || p.status === 'rejected' || p.status === 'approved') && <Note tone={p.status === 'approved' ? 'success' : p.status === 'rejected' ? 'danger' : 'info'} title={p.status === 'returned' ? 'Sent back — change the goals and submit again' : p.status === 'rejected' ? 'Plan rejected' : 'Approved with a note'} body={p.decisionComment}/>}
      {mode === 'manager' && p.canDecide && <DecisionBar cycleId={cycle.id} employeeId={employeeId}/>}

      {goals.length === 0 ? (<Card><EmptyState icon={<Target className="size-6"/>} title="No goals yet" body={mode === 'self' ? 'Add 3–5 goals for this cycle. Give each a weight (they add up to 100%) and a way to measure it.' : 'No goals in this plan yet.'} action={canChange ? <Button icon={<Plus className="size-4"/>} onClick={() => setEditing('new')}>{mode === 'manager' ? 'Assign goal' : 'Add goal'}</Button> : undefined}/></Card>) : (<div className="grid gap-4 lg:grid-cols-2">
          {goals.map((g, i) => (<motion.div key={g.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
              <GoalCard g={g} canEdit={canChange && (mode === 'self' || !proposal(g))} canCheckIn={mode === 'self' && (g.status === 'active' || p.status === 'approved') && cycle.status === 'open'} onEdit={() => setEditing(g)} onCheckIn={() => setCheckIn(g)}/>
            </motion.div>))}
        </div>)}
      <GoalDrawer value={editing} cycleId={cycle.id} employeeId={employeeId} onClose={() => setEditing(null)}/>
      <CheckInDrawer goal={checkIn} onClose={() => setCheckIn(null)}/>
    </div>);
}
/** A notice above the goals: who the plan is waiting for, or what the approver said. */
function Note({ tone, title, body }) {
    const tones = { warning: 'border-warning-border bg-warning-surface text-warning-text', info: 'border-info-border bg-info-surface text-info-text', danger: 'border-danger-border bg-danger-surface text-danger-text', success: 'border-success-border bg-success-surface text-success-text' };
    return (<div className={cx('flex gap-3 rounded-2xl border px-4 py-3 text-sm', tones[tone])}>
      <MessageSquareText className="mt-0.5 size-4 shrink-0"/>
      <div className="min-w-0"><div className="font-semibold">{title}</div>{body && <p className="mt-0.5 whitespace-pre-wrap text-fg">{body}</p>}</div>
    </div>);
}
/** The approver's decision on a submitted plan: approve, send back with what to change, or reject. */
function DecisionBar({ cycleId, employeeId }) {
    const qc = useQueryClient();
    const toast = useToast();
    const [comment, setComment] = useState('');
    const [busy, setBusy] = useState(null);
    async function decide(action) {
        setBusy(action);
        try {
            await api(`/pms/cycles/${cycleId}/plans/${employeeId}/decision`, { method: 'POST', body: { action, comment } });
            toast('success', action === 'approve' ? 'Plan approved.' : action === 'return' ? 'Sent back.' : 'Plan rejected.');
            setComment('');
            void qc.invalidateQueries({ queryKey: ['pms'] });
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not save the decision.');
        }
        finally {
            setBusy(null);
        }
    }
    const needsComment = !comment.trim();
    return (<Card className="space-y-3 border-warning-border p-5">
      <div><div className="font-semibold text-fg">This plan is waiting for your approval</div><p className="text-sm text-fg-muted">Approve it to make the goals active, or send it back saying what should change.</p></div>
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} maxLength={2000} placeholder="Comment (needed to send back or reject)" className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30"/>
      <div className="flex flex-wrap gap-2">
        <Button icon={<Check className="size-4"/>} loading={busy === 'approve'} disabled={!!busy} onClick={() => void decide('approve')}>Approve</Button>
        <Button variant="secondary" icon={<Undo2 className="size-4"/>} loading={busy === 'return'} disabled={!!busy || needsComment} title={needsComment ? 'Add a comment first' : undefined} onClick={() => void decide('return')}>Send back</Button>
        <Button variant="ghost" icon={<X className="size-4"/>} loading={busy === 'reject'} disabled={!!busy || needsComment} title={needsComment ? 'Add a comment first' : undefined} onClick={() => void decide('reject')}>Reject</Button>
      </div>
    </Card>);
}
function GoalCard({ g, canEdit, canCheckIn, onEdit, onCheckIn }) {
    const progress = pct(g.progressPercent);
    return (<Card className="flex h-full flex-col p-5">
      <div className="flex items-start gap-4">
        <Ring value={progress} tone={progress !== null && progress >= 100 ? 'text-success-solid' : 'text-brand'}/>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {g.weight && <Badge tone="brand">{Number(g.weight)}%</Badge>}
            {g.origin === 'assigned' && <Badge>Assigned</Badge>}
            {g.origin === 'carried' && <Badge>Carried over</Badge>}
            {g.pendingChange && <Badge tone="warning">Change waiting for approval</Badge>}
            {g.status === 'pending_approval' && <Badge tone="warning">Waiting for approval</Badge>}
            {g.status === 'returned' && <Badge tone="info">Sent back</Badge>}
            {g.status === 'completed' && <Badge tone="success">Completed</Badge>}
          </div>
          <div className="mt-1.5 font-semibold text-fg">{g.title}</div>
          {g.description && <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{g.description}</p>}
        </div>
      </div>
      {g.measures.length > 0 && (<div className="mt-4 space-y-2.5 border-t border-border pt-4">
          {g.measures.map((m) => <MeasureRow key={m.id} m={m}/>)}
        </div>)}
      {(canEdit || canCheckIn) && (<div className="mt-auto flex gap-2 pt-4">
          {canCheckIn && <Button size="sm" icon={<TrendingUp className="size-4"/>} onClick={onCheckIn}>Update progress</Button>}
          {canEdit && <Button size="sm" variant="ghost" icon={<Pencil className="size-4"/>} onClick={onEdit}>Edit</Button>}
        </div>)}
    </Card>);
}
function MeasureRow({ m }) {
    const p = pct(m.progressPercent);
    const value = m.kind === 'milestone' ? (m.isDone ? 'Done' : 'Not yet') : m.kind === 'qualitative' ? '' : `${m.currentValue ?? m.startValue ?? '—'} / ${m.targetValue ?? '—'}${m.unit ? ` ${m.unit}` : m.kind === 'percentage' ? '%' : ''}`;
    return (<div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="flex min-w-0 items-center gap-1.5 text-fg">{m.kind === 'milestone' ? (m.isDone ? <CheckCircle2 className="size-3.5 text-success-text"/> : <CircleDashed className="size-3.5 text-fg-subtle"/>) : <Flag className="size-3.5 text-fg-subtle"/>}<span className="truncate">{m.title}</span></span>
        <span className="shrink-0 text-xs tabular text-fg-muted">{value}</span>
      </div>
      {m.kind !== 'qualitative' && m.kind !== 'milestone' && (<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-subtle"><div className="h-full rounded-full bg-brand transition-all" style={{ width: `${p ?? 0}%` }}/></div>)}
    </div>);
}
const blankMeasure = () => ({ title: '', kind: 'numeric', direction: 'increase', unit: '', startValue: '0', targetValue: '' });
function GoalDrawer({ value, cycleId, employeeId, onClose }) {
    const qc = useQueryClient();
    const toast = useToast();
    const g = value && value !== 'new' ? value : null;
    // Each goal (and "new goal" per plan) keeps its unsaved edits as a draft until saved.
    const [f, setF, discardGoal] = useDraft(value ? `goal:${cycleId}:${employeeId}:${g?.id ?? 'new'}` : null, g ? {
        title: g.title,
        description: g.description,
        weight: g.weight ? String(Number(g.weight)) : '',
        measures: g.measures.length ? g.measures.map((m) => ({ title: m.title, kind: m.kind, direction: m.direction ?? 'increase', unit: m.unit, startValue: m.startValue ?? '', targetValue: m.targetValue ?? '' })) : [],
    } : { title: '', description: '', weight: '', measures: [blankMeasure()] });
    const [busy, setBusy] = useState(false);
    const setM = (i, patch) => setF((s) => ({ ...s, measures: s.measures.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
    const measures = () => f.measures.filter((m) => m.title.trim()).map((m) => ({
        title: m.title.trim(),
        kind: m.kind,
        ...(m.kind === 'numeric' || m.kind === 'percentage' ? { direction: m.direction, unit: m.unit || null, startValue: m.startValue || '0', targetValue: m.targetValue || null } : {}),
    }));
    async function save(e) {
        e.preventDefault();
        setBusy(true);
        try {
            if (g) {
                const updated = await api(`/pms/goals/${g.id}`, { method: 'PATCH', headers: { 'if-match': `"${g.version}"` }, body: { title: f.title, description: f.description, weight: f.weight || '0' } });
                await api(`/pms/goals/${g.id}/measures`, { method: 'PUT', headers: { 'if-match': `"${updated.version}"` }, body: { measures: measures() } });
            }
            else {
                await api('/pms/goals', { method: 'POST', idempotent: true, body: { level: 'individual', cycleId, ownerEmployeeId: employeeId, title: f.title, description: f.description, weight: f.weight || null, measures: measures() } });
            }
            toast('success', g ? 'Goal saved.' : 'Goal added.');
            discardGoal();
            void qc.invalidateQueries({ queryKey: ['pms'] });
            onClose();
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not save the goal.');
        }
        finally {
            setBusy(false);
        }
    }
    async function remove() {
        if (!g)
            return;
        setBusy(true);
        try {
            await api(`/pms/goals/${g.id}/archive`, { method: 'POST', headers: { 'if-match': `"${g.version}"` }, body: { reason: 'Removed from the plan' } });
            toast('success', 'Goal removed.');
            discardGoal();
            void qc.invalidateQueries({ queryKey: ['pms'] });
            onClose();
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not remove the goal.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<Drawer open={!!value} onClose={onClose} width="max-w-2xl" title={g ? 'Edit goal' : 'New goal'} subtitle="A clear outcome, how much it counts (weight), and how you will measure it." footer={<>{g && <Button variant="ghost" icon={<Trash2 className="size-4"/>} onClick={() => void remove()} disabled={busy}>Remove</Button>}<Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="goal-form" loading={busy} disabled={!f.title.trim()}>Save goal</Button></>}>
      <form id="goal-form" onSubmit={save} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
          <TextField label="Goal" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={200} required placeholder="e.g. Grow outlet sales in the North region"/>
          <TextField label="Weight (%)" type="number" min={0} max={100} value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} placeholder="25"/>
        </div>
        <Field label="Details (optional)">
          <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={3} maxLength={4000} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30"/>
        </Field>
        <Field label="How it is measured">
          <div className="space-y-3">
            {f.measures.map((m, i) => (<div key={i} className="space-y-2 rounded-2xl border border-border p-3">
                <div className="flex gap-2">
                  <Input value={m.title} onChange={(e) => setM(i, { title: e.target.value })} placeholder="e.g. Monthly sales" className="flex-1"/>
                  <Select value={m.kind} onChange={(e) => setM(i, { kind: e.target.value })} className="w-36">
                    <option value="numeric">Number</option>
                    <option value="percentage">Percentage</option>
                    <option value="milestone">Done / not done</option>
                    <option value="qualitative">Judgement</option>
                  </Select>
                  <button type="button" onClick={() => setF((s) => ({ ...s, measures: s.measures.filter((_, j) => j !== i) }))} className="rounded-lg p-2 text-fg-subtle hover:bg-danger-surface hover:text-danger-text" aria-label="Remove measure"><Trash2 className="size-4"/></button>
                </div>
                {(m.kind === 'numeric' || m.kind === 'percentage') && (<div className="grid grid-cols-4 gap-2">
                    <Select value={m.direction} onChange={(e) => setM(i, { direction: e.target.value })}><option value="increase">Higher is better</option><option value="decrease">Lower is better</option></Select>
                    <Input value={m.startValue} onChange={(e) => setM(i, { startValue: e.target.value })} placeholder="From" inputMode="decimal"/>
                    <Input value={m.targetValue} onChange={(e) => setM(i, { targetValue: e.target.value })} placeholder="Target" inputMode="decimal"/>
                    {m.kind === 'numeric' && <Input value={m.unit} onChange={(e) => setM(i, { unit: e.target.value })} placeholder="Unit (₹, units…)" maxLength={30}/>}
                  </div>)}
              </div>))}
            {f.measures.length < 20 && <Button type="button" size="sm" variant="ghost" icon={<Plus className="size-4"/>} onClick={() => setF((s) => ({ ...s, measures: [...s.measures, blankMeasure()] }))}>Add a measure</Button>}
          </div>
        </Field>
      </form>
    </Drawer>);
}
// ───────────────────────────── check-in ─────────────────────────────
function CheckInDrawer({ goal, onClose }) {
    const qc = useQueryClient();
    const toast = useToast();
    const history = useCheckIns(goal?.id ?? null);
    const [measureId, setMeasureId] = useState('');
    const [value, setValue] = useState('');
    const [done, setDone] = useState(false);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [was, setWas] = useState(null);
    if ((goal?.id ?? null) !== was) {
        setWas(goal?.id ?? null);
        const m = goal?.measures[0];
        setMeasureId(m?.id ?? '');
        setValue(m?.currentValue ?? '');
        setDone(!!m?.isDone);
        setNote('');
    }
    const m = goal?.measures.find((x) => x.id === measureId);
    async function save(e) {
        e.preventDefault();
        if (!goal || !m)
            return;
        setBusy(true);
        try {
            await api(`/pms/goals/${goal.id}/check-ins`, { method: 'POST', idempotent: true, body: { measureId: m.id, ...(m.kind === 'milestone' ? { isDone: done } : m.kind === 'qualitative' ? {} : { value }), note } });
            toast('success', 'Progress updated.');
            void qc.invalidateQueries({ queryKey: ['pms'] });
            setNote('');
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not save.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<Drawer open={!!goal} onClose={onClose} title="Update progress" subtitle={goal?.title} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button type="submit" form="checkin-form" loading={busy} disabled={!m}>Save update</Button></>}>
      {!goal?.measures.length ? <p className="text-sm text-fg-muted">This goal has no measures yet — add one first.</p> : (<div className="space-y-6">
          <form id="checkin-form" onSubmit={save} className="space-y-4">
            <Field label="Measure">
              <Select value={measureId} onChange={(e) => { const x = goal.measures.find((y) => y.id === e.target.value); setMeasureId(e.target.value); setValue(x?.currentValue ?? ''); setDone(!!x?.isDone); }}>
                {goal.measures.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
              </Select>
            </Field>
            {m?.kind === 'milestone' ? (<label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" className="size-4 accent-[var(--cc-brand)]" checked={done} onChange={(e) => setDone(e.target.checked)}/>Done</label>) : m?.kind !== 'qualitative' && (<TextField label={`Where it stands now${m?.targetValue ? ` (target ${m.targetValue}${m.unit ? ` ${m.unit}` : ''})` : ''}`} value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" required/>)}
            <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="What moved it, what is blocking it"/>
          </form>
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">History</div>
            {history.isLoading ? <Skeleton className="h-20"/> : !(history.data ?? []).length ? <p className="text-sm text-fg-muted">No updates yet.</p> : (<ol className="relative space-y-3 border-l border-border pl-4">
                {(history.data ?? []).map((c) => (<li key={c.id} className="relative text-sm">
                    <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-brand"/>
                    <div className="flex justify-between gap-2"><span className="font-medium text-fg">{goal.measures.find((x) => x.id === c.measureId)?.title}: {c.isDone !== null ? (c.isDone ? 'done' : 'not done') : c.value ?? '—'}</span><span className="text-xs text-fg-subtle">{fmtDate(c.createdAt, { day: 'numeric', month: 'short' })}</span></div>
                    {c.note && <div className="text-xs text-fg-muted">{c.note}</div>}
                  </li>))}
              </ol>)}
          </div>
        </div>)}
    </Drawer>);
}
