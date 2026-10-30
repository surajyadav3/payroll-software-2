import React from 'react';
import { useEffect, useState, useCallback, useMemo } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { fetchPayroll, processPayroll, processRaniwalaPayroll, revertPayroll, setPayrollReleased, fetchApprovedOvertimeForMonth, fetchPayrollGlEntries, buildBankFileRows } from '@/services/payrollService';
import { fetchPartRuns, savePartRun, deletePartRun, updatePartRunLines } from '@/services/payrollPartService';
import { listPayrollEmployees } from '@/services/employeeService';
import { listComponents } from '@/services/salaryService';
import { listActiveAdvances } from '@/services/advanceService';
import { fetchAllTenantAttendance, fetchTenantAttendanceInRange } from '@/services/attendanceService';
import { fmt, monthLabel, calcSalary, calcPfEsic, calcOtPay, calcPayableOvertimeHours, getInitials, getAvatarColor, getWeeklyOffDaysInMonth, getTenantWeeklyOffDays, calcWeeklyOffSettlement, computeLateDeductionDays, isFullPaidDayStatus, HIGH_SALARY_THRESHOLD, fullName, scopedToOutlet, currentFinancialYear, isRaniwalaTenant, raniwalaPayableOtHours, isWeeklyOffDate, calcRaniwalaOtPay, todayStr, dateStr } from '@/lib/helpers';
import { calendarPaidDays } from '@/lib/paidDays';
import { calcRaniwalaPay, probationEndDate, parseBreakdown, raniwalaSplitFor, monthEndDate, raniwalaPartPay, partSlipDetails, partFromLine, RANIWALA_SPLIT_MONTHS } from '@/lib/raniwalaPayroll';
import { fetchPayrollSettings } from '@/services/payrollSettingsService';
import RaniwalaPayrollSection from '@/components/payroll/RaniwalaPayrollSection';
import RaniwalaPayslip from '@/components/payroll/RaniwalaPayslip';
import RaniwalaSetupCheck, { raniwalaSetupGaps } from '@/components/payroll/RaniwalaSetupCheck';
import { listEsslCodes } from '@/services/esslService';
import { fetchApprovedCompOffLeavesForMonth, fetchApprovedLeavesForMonth, fetchLeaveSandwichDays } from '@/services/leaveService';
import { listLeaveTypes, fetchLeaveBalancesAsOf } from '@/services/leaveLedgerService';
import { fetchHolidaysInRange } from '@/services/holidayService';
import { settleWeeklyOffForMonth, fetchMonthlySettlements } from '@/services/compOffService';
import { fetchActiveTaxSlab, fetchDeclarationsForTenant } from '@/services/taxService';
import { fetchPendingSalaryAdditions } from '@/services/salaryAdditionsService';
import { withSalaries } from '@/services/employeeSalaryService';
import * as XLSX from 'xlsx';

// HR's PF ticks for a part not yet run — a convenience kept in this browser
// only, so a reload does not lose them. The run itself stores the ticks.
// Sandwich rule: days either side of the month loaded for a weekly off on the
// 1st or the last day — a weekly off plus a holiday or two (see calendarPaidDays).
const SANDWICH_EDGE_DAYS = 3;

const partPfKey = (tenantId, year, month, part) => `raniwala-part-pf:${tenantId}:${year}-${month + 1}:${part}`;
function loadPartPf(tenantId, year, month, part) {
  try { return JSON.parse(localStorage.getItem(partPfKey(tenantId, year, month, part)) || '{}') || {}; } catch { return {}; }
}
function savePartPf(tenantId, year, month, part, ticks) {
  try { localStorage.setItem(partPfKey(tenantId, year, month, part), JSON.stringify(ticks)); } catch { /* private window */ }
}

// HR's late deduction days typed on Run Payroll (Raniwala), kept in this
// browser until the run is processed — the payslip stores them then.
const lateDaysKey = (tenantId, year, month) => `raniwala-late-days:${tenantId}:${year}-${month + 1}`;
function loadLateDays(tenantId, year, month) {
  try { return JSON.parse(localStorage.getItem(lateDaysKey(tenantId, year, month)) || '{}') || {}; } catch { return {}; }
}
function saveLateDays(tenantId, year, month, days) {
  try { localStorage.setItem(lateDaysKey(tenantId, year, month), JSON.stringify(days)); } catch { /* private window */ }
}

function isCompliance(emp) {
  return !!(emp.pf_enabled || emp.esic_enabled);
}

