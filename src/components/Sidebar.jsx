import React, { useState, useRef, useEffect, useContext, createContext } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { useFeatures } from '@/context/FeatureContext';
import { getInitials, fullName, isRaniwalaTenant, isHrSupport } from '@/lib/helpers';
import { fetchMyL1Members } from '@/services/l1Service';

const HOME_NAV_ITEM = {
  label: 'Home', icon: 'fa-house', href: '/home',
  flyout: [
    { label: 'Dashboard', href: '/home' },
    { label: 'Welcome', href: '/home?tab=welcome' },
  ],
};

const ME_NAV_ITEM = {
  label: 'Me', icon: 'fa-user', href: '/me',
  flyout: [
    {
      label: 'Attendance', href: '/me?tab=attendance',
      flyout: [
        { label: 'Log', href: '/me?tab=attendance&sub=log' },
        { label: 'Regularize', href: '/me?tab=attendance&sub=regularize' },
        { label: 'Work From Home', href: '/me?tab=attendance&sub=wfh' },
      ],
    },
    { label: 'Leave', href: '/me?tab=leave' },
    { label: 'My Training', href: '/me?tab=training', featureKey: 'training' },
    { label: 'My Onboarding', href: '/me?tab=onboarding', featureKey: 'onboarding' },
    { label: 'My Offboarding', href: '/me?tab=offboarding', featureKey: 'offboarding' },
    { label: 'My Assets', href: '/me?tab=assets', featureKey: 'assets' },
  ],
};

// Work — the task register, project boards and company messaging (src/crew, the screens of the
// new CrewCore platform). The same three entries for every role; what each person sees and may
// do inside is decided by the server.
const WORK_SECTION = {
  title: 'Work',
  items: [
    { label: 'My Work', icon: 'fa-list-check', href: '/work/me', featureKey: 'tasks' },
    { label: 'Tasks & Projects', icon: 'fa-diagram-project', href: '/work', featureKey: 'tasks', matchPrefix: ['/work/projects/'] },
    { label: 'Messages', icon: 'fa-comments', href: '/work/chat', featureKey: 'team_chat', matchPrefix: ['/work/mentions'] },
  ],
};
const MEETINGS_NAV_ITEM = { label: 'Meeting Notes', icon: 'fa-microphone-lines', href: '/meetings', featureKey: 'ai_meetings' };
const HELP_NAV_ITEM = { label: 'Help & FAQ', icon: 'fa-circle-question', href: '/help' };
// Only for someone HR made an L1 SPOC (l1Service) — added under Overview at render time.
const L1_NAV_ITEM = { label: 'My L1 Employees', icon: 'fa-people-group', href: '/l1-employees' };

// Personal finance-related self-service items — Payslips, Tax Declaration, and
// Grievances all moved out of the Me flyout/tabs into their own section so
// they read as a distinct "My Finances" area rather than being buried among
// Me's attendance/performance/onboarding tabs. Each already has its own
// standalone route+page (not a /me?tab= query tab), shared identically across
// admin/manager/employee.
const MY_FINANCES_SECTION = {
  title: 'My Finances',
  items: [
    { label: 'My Payslips', icon: 'fa-file-invoice-dollar', href: '/my-payslips', featureKey: 'payslips' },
    { label: 'Tax Declaration', icon: 'fa-file-invoice', href: '/my-tax-declaration', featureKey: 'tax_declaration' },
    { label: 'Grievances', icon: 'fa-gavel', href: '/grievances', featureKey: 'grievances' },
  ],
};

// Shared building blocks for the category flyouts below — reused across roles
// wherever the underlying route/feature-key is identical, so a fix to one
// role's menu doesn't silently drift from the others.
const COMPANY_FLYOUT = [
  { label: 'Announcements', href: '/announcements', featureKey: 'announcements' },
  { label: 'Policies', href: '/policies', featureKey: 'policies' },
];

