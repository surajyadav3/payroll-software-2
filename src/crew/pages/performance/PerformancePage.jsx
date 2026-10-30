import { CalendarRange, ChevronRight, ClipboardCheck, Target, UsersRound } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Avatar, Badge, Card, CardHeader, cx, EmptyState, ErrorState, PageHeader, Skeleton, Tabs } from '@/crew/components/ui';
import { useAuth } from '@/crew/lib/auth';
import { useCrewFeatures } from '@/crew/lib/features';
import { fmtDate } from '@/crew/lib/format';
import { currentCycle, PHASES, PLAN_STATUS, REVIEW_STATUS, useCycles, useMyReviews, usePlans } from '@/crew/lib/pms';
import { Cycles } from './Cycles';
import { Kpis } from './Kpis';
import { GoalPlan } from './GoalPlan';
import { ReviewSheet } from './ReviewSheet';
/** One performance screen for everyone: my goals and reviews, my team's, and running cycles for HR. */
export function PerformancePage() {
    const { me, can, canForOthers } = useAuth();
    const features = useCrewFeatures();
    const cycles = useCycles();
    const reviews = useMyReviews();
    const isEmployee = !!me?.employee;
    const manages = canForOthers('pms.goal.manage') || (reviews.data?.asReviewer.length ?? 0) > 0;
    const hr = can('pms.cycle.manage');
    const tabs = [
        // Goals and KPIs come with "Goals & Scorecards", reviews with "Performance Reviews" (Toggle Services).
        ...(isEmployee ? [{ id: 'goals', label: 'My goals' }, ...(features.goals ? [{ id: 'kpis', label: 'KPIs' }] : []), ...(features.reviews ? [{ id: 'reviews', label: 'My reviews' }] : [])] : hr && features.goals ? [{ id: 'kpis', label: 'KPIs' }] : []),
        ...(manages ? [{ id: 'team', label: 'My team', count: (reviews.data?.asReviewer ?? []).filter((r) => r.status === 'self_submitted' || r.status === 'manager_in_progress').length }] : []),
        ...(hr ? [{ id: 'cycles', label: 'Review cycles' }] : []),
    ];
    const [params] = useSearchParams();
    // Notification links open a tab directly (?tab=kpis).
    const [tab, setTab] = useState(() => (params.get('tab') === 'kpis' ? 'kpis' : null));
    const current = tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id ?? 'goals';
    const cycle = currentCycle(cycles.data);
    return (<div>
      <PageHeader title="Performance" subtitle="Goals, progress, reviews and results — in one place."/>
      {cycle && current !== 'cycles' && <CycleBanner c={cycle}/>}
      {tabs.length > 1 && <div className="mb-6"><Tabs value={current} onChange={setTab} tabs={tabs}/></div>}
      {cycles.error ? <ErrorState error={cycles.error} retry={() => cycles.refetch()}/> : cycles.isLoading ? <Skeleton className="h-64"/> : (<>
          {current === 'goals' && (cycle && me?.employee ? <GoalPlan cycle={cycle} employeeId={me.employee.id} mode="self"/> : <NoCycle hr={hr}/>)}
          {current === 'kpis' && <Kpis manages={manages || canForOthers('pms.goal.manage')} hr={can('pms.goal.company.manage')}/>}
          {current === 'reviews' && <MyReviews />}
          {current === 'team' && (cycle ? <Team cycle={cycle} reviewsOn={features.reviews}/> : <NoCycle hr={hr}/>)}
          {current === 'cycles' && <Cycles />}
        </>)}
    </div>);
}
function NoCycle({ hr }) {
    return <Card><EmptyState icon={<CalendarRange className="size-6"/>} title="No review cycle is running" body={hr ? 'Start one under Review cycles: people then set goals and get reviewed.' : 'HR starts review cycles. Your goals and reviews will appear here then.'}/></Card>;
}
function CycleBanner({ c }) {
    const idx = PHASES.findIndex((p) => p.id === c.phase);
    const due = c.phase === 'self_review' ? c.selfReviewDue : c.phase === 'manager_review' ? c.managerReviewDue : null;
    return (<Card className="mb-6 overflow-hidden">
      <div className="flex flex-wrap items-center gap-4 bg-gradient-to-r from-iris-50 via-surface to-aqua-50 px-5 py-4">
        <span className="rounded-xl bg-iris-100 p-2.5 text-iris-700"><CalendarRange className="size-5"/></span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-fg">{c.name}</div>
          <div className="text-sm text-fg-muted">{c.status === 'open' ? `Now: ${PHASES[idx]?.label} — ${PHASES[idx]?.who}` : c.status === 'draft' ? 'Not started yet' : 'Closed'}{due ? ` · due ${fmtDate(due)}` : ''}</div>
        </div>
        <div className="hidden gap-1 sm:flex" aria-hidden>
          {PHASES.map((p, i) => <span key={p.id} title={p.label} className={cx('h-1.5 w-8 rounded-full', c.status === 'open' && i <= idx ? 'bg-brand' : c.status === 'closed' ? 'bg-success-solid' : 'bg-border')}/>)}
        </div>
      </div>
    </Card>);
}
function ReviewList({ rows, onOpen, empty, showName }) {
    if (!rows.length)
        return <p className="px-5 pb-5 text-sm text-fg-muted">{empty}</p>;
    return (<div className="divide-y divide-border border-t border-border">
      {rows.map((r) => (<button key={r.id} onClick={() => onOpen(r.id)} className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition hover:bg-bg-subtle">
          {showName ? <Avatar name={r.employeeName ?? '?'} size="sm"/> : <span className="rounded-xl bg-iris-100 p-2 text-iris-700"><ClipboardCheck className="size-4"/></span>}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-fg">{showName ? r.employeeName : 'Performance review'}</span>
            <span className="block text-xs text-fg-muted">{r.selfSubmittedAt ? `Self review ${fmtDate(r.selfSubmittedAt, { day: 'numeric', month: 'short' })}` : 'Self review not done yet'}{r.managerSubmittedAt ? ` · manager review ${fmtDate(r.managerSubmittedAt, { day: 'numeric', month: 'short' })}` : ''}</span>
          </span>
          <Badge tone={REVIEW_STATUS[r.status].tone}>{REVIEW_STATUS[r.status].label}</Badge>
          <ChevronRight className="size-4 text-fg-subtle"/>
        </button>))}
    </div>);
}
function MyReviews() {
    const reviews = useMyReviews();
    const [open, setOpen] = useState(null);
    if (reviews.isLoading)
        return <Skeleton className="h-40"/>;
    const mine = reviews.data?.asEmployee ?? [];
    return (<>
      <Card>
        <CardHeader title="My reviews" subtitle="Rate yourself when the self-review stage opens; your result appears here once HR shares it."/>
        {mine.length === 0 ? <EmptyState icon={<ClipboardCheck className="size-6"/>} title="No reviews yet" body="Your review opens when HR starts the self-review stage."/> : <ReviewList rows={mine} onOpen={setOpen} empty=""/>}
      </Card>
      <ReviewSheet id={open} onClose={() => setOpen(null)}/>
    </>);
}
function Team({ cycle, reviewsOn }) {
    const { canForOthers } = useAuth();
    const reviews = useMyReviews();
    const plans = usePlans(cycle.id, canForOthers('pms.goal.manage'));
    const [open, setOpen] = useState(null);
    const [person, setPerson] = useState(null);
    const toDo = (reviews.data?.asReviewer ?? []).filter((r) => r.status === 'self_submitted' || r.status === 'manager_in_progress' || r.status === 'not_started' || r.status === 'self_in_progress');
    const done = (reviews.data?.asReviewer ?? []).filter((r) => !toDo.includes(r));
    return (<div className="space-y-6">
      {person ? (<div className="space-y-4">
          <button onClick={() => setPerson(null)} className="text-sm text-brand-text hover:underline">← Back to my team</button>
          <div className="flex items-center gap-3"><Avatar name={person.name}/><div><div className="font-semibold text-fg">{person.name}</div><div className="text-sm text-fg-muted">Goal plan · {cycle.name}</div></div></div>
          <GoalPlan cycle={cycle} employeeId={person.id} mode="manager"/>
        </div>) : (<>
          {reviewsOn && <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Reviews to write" subtitle="Their self review is visible to you after you submit yours."/>
              <ReviewList rows={toDo} onOpen={setOpen} empty="Nothing waiting for you." showName/>
            </Card>
            <Card>
              <CardHeader title="Done"/>
              <ReviewList rows={done} onOpen={setOpen} empty="No finished reviews yet." showName/>
            </Card>
          </div>}
          {canForOthers('pms.goal.manage') && (<Card>
              <CardHeader title="Team goal plans" subtitle="Open a plan to assign goals, or to approve one that is waiting for you."/>
              {plans.isLoading ? <div className="p-5"><Skeleton className="h-24"/></div> : !(plans.data ?? []).length ? <EmptyState icon={<UsersRound className="size-6"/>} title="No plans yet" body="Plans appear when your team starts setting goals."/> : (<div className="divide-y divide-border border-t border-border">
                  {(plans.data ?? []).map((p) => (<button key={p.id} onClick={() => setPerson({ id: p.employeeId, name: p.employeeName ?? 'Employee' })} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-bg-subtle">
                      <Avatar name={p.employeeName ?? '?'} size="sm"/>
                      <span className="flex-1 truncate font-medium text-fg">{p.employeeName}</span>
                      <span className={cx('text-xs tabular', p.weightsComplete ? 'text-success-text' : 'text-warning-text')}><Target className="mr-1 inline size-3"/>{Number(p.totalWeight)}%</span>
                      <Badge tone={PLAN_STATUS[p.status].tone}>{p.status === 'submitted' ? 'Waiting for you' : PLAN_STATUS[p.status].label}</Badge>
                      <ChevronRight className="size-4 text-fg-subtle"/>
                    </button>))}
                </div>)}
            </Card>)}
        </>)}
      <ReviewSheet id={open} onClose={() => setOpen(null)}/>
    </div>);
}