export default function RunPayrollPage() {
  const { tenant, profile } = useAuth();
  const { outlets, outletProfileIds, ready: outletsReady } = useOutletView();
  const isManager = profile?.role === 'manager';
  const [payrollMonth, setPayrollMonth]                     = useState(new Date().getMonth());
  const [payrollYear,  setPayrollYear]                      = useState(new Date().getFullYear());
  const [employees,    setEmployees]                        = useState([]);
  const [components,   setComponents]                       = useState([]);
  const [advances,     setAdvances]                         = useState([]);
  const [processedCompliance,    setProcessedCompliance]    = useState(null);
  const [processedNonCompliance, setProcessedNonCompliance] = useState(null);
  const [workDayOverrides, setWorkDayOverrides]             = useState({});
  // Raniwala, month still running: days counted so far per employee (see calendarPaidDays).
  const [daysSoFar, setDaysSoFar]                           = useState(null);
  // Raniwala: days actually attended, Late marks, and HR's late deduction
  // days per employee (blank until HR types one — no automatic ladder).
  const [presentDays, setPresentDays]                       = useState({});
  const [lateCounts, setLateCounts]                         = useState({});
  const [lateDays, setLateDays]                             = useState({});
  const [overtimeRequests, setOvertimeRequests]             = useState([]);
  const [loading,             setLoading]             = useState(true);
  const [processingComp,      setProcessingComp]      = useState(false);
  const [processingNonComp,   setProcessingNonComp]   = useState(false);
  const [detailSlip,   setDetailSlip]   = useState(null);
  const [detailLeave,  setDetailLeave]  = useState(null);
  const [attendanceRaw, setAttendanceRaw] = useState([]);
  const [compOffLeaves, setCompOffLeaves] = useState({});
  const [settlements,   setSettlements]   = useState([]);
  const [taxSlab,       setTaxSlab]       = useState(null);
  const [declarationsByProfile, setDeclarationsByProfile] = useState({});
  const [pendingAdditions, setPendingAdditions] = useState([]);
  const [lastWithheld,  setLastWithheld]  = useState([]);
  const [payrollSettings, setPayrollSettings] = useState({});
  // A month HR pays in two runs (Raniwala, Sept 2026): the stored part runs,
  // each part's paid days, and HR's PF ticks per part — { [part]: { [id]: … } }.
  const [partRuns, setPartRuns]                 = useState({});
  const [partDayOverrides, setPartDayOverrides] = useState({});
  const [partPf, setPartPf]                     = useState({});
  // PF ticks changed on a part that is already run, not saved yet.
  const [partPfEdits, setPartPfEdits]           = useState({});
  const [partBusy, setPartBusy]                 = useState(false);
  const raniwala = isRaniwalaTenant(tenant);
  const split = useMemo(() => (raniwala ? raniwalaSplitFor(payrollYear, payrollMonth) : null), [raniwala, payrollYear, payrollMonth]);

  // Total working days = actual calendar days in the selected payroll month
  // (28-31), not a fixed configured number, so a full-attendance employee
  // always gets their full CTC regardless of how long the month is.
  const workDays          = new Date(payrollYear, payrollMonth + 1, 0).getDate();
  const complianceEmps    = employees.filter(isCompliance);
  // Whoever's last day falls in this month (left, or leaving): Raniwala shows
  // them in their own table so HR can check what they are paid for.
  const monthEndStr       = dateStr(new Date(payrollYear, payrollMonth + 1, 0));
  const leaversInMonth    = useMemo(() => Object.fromEntries(
    employees.filter((e) => e.exit_date && e.exit_date <= monthEndStr).map((e) => [e.id, e]),
  ), [employees, monthEndStr]);
  const nonComplianceEmps = employees.filter(e => !isCompliance(e));

  const fetchData = useCallback(async () => {
    // Raniwala's paid days need each employee's outlet (weekly off, holidays).
    if (!tenant || !outletsReady) return;
    setLoading(true);
    try {
      const none = Promise.resolve({ data: [] });
      const monthKey = `${payrollYear}-${String(payrollMonth + 1).padStart(2, '0')}`;
      const splitParts = raniwala ? raniwalaSplitFor(payrollYear, payrollMonth) : null;
      const sandwich = raniwala && !!tenant.sandwich_rule_enabled;
      const edge = sandwich ? SANDWICH_EDGE_DAYS : 0;
      const today = todayStr();
      const edgeBefore = [dateStr(new Date(payrollYear, payrollMonth, 1 - edge)), dateStr(new Date(payrollYear, payrollMonth, 0))];
      const edgeAfter = [dateStr(new Date(payrollYear, payrollMonth + 1, 1)), dateStr(new Date(payrollYear, payrollMonth + 1, edge))];
      const [empsRes, compsRes, advsRes, payCompRes, payNonCompRes, attRes, otRes, compOffRes, settleRes, taxSlabRes, declRes, additionsRes, holidaysRes, leavesRes, leaveTypesRes, settingsRes, partRunsRes, edgeBeforeRes, edgeAfterRes, sandwichRes] = await Promise.all([
        listPayrollEmployees(tenant.id, `${monthKey}-01`).then((res) => withSalaries(tenant, res)),
        listComponents(tenant.id),
        listActiveAdvances(tenant.id),
        fetchPayroll(tenant.id, payrollMonth, payrollYear, 'Compliance'),
        fetchPayroll(tenant.id, payrollMonth, payrollYear, 'Non-Compliance'),
        fetchAllTenantAttendance(tenant.id, payrollYear, payrollMonth),
        fetchApprovedOvertimeForMonth(tenant.id, payrollMonth, payrollYear),
        fetchApprovedCompOffLeavesForMonth(tenant.id, payrollMonth, payrollYear),
        fetchMonthlySettlements(tenant.id, payrollMonth, payrollYear),
        fetchActiveTaxSlab(tenant.id, currentFinancialYear(new Date(payrollYear, payrollMonth))),
        fetchDeclarationsForTenant(tenant.id, currentFinancialYear(new Date(payrollYear, payrollMonth))),
        fetchPendingSalaryAdditions(tenant.id, payrollMonth + 1, payrollYear),
        raniwala ? fetchHolidaysInRange(tenant.id, dateStr(new Date(payrollYear, payrollMonth, 1 - edge)), dateStr(new Date(payrollYear, payrollMonth + 1, edge))) : none,
        raniwala ? fetchApprovedLeavesForMonth(tenant.id, payrollMonth, payrollYear, edge) : none,
        raniwala ? listLeaveTypes(tenant.id) : none,
        raniwala ? fetchPayrollSettings(tenant.id) : none,
        splitParts ? fetchPartRuns(tenant.id, payrollMonth, payrollYear) : none,
        sandwich ? fetchTenantAttendanceInRange(tenant.id, ...edgeBefore) : none,
        sandwich && edgeAfter[0] < today ? fetchTenantAttendanceInRange(tenant.id, ...edgeAfter) : none,
        sandwich ? fetchLeaveSandwichDays(tenant.id, payrollMonth, payrollYear) : none,
      ]);
      const emps = scopedToOutlet(empsRes.data, outletProfileIds, 'id');
      setEmployees(emps);
      setComponents(compsRes.data);
      setAdvances(scopedToOutlet(advsRes.data, outletProfileIds));
      setProcessedCompliance(payCompRes.data);
      setProcessedNonCompliance(payNonCompRes.data);
      setOvertimeRequests(scopedToOutlet(otRes.data || [], outletProfileIds));
      setCompOffLeaves(compOffRes.data || {});
      setSettlements(scopedToOutlet(settleRes.data || [], outletProfileIds));
      setTaxSlab(taxSlabRes.data || null);
      setDeclarationsByProfile(declRes.data || {});
      setPendingAdditions(scopedToOutlet(additionsRes.data || [], outletProfileIds));
      setPayrollSettings(raniwala ? settingsRes.data || {} : {});
      setPartRuns(splitParts ? partRunsRes.data || {} : {});
      setPartPfEdits({});
      if (partRunsRes.error) showToast('Could not load the part runs: ' + partRunsRes.error.message, 'error');
      setPartPf(splitParts ? Object.fromEntries(splitParts.map((p) => [p.part, loadPartPf(tenant.id, payrollYear, payrollMonth, p.part)])) : {});

      // Paid days come from these rows: a partial load would quietly underpay.
      if (attRes.error || edgeBeforeRes.error || edgeAfterRes.error) showToast('Attendance did not load completely — reload the page before processing payroll', 'error');
      if (leavesRes.error || sandwichRes.error) showToast('Approved leaves did not load — reload the page before processing payroll', 'error');
      const attendance = scopedToOutlet(attRes.data || [], outletProfileIds);
      setAttendanceRaw(attendance);
      const overrides  = {};
      const outletById = Object.fromEntries(outlets.map(o => [o.id, o]));
      const unpaidLeaveTypes = (leaveTypesRes.data || []).filter(t => t.is_paid === false).map(t => t.name);
      const running = raniwala && today.slice(0, 7) === monthKey;
      const counted = {};
      const present = {};
      const lates = {};
      const partOverrides = Object.fromEntries((splitParts || []).map((p) => [p.part, {}]));
      // The days just outside the month: only read by the sandwich rule.
      const edgeAtt = [...(edgeBeforeRes.data || []), ...(edgeAfterRes.data || [])];
      emps.forEach(emp => {
        const empAtt = attendance.filter(a => a.profile_id === emp.id);
        const joinDate = emp.join_date ? new Date(emp.join_date) : null;
        const monthEnd = new Date(payrollYear, payrollMonth + 1, 0);
        if (joinDate && joinDate > monthEnd) {
          overrides[emp.id] = 0;
          (splitParts || []).forEach((p) => { partOverrides[p.part][emp.id] = 0; });
          return;
        }
        // Offboarding (20261024_4): no day after the exit date is paid.
        const exitInMonth = !!emp.exit_date && emp.exit_date < dateStr(new Date(payrollYear, payrollMonth + 1, 1));
        if (exitInMonth && !raniwala && empAtt.length === 0) {
          overrides[emp.id] = Number(emp.exit_date.slice(8, 10));
          return;
        }
        // No attendance rows at all for this employee this month means
        // attendance simply hasn't been tracked/marked yet — pay their full
        // base salary rather than zeroing it out. Leaving the override unset
        // here lets the `?? workDays` / `!== undefined ? ... : workDays`
        // fallbacks (below, and in processPayroll) apply the full month.
        // While Raniwala's month is still running, everyone is shown as of
        // today — no punches so far means only the paid offs so far.
        // Raniwala still pays no day before joining (the Setup check lists them).
        if (empAtt.length === 0 && !running && !exitInMonth) {
          if (raniwala && emp.join_date && emp.join_date > `${monthKey}-01`) {
            overrides[emp.id] = monthEnd.getDate() - Number(emp.join_date.slice(8, 10)) + 1;
          }
          return;
        }
        // Raniwala pays the calendar month: weekly offs, outlet holidays and
        // paid leave count, only unpaid days come off (see calendarPaidDays).
        if (raniwala) {
          const paidDaysArgs = {
            year: payrollYear, month: payrollMonth, emp, tenant, outlet: outletById[emp.outlet_id],
            attByDate: Object.fromEntries([...edgeAtt.filter(a => a.profile_id === emp.id), ...empAtt].map(a => [a.date, a])),
            holidays: holidaysRes.data || [],
            leaves: (leavesRes.data || []).filter(l => l.profile_id === emp.id),
            unpaidLeaveTypes, today,
            sandwichDays: (sandwichRes.data || []).filter(s => s.profile_id === emp.id),
            edgeDays: edge,
          };
          const r = calendarPaidDays(paidDaysArgs);
          // Only HR's late deduction comes off these (calcRaniwalaPay), never
          // the tenant's late ladder (HR, 30 Oct 2026).
          overrides[emp.id] = splitParts ? r.paidDays : r.paidBeforeLate;
          counted[emp.id] = r.daysCounted;
          present[emp.id] = r.presentDays;
          lates[emp.id] = r.lateCount;
          // Two-run month: the same rules, on each part's own dates.
          (splitParts || []).forEach((p) => {
            partOverrides[p.part][emp.id] = calendarPaidDays({ ...paidDaysArgs, fromDay: p.fromDay, toDay: p.toDay }).paidDays;
          });
          return;
        }
        let days = 0;
        let lateCount = 0;
        empAtt.forEach(a => {
          if (exitInMonth && a.date > emp.exit_date) return;
          if (isFullPaidDayStatus(a.status)) days += 1;
          else if (a.status === 'Half Day') days += 0.5;
          if (a.status === 'Late') lateCount += 1;
        });
        // Late-arrival-count deduction ladder, on top of the day-level tally
        // above — opt-in per tenant (see computeLateDeductionDays).
        days = Math.max(0, days - computeLateDeductionDays(lateCount, tenant));
        overrides[emp.id] = days;
      });
      setWorkDayOverrides(overrides);
      setPartDayOverrides(partOverrides);
      setDaysSoFar(running ? counted : null);
      setPresentDays(present);
      setLateCounts(lates);
      setLateDays(raniwala && !splitParts ? loadLateDays(tenant.id, payrollYear, payrollMonth) : {});
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [tenant, raniwala, payrollMonth, payrollYear, outletProfileIds, outlets, outletsReady]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // A Raniwala slip shows the leave balance on the month's last day.
  useEffect(() => {
    setDetailLeave(null);
    if (!detailSlip || !parseBreakdown(detailSlip).raniwala) return;
    fetchLeaveBalancesAsOf(tenant.id, monthEndDate(payrollYear, payrollMonth), [detailSlip.profile_id])
      .then(({ data }) => setDetailLeave(data[detailSlip.profile_id] || null));
  }, [detailSlip, tenant?.id, payrollYear, payrollMonth]);

  // Raniwala's details modal adds arrears and advances while HR is still
  // working on the run. These reload just that list — a full fetchData would
  // throw away the paid days HR has typed in.
  const reloadAdditions = async () => {
    const { data } = await fetchPendingSalaryAdditions(tenant.id, payrollMonth + 1, payrollYear);
    setPendingAdditions(scopedToOutlet(data || [], outletProfileIds));
  };
  const reloadAdvances = async () => {
    const { data } = await listActiveAdvances(tenant.id);
    setAdvances(scopedToOutlet(data, outletProfileIds));
  };

  // Raniwala: every employee's pay for the month by the salary structure
  // rules (lib/raniwalaPayroll.js). The table shows these rows and Process
  // Payroll stores exactly them.
  const attByProfile = useMemo(() => {
    const by = {};
    attendanceRaw.forEach((a) => { (by[a.profile_id] ||= []).push(a); });
    return by;
  }, [attendanceRaw]);

  // Each employee's weekly off is their outlet's (Delhi: Monday) — OT counts
  // every hour worked on it.
  const outletById = useMemo(() => Object.fromEntries(outlets.map((o) => [o.id, o])), [outlets]);

  // Two-run month: each part's line per employee — read from the stored run
  // once the part is run, else worked out live from the part's paid days,
  // overtime and HR's PF tick. Part 2's PF tick starts as part 1's.
  const partRows = useMemo(() => {
    if (!split) return {};
    const storedById = Object.fromEntries(split.map((p) => [
      p.part, Object.fromEntries((partRuns[p.part]?.lines || []).map((l) => [l.profileId, l])),
    ]));
    return Object.fromEntries(split.map((p) => {
      const run = partRuns[p.part];
      const rows = employees.map((emp) => {
        const settings = payrollSettings[emp.id] || null;
        const gross = emp.ctc || 0;
        if (run) {
          // Someone added after the part was run has nothing in it.
          const stored = storedById[p.part][emp.id];
          if (!stored) {
            return { emp, settings, stored: false, line: { ...raniwalaPartPay({ gross, paidDays: 0, monthDays: workDays, pfOn: false, pfRule: p.pfRule }), part: p.part, label: p.label } };
          }
          // HR changed the PF tick after the run: the same days and gross,
          // worked out again with the new tick (sheet amounts kept).
          const edit = partPfEdits[p.part]?.[emp.id];
          if (edit !== undefined && edit !== (stored.pfOn !== false)) {
            const redone = raniwalaPartPay({
              gross: Number(stored.gross) || 0, paidDays: Number(stored.paidDays) || 0, monthDays: workDays, pfOn: edit,
              pfRule: p.pfRule, otPay: Number(stored.overtime) || 0, otHours: Number(stored.overtimeHours) || 0,
            });
            return { emp, settings, stored: true, edited: true, line: { ...redone, part: p.part, label: p.label, sheet: stored.sheet || null } };
          }
          return { emp, settings, stored: true, line: partFromLine(stored, p) };
        }
        const otHours = emp.overtime_applicable
          ? (attByProfile[emp.id] || []).filter((a) => a.date >= p.fromDate && a.date <= p.toDate)
            .reduce((sum, a) => sum + raniwalaPayableOtHours(a.total_hours, isWeeklyOffDate(a.date, tenant, outletById[emp.outlet_id], emp)), 0)
          : 0;
        const pfDefault = storedById[p.part - 1]?.[emp.id]?.pfOn ?? (settings?.pf_applicable !== false);
        const pfOn = partPf[p.part]?.[emp.id] ?? pfDefault;
        const line = raniwalaPartPay({
          gross, monthDays: workDays, pfRule: p.pfRule, pfOn, actualGross: emp.actual_gross || 0,
          paidDays: partDayOverrides[p.part]?.[emp.id] ?? p.days,
          // OT is an hour of normal pay: the actual gross where one is set.
          otHours, otPay: calcRaniwalaOtPay(emp.actual_gross || gross, workDays, otHours),
        });
        return { emp, settings, stored: false, line: { ...line, part: p.part, label: p.label } };
      });
      return [p.part, rows];
    }));
  }, [split, partRuns, employees, payrollSettings, attByProfile, partPf, partPfEdits, partDayOverrides, workDays, tenant, outletById]);

  const raniwalaRows = useMemo(() => {
    if (!raniwala) return [];
    const partLineById = split
      ? split.map((p) => Object.fromEntries((partRows[p.part] || []).map((r) => [r.emp.id, r.line])))
      : null;
    // Two-run month with a part already run: the final payroll is for the
    // people in the runs (a run filled from HR's sheet covers only its staff),
    // on the gross the latest part was run with.
    const storedParts = split ? split.map((p) => new Set((partRows[p.part] || []).filter((r) => r.stored).map((r) => r.emp.id))) : [];
    const anyRun = storedParts.some((ids) => ids.size > 0);
    const inRuns = (id) => storedParts.some((ids) => ids.has(id));
    const runGross = (id) => {
      for (let i = storedParts.length - 1; i >= 0; i--) if (storedParts[i].has(id)) return partLineById[i][id].gross;
      return null;
    };
    return employees.filter((emp) => !anyRun || inRuns(emp.id)).map((emp) => {
      const settings = payrollSettings[emp.id] || null;
      // Opt-in per employee ("Apply overtime"), each day slabbed on its own —
      // see raniwalaPayableOtHours. On their weekly off every hour counts.
      const otHours = emp.overtime_applicable
        ? (attByProfile[emp.id] || []).reduce((sum, a) => sum + raniwalaPayableOtHours(a.total_hours, isWeeklyOffDate(a.date, tenant, outletById[emp.outlet_id], emp)), 0)
        : 0;
      const inputs = {
        gross: (anyRun ? runGross(emp.id) : null) ?? (emp.ctc || 0),
        paidDays: workDayOverrides[emp.id] ?? workDays,
        monthDays: workDays,
        year: payrollYear,
        month: payrollMonth,
        otHours,
        otPay: calcRaniwalaOtPay(emp.actual_gross || emp.ctc || 0, workDays, otHours),
        actualGross: emp.actual_gross || 0,
        additions: pendingAdditions.filter((a) => a.profile_id === emp.id),
        advances: advances.filter((a) => a.profile_id === emp.id),
        lateDays: lateDays[emp.id] || 0,
        presentDays: presentDays[emp.id] ?? null,
      };
      // Two-run month: the final slip is the two parts added up.
      if (partLineById) inputs.parts = partLineById.map((byId) => byId[emp.id]);
      return { emp, settings, inputs, pay: calcRaniwalaPay({ ...inputs, settings, probationEnd: probationEndDate(emp, settings) }) };
    });
  }, [raniwala, split, partRows, employees, payrollSettings, attByProfile, workDayOverrides, workDays, payrollYear, payrollMonth, pendingAdditions, advances, tenant, outletById, lateDays, presentDays]);

  // Raniwala: machine codes for the Setup check's "punching with no employee".
  const [esslCodes, setEsslCodes] = useState(null);
  useEffect(() => {
    if (!raniwala || isManager || !tenant?.id) return;
    listEsslCodes(tenant.id).then(({ data, error }) => setEsslCodes(error ? null : data));
  }, [raniwala, isManager, tenant?.id]);
  const setupGaps = useMemo(() => (raniwala && !isManager ? raniwalaSetupGaps({
    employees, attendance: attendanceRaw, esslCodes, today: todayStr(),
    monthStart: dateStr(new Date(payrollYear, payrollMonth, 1)), monthEnd: monthEndStr,
  }) : []), [raniwala, isManager, employees, attendanceRaw, esslCodes, payrollYear, payrollMonth, monthEndStr]);

  const changeLateDays = (id, days) => {
    setLateDays((prev) => {
      const next = { ...prev, [id]: days };
      saveLateDays(tenant.id, payrollYear, payrollMonth, next);
      return next;
    });
  };

  const togglePartPf = (part, ids, on) => {
    // A part already run: the change waits for "Save PF changes".
    if (partRuns[part]) {
      setPartPfEdits((prev) => ({ ...prev, [part]: { ...(prev[part] || {}), ...Object.fromEntries(ids.map((id) => [id, on])) } }));
      return;
    }
    setPartPf((prev) => {
      const next = { ...prev, [part]: { ...(prev[part] || {}), ...Object.fromEntries(ids.map((id) => [id, on])) } };
      savePartPf(tenant.id, payrollYear, payrollMonth, part, next[part]);
      return next;
    });
  };

  const runPart = async (p) => {
    const rows = partRows[p.part] || [];
    if (!rows.length) return showToast('No employees to run', 'error');
    const noGross = rows.filter((r) => (r.emp.ctc || 0) <= 1).length;
    const pfCount = rows.filter((r) => r.line.pfOn).length;
    if (!confirm(`Run part ${p.part} (${p.label}, ${p.rule.label}) for ${rows.length} employees? PF is ticked for ${pfCount}.`
      + (noGross ? ` ${noGross} have no gross salary set (₹0 or ₹1).` : '')
      + '\n\nThe figures are frozen until you undo the run. Nothing is shown to employees.')) return;
    setPartBusy(true);
    const lines = rows.map((r) => ({ profileId: r.emp.id, empCode: r.emp.employee_id || '', name: fullName(r.emp), ...partSlipDetails(r.line) }));
    const { error } = await savePartRun({ tenantId: tenant.id, month: payrollMonth, year: payrollYear, part: p, lines, runBy: profile.id });
    if (error) {
      setPartBusy(false);
      return showToast('Could not run the part: ' + error.message, 'error');
    }
    const { data } = await fetchPartRuns(tenant.id, payrollMonth, payrollYear);
    setPartRuns(data || {});
    setPartBusy(false);
    showToast(`Part ${p.part} (${p.label}) run`, 'success');
  };

  const pendingPf = (part) => (partRows[part] || []).filter((r) => r.edited).length;

  const savePartPfChanges = async (p) => {
    const run = partRuns[p.part];
    const edited = Object.fromEntries((partRows[p.part] || []).filter((r) => r.edited).map((r) => [r.emp.id, r.line]));
    const n = Object.keys(edited).length;
    if (!run || !n) return;
    if (!confirm(`Save PF changes for ${n} employee(s) in part ${p.part} (${p.label})? Their PF and pay for this part are worked out again.`)) return;
    setPartBusy(true);
    const lines = run.lines.map((l) => (edited[l.profileId] ? { ...l, ...partSlipDetails(edited[l.profileId]) } : l));
    const { data, error } = await updatePartRunLines(run.id, lines);
    setPartBusy(false);
    if (error) return showToast('Could not save: ' + error.message, 'error');
    setPartRuns((prev) => ({ ...prev, [p.part]: data }));
    setPartPfEdits((prev) => ({ ...prev, [p.part]: {} }));
    showToast(`PF saved for ${n} employee(s) in part ${p.part}`, 'success');
  };

  const discardPartPfChanges = (p) => setPartPfEdits((prev) => ({ ...prev, [p.part]: {} }));

  const undoPart = async (p) => {
    const run = partRuns[p.part];
    if (!run || !confirm(`Undo part ${p.part} (${p.label})? Its figures are worked out again from attendance and you can run it again.`)) return;
    setPartBusy(true);
    const { error } = await deletePartRun(run.id);
    setPartBusy(false);
    if (error) return showToast('Could not undo: ' + error.message, 'error');
    setPartRuns((prev) => { const next = { ...prev }; delete next[p.part]; return next; });
    showToast(`Part ${p.part} undone`, 'warning');
  };

  const toggleRelease = async (released) => {
    const run = processedCompliance;
    if (!run) return;
    if (!confirm(released
      ? `Release ${monthLabel(payrollMonth, payrollYear)} payslips to employees? Every employee in this run can then see their payslip on the website and the app.`
      : 'Hold these payslips again? Employees stop seeing them until you release them.')) return;
    const { data, error } = await setPayrollReleased(run.id, released, profile.id);
    if (error) return showToast('Could not change it: ' + error.message, 'error');
    setProcessedCompliance((prev) => ({ ...prev, released_at: data.released_at }));
    showToast(released ? 'Payslips released to employees' : 'Payslips held — employees cannot see them', released ? 'success' : 'warning');
  };

  const changeMonth = (delta) => {
    let m = payrollMonth + delta;
    let y = payrollYear;
    if (m > 11) { m = 0; y++; }
    if (m < 0)  { m = 11; y--; }
    setPayrollMonth(m);
    setPayrollYear(y);
  };

  const handleProcess = async (group) => {
    // Raniwala has one run for everyone; PF/ESIC follow the salary rules.
    const emps = raniwala ? employees : group === 'Compliance' ? complianceEmps : nonComplianceEmps;
    if (emps.length === 0) return showToast('No employees in this group to process', 'error');
    if (!raniwala && components.length === 0) return showToast('Configure salary components first', 'error');
    if (raniwala) {
      const notRun = (split || []).filter((p) => !partRuns[p.part]);
      if (notRun.length) return showToast(`Run ${notRun.map((p) => `part ${p.part} (${p.label})`).join(' and ')} first — the final payslip adds both parts`, 'error');
      const unsaved = (split || []).filter((p) => pendingPf(p.part) > 0);
      if (unsaved.length) return showToast(`Save or discard the PF changes in ${unsaved.map((p) => `part ${p.part}`).join(' and ')} first`, 'error');
      const payable = raniwalaRows.filter((r) => !r.emp.is_withheld);
      const negative = payable.find((r) => r.pay.netPay < 0);
      if (negative) return showToast(`Deductions are more than the pay for ${fullName(negative.emp)} — correct that first`, 'error');
      const noGross = payable.filter((r) => (r.pay.structure.gross || 0) <= 1).length;
      if (noGross && !confirm(`${noGross} employee(s) have no gross salary set (₹0 or ₹1) and will get a payslip for that amount. Process anyway?`)) return;
      const changedGross = (split || []).flatMap((p) => partRows[p.part] || [])
        .filter((r) => r.stored && !r.line.sheet && !r.emp.is_withheld && r.line.gross !== (r.emp.ctc || 0));
      const changed = new Set(changedGross.map((r) => r.emp.id)).size;
      if (changed && !confirm(`${changed} employee(s) have a different gross salary now than when the parts were run. The final payslip uses the parts as they were run. Process anyway?`)) return;
      if (daysSoFar && !confirm(`${monthLabel(payrollMonth, payrollYear)} is not over yet — paid days count only up to today, so these payslips would pay part of the month. Process anyway?`)) return;
    }
    const setProc = group === 'Compliance' ? setProcessingComp : setProcessingNonComp;
    setProc(true);
    try {
      // Shift duration in hours
      const shiftHrs = (() => {
        if (!tenant?.shift_start || !tenant?.shift_end) return 8;
        const [sh, sm] = tenant.shift_start.split(':').map(Number);
        const [eh, em] = tenant.shift_end.split(':').map(Number);
        let from = sh * 60 + sm, to = eh * 60 + em;
        if (to <= from) to += 1440;
        return (to - from) / 60;
      })();

      // Auto-calculate overtime from attendance for employees below the salary threshold.
      // For each day where total_hours > shift_hours, accumulate the extra minutes
      // then convert to payable rounded hours. (Raniwala's own slabs are already
      // in raniwalaRows.)
      const autoOtRequests = [];
      if (!raniwala) emps.forEach(emp => {
        // Opt-in per employee ("Apply overtime" on the employee form).
        if (!emp.overtime_applicable) return;
        if ((emp.ctc || 0) >= HIGH_SALARY_THRESHOLD) return;
        const empAtt = attendanceRaw.filter(a => a.profile_id === emp.id);
        let totalOtMinutes = 0;
        empAtt.forEach(a => {
          if ((a.status === 'Present' || a.status === 'Late') && Number(a.total_hours) > shiftHrs) {
            totalOtMinutes += Math.round((Number(a.total_hours) - shiftHrs) * 60);
          }
        });
        const payableHours = calcPayableOvertimeHours(totalOtMinutes);
        if (payableHours > 0) {
          autoOtRequests.push({
            profile_id:     emp.id,
            overtime_hours: payableHours,
            overtime_pay:   calcOtPay(emp.ctc || 0, shiftHrs, payableHours),
          });
        }
      });

      const { withheld } = raniwala
        ? await processRaniwalaPayroll({ tenantId: tenant.id, month: payrollMonth, year: payrollYear, rows: raniwalaRows })
        : await processPayroll({
          tenantId:         tenant.id,
          month:            payrollMonth,
          year:             payrollYear,
          countryGroup:     group,
          employees:        emps,
          components,
          advances,
          workDays,
          workDayOverrides,
          overtimeRequests: autoOtRequests,
          shiftHours:       shiftHrs,
          taxSlab,
          declarationsByProfile,
          salaryAdditions:  pendingAdditions,
          pfSettings:       { wageCeiling: tenant?.pf_wage_ceiling, rate: tenant?.pf_employee_rate },
        });
      setLastWithheld(withheld || []);

      // Run comp off settlement for high-salary employees in this group.
      // Skipped entirely when the tenant has the real-time per-instance
      // comp-off grant on (attendanceService.js clockIn / essl-punch) — that
      // mechanism already credits every worked weekly-off as it happens, so
      // running this month-end settlement too would double-credit.
      if (!tenant?.auto_comp_off_on_weekly_off_worked) {
        const outletById = Object.fromEntries(outlets.map(o => [o.id, o]));
        const highSalEmps = emps.filter(e => (e.ctc || 0) >= HIGH_SALARY_THRESHOLD);
        if (highSalEmps.length > 0) {
          const settlementInput = highSalEmps.map(emp => {
            // Each employee's own outlet may override the tenant-wide weekly
            // off days (e.g. Raniwala's Delhi outlet is off Monday while
            // Office/Factory are off Sunday) — resolve per employee rather
            // than once for the whole tenant.
            const weeklyOffDays = getTenantWeeklyOffDays(tenant, outletById[emp.outlet_id], emp);
            const woDays        = getWeeklyOffDaysInMonth(payrollYear, payrollMonth, weeklyOffDays);
            const empAtt     = attendanceRaw.filter(a => a.profile_id === emp.id);
            // 'Comp Off' is excluded here on purpose — that status means the
            // employee is spending an already-earned comp-off, not earning a
            // new one by working the day.
            const workedWOs  = woDays.filter(d =>
              empAtt.some(a => a.date === d && ['Present', 'Late', 'Travel', 'Show Visit'].includes(a.status))
            ).length;
            const compLeavesUsed = compOffLeaves[emp.id] || 0;
            return {
              profileId: emp.id,
              totalWOs:  woDays.length,
              workedWOs,
              compLeavesUsed,
              settlement: calcWeeklyOffSettlement(workedWOs, woDays.length, compLeavesUsed),
            };
          }).filter(s => s.totalWOs > 0);
          if (settlementInput.length > 0) {
            await settleWeeklyOffForMonth(tenant.id, payrollMonth, payrollYear, settlementInput);
          }
        }
      }

      const withheldNote = withheld?.length ? ` — ${withheld.length} employee${withheld.length > 1 ? 's' : ''} skipped (withheld)` : '';
      showToast(`${raniwala ? 'Payroll' : group + ' payroll'} processed for ${monthLabel(payrollMonth, payrollYear)}${withheldNote}`, 'success');
      fetchData();
    } catch (err) {
      showToast('Processing failed: ' + err.message, 'error');
    } finally {
      setProc(false);
    }
  };

  const handleRevert = async (group) => {
    const processed = group === 'Compliance' ? processedCompliance : processedNonCompliance;
    if (!processed || !confirm(raniwala
      ? 'Revert this payroll? All its payslips are deleted, advance balances go back and arrears become due again.'
      : `Revert ${group} payroll? All payslips for this group will be deleted.`)) return;
    try {
      await revertPayroll(processed.id);
      showToast('Payroll reverted', 'warning');
      fetchData();
    } catch (err) {
      showToast('Revert failed: ' + err.message, 'error');
    }
  };

  const exportCSV = (group) => {
    const processed = group === 'Compliance' ? processedCompliance : processedNonCompliance;
    if (!processed?.payslips?.length) return showToast('Process payroll first', 'warning');
    let csv = 'Employee,Department,Working Days,Gross Earnings,Deductions,Advance Ded.,Net Salary\n';
    processed.payslips.forEach((p) => {
      csv += `"${p.emp_name}",${p.department},${p.work_days},${p.gross_earnings},${p.total_deductions},${p.advance_deduction},${p.net_pay}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `payroll_${group.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${payrollYear}-${String(payrollMonth + 1).padStart(2, '0')}.csv`;
    a.click();
    showToast('CSV exported', 'success');
  };

  /** GL journal export — department-level debit/credit rows posted by process_payroll_by_country. */
  const exportGL = async (group) => {
    const processed = group === 'Compliance' ? processedCompliance : processedNonCompliance;
    if (!processed) return showToast('Process payroll first', 'warning');
    const { data, error } = await fetchPayrollGlEntries(processed.id);
    if (error) return showToast('Failed to load GL entries: ' + error.message, 'error');
    if (!data.length) return showToast('No GL entries for this run', 'warning');
    const ws = XLSX.utils.json_to_sheet(data.map((r) => ({
      Department: r.department, Side: r.entry_side, Account: r.account_name, Amount: r.amount,
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'GL Journal');
    XLSX.writeFile(wb, `payroll_gl_${group.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${payrollYear}-${String(payrollMonth + 1).padStart(2, '0')}.xlsx`);
    showToast('GL journal exported', 'success');
  };

  /** Generic NEFT/RTGS-style bank payout file — adjust columns to your bank's exact bulk-upload layout before real use. */
  const exportBankFile = (group) => {
    const processed = group === 'Compliance' ? processedCompliance : processedNonCompliance;
    if (!processed?.payslips?.length) return showToast('Process payroll first', 'warning');
    const employeesById = Object.fromEntries(employees.map((e) => [e.id, e]));
    const rows = buildBankFileRows(processed.payslips, employeesById, `Salary ${monthLabel(payrollMonth, payrollYear)}`);
    const missing = rows.filter((r) => !r['Account Number']).length;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Bank Payout');
    XLSX.writeFile(wb, `payroll_bankfile_${group.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${payrollYear}-${String(payrollMonth + 1).padStart(2, '0')}.xlsx`);
    showToast(missing ? `Bank file exported — ${missing} employee(s) missing an account number` : 'Bank file exported', missing ? 'warning' : 'success');
  };

  return (
    <>
      <Header title="Run Payroll" breadcrumb={monthLabel(payrollMonth, payrollYear)} />
      <div className="page-content">

        <div className="filter-bar">
          <div className="month-selector">
            <button onClick={() => changeMonth(-1)}><i className="fas fa-chevron-left" /></button>
            <span>{monthLabel(payrollMonth, payrollYear)}</span>
            <button onClick={() => changeMonth(1)}><i className="fas fa-chevron-right" /></button>
          </div>
          {raniwala && Object.keys(RANIWALA_SPLIT_MONTHS).map((key) => {
            const [y, m] = key.split('-').map(Number);
            if (y === payrollYear && m - 1 === payrollMonth) return null;
            return (
              <button key={key} className="btn btn-outline btn-sm" onClick={() => { setPayrollYear(y); setPayrollMonth(m - 1); }}
                title="This month is paid in two runs (1–16 and 17 to month end) and a combined final payslip">
                <i className="fas fa-columns" /> {monthLabel(m - 1, y)} · two runs
              </button>
            );
          })}
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…
          </div>
        ) : (
          <>
          {(employees.some((e) => e.is_withheld) || lastWithheld.length > 0) && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--warning)' }}>
              <div style={{ padding: '12px 20px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
                <i className="fas fa-pause-circle" style={{ color: 'var(--warning)' }} />
                <span>
                  <strong>{employees.filter((e) => e.is_withheld).length}</strong> employee(s) have salary withheld and will be skipped when payroll runs.
                  Manage this from the employee's profile.
                </span>
              </div>
            </div>
          )}

          {raniwala && !processedCompliance && <RaniwalaSetupCheck gaps={setupGaps} />}
          {raniwala ? (
            <RaniwalaPayrollSection
              tenant={tenant}
              profile={profile}
              month={payrollMonth}
              year={payrollYear}
              monthDays={workDays}
              daysSoFar={daysSoFar}
              rows={raniwalaRows}
              employees={employees}
              leavers={leaversInMonth}
              processed={processedCompliance}
              processing={processingComp}
              isManager={isManager}
              additions={pendingAdditions}
              advances={advances}
              workDayOverrides={workDayOverrides}
              setWorkDayOverrides={setWorkDayOverrides}
              lateDays={lateDays}
              lateCounts={lateCounts}
              onLateDaysChange={changeLateDays}
              onSettingsSaved={(row) => setPayrollSettings((prev) => ({ ...prev, [row.profile_id]: row }))}
              onAdditionsChanged={reloadAdditions}
              onAdvancesChanged={reloadAdvances}
              onProcess={() => handleProcess('Compliance')}
              onRevert={() => handleRevert('Compliance')}
              onExportGL={() => exportGL('Compliance')}
              onExportBank={() => exportBankFile('Compliance')}
              onViewSlip={setDetailSlip}
              split={split}
              partRuns={partRuns}
              partRows={partRows}
              partDayOverrides={partDayOverrides}
              setPartDayOverrides={setPartDayOverrides}
              partBusy={partBusy}
              onTogglePartPf={togglePartPf}
              onRunPart={runPart}
              onUndoPart={undoPart}
              onSavePartPf={savePartPfChanges}
              onDiscardPartPf={discardPartPfChanges}
              onRelease={toggleRelease}
            />
          ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <PayrollSection
              title="Compliance Payroll"
              subtitle="Employees with PF / ESIC"
              group="Compliance"
              emps={complianceEmps}
              processed={processedCompliance}
              processing={processingComp}
              workDays={workDays}
              workDayOverrides={workDayOverrides}
              setWorkDayOverrides={setWorkDayOverrides}
              components={components}
              advances={advances}
              isManager={isManager}
              pfSettings={{ wageCeiling: tenant?.pf_wage_ceiling, rate: tenant?.pf_employee_rate }}
              onProcess={() => handleProcess('Compliance')}
              onRevert={() => handleRevert('Compliance')}
              onExport={() => exportCSV('Compliance')}
              onExportGL={() => exportGL('Compliance')}
              onExportBank={() => exportBankFile('Compliance')}
              onViewSlip={setDetailSlip}
              month={payrollMonth}
              year={payrollYear}
            />
            <PayrollSection
              title="Non-Compliance Payroll"
              subtitle="Employees without PF / ESIC"
              group="Non-Compliance"
              emps={nonComplianceEmps}
              processed={processedNonCompliance}
              processing={processingNonComp}
              workDays={workDays}
              workDayOverrides={workDayOverrides}
              setWorkDayOverrides={setWorkDayOverrides}
              components={components}
              advances={advances}
              isManager={isManager}
              pfSettings={{ wageCeiling: tenant?.pf_wage_ceiling, rate: tenant?.pf_employee_rate }}
              onProcess={() => handleProcess('Non-Compliance')}
              onRevert={() => handleRevert('Non-Compliance')}
              onExport={() => exportCSV('Non-Compliance')}
              onExportGL={() => exportGL('Non-Compliance')}
              onExportBank={() => exportBankFile('Non-Compliance')}
              onViewSlip={setDetailSlip}
              month={payrollMonth}
              year={payrollYear}
            />
          </div>
          )}

          {settlements.length > 0 && (
            <CompOffSettlementCard settlements={settlements} />
          )}
          </>
        )}
      </div>

      <Modal show={!!detailSlip} onClose={() => setDetailSlip(null)} title="Salary Breakdown" width="620px"
        footer={<button className="btn btn-outline" onClick={() => setDetailSlip(null)}>Close</button>}
      >
        {detailSlip && (parseBreakdown(detailSlip).raniwala
          ? <RaniwalaPayslip slip={detailSlip} breakdown={parseBreakdown(detailSlip)} ctc={employees.find((x) => x.id === detailSlip.profile_id)?.salary_ctc} leave={detailLeave} companyName={tenant?.company_name} monthText={monthLabel(payrollMonth, payrollYear)} />
          : <PayslipDetail slip={detailSlip} companyName={tenant?.company_name} />)}
      </Modal>
    </>
  );
}

function PayrollSection({
  title, subtitle, group, emps, processed, processing,
  workDays, workDayOverrides, setWorkDayOverrides,
  components, advances, isManager, pfSettings,
  onProcess, onRevert, onExport, onExportGL, onExportBank, onViewSlip,
}) {
  const { outletProfileIds } = useOutletView();
  const slips      = scopedToOutlet(processed?.payslips || [], outletProfileIds);
  const totalGross = slips.reduce((s, p) => s + (p.gross_earnings || 0), 0);
  const totalNet   = slips.reduce((s, p) => s + (p.net_pay || 0), 0);

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{subtitle}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {processed
            ? <span className="badge badge-success"><i className="fas fa-check" /> Processed</span>
            : <span className="badge badge-warning">Not Processed</span>}
          {processed && (
            <>
              <button className="btn btn-outline btn-sm" onClick={onExport}>
                <i className="fas fa-file-csv" /> CSV
              </button>
              <button className="btn btn-outline btn-sm" onClick={onExportGL} title="Department-level debit/credit journal">
                <i className="fas fa-book" /> GL
              </button>
              <button className="btn btn-outline btn-sm" onClick={onExportBank} title="Generic NEFT/RTGS-style bank payout file">
                <i className="fas fa-university" /> Bank File
              </button>
            </>
          )}
          {!isManager && (processed ? (
            <button className="btn btn-danger btn-sm" onClick={onRevert}>
              <i className="fas fa-undo" /> Revert
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" onClick={onProcess} disabled={processing || emps.length === 0}>
              {processing
                ? <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Processing…</>
                : <><i className="fas fa-play" /> Process Payroll</>}
            </button>
          ))}
        </div>
      </div>

      {processed && (
        <div style={{ display: 'flex', gap: 24, padding: '12px 20px', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
          <span><strong>{slips.length}</strong> <span style={{ color: 'var(--text-muted)' }}>employees paid</span></span>
          <span><strong>{fmt(totalGross)}</strong> <span style={{ color: 'var(--text-muted)' }}>gross</span></span>
          <span><strong style={{ color: 'var(--success)' }}>{fmt(totalNet)}</strong> <span style={{ color: 'var(--text-muted)' }}>net</span></span>
        </div>
      )}

      {emps.length === 0 && !processed ? (
        <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          No {group === 'Compliance' ? 'compliance' : 'non-compliance'} employees found.
          {group === 'Compliance'
            ? ' Enable PF or ESIC on an employee to include them here.'
            : ' Employees with no PF/ESIC enabled will appear here.'}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Working Days</th>
                <th>Gross Earnings</th>
                <th>Deductions</th>
                <th>Advance Ded.</th>
                <th>Net Salary</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {processed ? (
                slips.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="emp-cell">
                        <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(p.profile_id)})` }}>
                          {getInitials(p.emp_name.split(' ')[0], p.emp_name.split(' ')[1])}
                        </div>
                        <div>
                          <div className="emp-name">{p.emp_name}</div>
                          <div className="emp-role">{p.department}</div>
                        </div>
                      </div>
                    </td>
                    <td>{p.work_days}/{p.total_work_days}</td>
                    <td>{fmt(p.gross_earnings)}</td>
                    <td style={{ color: 'var(--danger)' }}>-{fmt(p.total_deductions)}</td>
                    <td style={{ color: 'var(--warning)' }}>{p.advance_deduction > 0 ? '-' + fmt(p.advance_deduction) : '—'}</td>
                    <td><strong>{fmt(p.net_pay)}</strong></td>
                    <td>
                      <button className="btn btn-outline btn-sm" onClick={() => onViewSlip(p)}>
                        <i className="fas fa-eye" />
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                emps.map((e) => {
                  const actualDays  = workDayOverrides[e.id] ?? workDays;
                  const sal         = calcSalary(e.ctc || 0, components, workDays, actualDays);
                  const pfEsicDeds  = calcPfEsic(e, e.ctc || 0, actualDays, workDays, pfSettings);
                  const pfEsicTotal = pfEsicDeds.reduce((s, d) => s + d.amount, 0);
                  const advDed      = advances.filter((a) => a.profile_id === e.id).reduce((s, a) => s + Math.min(a.emi, a.balance), 0);
                  return (
                    <tr key={e.id}>
                      <td>
                        <div className="emp-cell">
                          <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(e.id)})` }}>
                            {getInitials(e.first_name, e.last_name)}
                          </div>
                          <div>
                            <div className="emp-name">{fullName(e)}</div>
                            <div className="emp-role">{e.department || ''}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {isManager ? (
                          <span>{workDayOverrides[e.id] ?? workDays}/{workDays}</span>
                        ) : (
                          <input
                            className="form-input"
                            type="number" min="0" max={workDays} step="0.5"
                            value={workDayOverrides[e.id] ?? workDays}
                            onChange={(ev) => setWorkDayOverrides((prev) => ({ ...prev, [e.id]: parseFloat(ev.target.value) || 0 }))}
                            style={{ width: 65, padding: '5px 8px', fontSize: 12 }}
                          />
                        )}
                      </td>
                      <td>{fmt(sal.totalEarning)}</td>
                      <td style={{ color: 'var(--danger)' }}>-{fmt(sal.totalDeduction + pfEsicTotal)}</td>
                      <td style={{ color: 'var(--warning)' }}>{advDed > 0 ? '-' + fmt(advDed) : '—'}</td>
                      <td><strong>{fmt(sal.net - pfEsicTotal - advDed)}</strong></td>
                      <td><span className="badge badge-warning">Pending</span></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PayslipDetail({ slip, companyName }) {
  let breakdown = { earnings: [], deductions: [] };
  try { breakdown = typeof slip.breakdown === 'string' ? JSON.parse(slip.breakdown) : slip.breakdown; } catch (_e) { /* ignore */ }

  return (
    <div className="payslip">
      <div className="payslip-header">
        <div><strong style={{ fontSize: 16 }}>{companyName || 'Company'}</strong></div>
        <div style={{ textAlign: 'right' }}><strong>Payslip</strong></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 12, marginBottom: 16 }}>
        <div><span style={{ color: 'var(--text-muted)' }}>Name:</span> <strong>{slip.emp_name}</strong></div>
        <div><span style={{ color: 'var(--text-muted)' }}>Department:</span> <strong>{slip.department || '—'}</strong></div>
        <div><span style={{ color: 'var(--text-muted)' }}>Working Days:</span> <strong>{slip.work_days}/{slip.total_work_days}</strong></div>
      </div>
      <div className="payslip-section-title" style={{ background: 'var(--success-light)', color: 'var(--success)' }}>Earnings</div>
      {(breakdown.earnings || []).map((e, i) => (
        <div className="payslip-row" key={i}><span>{e.name}</span><span>{fmt(e.amount)}</span></div>
      ))}
      <div className="payslip-row" style={{ fontWeight: 600, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
        <span>Total Earnings</span><span>{fmt(slip.gross_earnings)}</span>
      </div>
      <div className="payslip-section-title" style={{ background: 'var(--danger-light)', color: 'var(--danger)' }}>Deductions</div>
      {(breakdown.deductions || []).map((d, i) => (
        <div className="payslip-row" key={i}><span>{d.name}</span><span>{fmt(d.amount)}</span></div>
      ))}
      {slip.advance_deduction > 0 && (
        <div className="payslip-row"><span>Advance/Loan Recovery</span><span>{fmt(slip.advance_deduction)}</span></div>
      )}
      <div className="payslip-row" style={{ fontWeight: 600, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
        <span>Total Deductions</span><span>{fmt(slip.total_deductions + slip.advance_deduction)}</span>
      </div>
      <div className="payslip-row total"><span>Net Pay</span><span style={{ color: 'var(--success)' }}>{fmt(slip.net_pay)}</span></div>
    </div>
  );
}

const SETTLEMENT_BADGE = {
  none:     { cls: 'badge-info',    icon: 'fa-minus-circle',  label: 'No Miss'   },
  balanced: { cls: 'badge-success', icon: 'fa-check-circle',  label: 'Balanced'  },
  credited: { cls: 'badge-purple',  icon: 'fa-gift',          label: 'Comp Off +'  },
  expired:  { cls: 'badge-warning', icon: 'fa-exclamation-triangle', label: 'Expired' },
};

function CompOffSettlementCard({ settlements }) {
  const credited = settlements.filter(s => s.settlement_type === 'credited').length;
  const expired  = settlements.filter(s => s.settlement_type === 'expired').length;

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="card-header">
        <div>
          <h3 style={{ margin: 0 }}>Weekly Off Comp Off Settlement</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Employees with CTC ≥ ₹30,000 · No overtime cash · Comp off credited when all weekly offs are worked
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 13 }}>
          {credited > 0 && (
            <span style={{ color: 'var(--primary)', fontWeight: 600 }}>
              <i className="fas fa-gift" style={{ marginRight: 4 }} />{credited} credited
            </span>
          )}
          {expired > 0 && (
            <span style={{ color: 'var(--warning)', fontWeight: 600 }}>
              <i className="fas fa-exclamation-triangle" style={{ marginRight: 4 }} />{expired} expired
            </span>
          )}
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th style={{ textAlign: 'center' }}>Weekly Offs in Month</th>
              <th style={{ textAlign: 'center' }}>WOs Worked</th>
              <th style={{ textAlign: 'center' }}>Comp Leaves Used</th>
              <th>Outcome</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {settlements.map(s => {
              const b = SETTLEMENT_BADGE[s.settlement_type] || SETTLEMENT_BADGE.none;
              return (
                <tr key={s.id}>
                  <td>
                    <div className="emp-cell">
                      <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(s.profile_id)})` }}>
                        {getInitials(s.profile?.first_name, s.profile?.last_name)}
                      </div>
                      <div>
                        <div className="emp-name">{fullName(s.profile)}</div>
                        <div className="emp-role">{fmt(s.profile?.ctc)}/mo</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ textAlign: 'center' }}>{s.weekly_offs_in_month}</td>
                  <td style={{ textAlign: 'center' }}>{s.weekly_offs_worked}</td>
                  <td style={{ textAlign: 'center' }}>{s.comp_leaves_used}</td>
                  <td>
                    <span className={`badge ${b.cls}`}>
                      <i className={`fas ${b.icon}`} style={{ marginRight: 4 }} />{b.label}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {s.settlement_type === 'credited' && (
                      <span style={{ color: 'var(--primary)' }}>
                        +1 comp off added · expires {new Date(s.expires_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </span>
                    )}
                    {s.settlement_type === 'balanced' && 'Leaves used offset missed weekly offs'}
                    {s.settlement_type === 'expired' && (
                      <span style={{ color: 'var(--warning)' }}>
                        {s.weekly_offs_worked - s.comp_leaves_used} unused comp off{s.weekly_offs_worked - s.comp_leaves_used > 1 ? 's' : ''} expired
                      </span>
                    )}
                    {s.settlement_type === 'none' && 'All weekly offs taken — no action'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
