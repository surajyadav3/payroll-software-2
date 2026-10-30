import React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import NotificationChannelsCard from '@/components/NotificationChannelsCard';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/context/FeatureContext';
import { useOutletView } from '@/context/OutletViewContext';
import {
  updateTenant,
  listDepartments,
  addDepartment,
  removeDepartment,
  listShifts,
  addShift,
  removeShift,
  updateShiftThresholds,
  listHolidays,
  addHoliday,
  updateHoliday,
  updateHolidayStatus,
  deleteHoliday,
  importHolidays,
  initializeMajorHolidays,
  updateOutlet,
  resolveAttendanceSettings,
  recomputeAttendanceLateStatus,
} from '@/services/tenantService';
import { monthLabel, dateStr, isHrSupport } from '@/lib/helpers';
import { createGroup, linkToGroup, leaveGroup } from '@/services/groupService';

export default function SettingsPage() {
  const { tenant, profile, refreshProfile } = useAuth();
  // HR Support (no payroll) doesn't see the pay cycle, currency or late pay deduction.
  const hrSupport = isHrSupport(profile);
  const { outlets, selectedOutletId, selectedOutletName, selectOutlet, refreshOutlets } = useOutletView();
  const { isEnabled } = useFeatures();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    company_name: '', pay_day: 1, currency: '₹',
    shift_start: '09:00', shift_end: '18:00', late_threshold: 15,
    weekly_off_days: [0], location_code: '',
    late_deduction_enabled: false, late_deduction_tier2_min: 4, late_deduction_tier2_days: 0.5,
    late_deduction_tier3_min: 7, late_deduction_tier3_days: 1, sandwich_rule_enabled: false,
    auto_comp_off_on_weekly_off_worked: false,
  });
  const [attForm, setAttForm] = useState({
    min_half_day_hours: '', min_full_day_hours: '',
    geofence_lat: '', geofence_lng: '', geofence_radius: '',
    shift_start: '', shift_end: '', late_threshold: '', weekly_off_days: [],
    weekly_off_per_employee: false, holidays_enabled: true,
  });
  const [savingAtt, setSavingAtt] = useState(false);
  const [allowAnyOutletClockin, setAllowAnyOutletClockin] = useState(false);
  const [departments, setDepartments] = useState([]);
  const [shifts, setShifts]           = useState([]);
  const [saving, setSaving]           = useState(false);
  const [showDepartmentModal, setShowDepartmentModal] = useState(false);
  const [showShiftModal, setShowShiftModal] = useState(false);
  const [newDepartmentName, setNewDepartmentName] = useState('');
  const [newShiftName, setNewShiftName] = useState('');
  const [newShiftStart, setNewShiftStart] = useState('09:00');
  const [newShiftEnd, setNewShiftEnd] = useState('18:00');
  const [addLoading, setAddLoading] = useState(false);
  const [holidays, setHolidays] = useState([]);
  const [holidayMonth, setHolidayMonth] = useState(new Date().getMonth());
  const [holidayYear, setHolidayYear] = useState(new Date().getFullYear());
  const [showHolidayModal, setShowHolidayModal] = useState(false);
  const [newHolidayName, setNewHolidayName] = useState('');
  const [newHolidayDate, setNewHolidayDate] = useState(new Date().toISOString().slice(0, 10));
  const [newHolidayDesc, setNewHolidayDesc] = useState('');
  const [holidayLoading, setHolidayLoading] = useState(false);
  // Set while the holiday modal is editing an existing holiday (null = adding a new one).
  const [editingHolidayId, setEditingHolidayId] = useState(null);
  const [importLoading, setImportLoading] = useState(false);

  // Organization Group state
  const [groupMode,      setGroupMode]      = useState(null); // null | 'create' | 'join'
  const [groupName,      setGroupName]      = useState('');
  const [groupCodeInput, setGroupCodeInput] = useState('');
  const [groupLoading,   setGroupLoading]   = useState(false);

  const fetchData = useCallback(async () => {
    if (!tenant) return;
    const [deptRes, shiftRes] = await Promise.all([
      listDepartments(tenant.id),
      listShifts(tenant.id)
    ]);
    setDepartments(deptRes.data || []);
    setShifts(shiftRes.data || []);
  }, [tenant]);

  const getHolidayDate = (h) => h.holiday_date || h.date;

  const fetchHolidays = useCallback(async () => {
    if (!tenant) return;
    const { data, error } = await listHolidays(tenant.id, selectedOutletId);
    if (error) return showToast('Could not load holidays: ' + error.message, 'error');

    const currentYear = String(new Date().getFullYear());
    const hasCurrentYear = (data || []).some((h) => (getHolidayDate(h) || '').startsWith(currentYear));

    if (!hasCurrentYear) {
      const { error: initError } = await initializeMajorHolidays(tenant.id);
      if (initError) return showToast('Could not initialize holidays: ' + initError.message, 'error');
      const { data: newData } = await listHolidays(tenant.id, selectedOutletId);
      setHolidays(newData || []);
    } else {
      setHolidays(data);
    }
  }, [tenant, selectedOutletId]);

  useEffect(() => {
    if (!tenant) return;
    fetchHolidays();
  }, [tenant, fetchHolidays]);

  const majorIndianHolidays = [
    { name: 'Republic Day', holiday_date: `${new Date().getFullYear()}-01-26`, description: 'National holiday' },
    { name: 'Labour Day', holiday_date: `${new Date().getFullYear()}-05-01`, description: 'International Workers’ Day' },
    { name: 'Independence Day', holiday_date: `${new Date().getFullYear()}-08-15`, description: 'National holiday' },
    { name: 'Gandhi Jayanti', holiday_date: `${new Date().getFullYear()}-10-02`, description: 'National holiday' },
    { name: 'Christmas Day', holiday_date: `${new Date().getFullYear()}-12-25`, description: 'Major festival' },
  ];

  const importMajorIndianHolidays = async () => {
    if (!tenant) return;
    setImportLoading(true);
    const { error } = await initializeMajorHolidays(tenant.id);
    setImportLoading(false);
    if (error) return showToast('Import failed: ' + error.message, 'error');
    showToast('Major holidays added. Approve or reject as needed.', 'success');
    fetchHolidays();
  };

  const openAddHoliday = () => {
    setEditingHolidayId(null);
    setNewHolidayName('');
    setNewHolidayDesc('');
    setNewHolidayDate(new Date().toISOString().slice(0, 10));
    setShowHolidayModal(true);
  };

  const openEditHoliday = (holiday) => {
    setEditingHolidayId(holiday.id);
    setNewHolidayName(holiday.name || '');
    setNewHolidayDesc(holiday.description || '');
    setNewHolidayDate(getHolidayDate(holiday) || new Date().toISOString().slice(0, 10));
    setShowHolidayModal(true);
  };

  const closeHolidayModal = () => {
    setShowHolidayModal(false);
    setEditingHolidayId(null);
  };

  const handleSaveHoliday = async () => {
    if (!newHolidayName.trim() || !newHolidayDate) return showToast('Holiday name and date are required', 'warning');
    if (!tenant || !profile) return showToast('Unable to save holiday', 'error');
    if (editingHolidayId) {
      setHolidayLoading(true);
      const { error } = await updateHoliday(editingHolidayId, {
        name: newHolidayName.trim(),
        holiday_date: newHolidayDate,
        description: newHolidayDesc.trim(),
      });
      setHolidayLoading(false);
      if (error) {
        // holidays_tenant_outlet_date_key: one holiday per date per outlet (or company-wide).
        if (error.code === '23505') return showToast('Another holiday already exists on that date', 'error');
        return showToast('Failed to update holiday: ' + error.message, 'error');
      }
      showToast('Holiday updated', 'success');
      closeHolidayModal();
      fetchHolidays();
      return;
    }
    setHolidayLoading(true);
    const { error } = await addHoliday(tenant.id, {
      outlet_id: selectedOutletId || null,
      name: newHolidayName.trim(),
      holiday_date: newHolidayDate,
      description: newHolidayDesc.trim(),
      status: 'Approved',
      requested_by: profile.id,
      approved_by: profile.id,
      approved_at: new Date().toISOString(),
    });
    setHolidayLoading(false);
    if (error) return showToast('Failed to add holiday: ' + error.message, 'error');
    showToast('Holiday added and approved', 'success');
    setShowHolidayModal(false);
    setNewHolidayName('');
    setNewHolidayDesc('');
    setNewHolidayDate(new Date().toISOString().slice(0, 10));
    fetchHolidays();
  };

  const handleUpdateHolidayStatus = async (holidayId, status) => {
    if (!profile) return showToast('Unable to update status', 'error');
    setHolidayLoading(true);
    const { error } = await updateHolidayStatus(holidayId, status);
    setHolidayLoading(false);
    if (error) return showToast('Status update failed: ' + error.message, 'error');
    showToast(`Holiday ${status.toLowerCase()}`, 'success');
    fetchHolidays();
  };

  const handleDeleteHoliday = async (holiday) => {
    const where = holiday.outlet_id ? outlets.find((o) => o.id === holiday.outlet_id)?.name || 'this outlet' : 'all outlets';
    if (!confirm(`Delete "${holiday.name}" (${getHolidayDate(holiday)}) for ${where}? Attendance and payroll will treat that day as a normal working day.`)) return;
    setHolidayLoading(true);
    const { error } = await deleteHoliday(holiday.id);
    setHolidayLoading(false);
    if (error) return showToast('Failed to delete holiday: ' + error.message, 'error');
    showToast('Holiday deleted', 'success');
    fetchHolidays();
  };

  const moveHolidayMonth = (delta) => {
    let newMonth = holidayMonth + delta;
    let newYear = holidayYear;
    if (newMonth > 11) { newMonth = 0; newYear += 1; }
    if (newMonth < 0) { newMonth = 11; newYear -= 1; }
    setHolidayMonth(newMonth);
    setHolidayYear(newYear);
  };

  useEffect(() => {
    if (!tenant) return;
    setForm({
      company_name:   tenant.company_name   || '',
      pay_day:        tenant.pay_day        || 1,
      currency:       tenant.currency       || '₹',
      shift_start:    tenant.shift_start    || '09:00',
      shift_end:      tenant.shift_end      || '18:00',
      late_threshold: tenant.late_threshold || 15,
      weekly_off_days: Array.isArray(tenant.weekly_off_days) && tenant.weekly_off_days.length > 0
        ? tenant.weekly_off_days
        : [tenant.weekly_off_day ?? 0],
      location_code: tenant.location_code || '',
      late_deduction_enabled: !!tenant.late_deduction_enabled,
      late_deduction_tier2_min: tenant.late_deduction_tier2_min ?? 4,
      late_deduction_tier2_days: tenant.late_deduction_tier2_days ?? 0.5,
      late_deduction_tier3_min: tenant.late_deduction_tier3_min ?? 7,
      late_deduction_tier3_days: tenant.late_deduction_tier3_days ?? 1,
      sandwich_rule_enabled: !!tenant.sandwich_rule_enabled,
      auto_comp_off_on_weekly_off_worked: !!tenant.auto_comp_off_on_weekly_off_worked,
    });
    setAllowAnyOutletClockin(!!tenant.allow_any_outlet_clockin);
    fetchData();
  }, [tenant, fetchData]);

  // The Attendance & Geofencing card is scoped to whichever outlet is currently
  // selected app-wide (useOutletView) — null/"Combined" edits the tenant defaults
  // that every outlet without its own override falls back to.
  useEffect(() => {
    if (!tenant) return;
    const outlet = selectedOutletId ? outlets.find((o) => o.id === selectedOutletId) : null;
    setAttForm({
      min_half_day_hours: outlet?.min_half_day_hours ?? '',
      min_full_day_hours: outlet?.min_full_day_hours ?? '',
      geofence_lat: outlet?.geofence_lat ?? '',
      geofence_lng: outlet?.geofence_lng ?? '',
      geofence_radius: outlet?.geofence_radius ?? '',
      shift_start: outlet?.shift_start ?? '',
      shift_end: outlet?.shift_end ?? '',
      late_threshold: outlet?.late_threshold ?? '',
      weekly_off_days: outlet?.weekly_off_days ?? [],
      weekly_off_per_employee: !!outlet?.weekly_off_per_employee,
      holidays_enabled: outlet?.holidays_enabled ?? true,
    });
  }, [tenant, outlets, selectedOutletId]);

  // Trailing window recalculated right after a Report Time / Late Allowed
  // change is saved — matches the Late Comers Report's longest built-in
  // preset (Last 3 Months), so a settings tweak immediately corrects every
  // already-written row an admin could actually be looking at, without
  // silently rewriting years of older history on every small edit.
  const recentRecomputeWindow = () => {
    const to = new Date();
    const from = new Date();
    from.setMonth(from.getMonth() - 3);
    return { from: dateStr(from), to: dateStr(to) };
  };

  const recomputeAndNotify = async (outletId) => {
    const { from, to } = recentRecomputeWindow();
    const { count, error } = await recomputeAttendanceLateStatus(tenant.id, outletId, from, to);
    if (error) return showToast('Saved, but recalculating existing attendance failed: ' + error.message, 'error');
    if (count > 0) showToast(`Recalculated ${count} existing attendance record(s) to match the new timing.`, 'success');
  };

  const saveSettings = async () => {
    // Report Time / Late Allowed minutes feed every outlet that has no
    // override of its own — only worth a tenant-wide recompute if either
    // actually changed, not on every unrelated field in this card (currency,
    // pay day, late-deduction ladder, ...).
    const timingChanged = (form.shift_start || '09:00') !== (tenant.shift_start || '09:00')
      || (parseInt(form.late_threshold) || 15) !== (tenant.late_threshold ?? 15);
    setSaving(true);
    const { error } = await updateTenant(tenant.id, {
      company_name:   form.company_name   || 'My Company',
      pay_day:        parseInt(form.pay_day)        || 1,
      currency:       form.currency       || '₹',
      shift_start:    form.shift_start    || '09:00',
      shift_end:      form.shift_end      || '18:00',
      late_threshold: parseInt(form.late_threshold) || 15,
      weekly_off_days: form.weekly_off_days.length > 0 ? [...form.weekly_off_days].sort() : [0],
      weekly_off_day: form.weekly_off_days.length > 0 ? Math.min(...form.weekly_off_days) : 0,
      location_code: (form.location_code || '').toUpperCase().slice(0, 2) || null,
      late_deduction_enabled: form.late_deduction_enabled,
      late_deduction_tier2_min: parseInt(form.late_deduction_tier2_min) || 4,
      late_deduction_tier2_days: parseFloat(form.late_deduction_tier2_days) || 0.5,
      late_deduction_tier3_min: parseInt(form.late_deduction_tier3_min) || 7,
      late_deduction_tier3_days: parseFloat(form.late_deduction_tier3_days) || 1,
      sandwich_rule_enabled: form.sandwich_rule_enabled,
      auto_comp_off_on_weekly_off_worked: form.auto_comp_off_on_weekly_off_worked,
    });
    setSaving(false);
    if (error) return showToast('Save failed: ' + error.message, 'error');
    showToast('Settings saved', 'success');
    refreshProfile();
    if (timingChanged) recomputeAndNotify(null);
  };

  // Tenant-level fallback shown as placeholders when an outlet hasn't set its own value.
  const tenantDefaults = resolveAttendanceSettings(tenant, null);

  const saveAttendanceSettings = async () => {
    setSavingAtt(true);
    // Only worth a recompute if Report Time / Late Allowed minutes actually
    // changed, not on every geofence-only or weekly-off-only edit.
    const currentOutlet = selectedOutletId ? outlets.find((o) => o.id === selectedOutletId) : null;
    const timingChanged = !!selectedOutletId && (
      (attForm.shift_start || null) !== (currentOutlet?.shift_start ?? null)
      || (attForm.late_threshold === '' ? null : parseInt(attForm.late_threshold, 10)) !== (currentOutlet?.late_threshold ?? null)
    );
    const payload = {
      min_half_day_hours: attForm.min_half_day_hours === '' ? null : parseFloat(attForm.min_half_day_hours),
      min_full_day_hours: attForm.min_full_day_hours === '' ? null : parseFloat(attForm.min_full_day_hours),
      geofence_lat: attForm.geofence_lat === '' ? null : parseFloat(attForm.geofence_lat),
      geofence_lng: attForm.geofence_lng === '' ? null : parseFloat(attForm.geofence_lng),
      geofence_radius: attForm.geofence_radius === '' ? null : parseInt(attForm.geofence_radius, 10),
      ...(selectedOutletId ? {
        shift_start: attForm.shift_start === '' ? null : attForm.shift_start,
        shift_end: attForm.shift_end === '' ? null : attForm.shift_end,
        late_threshold: attForm.late_threshold === '' ? null : parseInt(attForm.late_threshold, 10),
        weekly_off_days: attForm.weekly_off_days.length > 0 ? [...attForm.weekly_off_days].sort() : null,
        weekly_off_per_employee: attForm.weekly_off_per_employee,
        holidays_enabled: attForm.holidays_enabled,
      } : {}),
    };
    const { error } = selectedOutletId
      ? await updateOutlet(selectedOutletId, payload)
      : await updateTenant(tenant.id, {
          min_half_day_hours: payload.min_half_day_hours ?? 4,
          min_full_day_hours: payload.min_full_day_hours ?? 8,
          geofence_lat: payload.geofence_lat,
          geofence_lng: payload.geofence_lng,
          geofence_radius: payload.geofence_radius ?? 200,
          allow_any_outlet_clockin: allowAnyOutletClockin,
        });
    setSavingAtt(false);
    if (error) return showToast('Save failed: ' + error.message, 'error');
    showToast(selectedOutletId ? `Attendance rules saved for ${selectedOutletName}` : 'Company-wide attendance rules saved', 'success');
    if (selectedOutletId) {
      await refreshOutlets();
      if (timingChanged) recomputeAndNotify(selectedOutletId);
    }
    refreshProfile();
  };

  const handleAddDepartment = () => {
    setNewDepartmentName('');
    setShowDepartmentModal(true);
  };

  const handleSubmitDepartment = async () => {
    if (!newDepartmentName.trim()) return showToast('Department name is required', 'warning');
    setAddLoading(true);
    const { error } = await addDepartment(tenant.id, newDepartmentName.trim());
    setAddLoading(false);
    if (error) return showToast('Failed to add: ' + error.message, 'error');
    showToast('Department added', 'success');
    setShowDepartmentModal(false);
    fetchData();
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim()) return showToast('Enter a group name', 'warning');
    setGroupLoading(true);
    const { code, error } = await createGroup(tenant.id, groupName);
    setGroupLoading(false);
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast(`Group created — code: ${code}`, 'success');
    setGroupMode(null);
    setGroupName('');
    refreshProfile();
  };

  const handleLinkGroup = async () => {
    if (!groupCodeInput.trim()) return showToast('Enter a group code', 'warning');
    setGroupLoading(true);
    const { error } = await linkToGroup(tenant.id, groupCodeInput);
    setGroupLoading(false);
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast('Outlet linked to group', 'success');
    setGroupMode(null);
    setGroupCodeInput('');
    refreshProfile();
  };

  const handleLeaveGroup = async () => {
    if (!confirm('Remove this outlet from the group? You can re-join anytime with the group code.')) return;
    setGroupLoading(true);
    const { error } = await leaveGroup(tenant.id);
    setGroupLoading(false);
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast('Outlet removed from group', 'warning');
    refreshProfile();
  };

  const handleRemoveDepartment = async (id) => {
    const { error } = await removeDepartment(id);
    if (error) return showToast('Remove failed: ' + error.message, 'error');
    showToast('Department removed', 'success');
    fetchData();
  };

  const handleAddShift = () => {
    setNewShiftName('');
    setNewShiftStart('09:00');
    setNewShiftEnd('18:00');
    setShowShiftModal(true);
  };

  const calculateShiftHours = (start, end) => {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    let from = sh * 60 + sm;
    let to = eh * 60 + em;
    if (to <= from) to += 24 * 60;
    return Math.round((to - from) / 60 * 100) / 100;
  };

  const handleSubmitShift = async () => {
    if (!newShiftName.trim()) return showToast('Shift name is required', 'warning');
    if (!newShiftStart || !newShiftEnd) return showToast('Shift start and end are required', 'warning');
    setAddLoading(true);
    const totalHours = calculateShiftHours(newShiftStart, newShiftEnd) || 8;
    const { error } = await addShift(tenant.id, {
      name: newShiftName.trim(),
      start_time: newShiftStart,
      end_time: newShiftEnd,
      total_hours: totalHours,
    });
    setAddLoading(false);
    if (error) return showToast('Failed to add shift: ' + error.message, 'error');
    showToast('Shift added', 'success');
    setShowShiftModal(false);
    fetchData();
  };

  const handleCopyJoinCode = async () => {
    if (!tenant?.join_code) return showToast('No join code available yet', 'warning');
    try {
      await navigator.clipboard.writeText(tenant.join_code);
      showToast('Join code copied to clipboard', 'success');
    } catch {
      showToast('Could not copy — please copy manually', 'error');
    }
  };

  const handleRemoveShift = async (id) => {
    const { error } = await removeShift(id);
    if (error) return showToast('Remove failed: ' + error.message, 'error');
    showToast('Shift removed', 'success');
    fetchData();
  };

  const [thresholdShift, setThresholdShift] = useState(null);
  const [thresholdForm, setThresholdForm] = useState({ grace_minutes: 10, early_exit_threshold_minutes: 10, auto_absent_after_hours: 20, early_departure_after: '', late_arrival_allowance_until: '' });

  const openThresholds = (s) => {
    setThresholdShift(s);
    setThresholdForm({
      grace_minutes: s.grace_minutes ?? 10,
      early_exit_threshold_minutes: s.early_exit_threshold_minutes ?? 10,
      auto_absent_after_hours: s.auto_absent_after_hours ?? 20,
      early_departure_after: s.early_departure_after ?? '',
      late_arrival_allowance_until: s.late_arrival_allowance_until ?? '',
    });
  };

  const saveThresholds = async () => {
    const { error } = await updateShiftThresholds(thresholdShift.id, thresholdForm);
    if (error) return showToast('Save failed: ' + error.message, 'error');
    showToast('Automation thresholds updated', 'success');
    setThresholdShift(null);
    fetchData();
  };

  return (
    <>
      <Header title="Settings" breadcrumb="Company and system configuration" />

      <Modal
        show={showDepartmentModal}
        onClose={() => setShowDepartmentModal(false)}
        title="Add Department"
        footer={<>
          <button className="btn btn-outline" onClick={() => setShowDepartmentModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmitDepartment} disabled={addLoading}>
            {addLoading ? 'Adding…' : 'Add Department'}
          </button>
        </>}
      >
        <div className="form-group">
          <label className="form-label">Department name</label>
          <input
            className="form-input"
            value={newDepartmentName}
            onChange={(e) => setNewDepartmentName(e.target.value)}
            placeholder="e.g. Sales"
          />
        </div>
      </Modal>

      <Modal
        show={showHolidayModal}
        onClose={closeHolidayModal}
        title={editingHolidayId ? 'Edit Holiday' : 'Add Holiday'}
        footer={<>
          <button className="btn btn-outline" onClick={closeHolidayModal}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSaveHoliday} disabled={holidayLoading}>
            {holidayLoading ? 'Saving…' : 'Save Holiday'}
          </button>
        </>}
      >
        <div className="form-group">
          <label className="form-label">Holiday name</label>
          <input
            className="form-input"
            value={newHolidayName}
            onChange={(e) => setNewHolidayName(e.target.value)}
            placeholder="e.g. Diwali"
          />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Date</label>
            <input className="form-input" type="date" value={newHolidayDate}
              onChange={(e) => setNewHolidayDate(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Description</label>
            <input
              className="form-input"
              value={newHolidayDesc}
              onChange={(e) => setNewHolidayDesc(e.target.value)}
              placeholder="Optional description"
            />
          </div>
        </div>
      </Modal>

      <Modal
        show={showShiftModal}
        onClose={() => setShowShiftModal(false)}
        title="Add Shift"
        footer={<>
          <button className="btn btn-outline" onClick={() => setShowShiftModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmitShift} disabled={addLoading}>
            {addLoading ? 'Adding…' : 'Add Shift'}
          </button>
        </>}
      >
        <div className="form-group">
          <label className="form-label">Shift name</label>
          <input
            className="form-input"
            value={newShiftName}
            onChange={(e) => setNewShiftName(e.target.value)}
            placeholder="e.g. Night Shift"
          />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Start time</label>
            <input className="form-input" type="time" value={newShiftStart}
              onChange={(e) => setNewShiftStart(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">End time</label>
            <input className="form-input" type="time" value={newShiftEnd}
              onChange={(e) => setNewShiftEnd(e.target.value)} />
          </div>
        </div>
        <div className="form-hint">Leave end time earlier than start time for overnight shifts.</div>
      </Modal>

      <Modal
        show={!!thresholdShift}
        onClose={() => setThresholdShift(null)}
        title={`Auto-Attendance Thresholds — ${thresholdShift?.name || ''}`}
        footer={<>
          <button className="btn btn-outline" onClick={() => setThresholdShift(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveThresholds}>Save</button>
        </>}
      >
        <div className="form-group">
          <label className="form-label">Grace period (minutes)</label>
          <input className="form-input" type="number" value={thresholdForm.grace_minutes}
            onChange={(e) => setThresholdForm({ ...thresholdForm, grace_minutes: e.target.value })} />
          <div className="form-hint">Punch-ins within this window of shift start still count as on-time.</div>
        </div>
        <div className="form-group">
          <label className="form-label">Early-exit threshold (minutes)</label>
          <input className="form-input" type="number" value={thresholdForm.early_exit_threshold_minutes}
            onChange={(e) => setThresholdForm({ ...thresholdForm, early_exit_threshold_minutes: e.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label">Auto-mark Absent after (hours past midnight)</label>
          <input className="form-input" type="number" value={thresholdForm.auto_absent_after_hours}
            onChange={(e) => setThresholdForm({ ...thresholdForm, auto_absent_after_hours: e.target.value })} />
          <div className="form-hint">Used by the nightly sweep that marks employees with zero punches as Absent.</div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Early departure after</label>
            <input className="form-input" type="time" value={thresholdForm.early_departure_after}
              onChange={(e) => setThresholdForm({ ...thresholdForm, early_departure_after: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Late-arrival allowance until</label>
            <input className="form-input" type="time" value={thresholdForm.late_arrival_allowance_until}
              onChange={(e) => setThresholdForm({ ...thresholdForm, late_arrival_allowance_until: e.target.value })} />
          </div>
        </div>
        <div className="form-hint">
          {tenant?.early_late_grace_minutes
            ? `Late arrival / early left: arriving more than ${tenant.early_late_grace_minutes} min after shift start, or leaving more than ${tenant.early_left_minutes ?? tenant.early_late_grace_minutes} min before shift end, is graced once a calendar month (marked Present, or Late when an early left follows a late arrival) when it stays within these limits. Late and early on the same day is Half Day and uses no grace. Without the grace (later that month, or past these limits: after "late-arrival allowance until" / before "early departure after") the hours decide: Half Day when under the full-day hours.`
            : 'One clock-out before "early departure after" OR one clock-in after "late-arrival allowance until" is forgiven per calendar month; any further instance that month is marked Half Day. Leave either blank to turn that check off for this shift.'}
        </div>
      </Modal>

      <div className="page-content settings-page">
        <div className="grid-2">
          <div className="card">
            <div className="card-header"><h3>Invite Employees</h3></div>
            <div className="card-body">
              <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14 }}>
                Share this join code with new employees. They enter it on the signup page to be added to your company.
              </p>
              <div className="form-label">Company join code</div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{
                  fontFamily: 'monospace',
                  fontSize: 20,
                  fontWeight: 700,
                  letterSpacing: 2,
                  padding: '12px 18px',
                  background: 'var(--bg)',
                  border: '1px dashed var(--border)',
                  borderRadius: 'var(--radius-md)',
                  userSelect: 'all',
                  color: 'var(--primary)',
                }}>
                  {tenant?.join_code || '—'}
                </span>
                <button className="btn btn-outline btn-sm" onClick={handleCopyJoinCode} disabled={!tenant?.join_code}>
                  <i className="fas fa-copy" /> Copy
                </button>
              </div>
              <div className="form-hint" style={{ marginTop: 12 }}>
                Tip: send this code along with the link to <code>/signup</code> so employees can sign up directly.
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><h3>Company Settings</h3></div>
            <div className="card-body">
              <div className="form-row">
                <div className="form-group" style={{ flex: 2 }}>
                  <label className="form-label">Company Name</label>
                  <input className="form-input" value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} />
                </div>
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Branch Location Code</label>
                  <input
                    className="form-input"
                    value={form.location_code}
                    onChange={(e) => setForm({ ...form, location_code: e.target.value.toUpperCase().slice(0, 2) })}
                    placeholder="e.g. MU"
                    maxLength={2}
                    style={{ textTransform: 'uppercase', letterSpacing: 2, fontWeight: 700, fontFamily: 'monospace' }}
                  />
                  <div className="form-hint">2-letter code for this branch. Used in employee IDs (e.g. <strong>MU</strong> → MCMU1042).</div>
                </div>
              </div>
              <div className="form-row">
                {!hrSupport && (
                  <div className="form-group">
                    <label className="form-label">Pay Cycle Start Day</label>
                    <input className="form-input" type="number" min="1" max="28" value={form.pay_day} onChange={(e) => setForm({ ...form, pay_day: e.target.value })} />
                  </div>
                )}
                <div className="form-group">
                  <label className="form-label">Working Days</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px' }}>
                    {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) => {
                      const isOff = form.weekly_off_days.includes(i);
                      return (
                        <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={!isOff}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setForm((f) => {
                                let days = checked
                                  ? f.weekly_off_days.filter((x) => x !== i)
                                  : [...f.weekly_off_days, i];
                                if (days.length === 7) days = f.weekly_off_days; // keep at least one off day
                                return { ...f, weekly_off_days: days };
                              });
                            }}
                          />
                          {d}
                        </label>
                      );
                    })}
                  </div>
                  <div className="form-hint">Uncheck a day to mark it as a weekly off for this company (e.g. uncheck only Sunday for a 6-day work week). Drives attendance, calendars and comp off settlement (CTC ≥ ₹30,000).</div>
                </div>
              </div>
              {!hrSupport && (
                <div className="form-group">
                  <label className="form-label">Currency Symbol</label>
                  <input className="form-input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
                </div>
              )}
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Default Shift Start</label>
                  <input className="form-input" type="time" value={form.shift_start} onChange={(e) => setForm({ ...form, shift_start: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Default Shift End</label>
                  <input className="form-input" type="time" value={form.shift_end} onChange={(e) => setForm({ ...form, shift_end: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Late Threshold (minutes)</label>
                <input className="form-input" type="number" min="0" value={form.late_threshold} onChange={(e) => setForm({ ...form, late_threshold: e.target.value })} />
                <div className="form-hint">Minutes after shift start before marking as Late</div>
              </div>

              {!hrSupport && (
              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                  <input type="checkbox" checked={form.late_deduction_enabled}
                    onChange={(e) => setForm({ ...form, late_deduction_enabled: e.target.checked })} />
                  Late Deduction Policy
                </label>
                <div className="form-hint">
                  Deduct extra day(s) of pay based on how many times an employee is marked Late in a calendar
                  month, on top of any Half Day/Absent already deducted.
                </div>
                {form.late_deduction_enabled && (
                  <div className="form-row" style={{ marginTop: 8 }}>
                    <div className="form-group">
                      <label className="form-label">Lates for 0.5-day deduction</label>
                      <input className="form-input" type="number" min="1" value={form.late_deduction_tier2_min}
                        onChange={(e) => setForm({ ...form, late_deduction_tier2_min: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Deduction (days)</label>
                      <input className="form-input" type="number" step="0.5" min="0" value={form.late_deduction_tier2_days}
                        onChange={(e) => setForm({ ...form, late_deduction_tier2_days: e.target.value })} />
                    </div>
                  </div>
                )}
                {form.late_deduction_enabled && (
                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label">Lates for 1-day deduction</label>
                      <input className="form-input" type="number" min="1" value={form.late_deduction_tier3_min}
                        onChange={(e) => setForm({ ...form, late_deduction_tier3_min: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Deduction (days)</label>
                      <input className="form-input" type="number" step="0.5" min="0" value={form.late_deduction_tier3_days}
                        onChange={(e) => setForm({ ...form, late_deduction_tier3_days: e.target.value })} />
                    </div>
                  </div>
                )}
              </div>
              )}

              <div className="form-group">
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                  <input type="checkbox" checked={form.sandwich_rule_enabled}
                    onChange={(e) => setForm({ ...form, sandwich_rule_enabled: e.target.checked })} />
                  Sandwich Rule
                </label>
                <div className="form-hint">
                  A weekly off (each outlet's own, e.g. Delhi Monday) between two leave days counts as leave and
                  takes a day off the balance (leave Sat + Sunday off + leave Mon = 3 leave days). Between two
                  absent days it is unpaid too (absent Sat + Sun + Mon = 3 absent). A holiday is always paid:
                  absent Thu + holiday Fri + absent Sat = 2 absent.
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Comp-Off Gain Type</label>
                <div className="form-hint" style={{ marginTop: -2, marginBottom: 8 }}>
                  How employees earn a Comp Off for working on a weekly off day.
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                      border: `1px solid ${!form.auto_comp_off_on_weekly_off_worked ? 'var(--primary)' : 'var(--border-light)'}`,
                      borderRadius: 8, cursor: 'pointer',
                      background: !form.auto_comp_off_on_weekly_off_worked ? 'var(--primary-light)' : 'transparent',
                    }}
                  >
                    <input
                      type="radio"
                      name="comp_off_gain_type"
                      checked={!form.auto_comp_off_on_weekly_off_worked}
                      onChange={() => setForm({ ...form, auto_comp_off_on_weekly_off_worked: false })}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>Month-end settlement</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        Comp Offs are credited when payroll runs the monthly weekly-off settlement — the standard, batch-reviewed flow.
                      </div>
                    </div>
                  </label>
                  <label
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                      border: `1px solid ${form.auto_comp_off_on_weekly_off_worked ? 'var(--primary)' : 'var(--border-light)'}`,
                      borderRadius: 8, cursor: 'pointer',
                      background: form.auto_comp_off_on_weekly_off_worked ? 'var(--primary-light)' : 'transparent',
                    }}
                  >
                    <input
                      type="radio"
                      name="comp_off_gain_type"
                      checked={form.auto_comp_off_on_weekly_off_worked}
                      onChange={() => setForm({ ...form, auto_comp_off_on_weekly_off_worked: true })}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>Real-time grant</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        A Comp Off is credited the instant an employee punches in on their weekly off — no need to wait for month-end.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <button className="btn btn-primary" onClick={saveSettings} disabled={saving}>
                {saving ? 'Saving…' : <><i className="fas fa-save" /> Save Settings</>}
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-header"><h3>Attendance & Geofencing</h3></div>
            <div className="card-body">
              {outlets.length > 0 && (
                <div className="form-group">
                  <label className="form-label">Applies to</label>
                  <select
                    className="form-select"
                    value={selectedOutletId || ''}
                    onChange={(e) => selectOutlet(e.target.value || null)}
                  >
                    <option value="">Combined (Company Default)</option>
                    {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  <div className="form-hint">
                    {selectedOutletId
                      ? `Editing rules just for ${selectedOutletName}. Leave a field blank to inherit the company default.`
                      : 'Editing the company-wide default. Any outlet without its own override uses these values.'}
                  </div>
                </div>
              )}

              {selectedOutletId && (
                <div className="settings-geofence" style={{ marginBottom: 18 }}>
                  <h4><i className="fas fa-clock" /> Reporting Time for {selectedOutletName}</h4>
                  <p>Fixed rule — Report Time + Late Allowed minutes is the whole rule, every day of the month. Leave blank to use the company default.</p>
                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label">Report Time (Shift Start)</label>
                      <input className="form-input" type="time"
                        placeholder={tenantDefaults.shift_start}
                        value={attForm.shift_start}
                        onChange={(e) => setAttForm({ ...attForm, shift_start: e.target.value })} />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Shift End</label>
                      <input className="form-input" type="time"
                        placeholder={tenantDefaults.shift_end}
                        value={attForm.shift_end}
                        onChange={(e) => setAttForm({ ...attForm, shift_end: e.target.value })} />
                    </div>
                  </div>
                  <div className="form-group" style={{ marginBottom: 14 }}>
                    <label className="form-label">Late Allowed (minutes after Report Time)</label>
                    <input className="form-input" type="number" min="0"
                      placeholder={String(tenantDefaults.late_threshold)}
                      value={attForm.late_threshold}
                      onChange={(e) => setAttForm({ ...attForm, late_threshold: e.target.value })} />
                    <div className="form-hint">
                      e.g. Report Time 11:00 with 5 minutes allowed marks anyone clocking in at 11:06 or later as
                      Late — every day of the month, no separate monthly grace. Saving recalculates recent
                      attendance to match immediately.
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Weekly Off Days for {selectedOutletName}</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 14px' }}>
                      {['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((d, i) => {
                        const isOff = attForm.weekly_off_days.includes(i);
                        return (
                          <label key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={isOff}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setAttForm((f) => ({
                                  ...f,
                                  weekly_off_days: checked
                                    ? [...f.weekly_off_days, i]
                                    : f.weekly_off_days.filter((x) => x !== i),
                                }));
                              }}
                            />
                            {d}
                          </label>
                        );
                      })}
                    </div>
                    <div className="form-hint">Overrides the company-wide working days just for this outlet. Leave every box unchecked to inherit the company default.</div>
                  </div>
                  <div className="form-group" style={{ marginTop: 14 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={attForm.weekly_off_per_employee}
                        onChange={(e) => setAttForm((f) => ({ ...f, weekly_off_per_employee: e.target.checked }))}
                      />
                      Each employee at {selectedOutletName} has their own weekly off
                    </label>
                    <div className="form-hint">
                      When ticked, an employee's weekly off is the Weekly Holiday on their employee form, for
                      attendance, comp off, overtime, the sandwich rule, payroll and reports. Employees set to
                      Flexible use the outlet's weekly off days above (or the company default).
                    </div>
                  </div>
                  <div className="form-group" style={{ marginTop: 14 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={!attForm.holidays_enabled}
                        onChange={(e) => setAttForm((f) => ({ ...f, holidays_enabled: !e.target.checked }))}
                      />
                      No company-wide holidays at {selectedOutletName} — weekly off only
                    </label>
                    <div className="form-hint">
                      When ticked, company-wide holidays don't apply to this outlet's staff: their calendars don't show
                      them, and working on one is an ordinary working day with no comp-off. Holidays added under
                      Holidays with this outlet picked still apply.
                    </div>
                  </div>
                </div>
              )}

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Half-Day Min. Hours</label>
                  <input className="form-input" type="number" step="0.5"
                    placeholder={String(tenantDefaults.min_half_day_hours)}
                    value={attForm.min_half_day_hours}
                    onChange={(e) => setAttForm({ ...attForm, min_half_day_hours: e.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Full-Day Min. Hours</label>
                  <input className="form-input" type="number" step="0.5"
                    placeholder={String(tenantDefaults.min_full_day_hours)}
                    value={attForm.min_full_day_hours}
                    onChange={(e) => setAttForm({ ...attForm, min_full_day_hours: e.target.value })} />
                </div>
              </div>

              <div className="settings-geofence">
                <h4><i className="fas fa-map-marker-alt" /> Geofencing</h4>
                <p>Restrict employee clock-in/out to a specific location.</p>

                {!selectedOutletId && outlets.length > 1 && (
                  <div className="form-group" style={{ marginBottom: 14 }}>
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        style={{ marginTop: 2 }}
                        checked={allowAnyOutletClockin}
                        onChange={(e) => setAllowAnyOutletClockin(e.target.checked)}
                      />
                      Allow clock-in/out at any outlet (multifencing)
                    </label>
                    <div className="form-hint">
                      Any employee can clock in/out from inside any of the company's outlet
                      geofences — not just their home outlet — but still nowhere outside all of them.
                      Overrides per-employee outlet access on the Employees page.
                    </div>
                  </div>
                )}

                {selectedOutletId && allowAnyOutletClockin && (
                  <div className="form-hint" style={{ marginBottom: 14 }}>
                    "Allow clock-in/out at any outlet" is on for the whole company, so every
                    employee can already use this outlet's fence — switch to "Combined" to change it.
                  </div>
                )}

                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Latitude</label>
                    <input className="form-input" placeholder={selectedOutletId ? String(tenantDefaults.geofence_lat ?? 'e.g. 28.6139') : 'e.g. 28.6139'}
                      value={attForm.geofence_lat} onChange={(e) => setAttForm({ ...attForm, geofence_lat: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Longitude</label>
                    <input className="form-input" placeholder={selectedOutletId ? String(tenantDefaults.geofence_lng ?? 'e.g. 77.2090') : 'e.g. 77.2090'}
                      value={attForm.geofence_lng} onChange={(e) => setAttForm({ ...attForm, geofence_lng: e.target.value })} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Radius (meters)</label>
                  <input className="form-input" type="number" placeholder={String(tenantDefaults.geofence_radius)}
                    value={attForm.geofence_radius} onChange={(e) => setAttForm({ ...attForm, geofence_radius: e.target.value })} />
                </div>
              </div>

              <button className="btn btn-primary" onClick={saveAttendanceSettings} disabled={savingAtt}>
                {savingAtt ? 'Saving…' : <><i className="fas fa-save" /> Save Attendance Rules</>}
              </button>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3>Holiday Calendar</h3>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-outline" onClick={openAddHoliday}>
                  <i className="fas fa-plus" /> Add Holiday
                </button>
                <button className="btn btn-primary btn-sm" onClick={importMajorIndianHolidays} disabled={importLoading}>
                  {importLoading ? 'Importing…' : 'Import Major Holidays'}
                </button>
              </div>
            </div>
            <div className="card-body">
              {outlets.length > 1 && (
                <div className="form-group">
                  <label className="form-label">Applies to</label>
                  <select
                    className="form-select"
                    value={selectedOutletId || ''}
                    onChange={(e) => selectOutlet(e.target.value || null)}
                  >
                    <option value="">All outlets (Company default)</option>
                    {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                  <div className="form-hint">
                    {selectedOutletId
                      ? `Showing company-wide holidays plus holidays specific to ${selectedOutletName}. New holidays added here apply only to ${selectedOutletName}.`
                      : 'Showing every company-wide holiday. New holidays added here apply to all outlets — pick a specific outlet above to add one just for that outlet.'}
                  </div>
                  {selectedOutletId && outlets.find((o) => o.id === selectedOutletId)?.holidays_enabled === false && (
                    <div className="form-hint" style={{ color: 'var(--warning)', fontWeight: 600 }}>
                      <i className="fas fa-triangle-exclamation" style={{ marginRight: 6 }} />
                      {selectedOutletName} observes no company-wide holidays, so only the holidays added for{' '}
                      {selectedOutletName} itself apply to its staff. Change this under Attendance & Geofencing above.
                    </div>
                  )}
                </div>
              )}
              <div className="settings-holiday-meta">
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Approved holidays automatically apply to employee attendance calendars.</span>
                <div className="settings-holiday-nav">
                  <button className="btn btn-outline btn-icon btn-sm" onClick={() => moveHolidayMonth(-1)}><i className="fas fa-chevron-left" /></button>
                  <span>{monthLabel(holidayMonth, holidayYear)}</span>
                  <button className="btn btn-outline btn-icon btn-sm" onClick={() => moveHolidayMonth(1)}><i className="fas fa-chevron-right" /></button>
                </div>
              </div>
              <div className="att-calendar" style={{ marginBottom: 20 }}>
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                  <div className="att-cal-header" key={day}>{day}</div>
                ))}
                {(() => {
                  const firstDay = new Date(holidayYear, holidayMonth, 1).getDay();
                  const daysInMonth = new Date(holidayYear, holidayMonth + 1, 0).getDate();
                  const today = new Date();
                  const holidayMap = new Map(holidays.map((h) => [getHolidayDate(h), h]));
                  const cells = [];
                  for (let i = 0; i < firstDay; i++) cells.push(<div className="att-cal-day empty" key={`empty-${i}`} />);
                  for (let d = 1; d <= daysInMonth; d++) {
                    const date = new Date(holidayYear, holidayMonth, d);
                    // Build the key from local y/m/d, not date.toISOString() — that converts to UTC
                    // first, which for any UTC+ timezone (e.g. IST) rolls local midnight back to the
                    // previous day and shifts every holiday marker one day later than the stored date.
                    const ds = `${holidayYear}-${String(holidayMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                    const holiday = holidayMap.get(ds);
                    const isToday = d === today.getDate() && holidayMonth === today.getMonth() && holidayYear === today.getFullYear();
                    const cls = holiday ? 'holiday' : (form.weekly_off_days.includes(date.getDay()) ? 'weekend' : '');
                    cells.push(
                      <div className={`att-cal-day ${cls}${isToday ? ' today' : ''}`} key={ds}>
                        <div className="day-num">{d}</div>
                        {holiday && <div className="day-hours" style={{ fontSize: 10 }}>{holiday.name}</div>}
                      </div>
                    );
                  }
                  return cells;
                })()}
              </div>
              {holidays.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No holidays configured yet. Import the major Indian holidays or add a custom holiday.</p>
              ) : (
                <div className="settings-holiday-list">
                  {holidays.map((holiday) => (
                    <div key={holiday.id} className="settings-holiday-row">
                      <div>
                        <div className="name">
                          {holiday.name}
                          {outlets.length > 1 && (
                            <span className="badge" style={{ marginLeft: 8, fontSize: 11, fontWeight: 500 }}>
                              {holiday.outlet_id
                                ? outlets.find((o) => o.id === holiday.outlet_id)?.name || 'Outlet-specific'
                                : 'All outlets'}
                            </span>
                          )}
                        </div>
                        <div className="meta">{getHolidayDate(holiday)} • {holiday.description || 'No description'}</div>
                        <div className="status"><strong>Status:</strong> {holiday.status}</div>
                      </div>
                      <div className="actions">
                        {holiday.status === 'Pending' && (
                          <>
                            <button className="btn btn-success btn-sm" onClick={() => handleUpdateHolidayStatus(holiday.id, 'Approved')} disabled={holidayLoading}>Approve</button>
                            <button className="btn btn-danger btn-sm" onClick={() => handleUpdateHolidayStatus(holiday.id, 'Rejected')} disabled={holidayLoading}>Reject</button>
                          </>
                        )}
                        <button className="btn btn-outline btn-sm" onClick={() => openEditHoliday(holiday)} disabled={holidayLoading}>
                          <i className="fas fa-pen" /> Edit
                        </button>
                        <button className="btn btn-outline btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleDeleteHoliday(holiday)} disabled={holidayLoading}>
                          <i className="fas fa-trash" /> Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3>Shifts</h3>
              <button className="btn btn-primary btn-sm" onClick={handleAddShift}><i className="fas fa-plus" /> Add Shift</button>
            </div>
            <div className="card-body">
              {shifts.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Only the company default shift is available. Add more shifts for flexible timing.</p>
              ) : shifts.map((s) => (
                <div key={s.id} className="settings-list-row">
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {s.start_time} — {s.end_time}
                      {tenant?.auto_shift_from_punch && s.for_designations?.length > 0 && ` · only ${s.for_designations.join(', ').toUpperCase()}`}
                      {tenant?.auto_shift_from_punch && s.auto_pick === false && ' · not picked from punch-in'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-outline btn-icon btn-sm" title="Auto-attendance thresholds" onClick={() => openThresholds(s)}>
                      <i className="fas fa-stopwatch" />
                    </button>
                    <button className="btn btn-outline btn-icon btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleRemoveShift(s.id)}>
                      <i className="fas fa-trash-alt" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3>Departments</h3>
              <button className="btn btn-primary btn-sm" onClick={handleAddDepartment}><i className="fas fa-plus" /> Add Dept</button>
            </div>
            <div className="card-body">
              {departments.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No departments configured. Add departments to organize your team.</p>
              ) : departments.map((d) => (
                <div key={d.id} className="settings-list-row">
                  <span style={{ fontSize: 13 }}>{d.name}</span>
                  <button className="btn btn-outline btn-icon btn-sm" style={{ color: 'var(--danger)' }} onClick={() => handleRemoveDepartment(d.id)}>
                    <i className="fas fa-times" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* ── Organization Group ──────────────────────────────────────────── */}
          <div className="card">
            <div className="card-header">
              <div>
                <h3 style={{ margin: 0 }}>Organization Group</h3>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  Link multiple outlets under one group to view combined stats in Group Dashboard
                </div>
              </div>
              {tenant?.group_code && (
                <span className="badge badge-success">
                  <i className="fas fa-layer-group" style={{ marginRight: 4 }} />Linked
                </span>
              )}
            </div>
            <div className="card-body">
              {tenant?.group_code ? (
                /* ── Currently in a group ── */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>GROUP NAME</div>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{tenant.group_name || '—'}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>GROUP CODE</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <code style={{
                          fontWeight: 700, fontSize: 14, letterSpacing: 1,
                          background: 'var(--primary-light)', color: 'var(--primary)',
                          padding: '2px 10px', borderRadius: 6,
                        }}>
                          {tenant.group_code}
                        </code>
                        <button
                          className="btn btn-outline btn-icon btn-sm"
                          title="Copy code"
                          onClick={() => {
                            navigator.clipboard.writeText(tenant.group_code);
                            showToast('Group code copied', 'success');
                          }}
                        >
                          <i className="fas fa-copy" />
                        </button>
                      </div>
                    </div>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                    Share the group code with admins of other outlets so they can link their outlet to this group.
                    All linked outlets will appear in <strong>Group Dashboard</strong>.
                  </p>
                  <div>
                    <button
                      className="btn btn-outline btn-sm"
                      style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                      onClick={handleLeaveGroup}
                      disabled={groupLoading}
                    >
                      {groupLoading
                        ? <><div className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} /> Removing…</>
                        : <><i className="fas fa-unlink" /> Remove from Group</>}
                    </button>
                  </div>
                </div>
              ) : groupMode === null ? (
                /* ── Not in a group – choose action ── */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                    This outlet is not part of any group. Create a new group or join an existing one using a group code.
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-primary btn-sm" onClick={() => setGroupMode('create')}>
                      <i className="fas fa-plus" /> Create New Group
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => setGroupMode('join')}>
                      <i className="fas fa-link" /> Join Existing Group
                    </button>
                  </div>
                </div>
              ) : groupMode === 'create' ? (
                /* ── Create group form ── */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                    Give your group a name (e.g. "My Restaurant Chain"). A unique code will be generated — share it with other outlet admins.
                  </p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      className="form-input"
                      placeholder="Group name, e.g. My Restaurant Chain"
                      value={groupName}
                      onChange={e => setGroupName(e.target.value)}
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <button className="btn btn-primary btn-sm" onClick={handleCreateGroup} disabled={groupLoading}>
                      {groupLoading
                        ? <><div className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} /> Creating…</>
                        : 'Create Group'}
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => { setGroupMode(null); setGroupName(''); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                /* ── Join group form ── */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
                    Enter the group code from the outlet that created the group (e.g. <code>XKCD-9182</code>).
                  </p>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      className="form-input"
                      placeholder="Group code, e.g. XKCD-9182"
                      value={groupCodeInput}
                      onChange={e => setGroupCodeInput(e.target.value.toUpperCase())}
                      style={{ flex: 1, minWidth: 200, fontFamily: 'monospace', letterSpacing: 1 }}
                    />
                    <button className="btn btn-primary btn-sm" onClick={handleLinkGroup} disabled={groupLoading}>
                      {groupLoading
                        ? <><div className="spinner" style={{ width: 11, height: 11, borderWidth: 2 }} /> Linking…</>
                        : 'Link Outlet'}
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={() => { setGroupMode(null); setGroupCodeInput(''); }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Outlet View ──────────────────────────────────────────────────── */}
          {outlets.length > 0 && (
            <div className="card">
              <div className="card-header">
                <div>
                  <h3 style={{ margin: 0 }}>Outlet View</h3>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    Scope Dashboard, Attendance, Requests and Payroll to one outlet, or view everything combined
                  </div>
                </div>
              </div>
              <div className="card-body">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>CURRENTLY VIEWING</div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {selectedOutletName || 'All Outlets (Combined)'}
                    </div>
                  </div>
                  <button className="btn btn-outline btn-sm" style={{ marginLeft: 'auto' }} onClick={() => navigate('/outlets')}>
                    <i className="fas fa-exchange-alt" /> Change Outlet View
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Task notification channels (Slack / email / WhatsApp) ─────────── */}
          {['admin', 'superadmin'].includes(profile?.role) && isEnabled('tasks') && isEnabled('task_reminders') && <NotificationChannelsCard tenantId={tenant?.id} />}

        </div>
      </div>
    </>
  );
}