// Performance is one screen (goals, KPIs, reviews, team, review cycles — its tabs follow the
// person's role); the server decides what each role may see and do inside it.
const PERFORMANCE_FLYOUT_BASE = [
  { label: 'Goals & Reviews', href: '/performance', anyFeature: ['performance_kras', 'performance_reviews'] },
  { label: 'KPIs', href: '/performance?tab=kpis', featureKey: 'performance_kras' },
  { label: '1:1 Meetings', href: '/performance/one-on-ones', featureKey: 'performance_one_on_ones' },
  { label: 'Feedback', href: '/performance/feedback', featureKey: 'performance_feedback' },
  { label: 'PIP', href: '/performance/pip', featureKey: 'performance_pip' },
];

// HR's Workforce section, shared by full HR and HR Support.
const HR_WORKFORCE_ITEMS = [
  // flyout populated at render time from live outlet/group data — see injectOutletsFlyout()
  { label: 'Outlets', icon: 'fa-store', href: '/outlets', flyout: 'DYNAMIC_OUTLETS' },
  {
    label: 'People', icon: 'fa-users', href: '/employees',
    flyout: [
      { label: 'Employees', href: '/employees', featureKey: 'employees' },
      { label: 'Leave Balances', href: '/leave-balances', featureKey: 'leave_setup' },
      { label: 'Org Structure', href: '/org-structure', featureKey: 'org_hierarchy' },
      { label: 'Assets', href: '/assets', featureKey: 'assets' },
      { label: 'Onboarding', href: '/onboarding', featureKey: 'onboarding' },
      { label: 'Offboarding', href: '/offboarding', featureKey: 'offboarding' },
      { label: 'Grievances', href: '/grievances', featureKey: 'grievances' },
    ],
  },
  {
    label: 'Attendance', icon: 'fa-fingerprint', href: '/attendance',
    flyout: [
      { label: 'Attendance Log', href: '/attendance', featureKey: 'attendance' },
      { label: 'ESSL Records', href: '/essl-records', featureKey: 'attendance', raniwalaOnly: true },
      { label: 'Shift Roster', href: '/shift-roster', featureKey: 'shift_roster' },
      { label: 'Employee Calendar', href: '/employee-calendar', featureKey: 'employee_calendar' },
    ],
  },
  { label: 'Live Tracking', icon: 'fa-location-crosshairs', href: '/live-tracking', featureKey: 'live_tracking' },
  {
    label: 'Requests', icon: 'fa-inbox', href: '/leaves',
    flyout: [
      { label: 'Leave Requests', href: '/leaves', featureKey: 'leave_requests' },
      { label: 'Punch Approvals', href: '/punch-approvals', featureKey: 'attendance', raniwalaOnly: true },
      { label: 'Regularize Attendance', href: '/regularize', featureKey: 'regularize_attendance' },
      { label: 'WFH Requests', href: '/wfh-requests', featureKey: 'wfh_requests' },
      { label: 'Verification Requests', href: '/verification-requests', featureKey: 'profile_verification' },
      { label: 'Special Requests', href: '/special-requests', featureKey: 'special_requests' },
      { label: 'Expense Claims', href: '/expense-claims', featureKey: 'expense_claims' },
      { label: 'Travel Requests', href: '/travel-requests', featureKey: 'travel_requests' },
    ],
  },
];
const HR_MASTER_REPORT_ITEM = { label: 'Master Report', icon: 'fa-file-alt', href: '/master-report', featureKey: 'master_report' };
const HR_SETTINGS_ITEM = {
  label: 'Settings', icon: 'fa-gears', href: '/settings',
  flyout: [
    { label: 'Leave Types', href: '/leave-types', featureKey: 'leave_setup' },
    { label: 'Approval Chains', href: '/approval-chains', featureKey: 'approval_chains' },
    { label: 'HR Settings', href: '/feature-settings' },
    { label: 'General Settings', href: '/settings' },
  ],
};

