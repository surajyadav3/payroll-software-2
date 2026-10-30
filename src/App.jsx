import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { useFeatures } from './context/FeatureContext';

// Pages
import HomePage from './pages/HomePage';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage';
import LoginPage from './pages/auth/LoginPage';
import SignupPage from './pages/auth/SignupPage';
import ResetPasswordPage from './pages/auth/ResetPasswordPage';

import DashboardPage from './pages/dashboard/DashboardPage';
import EmployeesPage from './pages/dashboard/EmployeesPage';
import AttendancePage from './pages/dashboard/AttendancePage';
import EsslRecordsPage from './pages/dashboard/EsslRecordsPage';
import SalaryPage from './pages/dashboard/SalaryPage';
import PayrollPage from './pages/dashboard/PayrollPage';
import PayslipsPage from './pages/dashboard/PayslipsPage';

import LeavesPage from './pages/dashboard/LeavesPage';
import AdvancesPage from './pages/dashboard/AdvancesPage';
import SettingsPage from './pages/dashboard/SettingsPage';
import TenantsPage from './pages/dashboard/TenantsPage';
import AllEmployeesPage from './pages/dashboard/AllEmployeesPage';
import MasterDashboardPage from './pages/dashboard/MasterDashboardPage';
import HelpdeskPage from './pages/dashboard/HelpdeskPage';
import HelpdeskAdminPage from './pages/dashboard/HelpdeskAdminPage';
import ToggleServicesPage from './pages/dashboard/ToggleServicesPage';
import HrFeatureSettingsPage from './pages/dashboard/HrFeatureSettingsPage';
import NotificationsPage from './pages/dashboard/NotificationsPage';
import HiringPage from './pages/dashboard/HiringPage';
import ReferPage from './pages/dashboard/ReferPage';
import RegularizeAttendancePage from './pages/dashboard/RegularizeAttendancePage';
import PunchApprovalsPage from './pages/dashboard/PunchApprovalsPage';
import WFHRequestsPage from './pages/dashboard/WFHRequestsPage';
import VerificationRequestsPage from './pages/dashboard/VerificationRequestsPage';
import SpecialRequestsPage from './pages/dashboard/SpecialRequestsPage';
import EmployeeCalendarPage from './pages/dashboard/EmployeeCalendarPage';
import LiveTrackingPage from './pages/dashboard/LiveTrackingPage';
import MasterReportPage from './pages/dashboard/MasterReportPage';
import GroupDashboardPage from './pages/dashboard/GroupDashboardPage';
import OutletsOverviewPage from './pages/dashboard/OutletsOverviewPage';
import CombinedOutletDashboardPage from './pages/dashboard/CombinedOutletDashboardPage';
import AnnouncementsPage from './pages/dashboard/AnnouncementsPage';
import PoliciesPage from './pages/dashboard/PoliciesPage';
import FeedbackPage from './pages/dashboard/FeedbackPage';
import PIPPage from './pages/dashboard/PIPPage';
import OneOnOnesPage from './pages/dashboard/OneOnOnesPage';
import TaxSlabsPage from './pages/dashboard/TaxSlabsPage';
import PfDifferencePage from './pages/dashboard/PfDifferencePage';
import SalaryAdditionsPage from './pages/dashboard/SalaryAdditionsPage';
import LeaveTypesPage from './pages/dashboard/LeaveTypesPage';
import LeaveBalancesPage from './pages/dashboard/LeaveBalancesPage';
import ShiftAssignmentsPage from './pages/dashboard/ShiftAssignmentsPage';
import GrievancePage from './pages/dashboard/GrievancePage';
import HeadcountRequestsPage from './pages/dashboard/HeadcountRequestsPage';
import RecruitmentPipelinePage from './pages/dashboard/RecruitmentPipelinePage';
import InterviewsPage from './pages/dashboard/InterviewsPage';
import OfferLettersPage from './pages/dashboard/OfferLettersPage';
import TrainingPage from './pages/dashboard/TrainingPage';
import MyTrainingPage from './pages/employee/MyTrainingPage';
import OnboardingPage from './pages/dashboard/OnboardingPage';
import MyOnboardingPage from './pages/employee/MyOnboardingPage';
import OffboardingPage from './pages/dashboard/OffboardingPage';
import MyOffboardingPage from './pages/employee/MyOffboardingPage';
import AssetsPage from './pages/dashboard/AssetsPage';
import MyAssetsPage from './pages/employee/MyAssetsPage';
import { CrewShell, WorkPage, MyWorkPage, ProjectPage, ChatPage, MentionsPage, PerformancePage } from './crew/routes';
import HelpPage from './pages/dashboard/HelpPage';
import MeetingsPage from './pages/dashboard/MeetingsPage';
import CareersPage from './pages/CareersPage';
import ErpPage from './pages/ErpPage';
import ExpenseClaimsPage from './pages/dashboard/ExpenseClaimsPage';
import TravelRequestsPage from './pages/dashboard/TravelRequestsPage';
import ApprovalChainsPage from './pages/dashboard/ApprovalChainsPage';
import OrgHierarchyPage from './pages/dashboard/OrgHierarchyPage';

