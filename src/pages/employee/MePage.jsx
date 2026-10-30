import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Header from '@/components/Header';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/context/FeatureContext';
import { fullName } from '@/lib/helpers';

import { AttendanceContent } from './MyAttendancePage';
import { RegularizeContent } from './MyRegularizeRequestsPage';
import { WfhContent } from './MyWfhRequestsPage';
import { LeaveContent } from './MyLeavesPage';
import { OneOnOnesContent } from '@/pages/dashboard/OneOnOnesPage';
import { FeedbackContent } from '@/pages/dashboard/FeedbackPage';
import { PIPContent } from '@/pages/dashboard/PIPPage';
import { MyTrainingContent } from './MyTrainingPage';
import { MyOnboardingContent } from './MyOnboardingPage';
import { MyOffboardingContent } from './MyOffboardingPage';
import { MyAssetsContent } from './MyAssetsPage';

const ATTENDANCE_SUBTABS = [
  { key: 'log', label: 'Log' },
  { key: 'regularize', label: 'Regularize' },
  { key: 'wfh', label: 'Work From Home' },
];

const PERFORMANCE_SUBTABS = [
  { key: 'workspace', label: 'Goals, KPIs & Reviews' },
  { key: 'oneonones', label: '1:1 Meetings', featureKey: 'performance_one_on_ones' },
  { key: 'feedback', label: 'Feedback', featureKey: 'performance_feedback' },
  { key: 'pip', label: 'PIP', featureKey: 'performance_pip' },
];

// Every tab beyond the core three (Attendance/Leave/Performance) mirrors a
// destination in the sidebar's "Me" flyout — keeping this list and that
// flyout in sync is what makes "hover the sidebar" and "land on the page"
// show the same set of features, tab-for-tab, the way Keka's Me section does.
// Tax Declaration and Grievances live under the sidebar's "My Finances"
// section instead (standalone routes: /my-tax-declaration, /grievances),
// not as tabs here.
const EXTRA_TABS = [
  { key: 'training', label: 'Training', featureKey: 'training', Content: MyTrainingContent },
  { key: 'onboarding', label: 'Onboarding', featureKey: 'onboarding', Content: MyOnboardingContent },
  { key: 'offboarding', label: 'Offboarding', featureKey: 'offboarding', Content: MyOffboardingContent },
  { key: 'assets', label: 'Assets', featureKey: 'assets', Content: MyAssetsContent },
];

// Goals, KPIs and reviews have their own screen (Performance in the sidebar); this tab points to it.
function PerformanceLink() {
  return (
    <div className="page-content">
      <div className="card" style={{ padding: 24, maxWidth: 560 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>Your goals, KPIs and reviews</h3>
        <p style={{ margin: '8px 0 16px', fontSize: 14, color: 'var(--text-secondary)' }}>
          Set and track your goals, enter your monthly KPI results, write your self review and see your results — all on the Performance page.
        </p>
        <Link to="/performance" className="btn btn-primary"><i className="fas fa-trophy" /> Open Performance</Link>
      </div>
    </div>
  );
}

function SubTabs({ items, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
      {items.map((it) => (
        <button
          key={it.key}
          className={`btn btn-sm ${active === it.key ? 'btn-primary' : 'btn-outline'}`}
          style={{ borderRadius: '6px 6px 0 0' }}
          onClick={() => onChange(it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export default function MePage() {
  const { profile } = useAuth();
  const { isEnabled } = useFeatures();
  const [searchParams, setSearchParams] = useSearchParams();

  const availableExtraTabs = EXTRA_TABS.filter((t) => isEnabled(t.featureKey));
  const validTabs = ['attendance', 'leave', 'performance', ...availableExtraTabs.map((t) => t.key)];

  const requestedTab = searchParams.get('tab');
  const tab = validTabs.includes(requestedTab) ? requestedTab : 'attendance';
  const setTab = (t) => setSearchParams(t === 'attendance' ? {} : { tab: t });

  const requestedSub = searchParams.get('sub');
  const attSubtab = ATTENDANCE_SUBTABS.some((s) => s.key === requestedSub) ? requestedSub : 'log';
  const setAttSubtab = (s) => setSearchParams(s === 'log' ? {} : { tab: 'attendance', sub: s });

  const performanceTabs = PERFORMANCE_SUBTABS.filter((item) => (item.featureKey ? isEnabled(item.featureKey) : isEnabled('performance_kras') || isEnabled('performance_reviews')));
  const perfSubtab = performanceTabs.some((item) => item.key === requestedSub) ? requestedSub : performanceTabs[0]?.key;
  const setPerfSubtab = (sub) => setSearchParams({ tab: 'performance', sub });

  const roleLabel = profile?.role === 'admin' ? 'HR' : profile?.role === 'manager' ? 'Manager' : 'Employee';

  const activeExtra = availableExtraTabs.find((t) => t.key === tab);

  return (
    <>
      <Header title="Me" breadcrumb={`${fullName(profile) || 'My Space'} · ${roleLabel}`} />

      {/* Top-level tabs — each tab's content below supplies its own page padding
          (matching its standalone route), so this wrapper only pads the tab bar
          itself rather than using .page-content, which would double up. */}
      <div className="tab-bar-wrap">
        <div className="tabs">
          {['attendance', 'leave', 'performance'].map((t) => (
            <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'attendance' ? 'Attendance' : t === 'leave' ? 'Leave' : 'Performance'}
            </button>
          ))}
          {availableExtraTabs.map((t) => (
            <button key={t.key} className={`tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'attendance' && (
        <>
          <div className="subtab-bar-wrap">
            <SubTabs items={ATTENDANCE_SUBTABS} active={attSubtab} onChange={setAttSubtab} />
          </div>
          {attSubtab === 'log' && <AttendanceContent />}
          {attSubtab === 'regularize' && <RegularizeContent />}
          {attSubtab === 'wfh' && <WfhContent />}
        </>
      )}

      {tab === 'leave' && <LeaveContent />}

      {tab === 'performance' && (
        <>
          <div className="subtab-bar-wrap">
            <SubTabs items={performanceTabs} active={perfSubtab} onChange={setPerfSubtab} />
          </div>
          {perfSubtab === 'workspace' && <PerformanceLink />}
          {perfSubtab === 'oneonones' && <OneOnOnesContent />}
          {perfSubtab === 'feedback' && <FeedbackContent />}
          {perfSubtab === 'pip' && <PIPContent />}
        </>
      )}

      {activeExtra && <activeExtra.Content />}
    </>
  );
}