const NAV_CONFIG = {
  superadmin: [
    {
      title: 'Platform',
      items: [
        { label: 'Master Dashboard', icon: 'fa-chart-line', href: '/master-dashboard' },
        { label: 'Tenants', icon: 'fa-building', href: '/tenants' },
        { label: 'Org Structure', icon: 'fa-sitemap', href: '/org-structure' },
        { label: 'Toggle Services', icon: 'fa-toggle-on', href: '/toggle-services' },
        { label: 'All Employees', icon: 'fa-users', href: '/platform-employees' },
        { label: 'Helpdesk', icon: 'fa-headset', href: '/helpdesk-admin' },
      ],
    },
  ],
  admin: [
    {
      title: 'Overview',
      items: [HOME_NAV_ITEM, ME_NAV_ITEM, MEETINGS_NAV_ITEM],
    },
    WORK_SECTION,
    MY_FINANCES_SECTION,
    {
      title: 'Workforce',
      items: [
        ...HR_WORKFORCE_ITEMS,
        {
          label: 'Recruitment', icon: 'fa-briefcase', href: '/hiring',
          flyout: [
            { label: 'Job Postings', href: '/hiring', featureKey: 'hiring' },
            { label: 'Recruitment Pipeline', href: '/recruitment-pipeline', featureKey: 'recruitment_pipeline' },
            { label: 'Headcount Requests', href: '/headcount-requests', featureKey: 'headcount_requests' },
            { label: 'Interviews', href: '/interviews', featureKey: 'interviews' },
            { label: 'Offer Letters', href: '/offer-letters', featureKey: 'offer_letters' },
            { label: 'Refer', href: '/refer', featureKey: 'refer' },
          ],
        },
      ],
    },
    {
      title: 'Growth',
      items: [
        {
          label: 'Performance', icon: 'fa-trophy', href: '/performance',
          flyout: [...PERFORMANCE_FLYOUT_BASE, { label: 'Training & Skills', href: '/training', featureKey: 'training' }],
        },
      ],
    },
    {
      title: 'Finance',
      items: [
        {
          label: 'Payroll', icon: 'fa-wallet', href: '/salary',
          flyout: [
            { label: 'Salary Structure', href: '/salary', featureKey: 'salary_structure' },
            { label: 'Run Payroll', href: '/payroll', featureKey: 'run_payroll' },
            { label: 'Payslips', href: '/payslips', featureKey: 'payslips' },
            { label: 'Advances & Loans', href: '/advances', featureKey: 'advances_loans' },
            { label: 'One-Off Pay Items', href: '/salary-additions', featureKey: 'salary_additions' },
            { label: 'Income Tax Slabs', href: '/tax-slabs', featureKey: 'tax_slabs' },
            // Arrears for a payroll month + Sept 2026's PF taken above the new cap.
            { label: 'Difference', href: '/pf-difference', featureKey: 'run_payroll', raniwalaOnly: true },
          ],
        },
      ],
    },
    {
      title: 'Company',
      items: [
        { label: 'Company', icon: 'fa-building', href: '/announcements', flyout: COMPANY_FLYOUT },
        HR_MASTER_REPORT_ITEM,
        { label: 'Helpdesk', icon: 'fa-headset', href: '/helpdesk', featureKey: 'helpdesk' },
      ],
    },
    {
      title: 'System',
      items: [
        HR_SETTINGS_ITEM,
        HELP_NAV_ITEM,
      ],
    },
  ],
  // HR Support (profiles.hr_support): an HR login with no payroll and no
  // Settings / HR Settings — HR's workforce and company menus, and every
  // request to approve as HR.
  hrSupport: [
    { title: 'Overview', items: [HOME_NAV_ITEM] },
    { title: 'Workforce', items: HR_WORKFORCE_ITEMS },
    {
      title: 'Company',
      items: [
        { label: 'Company', icon: 'fa-building', href: '/announcements', flyout: COMPANY_FLYOUT },
        HR_MASTER_REPORT_ITEM,
      ],
    },
    { title: 'System', items: [HELP_NAV_ITEM] },
  ],
  manager: [
    {
      title: 'Overview',
      items: [HOME_NAV_ITEM, ME_NAV_ITEM, MEETINGS_NAV_ITEM],
    },
    WORK_SECTION,
    MY_FINANCES_SECTION,
    {
      title: 'Workforce',
      items: [
        { label: 'My Team', icon: 'fa-users', href: '/manager-employees', featureKey: 'employees' },
        {
          label: 'Attendance', icon: 'fa-fingerprint', href: '/manager-attendance',
          flyout: [
            { label: 'Attendance Log', href: '/manager-attendance', featureKey: 'attendance' },
            { label: 'Employee Calendar', href: '/manager-employee-calendar', featureKey: 'employee_calendar' },
          ],
        },
        {
          label: 'Requests', icon: 'fa-inbox', href: '/manager-leaves',
          flyout: [
            { label: 'Leave Requests', href: '/manager-leaves', featureKey: 'leave_requests' },
            { label: 'Punch Approvals', href: '/manager-punch-approvals', featureKey: 'attendance', raniwalaOnly: true },
            { label: 'Regularize Attendance', href: '/manager-regularize', featureKey: 'regularize_attendance' },
            { label: 'WFH Requests', href: '/manager-wfh-requests', featureKey: 'wfh_requests' },
            { label: 'Verification Requests', href: '/manager-verification-requests', featureKey: 'profile_verification' },
            { label: 'Special Requests', href: '/manager-special-requests', featureKey: 'special_requests' },
            { label: 'Expense Claims', href: '/expense-claims', featureKey: 'expense_claims' },
            { label: 'Travel Requests', href: '/travel-requests', featureKey: 'travel_requests' },
          ],
        },
        {
          label: 'Recruitment', icon: 'fa-briefcase', href: '/hiring',
          flyout: [
            { label: 'Job Postings', href: '/hiring', featureKey: 'hiring' },
            { label: 'Recruitment Pipeline', href: '/recruitment-pipeline', featureKey: 'recruitment_pipeline' },
            { label: 'Headcount Requests', href: '/headcount-requests', featureKey: 'headcount_requests' },
            { label: 'Interviews', href: '/interviews', featureKey: 'interviews' },
            { label: 'Offer Letters', href: '/offer-letters', featureKey: 'offer_letters' },
            { label: 'Refer', href: '/refer', featureKey: 'refer' },
          ],
        },
      ],
    },
    {
      title: 'Growth',
      items: [
        { label: 'Performance', icon: 'fa-trophy', href: '/performance', flyout: PERFORMANCE_FLYOUT_BASE },
      ],
    },
    {
      title: 'Finance',
      items: [
        {
          label: 'Payroll', icon: 'fa-wallet', href: '/manager-payroll',
          flyout: [
            { label: 'Run Payroll', href: '/manager-payroll', featureKey: 'run_payroll' },
            { label: 'Payslips', href: '/manager-payslips', featureKey: 'payslips' },
            { label: 'Advances & Loans', href: '/manager-advances', featureKey: 'advances_loans' },
            { label: 'One-Off Pay Items', href: '/manager-salary-additions', featureKey: 'salary_additions' },
          ],
        },
      ],
    },
    {
      title: 'Company',
      items: [
        { label: 'Company', icon: 'fa-building', href: '/announcements', flyout: COMPANY_FLYOUT },
        { label: 'HR Settings', icon: 'fa-sliders', href: '/hr-settings' },
        HELP_NAV_ITEM,
      ],
    },
  ],
  raniwalaManager: [
    {
      title: 'Overview',
      items: [HOME_NAV_ITEM, ME_NAV_ITEM, MEETINGS_NAV_ITEM],
    },
    WORK_SECTION,
    MY_FINANCES_SECTION,
    {
      title: 'Workforce',
      items: [
        { label: 'My Team', icon: 'fa-users', href: '/manager-employees', featureKey: 'employees' },
        {
          label: 'Requests', icon: 'fa-inbox', href: '/manager-leaves',
          flyout: [
            { label: 'Leave Requests', href: '/manager-leaves', featureKey: 'leave_requests' },
            { label: 'Punch Approvals', href: '/manager-punch-approvals', featureKey: 'attendance', raniwalaOnly: true },
            { label: 'Regularize Attendance', href: '/manager-regularize', featureKey: 'regularize_attendance' },
            { label: 'WFH Requests', href: '/manager-wfh-requests', featureKey: 'wfh_requests' },
            { label: 'Special Requests', href: '/manager-special-requests', featureKey: 'special_requests' },
          ],
        },
      ],
    },
    {
      title: 'Growth',
      items: [
        { label: 'Performance', icon: 'fa-trophy', href: '/performance', flyout: PERFORMANCE_FLYOUT_BASE },
      ],
    },
    {
      title: 'Company',
      items: [
        { label: 'Company', icon: 'fa-building', href: '/announcements', flyout: COMPANY_FLYOUT },
        HELP_NAV_ITEM,
      ],
    },
  ],
  employee: [
    {
      title: 'Overview',
      items: [HOME_NAV_ITEM, ME_NAV_ITEM, MEETINGS_NAV_ITEM],
    },
    WORK_SECTION,
    MY_FINANCES_SECTION,
    {
      title: 'My Work',
      items: [
        {
          label: 'Requests', icon: 'fa-inbox', href: '/my-special-requests',
          flyout: [
            { label: 'Special Requests', href: '/my-special-requests', featureKey: 'special_requests' },
            { label: 'Expense Claims', href: '/expense-claims', featureKey: 'expense_claims' },
            { label: 'Travel Requests', href: '/travel-requests', featureKey: 'travel_requests' },
          ],
        },
        {
          label: 'Recruitment', icon: 'fa-briefcase', href: '/hiring',
          flyout: [
            { label: 'Job Postings', href: '/hiring', featureKey: 'hiring' },
            { label: 'My Interviews', href: '/interviews', featureKey: 'interviews' },
            { label: 'Refer', href: '/refer', featureKey: 'refer' },
          ],
        },
      ],
    },
    {
      title: 'Growth',
      items: [
        { label: 'Performance', icon: 'fa-trophy', href: '/performance', flyout: PERFORMANCE_FLYOUT_BASE },
      ],
    },
    {
      title: 'Company',
      items: [
        { label: 'Company', icon: 'fa-building', href: '/announcements', flyout: COMPANY_FLYOUT },
        HELP_NAV_ITEM,
      ],
    },
  ],
};