import ManagerDashboardPage from './pages/dashboard/ManagerDashboardPage';
import MyTeamPage from './pages/dashboard/MyTeamPage';
import { isRaniwalaTenant, isHrSupport } from './lib/helpers';

import EmployeeDashboard from './pages/employee/DashboardPage';
import MyAttendancePage from './pages/employee/MyAttendancePage';
import MyLeavesPage from './pages/employee/MyLeavesPage';
import MyPayslipsPage from './pages/employee/MyPayslipsPage';
import TaxDeclarationPage from './pages/employee/TaxDeclarationPage';
import MySpecialRequestsPage from './pages/employee/MySpecialRequestsPage';
import MyRegularizeRequestsPage from './pages/employee/MyRegularizeRequestsPage';
import L1EmployeesPage from './pages/employee/L1EmployeesPage';
import MyWfhRequestsPage from './pages/employee/MyWfhRequestsPage';
import MePage from './pages/employee/MePage';
import HomePageTab from './pages/home/HomePage';

// Layouts
import DashboardLayout from './layouts/DashboardLayout';
import AuthLayout from './layouts/AuthLayout';

// Raniwala managers get the team calendar/summary page; every other
// tenant's manager keeps the existing employee list.
function ManagerTeamPage() {
  const { tenant } = useAuth();
  return isRaniwalaTenant(tenant) ? <MyTeamPage /> : <EmployeesPage />;
}

// Everyone with an employee record uses Work, Messages and Performance (the platform console
// account — superadmin — has no company, so it has none of them).
const WORK_ROLES = ['employee', 'admin', 'manager', 'hod', 'management'];

