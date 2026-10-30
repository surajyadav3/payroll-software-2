// Single source of truth for every toggleable CrewCore feature. This is what
// makes new features show up for the superadmin automatically: add one entry
// here in the same commit/PR that ships the feature, and the next time
// anyone opens Toggle Services, featureService.syncFeatureRegistry() upserts
// it into the `features` table — no separate SQL migration needed to make it
// visible/toggleable (the table itself still exists for company_feature_toggles'
// FK and for RLS-scoped reads, this file is just what keeps it in sync).
//
// Dashboard/Home, "Me", and Settings are deliberately absent — they stay
// always-on so a company never loses its landing page or the ability to fix
// its own configuration.
//
// `since` (YYYY-MM) is code-only — it is stripped before the DB upsert and
// drives the "New" badge on Toggle Services. Set it on every new entry.
export const FEATURE_REGISTRY = [
  { key: 'employees', name: 'Employees', category: 'General', description: 'Employee directory, profiles, and records management.', sort_order: 10 },
  { key: 'attendance', name: 'Attendance', category: 'General', description: 'Daily attendance, punches, and attendance overview.', sort_order: 20 },
  { key: 'geofencing', name: 'Geofencing', category: 'General', description: 'Location-fence check on clock-in/out. Turn off for one outlet (via Scope below) to let that outlet\'s employees clock in/out from anywhere — leave on everywhere else.', sort_order: 25, since: '2026-09' },
  { key: 'shift_roster', name: 'Shift Roster', category: 'General', description: 'Assigning employees to shifts and roster planning.', sort_order: 30 },
  { key: 'employee_calendar', name: 'Employee Calendar', category: 'General', description: 'Calendar view of leave, holidays, and attendance.', sort_order: 40 },
  { key: 'late_comers_report', name: 'Late Comers Report', category: 'General', description: 'Date-wise and date-range late/absent report, with repeat-offender highlighting.', sort_order: 45, since: '2026-09' },
  { key: 'master_report', name: 'Master Report', category: 'General', description: 'Consolidated cross-module reporting.', sort_order: 50 },
  { key: 'helpdesk', name: 'Helpdesk', category: 'General', description: 'Internal support ticketing for employees.', sort_order: 60 },
  { key: 'announcements', name: 'Announcements', category: 'General', description: 'Company-wide announcements and notices.', sort_order: 70 },
  { key: 'policies', name: 'Policies', category: 'General', description: 'Company policy documents.', sort_order: 80 },
  { key: 'onboarding', name: 'Onboarding', category: 'General', description: 'New-hire onboarding checklists and tracking.', sort_order: 91 },
  { key: 'offboarding', name: 'Offboarding', category: 'General', description: 'Employee exit checklists and tracking.', sort_order: 92 },
  { key: 'training', name: 'Training & Skills', category: 'General', description: 'Training programs and skill tracking.', sort_order: 90 },
  { key: 'assets', name: 'Assets', category: 'General', description: 'Company equipment inventory and assignment tracking.', sort_order: 93 },
  { key: 'projects', name: 'Projects', category: 'General', description: 'Projects inside Tasks: a board of tasks per project, members, and a channel of its own. Needs Task Management on.', sort_order: 94, since: '2026-10' },
  { key: 'tasks', name: 'Task Management', category: 'General', description: 'My Work and the task register: assign, track and review tasks with stages, priorities, due dates and revised dates, sub-tasks, dependencies, repeating tasks, comments and notifications. Turning this off also stops task reminders.', sort_order: 95, since: '2026-10' },
  { key: 'task_reminders', name: 'Task Reminders (Slack / Email / WhatsApp)', category: 'General', description: 'Daily due/overdue digests and assignment/status alerts sent outside the app, over the channels HR sets up in Settings. The in-app bell and mobile push are not affected. Needs Task Management on.', sort_order: 96, since: '2026-10' },
  { key: 'team_chat', name: 'Messages', category: 'General', description: 'Company messaging: #general, channels, a channel per project, direct messages, threads, @mentions, reactions and turning a message into a task.', sort_order: 97, since: '2026-10' },
  { key: 'org_hierarchy', name: 'Org Hierarchy', category: 'General', description: 'Visual reporting-structure tree and manager assignment.', sort_order: 99, since: '2026-09' },
  { key: 'grievances', name: 'Grievances', category: 'General', description: 'Employee grievance submission and resolution.', sort_order: 100 },
  { key: 'outlets_multi_branch', name: 'Outlets / Multi-Branch', category: 'General', description: 'Multi-outlet overview, combined and group dashboards.', sort_order: 110 },

  { key: 'leave_requests', name: 'Leave Requests', category: 'Requests', description: 'Employee leave request submission and approval.', sort_order: 200 },
  { key: 'regularize_attendance', name: 'Regularize Attendance', category: 'Requests', description: 'Requests to correct missed or incorrect punches.', sort_order: 210 },
  { key: 'wfh_requests', name: 'Work From Home', category: 'Requests', description: 'Work-from-home request submission and approval.', sort_order: 220 },
  { key: 'special_requests', name: 'Special Requests', category: 'Requests', description: 'Miscellaneous employee requests.', sort_order: 230 },
  { key: 'expense_claims', name: 'Expense Claims', category: 'Requests', description: 'Expense claim submission and reimbursement.', sort_order: 240 },
  { key: 'profile_verification', name: 'Profile Verification (Bank/PAN/Aadhar)', category: 'Requests', description: 'Employee self-service edit of Bank/PAN/Aadhar (from the mobile app) with HR/manager approval.', sort_order: 245, since: '2026-09' },
  { key: 'travel_requests', name: 'Travel Requests', category: 'Requests', description: 'Business travel request and approval.', sort_order: 250 },
  { key: 'leave_setup', name: 'Leave Setup', category: 'Requests', description: 'Leave type and leave balance configuration.', sort_order: 260 },
  { key: 'tax_declaration', name: 'Tax Declaration', category: 'Requests', description: 'Employee income tax declaration.', sort_order: 270 },

  { key: 'hiring', name: 'Job Postings', category: 'Hiring', description: 'Open job postings and candidate pipeline.', sort_order: 300 },
  { key: 'careers_page', name: 'Careers Page', category: 'Hiring', description: 'Public careers page (crewcore.in/careers/<company>) listing open job postings, with online applications and CV upload. HR still switches it on and picks the URL from Job Postings.', sort_order: 302, since: '2026-10' },
  { key: 'recruitment_pipeline', name: 'Recruitment Pipeline', category: 'Hiring', description: 'End-to-end candidate pipeline: requisition, interviews, offer, and onboarding hand-off, mapped to the recruitment SOP.', sort_order: 305, since: '2026-09' },
  { key: 'headcount_requests', name: 'Headcount Requests', category: 'Hiring', description: 'Requests to open new headcount.', sort_order: 310 },
  { key: 'interviews', name: 'Interviews', category: 'Hiring', description: 'Interview scheduling and feedback.', sort_order: 320 },
  { key: 'offer_letters', name: 'Offer Letters', category: 'Hiring', description: 'Offer letter generation and tracking.', sort_order: 330 },
  { key: 'refer', name: 'Refer a Candidate', category: 'Hiring', description: 'Employee referral submissions.', sort_order: 340 },

  { key: 'performance_kras', name: 'Goals & KPIs', category: 'Performance', description: 'Goal plans per review cycle (weights, measures, progress updates, manager approval) and the monthly KPI register with targets, results and confirmation.', sort_order: 400, since: '2026-10' },
  { key: 'performance_one_on_ones', name: '1:1 Meetings', category: 'Performance', description: 'One-on-one meeting scheduling and notes.', sort_order: 410 },
  { key: 'performance_feedback', name: 'Feedback', category: 'Performance', description: 'Peer and manager feedback.', sort_order: 420 },
  { key: 'performance_pip', name: 'PIP', category: 'Performance', description: 'Performance improvement plans.', sort_order: 430 },
  { key: 'performance_reviews', name: 'Performance Reviews', category: 'Performance', description: 'Review cycles: self review, manager review, calibration, final ratings, sharing results and acknowledgement.', sort_order: 440, since: '2026-10' },

  { key: 'salary_structure', name: 'Salary Structure', category: 'Payroll', description: 'Employee salary component structure.', sort_order: 500 },
  { key: 'run_payroll', name: 'Run Payroll', category: 'Payroll', description: 'Monthly payroll processing.', sort_order: 510 },
  { key: 'payslips', name: 'Payslips', category: 'Payroll', description: 'Payslip generation and access.', sort_order: 520 },
  { key: 'advances_loans', name: 'Advances & Loans', category: 'Payroll', description: 'Employee salary advances and loans.', sort_order: 530 },
  { key: 'salary_additions', name: 'One-Off Pay Items', category: 'Payroll', description: 'One-time additions or deductions to pay.', sort_order: 540 },
  { key: 'tax_slabs', name: 'Income Tax Slabs', category: 'Payroll', description: 'Income tax slab configuration.', sort_order: 550 },

  { key: 'approval_chains', name: 'Approval Chains', category: 'System', description: 'Multi-step approval workflow configuration.', sort_order: 600 },

  // Premium: is_premium defaults every other entry above to `false` (enabled
  // by default, same as before). A premium feature instead defaults to OFF
  // for every tenant until a superadmin explicitly turns it on from Toggle
  // Services — see resolveFeatureState()'s defaultEnabled param.
  { key: 'live_tracking', name: 'Live Tracking', category: 'Premium', description: 'Real-time and historical field-employee location tracking, with standing/moving time and a route map. Opt in per employee.', sort_order: 700, is_premium: true, since: '2026-09' },
  { key: 'ai_assistant', name: 'AI Assistant', category: 'Premium', description: 'In-app AI chat assistant: answers how-to questions, finds pages, looks up your own leave, attendance, payslips and tasks, and creates tasks.', sort_order: 710, is_premium: true, since: '2026-10' },
  { key: 'ai_meetings', name: 'AI Meeting Notes', category: 'Premium', description: 'Paste or upload a meeting transcript; AI writes the summary and turns action items into assigned tasks.', sort_order: 720, is_premium: true, since: '2026-10' },
];

/** Registry entry by key, for code-only metadata (e.g. `since`) the DB row doesn't carry. */
export const FEATURE_BY_KEY = new Map(FEATURE_REGISTRY.map((f) => [f.key, f]));

/** True when a feature shipped within the last `months` months — drives the "New" badge. */
export function isNewFeature(key, months = 2, today = new Date()) {
  const since = FEATURE_BY_KEY.get(key)?.since;
  if (!since) return false;
  const [y, m] = since.split('-').map(Number);
  const ageMonths = (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - m);
  return ageMonths >= 0 && ageMonths < months;
}