// Strips any nav item (or flyout child) whose featureKey is disabled for the
// current tenant/outlet. A parent item is defined purely by its children here
// (Requests/Leave Setup/Hiring never carry their own featureKey) — once every
// child is filtered out, the parent itself is dropped rather than left as a
// dead-end link.
function filterNavByFeatures(sections, isEnabled, tenant) {
  const keepItem = (item) => {
    // Raniwala-only entries: its ESSL web feed, app-punch approvals and the PF Difference page.
    if (item.raniwalaOnly && !isRaniwalaTenant(tenant)) return null;
    if (item.flyout && item.flyout.length > 0) {
      const flyout = item.flyout.map(keepItem).filter(Boolean);
      if (flyout.length === 0) return null;
      // If the parent's own target was filtered out (e.g. Special Requests
      // for Raniwala), point it at the first child that's still visible.
      const href = flyout.some((f) => f.href === item.href) ? item.href : flyout[0].href;
      return { ...item, href, flyout };
    }
    if (item.featureKey && !isEnabled(item.featureKey)) return null;
    // One screen shared by several services: shown while any of them is on.
    if (item.anyFeature && !item.anyFeature.some((key) => isEnabled(key))) return null;
    return item;
  };

  // A section whose every item was filtered out is dropped too, so its
  // title doesn't render as an empty heading.
  return sections
    .map((section) => ({ ...section, items: section.items.map(keepItem).filter(Boolean) }))
    .filter((section) => section.items.length > 0);
}

