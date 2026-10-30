// A flat, curated registry of every action/destination a user can jump to
// from the global search box — verb-first labels ("Apply Leave") rather than
// noun labels ("Leave"), matching what someone actually types when they want
// to *do* something rather than browse a menu. Each entry's `href` is either
// a single path or a {admin, manager, employee} map for routes that differ
// by role (mirrors the role-prefixed route convention used throughout
// src/App.jsx, e.g. '/leaves' vs '/manager-leaves' vs '/me?tab=leave').
const ACTIONS = [
  // ── Self-service — every role ────────────────────────────────────────
  { label: 'Apply Leave', keywords: ['vacation', 'pto', 'time off', 'holiday'], icon: 'fa-calendar-check', href: '/me?tab=leave', roles: ['employee', 'manager', 'admin', 'superadmin'] },
  { label: 'View Attendance Log', keywords: ['clock in', 'clock out', 'punch'], icon: 'fa-fingerprint', href: '/me?tab=attendance&sub=log', roles: ['employee', 'manager', 'admin', 'superadmin'] },
  { label: 'Regularize Attendance', keywords: ['fix punch', 'missed punch', 'correction'], icon: 'fa-clock-rotate-left', href: '/me?tab=attendance&sub=regularize', roles: ['employee', 'manager', 'admin', 'superadmin'] },
  { label: 'Request Work From Home', keywords: ['wfh', 'remote'], icon: 'fa-house-laptop', href: '/me?tab=attendance&sub=wfh', roles: ['employee', 'manager', 'admin', 'superadmin'] },
  { label: 'View My Payslips', payroll: true, keywords: ['salary slip', 'pay stub'], icon: 'fa-file-invoice-dollar', href: { employee: '/my-payslips', manager: '/manager-payslips', admin: '/payslips', superadmin: '/payslips' }, roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'payslips' },
  { label: 'Submit Expense Claim', keywords: ['reimbursement', 'bill'], icon: 'fa-receipt', href: '/expense-claims', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'expense_claims' },
  { label: 'Submit Travel Request', keywords: ['business trip'], icon: 'fa-plane', href: '/travel-requests', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'travel_requests' },
  { label: 'Raise a Special Request', icon: 'fa-star-half-alt', href: { employee: '/my-special-requests', manager: '/manager-special-requests', admin: '/special-requests', superadmin: '/special-requests' }, roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'special_requests' },
  { label: 'File a Grievance', keywords: ['complaint', 'issue', 'hr case'], icon: 'fa-exclamation-circle', href: '/grievances', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'grievances' },
  { label: 'Declare Tax Investments', payroll: true, keywords: ['80c', 'tds', 'hra'], icon: 'fa-file-invoice', href: '/my-tax-declaration', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'tax_declaration' },
  { label: 'View My Training', keywords: ['skills', 'courses'], icon: 'fa-graduation-cap', href: '/me?tab=training', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'training' },
  { label: 'View My Onboarding Checklist', icon: 'fa-clipboard-check', href: '/me?tab=onboarding', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'onboarding' },
  { label: 'View My Offboarding Checklist', keywords: ['exit', 'resignation'], icon: 'fa-door-open', href: '/me?tab=offboarding', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'offboarding' },
  { label: 'View My Assets', keywords: ['laptop', 'equipment'], icon: 'fa-boxes-stacked', href: '/me?tab=assets', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'assets' },
  { label: 'Help & FAQ', keywords: ['how to', 'guide', 'support', 'faq', 'help'], icon: 'fa-circle-question', href: '/help', roles: ['employee', 'manager', 'admin', 'superadmin'] },
  { label: 'My Work', keywords: ['todo', 'assign task', 'to-do', 'tasks', 'today', 'overdue', 'review', 'calendar'], icon: 'fa-list-check', href: '/work/me', roles: ['employee', 'manager', 'admin'], featureKey: 'tasks' },
  { label: 'Tasks & Projects', keywords: ['board', 'kanban', 'project', 'task'], icon: 'fa-diagram-project', href: '/work', roles: ['employee', 'manager', 'admin'], featureKey: 'tasks' },
  { label: 'Messages', keywords: ['chat', 'channel', 'dm', 'direct message', 'slack', 'general'], icon: 'fa-comments', href: '/work/chat', roles: ['employee', 'manager', 'admin'], featureKey: 'team_chat' },
  { label: 'My Performance (Goals, KPIs, Reviews)', keywords: ['goals', 'kra', 'kpi', 'review', 'appraisal', 'rating', 'cycle'], icon: 'fa-trophy', href: '/performance', roles: ['employee', 'manager', 'admin'] },
  { label: 'View Announcements', icon: 'fa-bullhorn', href: '/announcements', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'announcements' },
  { label: 'View Company Policies', icon: 'fa-file-contract', href: '/policies', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'policies' },
  { label: 'Browse Job Postings', keywords: ['internal jobs', 'openings'], icon: 'fa-briefcase', href: '/hiring', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'hiring' },
  { label: 'Refer a Candidate', icon: 'fa-user-plus', href: '/refer', roles: ['employee', 'manager', 'admin', 'superadmin'], featureKey: 'refer' },
  { label: 'View Helpdesk Tickets', keywords: ['support', 'ticket'], icon: 'fa-headset', href: '/helpdesk', roles: ['employee', 'manager', 'admin'], featureKey: 'helpdesk' },

  // ── Manager & HR — team/approval actions ────────────────────────────
  { label: 'Approve Leave Requests', icon: 'fa-inbox', href: { manager: '/manager-leaves', admin: '/leaves', superadmin: '/leaves' }, roles: ['manager', 'admin', 'superadmin'], featureKey: 'leave_requests' },
  { label: 'Approve Regularize Requests', icon: 'fa-clock-rotate-left', href: { manager: '/manager-regularize', admin: '/regularize', superadmin: '/regularize' }, roles: ['manager', 'admin', 'superadmin'], featureKey: 'regularize_attendance' },
  { label: 'Approve Work From Home Requests', icon: 'fa-house-laptop', href: { manager: '/manager-wfh-requests', admin: '/wfh-requests', superadmin: '/wfh-requests' }, roles: ['manager', 'admin', 'superadmin'], featureKey: 'wfh_requests' },
  { label: 'View Team Attendance', icon: 'fa-fingerprint', href: { manager: '/manager-attendance', admin: '/attendance', superadmin: '/attendance' }, roles: ['manager', 'admin', 'superadmin'], featureKey: 'attendance' },
  { label: 'View Employee Calendar', icon: 'fa-calendar-day', href: { manager: '/manager-employee-calendar', admin: '/employee-calendar', superadmin: '/employee-calendar' }, roles: ['manager', 'admin', 'superadmin'], featureKey: 'employee_calendar' },
  { label: 'Post a Job', keywords: ['job posting', 'vacancy'], icon: 'fa-briefcase', href: '/hiring', roles: ['manager', 'admin', 'superadmin'], featureKey: 'hiring' },
  { label: 'Request Headcount', icon: 'fa-user-plus', href: '/headcount-requests', roles: ['manager', 'admin', 'superadmin'], featureKey: 'headcount_requests' },
  { label: 'Schedule Interview', icon: 'fa-comments', href: '/interviews', roles: ['manager', 'admin', 'superadmin'], featureKey: 'interviews' },
  { label: 'Send Offer Letter', icon: 'fa-file-signature', href: '/offer-letters', roles: ['manager', 'admin', 'superadmin'], featureKey: 'offer_letters' },
  { label: 'Run Payroll', payroll: true, icon: 'fa-money-bill-wave', href: { manager: '/manager-payroll', admin: '/payroll', superadmin: '/payroll' }, roles: ['manager', 'admin', 'superadmin'], featureKey: 'run_payroll' },
  { label: 'Manage Advances & Loans', payroll: true, icon: 'fa-hand-holding-usd', href: { manager: '/manager-advances', admin: '/advances', superadmin: '/advances' }, roles: ['manager', 'admin', 'superadmin'], featureKey: 'advances_loans' },

  // ── HR / Admin only ──────────────────────────────────────────────────
  { label: 'Add or Manage Employees', keywords: ['new hire', 'employee directory', 'onboard'], icon: 'fa-users', href: '/employees', roles: ['admin', 'superadmin'], featureKey: 'employees' },
  { label: 'Manage Company Assets', keywords: ['inventory', 'equipment', 'assign laptop'], icon: 'fa-boxes-stacked', href: '/assets', roles: ['admin', 'superadmin'], featureKey: 'assets' },
  { label: 'Start Onboarding', keywords: ['new hire checklist'], icon: 'fa-clipboard-check', href: '/onboarding', roles: ['admin', 'superadmin'], featureKey: 'onboarding' },
  { label: 'Start Offboarding', keywords: ['exit process', 'resignation'], icon: 'fa-door-open', href: '/offboarding', roles: ['admin', 'superadmin'], featureKey: 'offboarding' },
  { label: 'Review Grievances', keywords: ['hr case', 'complaint'], icon: 'fa-exclamation-circle', href: '/grievances', roles: ['admin', 'superadmin'], featureKey: 'grievances' },
  { label: 'Manage Shift Roster', icon: 'fa-calendar-week', href: '/shift-roster', roles: ['admin', 'superadmin'], featureKey: 'shift_roster' },
  { label: 'View Master Report', icon: 'fa-file-alt', href: '/master-report', roles: ['admin', 'superadmin'], featureKey: 'master_report' },
  { label: 'Manage Announcements', icon: 'fa-bullhorn', href: '/announcements', roles: ['admin', 'superadmin'], featureKey: 'announcements' },
  { label: 'Manage Company Policies', icon: 'fa-file-contract', href: '/policies', roles: ['admin', 'superadmin'], featureKey: 'policies' },
  { label: 'Manage Training & Skills', icon: 'fa-graduation-cap', href: '/training', roles: ['admin', 'superadmin'], featureKey: 'training' },
  { label: 'Manage Leave Types', settings: true, icon: 'fa-calendar-check', href: '/leave-types', roles: ['admin', 'superadmin'], featureKey: 'leave_setup' },
  { label: 'Manage Leave Balances', icon: 'fa-calendar-check', href: '/leave-balances', roles: ['admin', 'superadmin'], featureKey: 'leave_setup' },
  { label: 'Manage Salary Structure', payroll: true, icon: 'fa-sliders-h', href: '/salary', roles: ['admin', 'superadmin'], featureKey: 'salary_structure' },
  { label: 'Manage One-Off Pay Items', payroll: true, keywords: ['bonus', 'deduction'], icon: 'fa-coins', href: '/salary-additions', roles: ['admin', 'superadmin'], featureKey: 'salary_additions' },
  { label: 'Manage Income Tax Slabs', payroll: true, icon: 'fa-receipt', href: '/tax-slabs', roles: ['admin', 'superadmin'], featureKey: 'tax_slabs' },
  { label: 'Manage Approval Chains', settings: true, keywords: ['workflow'], icon: 'fa-route', href: '/approval-chains', roles: ['admin', 'superadmin'], featureKey: 'approval_chains' },
  { label: 'Company Settings', settings: true, keywords: ['branding', 'geofence', 'holidays', 'invite code'], icon: 'fa-gears', href: '/settings', roles: ['admin', 'superadmin'] },
  { label: 'Manage Outlets', keywords: ['branches', 'locations'], icon: 'fa-store', href: '/outlets', roles: ['admin'], featureKey: 'outlets_multi_branch' },

  // ── Platform (superadmin only) ───────────────────────────────────────
  { label: 'Master Dashboard', icon: 'fa-chart-line', href: '/master-dashboard', roles: ['superadmin'] },
  { label: 'Manage Tenants', keywords: ['companies', 'customers'], icon: 'fa-building', href: '/tenants', roles: ['superadmin'] },
  { label: 'Toggle Services', keywords: ['feature flags'], icon: 'fa-toggle-on', href: '/toggle-services', roles: ['superadmin'] },
  { label: 'All Platform Employees', icon: 'fa-users', href: '/platform-employees', roles: ['superadmin'] },
];

/** Resolves a possibly role-keyed href to the plain path for the given role. */
function resolveHref(href, role) {
  if (typeof href === 'string') return href;
  return href[role] || href.employee || Object.values(href)[0];
}

/**
 * All actions visible to a role, with any feature-gated entries the tenant
 * has turned off (and payroll ones, for HR Support) already stripped out — same "role first, feature-flag
 * second" filter order used by the sidebar's own nav config.
 */
export function getActionsForRole(role, isEnabled, { hrSupport = false } = {}) {
  return ACTIONS
    .filter((a) => a.roles.includes(role))
    .filter((a) => !(hrSupport && (a.payroll || a.settings))) // HR Support: no payroll, no settings
    .filter((a) => !a.featureKey || isEnabled(a.featureKey))
    .map((a) => ({ ...a, href: resolveHref(a.href, role) }));
}
