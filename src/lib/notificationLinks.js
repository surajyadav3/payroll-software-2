// Maps a notification's logical link_key to the role-correct route — this
// app uses a different path per role for the same feature (e.g. '/leaves'
// vs '/manager-leaves' vs '/my-leaves'), so a notification can't just store
// a raw href without it being wrong for some of its recipients.
const LINKS = {
  leave_requests:         { admin: '/leaves',            manager: '/manager-leaves',            employee: '/my-leaves' },
  // HR: came in on an approved leave day (20261024_6) — the card on Leave Management.
  leave_worked_days:      { admin: '/leaves' },
  regularize_attendance:  { admin: '/regularize',         manager: '/manager-regularize',         employee: '/my-regularize' },
  wfh_requests:            { admin: '/wfh-requests',       manager: '/manager-wfh-requests',       employee: '/my-wfh' },
  special_requests:        { admin: '/special-requests',   manager: '/manager-special-requests',   employee: '/my-special-requests' },
  expense_claims:          { admin: '/expense-claims',     manager: '/expense-claims',             employee: '/expense-claims' },
  travel_requests:         { admin: '/travel-requests',    manager: '/travel-requests',            employee: '/travel-requests' },
  headcount_requests:      { admin: '/headcount-requests', manager: '/headcount-requests',         employee: '/headcount-requests' },
  grievances:              { admin: '/grievances',         manager: '/grievances',                 employee: '/grievances' },
  punch_approvals:         { admin: '/punch-approvals',    manager: '/manager-punch-approvals' },
  attendance:              { admin: '/attendance',         manager: '/manager-attendance',         employee: '/my-attendance' },
  announcements:           { admin: '/announcements',      manager: '/announcements',              employee: '/announcements' },
  policies:                { admin: '/policies',           manager: '/policies',                   employee: '/policies' },
  performance:             { admin: '/performance',        manager: '/performance',                employee: '/performance' },
  // Employee side (submitting/viewing their own requests) is mobile-app-only —
  // no web route exists for them, so there's deliberately no `employee` entry here.
  verification_requests:   { admin: '/verification-requests', manager: '/manager-verification-requests' },
  // Same page for every role; `param` deep-links to the notification's related_id.
  tasks:                   { admin: '/work', manager: '/work', employee: '/work', param: 'task' },
  // A mention or a direct message: related_id is the conversation.
  messages:                { admin: '/work/chat', manager: '/work/chat', employee: '/work/chat', param: 'c' },
  recruitment:             { admin: '/recruitment-pipeline', manager: '/recruitment-pipeline', param: 'candidate' },
  // A request an L1 filed was decided (20261024_2): related_id is the employee.
  l1_requests:             { admin: '/l1-employees', manager: '/l1-employees', employee: '/l1-employees', param: 'id' },
};

export function resolveNotificationLink(linkKey, role, relatedId = null) {
  const entry = LINKS[linkKey];
  if (!entry) return null;
  const href = entry[role] || ((role === 'hod' || role === 'management') ? entry.manager : null) || entry.employee || null;
  return href && entry.param && relatedId ? `${href}?${entry.param}=${relatedId}` : href;
}