// The "Outlets" item's children depend on live data (how many outlets exist,
// whether the tenant belongs to a group) rather than being statically known
// up front, so NAV_CONFIG just marks the spot with the 'DYNAMIC_OUTLETS'
// sentinel and this fills in the real flyout array at render time.
function injectOutletsFlyout(sections, { outlets, tenant, hrSupport }) {
  const children = [
    { label: 'All Outlets', href: '/outlets', featureKey: 'outlets_multi_branch' },
  ];
  if (outlets.length > 1) {
    children.push({ label: 'Combined Dashboard', href: '/outlets/combined', featureKey: 'outlets_multi_branch' });
  }
  // The group dashboard shows payroll figures — not for HR Support.
  if (tenant?.group_code && !hrSupport) {
    children.push({ label: 'Group Dashboard', href: '/group-dashboard' });
  }

  return sections.map((section) => ({
    ...section,
    items: section.items.map((item) => (item.flyout === 'DYNAMIC_OUTLETS' ? { ...item, flyout: children } : item)),
  }));
}

// iOS/touch browsers have no real hover — an element with a mouseenter
// listener needs a first "confirming" tap before a second tap registers as a
// click, which would make a hover-flyout nav item unusable on a phone.
// Detecting real hover support up front lets touch devices skip the flyout
// wiring entirely and get a plain, single-tap link instead.
const supportsHover = typeof window !== 'undefined'
  && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