// Old links such as /tasks?task=<id> keep working: same query, new address.
function RedirectKeepingQuery({ to }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

function homeFor(role) {
  if (role === 'superadmin') return '/master-dashboard';
  return '/home';
}

function PrivateRoute({ children, allowedRoles, featureKey, notForRaniwala, payroll, settings }) {
  const { user, profile, tenant, loading } = useAuth();
  const { isEnabled, loading: featuresLoading } = useFeatures();

  if (loading) {
    return <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner"></div></div>;
  }

  if (!user || !profile) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(profile.role)) {
    return <Navigate to={homeFor(profile.role)} replace />;
  }

  // Raniwala's manager portal drops payroll, the company-wide attendance
  // log and HR Settings (HR-only there) — RLS blocks the data too.
  if (notForRaniwala && isRaniwalaTenant(tenant)) {
    return <Navigate to={notForRaniwala === true ? homeFor(profile.role) : notForRaniwala} replace />;
  }

  // HR Support is HR without payroll (RLS hides those tables from it too)
  // and without the Settings / HR Settings pages.
  if ((payroll || settings) && isHrSupport(profile)) {
    return <Navigate to={homeFor(profile.role)} replace />;
  }

  if (featureKey) {
    // Wait for the toggle state to load before deciding — otherwise a page
    // whose feature IS enabled would flash-redirect on every load.
    if (featuresLoading) {
      return <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div className="spinner"></div></div>;
    }
    // A list means "any of these" (one screen shared by several services).
    if (![].concat(featureKey).some((key) => isEnabled(key))) {
      return <Navigate to={homeFor(profile.role)} replace />;
    }
  }

  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/privacy" element={<PrivacyPolicyPage />} />
      <Route path="/careers/:slug" element={<CareersPage />} />
      <Route path="/erp" element={<ErpPage />} />

      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
      </Route>

      <Route element={<DashboardLayout />}>
        {/* Admin Routes */}
        <Route path="/dashboard" element={<PrivateRoute payroll allowedRoles={['admin', 'superadmin']}><DashboardPage /></PrivateRoute>} />
        <Route path="/employees" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="employees"><EmployeesPage /></PrivateRoute>} />
        <Route path="/attendance" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="attendance"><AttendancePage /></PrivateRoute>} />
        <Route path="/essl-records" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="attendance"><EsslRecordsPage /></PrivateRoute>} />
        <Route path="/shift-roster" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="shift_roster"><ShiftAssignmentsPage /></PrivateRoute>} />
        <Route path="/salary" element={<PrivateRoute payroll allowedRoles={['admin', 'superadmin']} featureKey="salary_structure"><SalaryPage /></PrivateRoute>} />
        <Route path="/payroll" element={<PrivateRoute payroll allowedRoles={['admin', 'superadmin']} featureKey="run_payroll"><PayrollPage /></PrivateRoute>} />
        <Route path="/payslips" element={<PrivateRoute payroll allowedRoles={['admin', 'superadmin']} featureKey="payslips"><PayslipsPage /></PrivateRoute>} />
        <Route path="/tax-slabs" element={<PrivateRoute payroll allowedRoles={['admin', 'superadmin']} featureKey="tax_slabs"><TaxSlabsPage /></PrivateRoute>} />
        <Route path="/pf-difference" element={<PrivateRoute payroll allowedRoles={['admin', 'superadmin']} featureKey="run_payroll"><PfDifferencePage /></PrivateRoute>} />
        <Route path="/salary-additions" element={<PrivateRoute payroll allowedRoles={['admin', 'superadmin']} featureKey="salary_additions"><SalaryAdditionsPage /></PrivateRoute>} />
        <Route path="/leaves" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="leave_requests"><LeavesPage /></PrivateRoute>} />
        <Route path="/leave-types" element={<PrivateRoute settings allowedRoles={['admin', 'superadmin']} featureKey="leave_setup"><LeaveTypesPage /></PrivateRoute>} />
        <Route path="/leave-balances" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="leave_setup"><LeaveBalancesPage /></PrivateRoute>} />
        <Route path="/advances" element={<PrivateRoute payroll allowedRoles={['admin', 'superadmin']} featureKey="advances_loans"><AdvancesPage /></PrivateRoute>} />
        <Route path="/special-requests" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="special_requests"><SpecialRequestsPage /></PrivateRoute>} />
        <Route path="/employee-calendar" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="employee_calendar"><EmployeeCalendarPage /></PrivateRoute>} />
        <Route path="/live-tracking" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="live_tracking"><LiveTrackingPage /></PrivateRoute>} />
        <Route path="/master-report" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="master_report"><MasterReportPage /></PrivateRoute>} />
        <Route path="/settings" element={<PrivateRoute settings allowedRoles={['admin', 'superadmin']}><SettingsPage /></PrivateRoute>} />
        <Route path="/approval-chains" element={<PrivateRoute settings allowedRoles={['admin', 'superadmin']} featureKey="approval_chains"><ApprovalChainsPage /></PrivateRoute>} />
        <Route path="/org-structure" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="org_hierarchy"><OrgHierarchyPage /></PrivateRoute>} />
        <Route path="/punch-approvals" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="attendance"><PunchApprovalsPage /></PrivateRoute>} />
        <Route path="/regularize" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="regularize_attendance"><RegularizeAttendancePage /></PrivateRoute>} />
        <Route path="/wfh-requests" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="wfh_requests"><WFHRequestsPage /></PrivateRoute>} />
        <Route path="/verification-requests" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="profile_verification"><VerificationRequestsPage /></PrivateRoute>} />
        <Route path="/group-dashboard" element={<PrivateRoute payroll allowedRoles={['admin', 'superadmin']} featureKey="outlets_multi_branch"><GroupDashboardPage /></PrivateRoute>} />
        <Route path="/outlets" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="outlets_multi_branch"><OutletsOverviewPage /></PrivateRoute>} />
        <Route path="/outlets/combined" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="outlets_multi_branch"><CombinedOutletDashboardPage /></PrivateRoute>} />
        <Route path="/helpdesk" element={<PrivateRoute allowedRoles={['admin']} featureKey="helpdesk"><HelpdeskPage /></PrivateRoute>} />

        {/* Manager Routes */}
        <Route path="/manager-dashboard" element={<PrivateRoute allowedRoles={['manager']}><ManagerDashboardPage /></PrivateRoute>} />
        <Route path="/manager-employees" element={<PrivateRoute allowedRoles={['manager', 'hod', 'management']} featureKey="employees"><ManagerTeamPage /></PrivateRoute>} />
        <Route path="/manager-attendance" element={<PrivateRoute allowedRoles={['manager']} notForRaniwala="/manager-employees" featureKey="attendance"><AttendancePage /></PrivateRoute>} />
        <Route path="/manager-leaves" element={<PrivateRoute allowedRoles={['manager', 'hod', 'management']} featureKey="leave_requests"><LeavesPage /></PrivateRoute>} />
        <Route path="/manager-special-requests" element={<PrivateRoute allowedRoles={['manager', 'hod', 'management']} featureKey="special_requests"><SpecialRequestsPage /></PrivateRoute>} />
        <Route path="/manager-employee-calendar" element={<PrivateRoute allowedRoles={['manager']} notForRaniwala="/manager-employees" featureKey="employee_calendar"><EmployeeCalendarPage /></PrivateRoute>} />
        <Route path="/manager-punch-approvals" element={<PrivateRoute allowedRoles={['manager', 'hod', 'management']} featureKey="attendance"><PunchApprovalsPage /></PrivateRoute>} />
        <Route path="/manager-regularize" element={<PrivateRoute allowedRoles={['manager', 'hod', 'management']} featureKey="regularize_attendance"><RegularizeAttendancePage /></PrivateRoute>} />
        <Route path="/manager-wfh-requests" element={<PrivateRoute allowedRoles={['manager', 'hod', 'management']} featureKey="wfh_requests"><WFHRequestsPage /></PrivateRoute>} />
        <Route path="/manager-verification-requests" element={<PrivateRoute allowedRoles={['manager']} notForRaniwala="/manager-leaves" featureKey="profile_verification"><VerificationRequestsPage /></PrivateRoute>} />
        <Route path="/manager-payroll" element={<PrivateRoute allowedRoles={['manager']} notForRaniwala featureKey="run_payroll"><PayrollPage /></PrivateRoute>} />
        <Route path="/manager-payslips" element={<PrivateRoute allowedRoles={['manager']} notForRaniwala featureKey="payslips"><PayslipsPage /></PrivateRoute>} />
        <Route path="/manager-advances" element={<PrivateRoute allowedRoles={['manager']} notForRaniwala featureKey="advances_loans"><AdvancesPage /></PrivateRoute>} />
        <Route path="/manager-salary-additions" element={<PrivateRoute allowedRoles={['manager']} notForRaniwala featureKey="salary_additions"><SalaryAdditionsPage /></PrivateRoute>} />
        <Route path="/hr-settings" element={<PrivateRoute allowedRoles={['manager']} notForRaniwala><HrFeatureSettingsPage /></PrivateRoute>} />
        <Route path="/feature-settings" element={<PrivateRoute settings allowedRoles={['admin']}><HrFeatureSettingsPage /></PrivateRoute>} />

        {/* Superadmin specific */}
        <Route path="/master-dashboard" element={<PrivateRoute allowedRoles={['superadmin']}><MasterDashboardPage /></PrivateRoute>} />
        <Route path="/tenants" element={<PrivateRoute allowedRoles={['superadmin']}><TenantsPage /></PrivateRoute>} />
        <Route path="/toggle-services" element={<PrivateRoute allowedRoles={['superadmin']}><ToggleServicesPage /></PrivateRoute>} />
        <Route path="/platform-employees" element={<PrivateRoute allowedRoles={['superadmin']}><AllEmployeesPage /></PrivateRoute>} />
        <Route path="/helpdesk-admin" element={<PrivateRoute allowedRoles={['superadmin']}><HelpdeskAdminPage /></PrivateRoute>} />

        {/* Employee Routes */}
        <Route path="/home" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']}><HomePageTab /></PrivateRoute>} />
        <Route path="/me" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']}><MePage /></PrivateRoute>} />
        <Route path="/my-dashboard" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']}><EmployeeDashboard /></PrivateRoute>} />
        <Route path="/my-attendance" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']} featureKey="attendance"><MyAttendancePage /></PrivateRoute>} />
        <Route path="/my-leaves" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']} featureKey="leave_requests"><MyLeavesPage /></PrivateRoute>} />
        <Route path="/my-special-requests" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']} featureKey="special_requests"><MySpecialRequestsPage /></PrivateRoute>} />
        <Route path="/my-regularize" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']} featureKey="regularize_attendance"><MyRegularizeRequestsPage /></PrivateRoute>} />
        {/* L1 SPOC: the people HR put in this user's care (empty list for everyone else). */}
        <Route path="/l1-employees" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']}><L1EmployeesPage /></PrivateRoute>} />
        <Route path="/my-wfh" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']} featureKey="wfh_requests"><MyWfhRequestsPage /></PrivateRoute>} />
        <Route path="/my-payslips" element={<PrivateRoute payroll allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']} featureKey="payslips"><MyPayslipsPage /></PrivateRoute>} />
        <Route path="/my-tax-declaration" element={<PrivateRoute payroll allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']} featureKey="tax_declaration"><TaxDeclarationPage /></PrivateRoute>} />

        {/* Notifications: core, available to every role, never feature-gated */}
        <Route path="/notifications" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']}><NotificationsPage /></PrivateRoute>} />

        {/* Shared: Announcements & Policies (visible to everyone, create restricted to admin inside the page) */}
        <Route path="/announcements" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="announcements"><AnnouncementsPage /></PrivateRoute>} />
        <Route path="/policies" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="policies"><PoliciesPage /></PrivateRoute>} />
        <Route path="/grievances" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="grievances"><GrievancePage /></PrivateRoute>} />

        {/* Hiring: everyone can browse open positions and refer candidates; creating/editing postings is gated to admins inside the page (canManage) */}
        <Route path="/hiring" element={<PrivateRoute allowedRoles={['employee', 'manager', 'hod', 'management', 'admin', 'superadmin']} featureKey="hiring"><HiringPage /></PrivateRoute>} />
        {/* Shared: Refer (submit + track referrals for everyone, all-referrals oversight restricted to admin inside the page) */}
        <Route path="/refer" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="refer"><ReferPage /></PrivateRoute>} />
        <Route path="/headcount-requests" element={<PrivateRoute allowedRoles={['admin', 'manager', 'superadmin']} featureKey="headcount_requests"><HeadcountRequestsPage /></PrivateRoute>} />
        <Route path="/recruitment-pipeline" element={<PrivateRoute allowedRoles={['admin', 'manager', 'superadmin']} featureKey="recruitment_pipeline"><RecruitmentPipelinePage /></PrivateRoute>} />
        {/* Interviews: admin/manager schedule; any employee can be assigned as interviewer and needs "My Interviews" */}
        <Route path="/interviews" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="interviews"><InterviewsPage /></PrivateRoute>} />
        <Route path="/offer-letters" element={<PrivateRoute allowedRoles={['admin', 'manager', 'superadmin']} featureKey="offer_letters"><OfferLettersPage /></PrivateRoute>} />
        <Route path="/training" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="training"><TrainingPage /></PrivateRoute>} />
        <Route path="/my-training" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="training"><MyTrainingPage /></PrivateRoute>} />

        {/* Onboarding / Offboarding: admin manages checklists and processes; employees see and act on their own via My Onboarding / My Offboarding */}
        <Route path="/onboarding" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="onboarding"><OnboardingPage /></PrivateRoute>} />
        <Route path="/my-onboarding" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="onboarding"><MyOnboardingPage /></PrivateRoute>} />
        <Route path="/offboarding" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="offboarding"><OffboardingPage /></PrivateRoute>} />
        <Route path="/my-offboarding" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="offboarding"><MyOffboardingPage /></PrivateRoute>} />

        {/* Assets: admin manages inventory + assignments; employees see what's currently/previously assigned to them */}
        <Route path="/assets" element={<PrivateRoute allowedRoles={['admin', 'superadmin']} featureKey="assets"><AssetsPage /></PrivateRoute>} />
        <Route path="/my-assets" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="assets"><MyAssetsPage /></PrivateRoute>} />
        <Route path="/help" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']}><HelpPage /></PrivateRoute>} />
        <Route path="/meetings" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management']} featureKey="ai_meetings"><MeetingsPage /></PrivateRoute>} />
        {/* Old addresses of the task, project and performance screens (bookmarks, earlier notifications) */}
        <Route path="/tasks" element={<RedirectKeepingQuery to="/work/me" />} />
        <Route path="/projects" element={<Navigate to="/work" replace />} />
        <Route path="/my-projects" element={<Navigate to="/work" replace />} />
        <Route path="/performance/kras" element={<Navigate to="/performance" replace />} />
        <Route path="/performance/reviews" element={<Navigate to="/performance" replace />} />
        <Route path="/expense-claims" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="expense_claims"><ExpenseClaimsPage /></PrivateRoute>} />
        <Route path="/travel-requests" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="travel_requests"><TravelRequestsPage /></PrivateRoute>} />

        {/* Performance add-ons with their own pages (the goals, KPIs and reviews screen is under "Work, Messages, Performance" below) */}
        <Route path="/performance/feedback" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="performance_feedback"><FeedbackPage /></PrivateRoute>} />
        <Route path="/performance/pip" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="performance_pip"><PIPPage /></PrivateRoute>} />
        <Route path="/performance/one-on-ones" element={<PrivateRoute allowedRoles={['employee', 'admin', 'manager', 'hod', 'management', 'superadmin']} featureKey="performance_one_on_ones"><OneOnOnesPage /></PrivateRoute>} />
      </Route>

      {/* Work, Messages, Performance — the screens of the new CrewCore platform (src/crew). They sit in the
          same layout; CrewShell adds the header and the frame they need. Who sees and may do what is
          decided by the server (work_api / perf_api). */}
      <Route element={<DashboardLayout />}>
        <Route element={<PrivateRoute allowedRoles={WORK_ROLES} featureKey="tasks"><CrewShell title="Work" breadcrumb="Tasks, projects and the conversations around them" /></PrivateRoute>}>
          <Route path="/work" element={<WorkPage />} />
          <Route path="/work/me" element={<MyWorkPage />} />
          <Route path="/work/projects/:id" element={<ProjectPage />} />
        </Route>
        <Route element={<PrivateRoute allowedRoles={WORK_ROLES} featureKey="team_chat"><CrewShell title="Messages" breadcrumb="Channels, project chat and direct messages" fullBleed /></PrivateRoute>}>
          <Route path="/work/chat" element={<ChatPage />} />
        </Route>
        <Route element={<PrivateRoute allowedRoles={WORK_ROLES} featureKey="team_chat"><CrewShell title="Messages" breadcrumb="Where you were mentioned" /></PrivateRoute>}>
          <Route path="/work/mentions" element={<MentionsPage />} />
        </Route>
        <Route element={<PrivateRoute allowedRoles={WORK_ROLES} featureKey={['performance_kras', 'performance_reviews']}><CrewShell title="Performance" breadcrumb="Goals, KPIs, reviews and results" /></PrivateRoute>}>
          <Route path="/performance" element={<PerformancePage />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
