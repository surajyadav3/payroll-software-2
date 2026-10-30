import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, Clock, Gauge, Inbox, ListChecks, Plus, Send, Star, Target, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DraftNotice } from '@/crew/components/DraftNotice';
import { PeoplePicker } from '@/crew/components/work/PeoplePicker';
import { Badge, Button, Card, cx, Drawer, EmptyState, ErrorState, Field, Input, Select, Skeleton, TextField, useToast } from '@/crew/components/ui';
import { api, ApiError } from '@/crew/lib/api';
import { fmtDate, todayIso } from '@/crew/lib/format';
import { fmtNum, HEALTH, KIND_LABEL, monthLabel, shiftMonth, STATUS_LABEL, useKpi, useKpiRegister } from '@/crew/lib/kpis';
import { useDepartmentTree } from '@/crew/lib/queries';
import { useDraft } from '@/crew/lib/use-draft';
/**
 * KPIs: the monthly register (Expected / Actual against target, health, Delayed), submitting the month, reviewing
 * results, and defining KPIs for the people and departments you manage.
 */
export function Kpis({ manages, hr }) {
    const [params, setParams] = useSearchParams();
    const qc = useQueryClient();
    const toast = useToast();
    const [period, setPeriod] = useState(() => params.get('period') ?? todayIso().slice(0, 7));
    const [scope, setScope] = useState(() => (params.get('review') ? 'team' : 'mine'));
    const [departmentId, setDepartmentId] = useState('');
    const [reviewOnly, setReviewOnly] = useState(() => !!params.get('review'));
    const [open, setOpen] = useState(null);
    const [creating, setCreating] = useState(false);
    const [busy, setBusy] = useState(false);
    const depts = useDepartmentTree();
    const reg = useKpiRegister({ period, scope, departmentId: scope === 'department' ? departmentId || undefined : undefined });
    const refresh = () => void qc.invalidateQueries({ queryKey: ['pms'] });
    const r = reg.data;
    const rows = useMemo(() => (r?.rows ?? []).filter((x) => x.due && (!reviewOnly || x.can.decide)), [r, reviewOnly]);
    // Deep links from notifications (?tab=kpis&period=…&review=1) are read once, then the URL is tidied.
    useEffect(() => {
        if (params.get('period') || params.get('review')) {
            const next = new URLSearchParams(params);
            next.delete('period');
            next.delete('review');
            setParams(next, { replace: true });
        }
    }, [params, setParams]);
    async function submitMonth() {
        setBusy(true);
        try {
            const res = await api('/pms/kpi-entries/submit', {
                method: 'POST',
                body: { period, ...(scope === 'department' && departmentId ? { departmentId } : scope === 'mine' ? {} : { kpiIds: rows.filter((x) => x.can.submit).map((x) => x.kpi.id) }) },
            });
            toast(res.submitted ? 'success' : 'info', res.submitted ? `${res.submitted} result${res.submitted > 1 ? 's' : ''} submitted for ${monthLabel(period)}.${res.skipped.length ? ` ${res.skipped.length} skipped (no value yet).` : ''}` : 'Nothing to submit yet — enter Expected or Actual first.');
            refresh();
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not submit.');
        }
        finally {
            setBusy(false);
        }
    }
    const scopes = [
        { id: 'mine', label: 'Mine' },
        ...(manages ? [{ id: 'team', label: 'My team' }] : []),
        { id: 'department', label: 'Department' },
        { id: 'company', label: 'Company' },
    ];
    const c = r?.counts;
    return (<div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-xl border border-border bg-surface p-1">
          <Button size="sm" variant="ghost" aria-label="Previous month" icon={<ChevronLeft className="size-4"/>} onClick={() => setPeriod(shiftMonth(period, -1))}/>
          <span className="min-w-36 text-center text-sm font-semibold text-fg">{monthLabel(period)}</span>
          <Button size="sm" variant="ghost" aria-label="Next month" icon={<ChevronRight className="size-4"/>} onClick={() => setPeriod(shiftMonth(period, 1))}/>
        </div>
        <div className="flex flex-wrap gap-1">
          {scopes.map((s) => (<button key={s.id} onClick={() => { setScope(s.id); setReviewOnly(false); }} className={cx('rounded-full border px-3 py-1.5 text-sm', scope === s.id ? 'border-brand bg-brand-surface text-brand-text' : 'border-border text-fg-muted hover:text-fg')}>{s.label}</button>))}
        </div>
        {scope === 'department' && (<Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="w-56">
            <option value="">Choose a department</option>
            {(depts.data ?? []).filter((d) => d.isActive).sort((a, b) => a.name.localeCompare(b.name)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>)}
        <div className="ml-auto flex flex-wrap gap-2">
          {!!c?.toReview && <Button variant={reviewOnly ? 'primary' : 'secondary'} icon={<Inbox className="size-4"/>} onClick={() => setReviewOnly((v) => !v)}>Review {c.toReview}</Button>}
          {!!c?.toSubmit && <Button variant="secondary" icon={<Send className="size-4"/>} loading={busy} onClick={() => void submitMonth()}>Submit {monthLabel(period).split(' ')[0]}</Button>}
          {(manages || hr) && <Button icon={<Plus className="size-4"/>} onClick={() => setCreating(true)}>New KPI</Button>}
        </div>
      </div>

      {r && (<p className="text-xs text-fg-muted">
          Expected due by {fmtDate(r.window.expectedDueOn, { day: 'numeric', month: 'short' })} · Actual due by {fmtDate(r.window.actualDueOn, { day: 'numeric', month: 'short' })}
          {!r.window.canEditActual && ' (opens when the month ends)'}. Late entries are accepted and marked <b>Delayed</b>.
        </p>)}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Tile icon={CircleDashed} label="To fill" value={c?.toFill}/>
        <Tile icon={Send} label="To submit" value={c?.toSubmit} tone="text-brand-text"/>
        <Tile icon={Clock} label="Awaiting review" value={c?.awaitingReview}/>
        <Tile icon={Inbox} label="For me to review" value={c?.toReview} tone="text-brand-text"/>
        <Tile icon={CheckCircle2} label="Confirmed" value={c?.confirmed} tone="text-success-text"/>
        <Tile icon={AlertTriangle} label="Delayed" value={c?.delayed} tone="text-warning-text"/>
        <Tile icon={Gauge} label="Below 70 %" value={c?.red} tone="text-danger-text"/>
      </div>

      {reg.error ? (<ErrorState error={reg.error} retry={() => reg.refetch()}/>) : !r ? (<Skeleton className="h-64"/>) : !rows.length ? (<Card>
          <EmptyState icon={<Target className="size-6"/>} title={reviewOnly ? 'Nothing to review' : scope === 'department' && !departmentId ? 'Choose a department' : 'No KPIs here yet'} body={reviewOnly ? 'Submitted results you approve appear here.' : manages || hr ? 'Define KPIs for the people and departments you manage. Each month, Expected and Actual are entered against the target.' : 'Your manager defines your KPIs. Each month you enter what you expect and what you achieved.'} action={(manages || hr) && !reviewOnly ? <Button icon={<Plus className="size-4"/>} onClick={() => setCreating(true)}>New KPI</Button> : undefined}/>
        </Card>) : (<RegisterTable rows={rows} period={period} onOpen={setOpen} onChanged={refresh} reviewMode={reviewOnly}/>)}
      <KpiDrawer id={open} period={period} onClose={() => setOpen(null)}/>
      <NewKpi open={creating} onClose={() => setCreating(false)} hr={hr} onCreated={(id) => { setCreating(false); setOpen(id); refresh(); }}/>
    </div>);
}
function Tile({ icon: I, label, value, tone }) {
    return (<div className="rounded-2xl border border-border bg-surface p-3 shadow-1">
      <div className="flex items-center gap-1.5 text-xs text-fg-muted"><I className={cx('size-3.5', tone)}/>{label}</div>
      <div className={cx('mt-1 text-xl font-semibold tabular-nums', value ? (tone ?? 'text-fg') : 'text-fg-subtle')}>{value ?? '—'}</div>
    </div>);
}
// ───────────────────────────── the register ─────────────────────────────
function RegisterTable({ rows, period, onOpen, onChanged, reviewMode }) {
    const [cursor, setCursor] = useState(0);
    const [returning, setReturning] = useState(null);
    const toast = useToast();
    async function decide(row, action, reason) {
        try {
            await api(`/pms/kpis/${row.kpi.id}/entries/${period}/decision`, { method: 'POST', body: { action, reason } });
            toast('success', action === 'confirm' ? `${row.kpi.key} confirmed.` : action === 'return' ? `${row.kpi.key} returned.` : `${row.kpi.key} reopened.`);
            onChanged();
            return true;
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not record the decision.');
            return false;
        }
    }
    // Review mode keys: J / K move, A confirm, R return.
    useEffect(() => {
        if (!reviewMode)
            return;
        const onKey = (e) => {
            if (e.target.closest('input, textarea, select, [role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey)
                return;
            const row = rows[Math.min(cursor, rows.length - 1)];
            const k = e.key.toLowerCase();
            if (k === 'j')
                setCursor((i) => Math.min(i + 1, rows.length - 1));
            else if (k === 'k')
                setCursor((i) => Math.max(i - 1, 0));
            else if (k === 'a' && row?.can.decide)
                void decide(row, 'confirm');
            else if (k === 'r' && row?.can.decide)
                setReturning(row);
            else
                return;
            e.preventDefault();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });
    return (<Card className="overflow-x-auto">
      {reviewMode && <p className="hidden border-b border-border px-4 py-2 text-xs text-fg-subtle sm:block">Keys: J / K next / previous · A confirm · R return</p>}
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs font-medium text-fg-muted">
            <th className="px-4 py-3">KPI</th>
            <th className="px-2 py-3 text-right">Target</th>
            <th className="px-2 py-3 text-right">Expected</th>
            <th className="px-2 py-3 text-right">Actual</th>
            <th className="w-44 px-2 py-3">Achievement</th>
            <th className="px-2 py-3">Status</th>
            <th className="px-2 py-3 text-right">Year to date</th>
            <th className="px-4 py-3"/>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, i) => (<tr key={row.kpi.id} className={cx('align-middle', reviewMode && i === cursor && 'bg-brand-surface/40')}>
              <td className="px-4 py-2.5">
                <button onClick={() => onOpen(row.kpi.id)} className="block max-w-72 text-left">
                  <span className="flex items-center gap-1.5 text-xs text-fg-subtle">{row.kpi.key}{row.kpi.isPriority && <Star className="size-3 fill-amber-400 text-amber-400"/>}<span>· {row.kpi.level === 'individual' ? row.kpi.owner?.name : row.kpi.level === 'department' ? row.kpi.department?.name : 'Company'}</span></span>
                  <span className="block truncate font-medium text-fg hover:text-brand-text">{row.kpi.title}</span>
                </button>
              </td>
              <td className="px-2 text-right tabular-nums text-fg-muted">{fmtNum(row.target, row.kpi.unit)}</td>
              <td className="px-2 text-right"><ValueCell row={row} field="expected" period={period} onSaved={onChanged}/></td>
              <td className="px-2 text-right"><ValueCell row={row} field="actual" period={period} onSaved={onChanged} onOpen={() => onOpen(row.kpi.id)}/></td>
              <td className="px-2"><Bar pct={row.achievement} health={row.health}/></td>
              <td className="px-2">
                <div className="flex flex-wrap items-center gap-1">
                  {row.entry ? <Badge tone={STATUS_LABEL[row.entry.status].tone}>{STATUS_LABEL[row.entry.status].label}</Badge> : <span className="text-xs text-fg-subtle">Not started</span>}
                  {(row.entry?.expectedDelayed || row.entry?.actualDelayed) && <Badge tone="warning">Delayed</Badge>}
                  {row.entry?.notApplicable && <Badge>N/A</Badge>}
                </div>
                {row.entry?.status === 'returned' && row.entry.returnReason && <div className="mt-0.5 max-w-48 truncate text-xs text-danger-text" title={row.entry.returnReason}>“{row.entry.returnReason}”</div>}
              </td>
              <td className={cx('px-2 text-right tabular-nums', row.ytd.achievement === null ? 'text-fg-subtle' : row.ytd.achievement >= 100 ? 'text-success-text' : row.ytd.achievement >= 70 ? 'text-warning-text' : 'text-danger-text')}>{row.ytd.achievement === null ? '—' : `${Math.round(row.ytd.achievement)}%`}</td>
              <td className="px-4 text-right">
                <div className="flex justify-end gap-1">
                  {row.can.decide && <Button size="sm" onClick={() => void decide(row, 'confirm')}>Confirm</Button>}
                  {row.can.decide && <Button size="sm" variant="secondary" onClick={() => setReturning(row)}>Return</Button>}
                  {row.can.reopen && !reviewMode && <Button size="sm" variant="ghost" icon={<Undo2 className="size-4"/>} onClick={() => setReturning(row)}>Reopen</Button>}
                </div>
              </td>
            </tr>))}
        </tbody>
      </table>
      <ReasonDrawer row={returning} onClose={() => setReturning(null)} onSubmit={(reason) => decide(returning, returning.entry?.status === 'confirmed' ? 'reopen' : 'return', reason)}/>
    </Card>);
}
/** Expected or Actual edited in place (saved on Enter / leaving the cell). Rates, averages and milestones open the KPI. */
function ValueCell({ row, field, period, onSaved, onOpen }) {
    const toast = useToast();
    const value = row.entry?.[field] ?? null;
    const editable = field === 'expected' ? row.can.editExpected : row.can.editActual;
    const complex = field === 'actual' && (row.kpi.kind === 'rate' || row.kpi.kind === 'average' || row.kpi.kind === 'milestone');
    const [text, setText] = useState(value === null ? '' : String(value));
    const [was, setWas] = useState(value);
    if (value !== was) {
        setWas(value);
        setText(value === null ? '' : String(value));
    }
    if (!editable)
        return <span className="tabular-nums text-fg">{fmtNum(value, row.kpi.unit)}</span>;
    if (complex)
        return <button onClick={onOpen} className="rounded-lg px-2 py-1 text-sm text-brand-text hover:bg-bg-subtle">{value === null ? 'Enter…' : fmtNum(value, row.kpi.unit)}</button>;
    async function save() {
        const next = text.trim() === '' ? null : Number(text);
        if (next === value || (next !== null && Number.isNaN(next)))
            return;
        try {
            await api(`/pms/kpis/${row.kpi.id}/entries/${period}`, { method: 'PUT', body: { [field]: next } });
            onSaved();
        }
        catch (e) {
            toast('danger', e instanceof ApiError ? e.message : 'Could not save.');
            setText(value === null ? '' : String(value));
        }
    }
    if (row.kpi.kind === 'rubric' && field === 'actual') {
        return (<Select value={text} onChange={(e) => { setText(e.target.value); void api(`/pms/kpis/${row.kpi.id}/entries/${period}`, { method: 'PUT', body: { actual: e.target.value ? Number(e.target.value) : null } }).then(onSaved, (err) => toast('danger', err instanceof ApiError ? err.message : 'Could not save.')); }} className="ml-auto h-8 w-20">
        <option value="">—</option>
        {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
      </Select>);
    }
    return (<Input value={text} inputMode="decimal" onChange={(e) => setText(e.target.value.replace(/[^\d.-]/g, ''))} onBlur={() => void save()} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} aria-label={`${field === 'expected' ? 'Expected' : 'Actual'} for ${row.kpi.title}`} className="ml-auto h-8 w-24 text-right tabular-nums"/>);
}
function Bar({ pct, health }) {
    if (pct === null || !health)
        return <span className="text-xs text-fg-subtle">—</span>;
    return (<div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-subtle"><div className={cx('h-full rounded-full', HEALTH[health].bar)} style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}/></div>
      <span className={cx('w-12 text-right text-xs font-semibold tabular-nums', HEALTH[health].text)}>{Math.round(pct)}%</span>
    </div>);
}
function ReasonDrawer({ row, onClose, onSubmit }) {
    const reopen = row?.entry?.status === 'confirmed';
    const [reason, setReason, discard] = useDraft(row ? `kpi-decision:${row.kpi.id}:${row.entry?.period ?? ''}` : null, '');
    const [busy, setBusy] = useState(false);
    return (<Drawer open={!!row} onClose={onClose} title={row ? `${reopen ? 'Reopen' : 'Return'} ${row.kpi.key}` : ''} subtitle={row?.kpi.title} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={reopen ? 'primary' : 'danger'} loading={busy} disabled={reason.trim().length < 4} onClick={async () => { setBusy(true); if (await onSubmit(reason)) {
        discard();
        onClose();
    } setBusy(false); }}>{reopen ? 'Reopen' : 'Return'}</Button></>}>
      <Field label={reopen ? 'Why reopen it?' : 'What needs correcting?'} hint="4–500 characters. The submitter is told.">
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={500} autoFocus className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30 sm:text-sm"/>
      </Field>
    </Drawer>);
}
// ───────────────────────────── one KPI ─────────────────────────────
function KpiDrawer({ id, period, onClose }) {
    const k = useKpi(id, period);
    const d = k.data;
    return (<Drawer open={!!id} onClose={onClose} width="max-w-3xl" title={d ? `${d.key} · ${d.title}` : 'KPI'} subtitle={d ? `${KIND_LABEL[d.kind].label} · ${d.direction === 'higher' ? 'higher is better' : 'lower is better'}${d.unit ? ` · ${d.unit}` : ''}` : undefined}>
      {k.error ? <ErrorState error={k.error}/> : !d ? <Skeleton className="h-80"/> : <KpiBody key={`${d.id}:${d.version}`} d={d} period={period}/>}
    </Drawer>);
}
function KpiBody({ d, period }) {
    const qc = useQueryClient();
    const toast = useToast();
    const [targets, setTargets] = useState(() => Object.fromEntries(d.months.map((m) => [m.period, m.target === null ? '' : String(m.target)])));
    const [busy, setBusy] = useState(false);
    const cur = `${period}-01`;
    const row = d.months.find((m) => m.period === cur);
    async function saveTargets(e) {
        e.preventDefault();
        const changed = d.months.filter((m) => (targets[m.period] ?? '') !== (m.target === null ? '' : String(m.target)) && targets[m.period] !== '');
        if (!changed.length)
            return;
        setBusy(true);
        try {
            await api(`/pms/kpis/${d.id}/targets`, { method: 'PUT', body: { targets: changed.map((m) => ({ period: m.period.slice(0, 7), target: Number(targets[m.period]) })) } });
            toast('success', 'Targets saved.');
            void qc.invalidateQueries({ queryKey: ['pms'] });
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not save the targets.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<div className="space-y-6">
      {d.definition && <p className="whitespace-pre-wrap text-sm text-fg">{d.definition}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Info label="Owner">{d.level === 'individual' ? d.owner?.name : d.level === 'department' ? d.department?.name : 'Company'}</Info>
        <Info label="Approver">{d.approver?.name ?? (d.level === 'individual' ? 'Their manager' : d.level === 'department' ? 'The department head' : 'HR')}</Info>
        <Info label="Goal">{d.goal?.title ?? '—'}</Info>
        <Info label="Quarter to date">{fmtNum(d.toDate.qtd.actual, d.unit)} / {fmtNum(d.toDate.qtd.target, d.unit)} {d.toDate.qtd.achievement !== null && <b>· {Math.round(d.toDate.qtd.achievement)}%</b>}</Info>
        <Info label="Year to date">{fmtNum(d.toDate.ytd.actual, d.unit)} / {fmtNum(d.toDate.ytd.target, d.unit)} {d.toDate.ytd.achievement !== null && <b>· {Math.round(d.toDate.ytd.achievement)}%</b>}</Info>
        <Info label="Roll-up">{d.aggregation === 'sum' ? 'Adds up' : d.aggregation === 'average' ? 'Averages' : 'Latest value'} · {d.frequency}</Info>
      </div>

      {(d.kind === 'rate' || d.kind === 'average' || d.kind === 'milestone') && row && <ComplexEntry d={d} period={period}/>}

      <form onSubmit={saveTargets}>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">The year from {fmtDate(d.fyStart, { month: 'short', year: 'numeric' })}</div>
          {d.canManage && <Button size="sm" type="submit" loading={busy}>Save targets</Button>}
        </div>
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[620px] text-sm">
            <thead><tr className="border-b border-border text-left text-xs text-fg-muted"><th className="px-3 py-2">Month</th><th className="px-2 py-2 text-right">Target</th><th className="px-2 py-2 text-right">Expected</th><th className="px-2 py-2 text-right">Actual</th><th className="px-2 py-2 text-right">Achievement</th><th className="px-3 py-2">Status</th></tr></thead>
            <tbody className="divide-y divide-border">
              {d.months.map((m) => (<tr key={m.period} className={cx(m.period === cur && 'bg-brand-surface/40')}>
                  <td className="px-3 py-1.5 text-fg">{fmtDate(m.period, { month: 'short', year: '2-digit' })}</td>
                  <td className="px-2 text-right">{d.canManage ? <Input value={targets[m.period] ?? ''} onChange={(e) => setTargets({ ...targets, [m.period]: e.target.value.replace(/[^\d.-]/g, '') })} inputMode="decimal" className="ml-auto h-7 w-24 text-right tabular-nums" aria-label={`Target ${m.period}`}/> : <span className="tabular-nums">{fmtNum(m.target)}</span>}</td>
                  <td className="px-2 text-right tabular-nums text-fg-muted">{fmtNum(m.expected)}</td>
                  <td className="px-2 text-right tabular-nums">{m.notApplicable ? 'N/A' : fmtNum(m.actual)}</td>
                  <td className={cx('px-2 text-right tabular-nums', m.achievement === null ? 'text-fg-subtle' : m.achievement >= 100 ? 'text-success-text' : m.achievement >= 70 ? 'text-warning-text' : 'text-danger-text')}>{m.achievement === null ? '—' : `${Math.round(m.achievement)}%`}</td>
                  <td className="px-3">{m.status ? <span className="flex items-center gap-1"><Badge tone={STATUS_LABEL[m.status].tone}>{STATUS_LABEL[m.status].label}</Badge>{m.delayed && <Badge tone="warning">Delayed</Badge>}</span> : <span className="text-xs text-fg-subtle">—</span>}</td>
                </tr>))}
            </tbody>
          </table>
        </div>
      </form>

      {d.history.length > 0 && (<section>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">History</div>
          <ol className="relative space-y-2 border-l border-border pl-4 text-sm">
            {d.history.slice(0, 30).map((h) => (<li key={h.id} className="relative">
                <span className={cx('absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface', h.kind === 'confirm' ? 'bg-success-solid' : h.kind === 'return' || h.kind === 'reopen' ? 'bg-danger-solid' : 'bg-brand')}/>
                <span className="font-medium text-fg">{h.actor ?? 'Someone'}</span> <span className="text-fg-muted">{HISTORY[h.kind] ?? h.kind} {fmtDate(h.period, { month: 'short', year: 'numeric' })}</span>
                {h.reason && <span className="text-fg"> — “{h.reason}”</span>}
                <div className="text-xs text-fg-subtle">{fmtDate(h.at, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</div>
              </li>))}
          </ol>
        </section>)}
    </div>);
}
const HISTORY = { save: 'updated', submit: 'submitted', confirm: 'confirmed', return: 'returned', reopen: 'reopened' };
function Info({ label, children }) {
    return (<div className="rounded-xl border border-border px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">{label}</div>
      <div className="mt-0.5 text-sm text-fg">{children}</div>
    </div>);
}
/** Rates and averages (numerator / denominator) and milestone checklists, for the month shown. */
function ComplexEntry({ d, period }) {
    const qc = useQueryClient();
    const toast = useToast();
    const [v, setV, discard] = useDraft(`kpi-entry:${d.id}:${period}`, { numerator: '', denominator: '', completed: [], note: '' });
    const [busy, setBusy] = useState(false);
    async function save(e) {
        e.preventDefault();
        setBusy(true);
        try {
            const body = d.kind === 'milestone' ? { completed: v.completed, note: v.note || undefined } : { numerator: Number(v.numerator), denominator: Number(v.denominator), note: v.note || undefined };
            await api(`/pms/kpis/${d.id}/entries/${period}`, { method: 'PUT', body });
            discard();
            toast('success', 'Saved.');
            void qc.invalidateQueries({ queryKey: ['pms'] });
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not save.');
        }
        finally {
            setBusy(false);
        }
    }
    return (<form onSubmit={save} className="space-y-3 rounded-2xl border border-border p-4">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-fg"><ListChecks className="size-4"/>{monthLabel(period)} result</div>
      {d.kind === 'milestone' ? (<div className="space-y-1.5">
          {d.milestones.map((m) => (<label key={m.id} className="flex items-center gap-2 text-sm text-fg">
              <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={v.completed.includes(m.id)} onChange={(e) => setV({ ...v, completed: e.target.checked ? [...v.completed, m.id] : v.completed.filter((x) => x !== m.id) })}/>
              {m.title} <span className="text-xs text-fg-subtle">({m.weight})</span>
            </label>))}
        </div>) : (<div className="grid grid-cols-2 gap-3">
          <TextField label={d.kind === 'rate' ? 'Successful' : 'Total'} value={v.numerator} inputMode="decimal" onChange={(e) => setV({ ...v, numerator: e.target.value })}/>
          <TextField label={d.kind === 'rate' ? 'Eligible' : 'Count'} value={v.denominator} inputMode="decimal" onChange={(e) => setV({ ...v, denominator: e.target.value })}/>
        </div>)}
      <TextField label="Note (optional)" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} maxLength={2000}/>
      <Button type="submit" size="sm" loading={busy} disabled={d.kind !== 'milestone' && (!v.numerator || !v.denominator)}>Save result</Button>
    </form>);
}
// ───────────────────────────── new KPI ─────────────────────────────
const blankKpi = { level: 'individual', owner: [], departmentId: '', title: '', definition: '', unit: '', kind: 'volume', direction: 'higher', frequency: 'monthly', weight: '', isPriority: false, approver: [], submitter: [], milestones: [] };
function NewKpi({ open, onClose, onCreated, hr }) {
    const toast = useToast();
    const depts = useDepartmentTree();
    const [f, setF, discard, restored] = useDraft('new-kpi', blankKpi);
    const [busy, setBusy] = useState(false);
    async function create(e) {
        e.preventDefault();
        setBusy(true);
        try {
            const k = await api('/pms/kpis', {
                method: 'POST',
                body: {
                    level: f.level,
                    ownerEmployeeId: f.level === 'individual' ? f.owner[0]?.id : undefined,
                    departmentId: f.level === 'department' ? f.departmentId : undefined,
                    title: f.title,
                    definition: f.definition,
                    unit: f.unit,
                    kind: f.kind,
                    direction: f.kind === 'zero_incidents' ? 'lower' : f.direction,
                    frequency: f.frequency,
                    weight: f.weight ? Number(f.weight) : null,
                    isPriority: f.isPriority,
                    approverEmployeeId: f.approver[0]?.id ?? null,
                    submitterEmployeeId: f.submitter[0]?.id ?? null,
                    ...(f.kind === 'milestone' ? { milestones: f.milestones } : {}),
                },
            });
            toast('success', `${k.key} created. Set its monthly targets next.`);
            discard();
            onCreated(k.id);
        }
        catch (err) {
            toast('danger', err instanceof ApiError ? err.message : 'Could not create the KPI.');
        }
        finally {
            setBusy(false);
        }
    }
    const msTotal = f.milestones.reduce((s, m) => s + (Number(m.weight) || 0), 0);
    return (<Drawer open={open} onClose={onClose} title="New KPI" subtitle="A result measured every month against a target." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="new-kpi" loading={busy} disabled={!f.title.trim() || (f.level === 'individual' && !f.owner.length) || (f.level === 'department' && !f.departmentId)}>Create KPI</Button></>}>
      <DraftNotice show={restored && !!f.title} onDiscard={() => discard()} className="mb-4"/>
      <form id="new-kpi" onSubmit={create} className="space-y-4">
        <Field label="Whose KPI">
          <div className="grid grid-cols-3 gap-2">
            {['individual', 'department', ...(hr ? ['company'] : [])].map((l) => (<button type="button" key={l} onClick={() => setF({ ...f, level: l })} className={cx('rounded-xl border px-3 py-2 text-sm', f.level === l ? 'border-brand bg-brand-surface text-brand-text' : 'border-border text-fg-muted')}>{l === 'individual' ? 'A person' : l === 'department' ? 'A department' : 'The company'}</button>))}
          </div>
        </Field>
        {f.level === 'individual' && <Field label="Person"><PeoplePicker value={f.owner} onChange={(v) => setF({ ...f, owner: v.slice(-1) })} max={1} placeholder="Someone in your team"/></Field>}
        {f.level === 'department' && (<Field label="Department">
            <Select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
              <option value="">Choose…</option>
              {(depts.data ?? []).filter((d) => d.isActive).sort((a, b) => a.name.localeCompare(b.name)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>)}
        <TextField label="KPI" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Orders shipped on time" maxLength={200} required/>
        <Field label="How it is measured (optional)"><textarea value={f.definition} onChange={(e) => setF({ ...f, definition: e.target.value })} rows={2} maxLength={4000} className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-base text-fg outline-none focus:border-brand focus:ring-2 focus:ring-focus-ring/30 sm:text-sm"/></Field>
        <Field label="Kind" hint={KIND_LABEL[f.kind].hint}>
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, milestones: e.target.value === 'milestone' && !f.milestones.length ? [{ id: 'm1', title: '', weight: 100 }] : f.milestones })}>
            {Object.keys(KIND_LABEL).map((k) => <option key={k} value={k}>{KIND_LABEL[k].label}</option>)}
          </Select>
        </Field>
        {f.kind === 'milestone' && (<Field label="Milestones" hint={`Weights add up to 100 (now ${msTotal}).`}>
            <div className="space-y-2">
              {f.milestones.map((m, i) => (<div key={m.id} className="flex gap-2">
                  <Input value={m.title} placeholder={`Milestone ${i + 1}`} onChange={(e) => setF({ ...f, milestones: f.milestones.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}/>
                  <Input value={String(m.weight)} inputMode="decimal" className="w-20 text-right" onChange={(e) => setF({ ...f, milestones: f.milestones.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) || 0 } : x)) })} aria-label="Weight"/>
                </div>))}
              <Button type="button" size="sm" variant="ghost" icon={<Plus className="size-4"/>} onClick={() => setF({ ...f, milestones: [...f.milestones, { id: `m${f.milestones.length + 1}`, title: '', weight: 0 }] })}>Add milestone</Button>
            </div>
          </Field>)}
        <div className="grid gap-4 sm:grid-cols-3">
          {f.kind !== 'zero_incidents' && (<Field label="Better when">
              <Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
                <option value="higher">Higher</option>
                <option value="lower">Lower</option>
              </Select>
            </Field>)}
          <TextField label="Unit" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="₹, orders, %…" maxLength={40}/>
          <Field label="Reported">
            <Select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>
              <option value="monthly">Every month</option>
              <option value="quarterly">Every quarter</option>
              <option value="annual">Once a year</option>
            </Select>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Weight (optional)" hint="For the KPI score, 1–100." value={f.weight} inputMode="decimal" onChange={(e) => setF({ ...f, weight: e.target.value.replace(/[^\d.]/g, '') })}/>
          <Field label="Priority">
            <label className="flex h-10 items-center gap-2 text-sm text-fg"><input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={f.isPriority} onChange={(e) => setF({ ...f, isPriority: e.target.checked })}/>Show as a key KPI</label>
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Approver (optional)" hint="Default: the manager, or the department head."><PeoplePicker value={f.approver} onChange={(v) => setF({ ...f, approver: v.slice(-1) })} max={1} placeholder="Default"/></Field>
          <Field label="Enters results (optional)" hint="Default: the owner and their managers."><PeoplePicker value={f.submitter} onChange={(v) => setF({ ...f, submitter: v.slice(-1) })} max={1} placeholder="Default"/></Field>
        </div>
      </form>
    </Drawer>);
}