// Closing the flyout the instant the pointer leaves the trigger makes it nearly
// unusable — the flyout renders via position:fixed off to the side, so crossing
// the gap to reach it passes over page content that isn't a descendant of the
// trigger, firing mouseleave before the pointer arrives. A short grace period
// (cancelled if the pointer lands on the trigger OR the flyout) covers that gap.
const FLYOUT_CLOSE_DELAY = 300;

// Siblings in the same flyout list (or the same top-level nav list) share this
// context so that opening one immediately closes any other that's still open.
// Without it, each item's close was gated behind its own FLYOUT_CLOSE_DELAY
// grace timer, so moving the pointer from one trigger straight into the next
// left both panels rendered at once — visibly overlapping — until the first
// one's timer finally caught up.
const FlyoutGroupContext = createContext(null);

// Manages the open/close-with-grace-period state for one trigger within a
// FlyoutGroupContext. Opening always wins immediately (via shared state);
// closing still waits out FLYOUT_CLOSE_DELAY so crossing the gap to the
// flyout panel doesn't close it, but only takes effect if nothing else has
// claimed the group in the meantime.
function useFlyoutState(key) {
  const group = useContext(FlyoutGroupContext);
  const closeTimer = useRef(null);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const isOpen = group.activeKey === key;

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const open = () => {
    cancelClose();
    group.setActiveKey(key);
  };

  // Closes immediately, skipping the grace period — used after a real
  // navigation (link click), where there's no pointer gap left to protect.
  const close = () => {
    cancelClose();
    group.setActiveKey((prev) => (prev === key ? null : prev));
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      group.setActiveKey((prev) => (prev === key ? null : prev));
    }, FLYOUT_CLOSE_DELAY);
  };

  return { isOpen, open, close, cancelClose, scheduleClose };
}

// A flyout entry that itself has a `flyout` (e.g. Attendance's Log/Regularize/WFH)
// opens a second-level menu to its right, using the same hover-delay dance as
// the top-level trigger so the gap between the two panels doesn't close it.
function FlyoutItem({ item, onNavigate }) {
  const { isOpen, open, cancelClose, scheduleClose } = useFlyoutState(item.href);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const [panelActiveKey, setPanelActiveKey] = useState(null);
  const ref = useRef(null);

  if (!item.flyout) {
    return (
      <Link to={item.href} className="nav-flyout-item" onClick={onNavigate}>
        {item.label}
      </Link>
    );
  }

  const handleEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setCoords({ top: rect.top, left: rect.right + 6 });
    }
    open();
  };

  return (
    <div ref={ref} onMouseEnter={handleEnter} onMouseLeave={scheduleClose}>
      <Link to={item.href} className="nav-flyout-item nav-flyout-item-parent" onClick={onNavigate}>
        {item.label}
        <i className="fas fa-chevron-right nav-flyout-arrow" />
      </Link>
      {isOpen && (
        <div
          className="nav-flyout" style={{ top: coords.top, left: coords.left }}
          onMouseEnter={cancelClose} onMouseLeave={scheduleClose}
        >
          <FlyoutGroupContext.Provider value={{ activeKey: panelActiveKey, setActiveKey: setPanelActiveKey }}>
            {item.flyout.map((f) => (
              <FlyoutItem key={f.href} item={f} onNavigate={onNavigate} />
            ))}
          </FlyoutGroupContext.Provider>
        </div>
      )}
    </div>
  );
}

// Matches the current pathname against an item's own href OR (recursively) any
// of its flyout children's hrefs — so a parent like "Requests", whose four
// sub-pages each have a distinct pathname (unlike Home/Me's shared '/home'
// '/me' base), still highlights as active while on any of them.
function itemMatchesPath(item, pathname) {
  if (item.href.split('?')[0] === pathname) return true;
  // Pages below an item that have no menu entry of their own (a project's board under Tasks & Projects).
  if (item.matchPrefix?.some((prefix) => pathname.startsWith(prefix))) return true;
  return !!item.flyout?.some((f) => itemMatchesPath(f, pathname));
}

