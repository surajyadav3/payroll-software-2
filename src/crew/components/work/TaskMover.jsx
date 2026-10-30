import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Link2, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Field, Input } from '@/crew/components/ui';
import { useToast } from '@/crew/components/ui';
import { api, ApiError } from '@/crew/lib/api';
import { useDraft } from '@/crew/lib/use-draft';
import { moveVerb, STATUS_LABEL } from '@/crew/lib/work';
const EMPTY = { reason: '', dueDate: '', links: [''], note: '', followUp: '' };
const NEED_OF = { REASON_REQUIRED: 'reason', DUE_REQUIRED: 'due', DELIVERABLE_REQUIRED: 'deliverable' };
/** What a move will certainly need, known before asking the server (it may still ask for more). */
function knownNeeds(r) {
    const s = new Set();
    const { status } = r.task;
    if (r.to === status)
        return s; // a reorder inside the same column
    if (r.to === 'blocked' || r.to === 'cancelled' || status === 'done' || (status === 'in_review' && r.to === 'in_progress' && r.task.canApprove))
        s.add('reason');
    if ((r.to === 'in_progress' || r.to === 'blocked' || r.to === 'done') && !r.task.dueDate && (status === 'backlog' || status === 'todo'))
        s.add('due');
    return s;
}
/**
 * Every status change in the app goes through here. It tries the move; when the rules need something (a reason, a
 * due date, a link to the work) it asks for exactly that in a small dialog and tries again. Returns true when moved.
 */
