import { useQueryClient } from '@tanstack/react-query';
import { Award, CheckCircle2, MessageSquareWarning, Save, Send, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, cx, Drawer, ErrorState, Field, Skeleton, TextField, useToast } from '@/crew/components/ui';
import { api, ApiError } from '@/crew/lib/api';
import { useDraft } from '@/crew/lib/use-draft';
import { fmtDate } from '@/crew/lib/format';
import { REVIEW_STATUS, useReview, useScales } from '@/crew/lib/pms';
const SECTIONS = [
    { type: 'goal', title: 'Goals', hint: 'How well each goal was achieved.' },
    { type: 'competency', title: 'Competencies', hint: 'How the work was done.' },
    { type: 'question', title: 'Questions', hint: 'In your own words.' },
];
/** One review: the form for whoever may edit it now, the other side when visible, and the result. */
export function ReviewSheet({ id, onClose }) {
    const review = useReview(id);
    const r = review.data;
    return (<Drawer open={!!id} onClose={onClose} width="max-w-4xl" title={r ? (r.viewer === 'reviewee' ? 'My review' : `Review: ${r.employeeName ?? 'Employee'}`) : 'Review'} subtitle={r ? REVIEW_STATUS[r.status].label : undefined}>
      {review.error ? <ErrorState error={review.error}/> : !r ? <Skeleton className="h-96"/> : <Body key={`${r.id}:${r.version}`} r={r} onDone={onClose}/>}
    </Drawer>);
}
function Body({ r, onDone }) {
    const scales = useScales();
    const qc = useQueryClient();
    const toast = useToast();
    const side = r.canEditSelf ? 'self' : r.canEditManager ? 'manager' : null;
    const mine = side === 'self' ? r.self : side === 'manager' ? r.manager : null;
    const [sheet, setSheet, discardSheet] = useDraft(side ? `review:${r.id}:${side}` : null, {
        ratings: Object.fromEntries((mine?.ratings ?? []).map((x) => [x.itemId, x])),
        comment: mine?.summary?.comment ?? '',
        override: mine?.summary?.override ?? null,
    });
    const { ratings, comment, override } = sheet;
    const setRatings = (f) => setSheet((x) => ({ ...x, ratings: f(x.ratings) }));
    const setComment = (v) => setSheet((x) => ({ ...x, comment: v }));
    const setOverride = (v) => setSheet((x) => ({ ...x, override: v }));
    const [busy, setBusy] = useState(null);
    const levelsOf = (scaleId) => [...(scales.data?.find((s) => s.id === scaleId)?.levels ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    const allLevels = scales.data?.flatMap((s) => s.levels) ?? [];
    const levelLabel = (id) => allLevels.find((l) => l.id === id)?.label ?? null;
    const visible = (it) => (side ? it.answeredBy === side || it.answeredBy === 'both' : true);
    const set = (itemId, patch) => setRatings((s) => ({ ...s, [itemId]: { itemId, levelId: null, notApplicable: false, comment: '', ...s[itemId], ...patch } }));
    async function save(submit) {
        if (!side)
            return;
        setBusy(submit ? 'submit' : 'save');
        try {
            const body = {
                ratings: Object.values(ratings),
                summary: { comment, overallLevelId: null },
                ...(side === 'manager' ? { override: override && override.levelId && override.reason.trim().length >= 3 ? override : null } : {}),
            };
            await api(`/pms/reviews/${r.id}/${side}`, { method: 'PUT', body });
            if (submit)
                await api(`/pms/reviews/${r.id}/${side}/submit`, { method: 'POST', body: {} });
            discardSheet({ keep: true });
            toast('success', submit ? (side === 'self' ? 'Self review submitted — your manager reviews next.' : 'Review submitted.') : 'Saved. You can come back to it.');
            void qc.invalidateQueries({ queryKey: ['pms'] });
            if (submit)
                onDone();
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not save the review.');
        }
        finally {
            setBusy(null);
        }
    }
    const required = r.items.filter((it) => visible(it) && it.isRequired && it.scaleId);
    const missing = side ? required.filter((it) => !ratings[it.id]?.levelId && !ratings[it.id]?.notApplicable).length : 0;
    return (<div className="space-y-6">
      {r.result && <ResultCard r={r}/>}
      {r.status === 'blocked' && <div className="rounded-2xl border border-warning-border bg-warning-surface p-4 text-sm text-warning-text">This review opens once the goal plan is approved and its weights add up to 100%.</div>}

      {side === 'manager' && r.score?.proposedLevelId && (<Card className="flex flex-wrap items-center gap-3 p-4">
          <Sparkles className="size-5 text-brand-text"/>
          <div className="flex-1 text-sm text-fg">Suggested overall from your ratings: <b className="font-semibold">{levelLabel(r.score.proposedLevelId)}</b>{r.score.proposedScore ? <span className="text-fg-muted"> (score {Number(r.score.proposedScore).toFixed(2)})</span> : null}</div>
        </Card>)}

      {SECTIONS.map((sec) => {
            const items = r.items.filter((it) => it.itemType === sec.type && visible(it)).sort((a, b) => a.ordinal - b.ordinal);
            if (!items.length)
                return null;
            return (<section key={sec.type}>
            <div className="mb-3"><h3 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">{sec.title}</h3><p className="text-xs text-fg-subtle">{sec.hint}</p></div>
            <div className="space-y-3">
              {items.map((it) => {
                    const levels = levelsOf(it.scaleId);
                    const cur = ratings[it.id];
                    const theirs = side === 'manager' ? r.self?.ratings.find((x) => x.itemId === it.id) : null;
                    const self = !side ? r.self?.ratings.find((x) => x.itemId === it.id) : null;
                    const mgr = !side ? r.manager?.ratings.find((x) => x.itemId === it.id) : null;
                    return (<Card key={it.id} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-fg">{it.title}{it.isRequired && side && <span className="text-danger-text"> *</span>}</div>
                        {it.helpText && <div className="text-xs text-fg-muted">{it.helpText}</div>}
                      </div>
                      <div className="flex gap-1.5">{it.weight && <Badge tone="brand">{Number(it.weight)}%</Badge>}{it.expectedLevelId && <Badge>Expected: {levelLabel(it.expectedLevelId)}</Badge>}</div>
                    </div>
                    {side ? (<div className="mt-3 space-y-2">
                        {levels.length > 0 && (<div className="flex flex-wrap gap-1.5">
                            {levels.map((l) => (<button key={l.id} type="button" title={l.description} onClick={() => set(it.id, { levelId: cur?.levelId === l.id ? null : l.id, notApplicable: false })} className={cx('rounded-xl border px-3 py-1.5 text-sm transition', cur?.levelId === l.id ? 'border-brand bg-brand text-on-brand' : 'border-border text-fg-muted hover:border-border-strong hover:text-fg')}>
                                <span className="mr-1 font-semibold tabular">{l.value.replace(/\.0+$/, '')}</span>{l.label}
                              </button>))}
                            {!it.isRequired && <button type="button" onClick={() => set(it.id, { notApplicable: !cur?.notApplicable, levelId: null })} className={cx('rounded-xl border px-3 py-1.5 text-sm', cur?.notApplicable ? 'border-brand bg-brand-surface text-brand-text' : 'border-border text-fg-subtle')}>Not applicable</button>}
                          </div>)}
                        {theirs && (theirs.levelId || theirs.comment) && <div className="rounded-xl bg-bg-subtle px-3 py-2 text-xs text-fg-muted">Their own rating: <b className="font-medium text-fg">{levelLabel(theirs.levelId) ?? '—'}</b>{theirs.comment ? ` — “${theirs.comment}”` : ''}</div>}
                        <textarea value={cur?.comment ?? ''} onChange={(e) => set(it.id, { comment: e.target.value })} rows={2} maxLength={2000} placeholder={levels.length ? 'Examples that support this rating (optional)' : 'Your answer'} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30"/>
                      </div>) : (<div className="mt-3 grid gap-2 sm:grid-cols-2">
                        <Side who="Self" rating={self} label={levelLabel(self?.levelId)}/>
                        {r.manager && <Side who="Manager" rating={mgr} label={levelLabel(mgr?.levelId)}/>}
                      </div>)}
                  </Card>);
                })}
            </div>
          </section>);
        })}

      {side ? (<section className="space-y-4">
          <Field label={side === 'self' ? 'Overall, how did this period go for you?' : 'Overall comments for them'}>
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={4} maxLength={4000} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30"/>
          </Field>
          {side === 'manager' && (<Card className="p-4">
              <label className="flex items-center gap-2 text-sm font-medium text-fg"><input type="checkbox" className="size-4 accent-[var(--cc-brand)]" checked={!!override} onChange={(e) => setOverride(e.target.checked ? { levelId: '', reason: '' } : null)}/>Use a different overall rating than suggested</label>
              {override && (<div className="mt-3 space-y-3">
                  <div className="flex flex-wrap gap-1.5">
                    {levelsOf(r.items.find((i) => i.scaleId)?.scaleId ?? scales.data?.[0]?.id ?? null).map((l) => (<button key={l.id} type="button" onClick={() => setOverride({ ...override, levelId: l.id })} className={cx('rounded-xl border px-3 py-1.5 text-sm', override.levelId === l.id ? 'border-brand bg-brand text-on-brand' : 'border-border text-fg-muted')}>{l.label}</button>))}
                  </div>
                  <TextField label="Why (required, kept on record)" value={override.reason} onChange={(e) => setOverride({ ...override, reason: e.target.value })} maxLength={2000}/>
                </div>)}
            </Card>)}
          <div className="sticky -bottom-5 -mx-6 -mb-5 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface/95 px-6 py-3 backdrop-blur">
            {missing > 0 && <span className="mr-auto text-xs text-warning-text">{missing} required rating{missing === 1 ? '' : 's'} left</span>}
            <Button variant="secondary" icon={<Save className="size-4"/>} loading={busy === 'save'} disabled={!!busy} onClick={() => void save(false)}>Save draft</Button>
            <Button icon={<Send className="size-4"/>} loading={busy === 'submit'} disabled={!!busy || missing > 0} onClick={() => void save(true)}>Submit</Button>
          </div>
        </section>) : ((r.self?.summary?.comment || r.manager?.summary?.comment) && (<section className="grid gap-3 sm:grid-cols-2">
            {r.self?.summary?.comment && <Card className="p-4"><div className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Self summary</div><p className="mt-1 whitespace-pre-wrap text-sm text-fg">{r.self.summary.comment}</p></Card>}
            {r.manager?.summary?.comment && <Card className="p-4"><div className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">Manager summary</div><p className="mt-1 whitespace-pre-wrap text-sm text-fg">{r.manager.summary.comment}</p></Card>}
          </section>))}
    </div>);
}
function Side({ who, rating, label }) {
    return (<div className="rounded-xl bg-bg-subtle px-3 py-2 text-sm">
      <div className="text-xs text-fg-subtle">{who}</div>
      <div className="font-medium text-fg">{rating?.notApplicable ? 'Not applicable' : (label ?? '—')}</div>
      {rating?.comment && <div className="mt-0.5 text-xs text-fg-muted">{rating.comment}</div>}
    </div>);
}
/** The final result; the employee acknowledges it (agreeing, or recording a disagreement for HR). */
function ResultCard({ r }) {
    const qc = useQueryClient();
    const toast = useToast();
    const res = r.result;
    const [comment, setComment] = useState('');
    const [disagree, setDisagree] = useState(false);
    const [why, setWhy] = useState('');
    const [busy, setBusy] = useState(false);
    async function acknowledge() {
        setBusy(true);
        try {
            await api(`/pms/reviews/${r.id}/acknowledge`, { method: 'POST', body: { comment, disagree, ...(disagree ? { disagreementComment: why } : {}) } });
            toast('success', disagree ? 'Recorded. HR will look at your disagreement.' : 'Thank you — acknowledged.');
            void qc.invalidateQueries({ queryKey: ['pms'] });
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not save.');
        }
        finally {
            setBusy(false);
        }
    }
    const ack = res.acknowledgement;
    return (<Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-4 bg-gradient-to-r from-iris-50 via-surface to-aqua-50 p-5">
        <span className="rounded-2xl bg-iris-100 p-3 text-iris-700"><Award className="size-7"/></span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{r.viewer === 'reviewee' ? 'Your result' : 'Result'}{res.versionNo > 1 ? ` · version ${res.versionNo}` : ''}</div>
          <div className="text-2xl font-semibold tracking-tight text-fg">{res.finalLevel.label}</div>
          {res.finalLevel.description && <div className="text-sm text-fg-muted">{res.finalLevel.description}</div>}
        </div>
        {res.finalScore && <div className="text-right"><div className="text-3xl font-semibold tabular text-fg">{Number(res.finalScore).toFixed(2)}</div><div className="text-xs text-fg-muted">score</div></div>}
      </div>
      <div className="space-y-3 p-5">
        {res.override && r.viewer !== 'reviewee' && <div className="text-sm text-fg-muted">Overall set by the manager instead of the suggestion: “{res.override.reason}”</div>}
        {ack ? (<div className={cx('flex items-start gap-3 rounded-2xl p-4 text-sm', ack.disagrees ? 'bg-warning-surface text-warning-text' : 'bg-success-surface text-success-text')}>
            {ack.disagrees ? <MessageSquareWarning className="mt-0.5 size-4"/> : <CheckCircle2 className="mt-0.5 size-4"/>}
            <div>
              <div className="font-medium">{ack.disagrees ? 'Acknowledged with a disagreement' : 'Acknowledged'} on {fmtDate(ack.acknowledgedAt)}</div>
              {ack.comment && <div className="mt-0.5">“{ack.comment}”</div>}
              {ack.disagreementComment && <div className="mt-0.5">Disagreement: “{ack.disagreementComment}”</div>}
              {ack.resolution && ack.resolution !== 'open' && <div className="mt-1 text-xs">HR: {ack.resolution === 'reopened' ? 'review reopened' : 'closed'}{ack.resolvedNote ? ` — “${ack.resolvedNote}”` : ''}</div>}
            </div>
          </div>) : r.canAcknowledge ? (<div className="space-y-3">
            <TextField label="Your comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000}/>
            <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" className="size-4 accent-[var(--cc-brand)]" checked={disagree} onChange={(e) => setDisagree(e.target.checked)}/>I disagree with this result</label>
            {disagree && <TextField label="What you disagree with" value={why} onChange={(e) => setWhy(e.target.value)} maxLength={2000} required/>}
            <div className="flex justify-end"><Button loading={busy} disabled={disagree && why.trim().length < 3} icon={<CheckCircle2 className="size-4"/>} onClick={() => void acknowledge()}>{disagree ? 'Acknowledge and record disagreement' : 'Acknowledge'}</Button></div>
          </div>) : res.acknowledgementRequired ? <div className="text-sm text-fg-muted">Waiting for {r.employeeName ?? 'them'} to acknowledge.</div> : null}
      </div>
    </Card>);
}