function NavItem({ item, pathname, onClose }) {
  const isActive = itemMatchesPath(item, pathname);

  if (!item.flyout) {
    return (
      <Link to={item.href} className={`nav-item ${isActive ? 'active' : ''}`} onClick={onClose}>
        <span className="icon"><i className={`fas ${item.icon}`} /></span>
        {item.label}
      </Link>
    );
  }

  // Touch devices have no reliable hover, so a category's children would
  // otherwise be completely unreachable (the desktop flyout never opens) —
  // this renders the exact same NAV_CONFIG data as a tap-to-expand accordion
  // instead, recursing for the one category (Me → Attendance) that nests
  // a second level.
  return supportsHover
    ? <NavItemWithFlyout item={item} isActive={isActive} onClose={onClose} />
    : <MobileAccordionItem item={item} isActive={isActive} pathname={pathname} onClose={onClose} />;
}

function MobileAccordionItem({ item, isActive, pathname, onClose }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="nav-accordion">
      <button
        type="button"
        className={`nav-item nav-item-toggle ${isActive ? 'active' : ''}`}
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className="icon"><i className={`fas ${item.icon}`} /></span>
        <span className="nav-item-label">{item.label}</span>
        <i className={`fas fa-chevron-down nav-item-caret ${expanded ? 'open' : ''}`} />
      </button>
      {expanded && (
        <div className="nav-accordion-panel">
          {item.flyout.map((f) => (
            <MobileAccordionChild key={f.href} item={f} pathname={pathname} onClose={onClose} depth={1} />
          ))}
        </div>
      )}
    </div>
  );
}

function MobileAccordionChild({ item, pathname, onClose, depth }) {
  const isActive = itemMatchesPath(item, pathname);
  const [expanded, setExpanded] = useState(false);
  const indent = 14 + depth * 16;

  if (!item.flyout) {
    return (
      <Link to={item.href} className={`nav-accordion-link ${isActive ? 'active' : ''}`} style={{ paddingLeft: indent }} onClick={onClose}>
        {item.label}
      </Link>
    );
  }

  return (
    <div>
      <button
        type="button"
        className={`nav-accordion-link nav-accordion-toggle ${isActive ? 'active' : ''}`}
        style={{ paddingLeft: indent }}
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span>{item.label}</span>
        <i className={`fas fa-chevron-down nav-item-caret ${expanded ? 'open' : ''}`} />
      </button>
      {expanded && item.flyout.map((f) => (
        <MobileAccordionChild key={f.href} item={f} pathname={pathname} onClose={onClose} depth={depth + 1} />
      ))}
    </div>
  );
}