export function useTaskMover() {
    const qc = useQueryClient();
    const toast = useToast();
    const [state, setState] = useState(null);
    const resolver = useRef(null);
    const finish = useCallback((ok) => {
        resolver.current?.(ok);
        resolver.current = null;
        setState(null);
    }, []);
    const attempt = useCallback(async (req, v) => {
        const links = v?.links.map((l) => l.trim()).filter(Boolean);
        const note = v?.note.trim() || undefined;
        const common = { reason: v?.reason.trim() || undefined, dueDate: v?.dueDate || undefined };
        // Board drops use /move (keeps the place); anything with a deliverable or a follow-up uses /transition.
        const viaMove = (req.beforeId !== undefined || req.afterId !== undefined) && !links?.length && !note && !v?.followUp.trim();
        const res = viaMove
            ? await api(`/work/tasks/${req.task.id}/move`, { method: 'POST', body: { status: req.to, beforeId: req.beforeId ?? null, afterId: req.afterId ?? null, ...common } })
            : await api(`/work/tasks/${req.task.id}/transition`, {
                method: 'POST',
                body: { to: req.to, ...common, ...(links?.length ? { links } : {}), note, followUp: v?.followUp.trim() ? { title: v.followUp.trim() } : undefined },
            });
        void qc.invalidateQueries({ queryKey: ['work'] });
        if (req.to === 'done' && res.status === 'in_review')
            toast('success', `${req.task.key} sent to ${res.approver?.name ?? 'the reviewer'} for review.`);
        else if (req.to === 'done' && req.task.status === 'in_review')
            toast('success', `${req.task.key} approved.${'followUpTaskId' in res && res.followUpTaskId ? ' Follow-up task created.' : ''}`);
        else if (req.to === 'done')
            toast('success', `${req.task.key} done.`);
    }, [qc, toast]);
    const fail = useCallback((err, req, needs, values) => {
        const need = err instanceof ApiError ? NEED_OF[err.code] : undefined;
        if (need) {
            setState({ req, needs: new Set([...needs, need]), message: err.message, values });
            return;
        }
        toast('danger', err instanceof ApiError ? err.message : 'Could not move the task.');
        void qc.invalidateQueries({ queryKey: ['work'] });
        finish(false);
    }, [toast, qc, finish]);
    const move = useCallback((req) => new Promise((resolve) => {
        resolver.current = resolve;
        const needs = knownNeeds(req);
        if (needs.size || req.offerFollowUp) {
            setState({ req, needs, message: null, values: EMPTY });
            return;
        }
        attempt(req, null).then(() => finish(true), (err) => fail(err, req, needs, EMPTY));
    }), [attempt, fail, finish]);
    const dialog = (<AnimatePresence>
      {state && (<MoveDialog key={state.req.task.id} state={state} onCancel={() => {
                void qc.invalidateQueries({ queryKey: ['work'] });
                finish(false);
            }} onSubmit={async (values) => {
                try {
                    await attempt(state.req, values);
                    finish(true);
                    return true;
                }
                catch (err) {
                    fail(err, state.req, state.needs, values);
                    return false;
                }
            }}/>)}
    </AnimatePresence>);
    return { move, dialog };
}
function MoveDialog({ state, onCancel, onSubmit }) {
    const { req, needs } = state;
    // What is typed here is kept per task and move until the move succeeds (cancel / Escape keep it).
    const [v, setV, discard] = useDraft(`move:${req.task.id}:${req.to}`, state.values);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        const onKey = (e) => e.key === 'Escape' && onCancel();
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onCancel]);
    const verb = moveVerb(req.task.status, req.to, !!req.task.canApprove);
    const reasonLabel = req.to === 'blocked' ? 'What is blocking it?' : req.to === 'cancelled' ? 'Why cancel it?' : req.task.status === 'done' ? 'Why reopen it?' : req.task.status === 'in_review' ? 'What needs to change?' : 'Reason';
    const ok = (!needs.has('reason') || v.reason.trim().length >= 4) &&
        (!needs.has('due') || !!v.dueDate) &&
        (!needs.has('deliverable') || v.links.some((l) => l.trim()) || v.note.trim().length > 0);
    async function submit(e) {
        e.preventDefault();
        if (!ok)
            return;
        setBusy(true);
        if (await onSubmit(v))
            discard();
        setBusy(false);
    }
    return (<div className="fixed inset-0 z-[210] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <motion.div className="absolute inset-0 bg-ink-950/50 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onCancel}/>
      <motion.form role="dialog" aria-modal="true" aria-label={verb} onSubmit={submit} initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: 0.98 }} transition={{ type: 'spring', damping: 30, stiffness: 380 }} className="relative w-full max-w-md rounded-t-2xl bg-surface p-5 shadow-3 sm:rounded-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{req.task.key} · {STATUS_LABEL[req.task.status]} → {STATUS_LABEL[req.to]}</div>
            <h2 className="mt-0.5 truncate text-base font-semibold text-fg">{verb}: {req.task.title}</h2>
          </div>
          <button type="button" onClick={onCancel} className="rounded-lg p-1.5 text-fg-muted hover:bg-bg-subtle" aria-label="Close"><X className="size-4"/></button>
        </div>
        {state.message && <p className="mb-3 rounded-xl bg-warning-surface px-3 py-2 text-sm text-warning-text">{state.message}</p>}
        <div className="space-y-4">
          {needs.has('due') && (<Field label="Due date" hint="The finish commitment. Once work starts it is fixed; later changes are recorded as revisions.">
              <Input type="date" value={v.dueDate} onChange={(e) => setV({ ...v, dueDate: e.target.value })} required autoFocus/>
            </Field>)}
          {needs.has('deliverable') && (<Field label="Link to the work" hint="A document, sheet, pull request… (or write a completion note below).">
              <div className="space-y-2">
                {v.links.map((l, i) => (<div key={i} className="relative">
                    <Link2 className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"/>
                    <Input value={l} onChange={(e) => setV({ ...v, links: v.links.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="https://" className="pl-9" type="url" autoFocus={i === 0}/>
                  </div>))}
                {v.links.length < 10 && <Button type="button" size="sm" variant="ghost" icon={<Plus className="size-4"/>} onClick={() => setV({ ...v, links: [...v.links, ''] })}>Another link</Button>}
              </div>
            </Field>)}
          {needs.has('deliverable') && (<Field label="Completion note">
              <textarea value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} rows={2} maxLength={2000} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30 sm:text-sm" placeholder="What was done, where to find it"/>
            </Field>)}
          {needs.has('reason') && (<Field label={reasonLabel} hint="4–500 characters. Saved on the task's timeline.">
              <textarea value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} rows={3} maxLength={500} autoFocus={!needs.has('due') && !needs.has('deliverable')} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30 sm:text-sm"/>
            </Field>)}
          {req.offerFollowUp && (<Field label="Next task (optional)" hint="Created right away as a sub-task, for the same person.">
              <Input value={v.followUp} onChange={(e) => setV({ ...v, followUp: e.target.value })} placeholder="What comes next?" maxLength={250} autoFocus={!needs.size}/>
            </Field>)}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!ok} variant={req.to === 'cancelled' ? 'danger' : 'primary'}>{verb}</Button>
        </div>
      </motion.form>
    </div>);
}