// Split out so the useFlyoutState hook (which needs FlyoutGroupContext) is only
// ever called for items that actually have a flyout — keeps NavItem's early
// return above hook-rule-safe.
function NavItemWithFlyout({ item, isActive, onClose }) {
  const { isOpen, open, close, cancelClose, scheduleClose } = useFlyoutState(item.href);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const [panelActiveKey, setPanelActiveKey] = useState(null);
  const ref = useRef(null);

  const handleEnter = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setCoords({ top: rect.top, left: rect.right + 6 });
    }
    open();
  };

  return (
    <div ref={ref} onMouseEnter={handleEnter} onMouseLeave={scheduleClose}>
      <Link to={item.href} className={`nav-item ${isActive ? 'active' : ''}`} onClick={onClose}>
        <span className="icon"><i className={`fas ${item.icon}`} /></span>
        {item.label}
        <i className="fas fa-chevron-right nav-item-arrow" />
      </Link>
      {isOpen && (
        <div
          className="nav-flyout" style={{ top: coords.top, left: coords.left }}
          onMouseEnter={cancelClose} onMouseLeave={scheduleClose}
        >
          <FlyoutGroupContext.Provider value={{ activeKey: panelActiveKey, setActiveKey: setPanelActiveKey }}>
            {item.flyout.map((f) => (
              <FlyoutItem
                key={f.href} item={f}
                onNavigate={() => { close(); setPanelActiveKey(null); onClose(); }}
              />
            ))}
          </FlyoutGroupContext.Provider>
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ open = false, onClose = () => {} }) {
  const { profile, tenant, signOut } = useAuth();
  const { outlets, selectedOutletName } = useOutletView();
  const { isEnabled } = useFeatures();
  const location = useLocation();
  const pathname = location.pathname;

  // One shared group for the whole top-level nav list — item hrefs are unique
  // across sections, so a single active key keeps at most one flyout open at
  // a time regardless of which section it's in. Declared before the early
  // return below so hook-call order stays stable across renders.
  const [topActiveKey, setTopActiveKey] = useState(null);

  // Is this user anyone's L1? Raniwala only, cached for a few minutes in l1Service.
  const [isL1, setIsL1] = useState(false);
  useEffect(() => {
    if (!profile?.id || profile.role === 'superadmin' || !isRaniwalaTenant(tenant)) { setIsL1(false); return; }
    let live = true;
    fetchMyL1Members(profile.id).then(({ data }) => { if (live) setIsL1(data.length > 0); });
    return () => { live = false; };
  }, [profile?.id, profile?.role, tenant]);

  if (!profile) return null;

  const role = profile.role || 'employee';
  // Management (Raniwala owners) use the HOD portal, scoped to their own org below them.
  const hrSupport = isHrSupport(profile);
  const navKey = hrSupport ? 'hrSupport'
    : (role === 'manager' && isRaniwalaTenant(tenant)) || role === 'hod' || role === 'management' ? 'raniwalaManager' : role;
  const rawSections = NAV_CONFIG[navKey] || NAV_CONFIG.employee;

  // Fill in the Outlets flyout from live data, then strip anything the
  // superadmin has turned off for this company/outlet.
  const featureSections = filterNavByFeatures(injectOutletsFlyout(rawSections, { outlets, tenant, hrSupport }), isEnabled, tenant);
  const sections = isL1
    ? featureSections.map((section, i) => (i === 0 ? { ...section, items: [...section.items, L1_NAV_ITEM] } : section))
    : featureSections;

  const initials = getInitials(profile.first_name, profile.last_name);
  const displayName = fullName(profile) || 'User';
  const roleLabel = hrSupport ? 'HR Support' : {
    superadmin: 'Super Admin', admin: 'HR', manager: 'Manager', hod: 'HOD', management: 'Management',
  }[role] || 'Employee';

  return (
    <>
      <div className={`sidebar-backdrop ${open ? 'show' : ''}`} onClick={onClose} />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="sidebar-logo">
        <div className="logo-icon"><img src="/logo.png" alt="CrewCore" /></div>
        <div className="sidebar-logo-text">
          {/* The tenant's own company name is what an HR admin or employee
              actually wants to see front and center — it's their workspace,
              not ours. CrewCore stays visible as a small "powered by"-style
              mark rather than the headline. */}
          <h2 title={tenant?.company_name || 'CrewCore'}>{tenant?.company_name || 'CrewCore'}</h2>
          <span>CrewCore</span>
          {(role === 'admin' || role === 'superadmin') && outlets.length > 0 && (
            <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>
              <i className="fas fa-store" style={{ marginRight: 4 }} />
              Outlet — {selectedOutletName || 'All Outlets'}
            </div>
          )}
        </div>
        {/* A flex sibling rather than an absolutely-positioned overlay, so it
            can never collide with a company name that wraps onto a second
            line — it just sits at the end of the row instead. */}
        <button className="sidebar-close-btn" onClick={onClose} aria-label="Close menu">
          <i className="fas fa-times" />
        </button>
      </div>

      <nav className="sidebar-nav">
        <FlyoutGroupContext.Provider value={{ activeKey: topActiveKey, setActiveKey: setTopActiveKey }}>
          {sections.map((section, si) => (
            <div className="nav-section" key={si}>
              <div className="nav-section-title">{section.title}</div>
              {section.items.map((item) => (
                <NavItem key={item.href} item={item} pathname={pathname} onClose={onClose} />
              ))}
            </div>
          ))}
        </FlyoutGroupContext.Provider>
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="avatar">{initials}</div>
          <div className="user-info">
            {displayName}
            <span>{roleLabel}</span>
          </div>
          <button className="logout-btn" onClick={signOut} title="Sign Out">
            <i className="fas fa-sign-out-alt" />
          </button>
        </div>
      </div>
      </aside>
    </>
  );
}
