import React from 'react';
import { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams, useLocation, useNavigate } from 'react-router-dom';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import Pagination from '@/components/Pagination';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useOutletView } from '@/context/OutletViewContext';
import { useDebounce } from '@/hooks/useDebounce';
import {
  listEmployees, listDivisions, listDistinctDepartments, createEmployee, updateEmployee,
  setEmployeeStatus, removeEmployee, EMPLOYEE_PAGE_SIZE, listActiveEmployees,
  setEmployeeWithholding, resetEmployeePassword, updateEmployeeEmail, updateEmployeePhone,
} from '@/services/employeeService';
import { fetchGroupDashboard, transferEmployee, fetchTransferHistory } from '@/services/groupService';
import { listEmployeePromotions, recordPromotion } from '@/services/promotionService';
import {
  listDepartments, listShifts, transferEmployeeOutlet, fetchOutletTransferHistory,
  listUnassignedEmployees, bulkAssignOutlet,
  listProfileOutletAccess, setProfileOutletAccess,
} from '@/services/tenantService';
import { supabase } from '@/lib/supabase';
import { fmt, getInitials, getAvatarColor, todayStr, fullName, resolveEmployeeCredentials, isRaniwalaTenant, isHrSupport } from '@/lib/helpers';
import { parseImportFile, runBulkImport, downloadSampleCSV, resolveLoginEmail, isValidEmail } from '@/lib/employeeImport';
import { startProcess as startOnboardingProcess } from '@/services/onboardingService';
import { advanceReferralStage } from '@/services/hiringService';
import { lookupEsslCode, refreshEsslFromMachine, splitMachineName } from '@/services/esslService';
import { withSalaries, setEmployeeSalary } from '@/services/employeeSalaryService';
import { listLeaveTypes, allocateLeave } from '@/services/leaveLedgerService';
import { listL1Assignments, setEmployeeL1 } from '@/services/l1Service';
import SalaryHistoryModal from '@/components/payroll/SalaryHistoryModal';

// Salary-private tenant (Raniwala): HR types both the gross and the CTC; the
// CTC is never worked out from the gross. A box left as it was opened is sent
// as null (keep what is stored); only a box the user emptied clears it.
const salaryField = (value, original) => {
  if (value !== '' && value != null) return parseFloat(value) || 0;
  return original !== '' && original != null ? 0 : null;
};

function buildNewEmployeeId(currentId, destLocationCode) {
  if (!currentId || currentId.length < 4) return currentId || '';
  const outletCode = currentId.slice(0, 2);
  const suffix     = currentId.slice(4);
  const locCode    = (destLocationCode || '').slice(0, 2).toUpperCase().padEnd(2, 'X');
  return outletCode + locCode + suffix;
}

function TransferModal({ show, onClose, employee, currentTenantId, groupCode, onTransferred }) {
  const [outlets,       setOutlets]       = useState([]);
  const [destId,        setDestId]        = useState('');
  const [newEmpId,      setNewEmpId]      = useState('');
  const [newLocation,   setNewLocation]   = useState('');
  const [notes,         setNotes]         = useState('');
  const [saving,        setSaving]        = useState(false);
  const [loadingOutlets, setLoadingOutlets] = useState(false);

  useEffect(() => {
    if (!show || !groupCode) return;
    setDestId(''); setNewEmpId(''); setNewLocation(''); setNotes('');
    setLoadingOutlets(true);
    fetchGroupDashboard(groupCode).then(({ data }) => {
      setOutlets((data?.outlets || []).filter(o => o.id !== currentTenantId));
      setLoadingOutlets(false);
    });
  }, [show, groupCode, currentTenantId]);

  const handleDestChange = (id) => {
    setDestId(id);
    const dest = outlets.find(o => o.id === id);
    if (dest) {
      setNewEmpId(buildNewEmployeeId(employee?.employee_id || '', dest.location_code));
      setNewLocation(dest.company_name || '');
    }
  };

  const handleSave = async () => {
    if (!destId) return showToast('Select destination branch', 'warning');
    setSaving(true);
    const { error } = await transferEmployee({
      profileId:      employee.id,
      fromTenantId:   currentTenantId,
      toTenantId:     destId,
      newEmployeeId:  newEmpId,
      outletLocation: newLocation,
      notes,
    });
    setSaving(false);
    if (error) return showToast('Transfer failed: ' + error.message, 'error');
    showToast(`${employee.first_name} transferred successfully`, 'success');
    onClose();
    onTransferred();
  };

  return (
    <Modal show={show} onClose={onClose} title="Transfer Employee" width="480px"
      footer={<>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving || !destId}>
          {saving ? <><div className="spinner" style={{ width: 15, height: 15, borderWidth: 2 }} /> Transferring…</> : <><i className="fas fa-exchange-alt" /> Transfer</>}
        </button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--primary-light)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15 }}>
            {getInitials(employee?.first_name, employee?.last_name)}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{fullName(employee)}</div>
            {employee?.employee_id && (
              <code style={{ fontSize: 11, color: 'var(--primary)', background: 'var(--primary-light)', padding: '1px 6px', borderRadius: 4 }}>
                {employee.employee_id}
              </code>
            )}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Transfer To Branch *</label>
          {loadingOutlets ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2, display: 'inline-block', marginRight: 6 }} />Loading branches…</div>
          ) : (
            <select className="form-select" value={destId} onChange={(e) => handleDestChange(e.target.value)}>
              <option value="">Select destination branch</option>
              {outlets.map(o => (
                <option key={o.id} value={o.id}>{o.company_name}{o.location_code ? ` (${o.location_code})` : ''}</option>
              ))}
            </select>
          )}
        </div>

        {destId && (
          <>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">New Employee ID</label>
                <input className="form-input" value={newEmpId} onChange={e => setNewEmpId(e.target.value.toUpperCase())}
                  placeholder="Auto-computed from current ID + new location code"
                  style={{ fontFamily: 'monospace', fontWeight: 700, letterSpacing: 1 }}
                />
                <div className="form-hint">First 2 chars = outlet code, next 2 = location code, rest = original suffix.</div>
              </div>
              <div className="form-group">
                <label className="form-label">Outlet Location Name</label>
                <input className="form-input" value={newLocation} onChange={e => setNewLocation(e.target.value)} placeholder="e.g. Mumbai" />
              </div>
            </div>
          </>
        )}

        <div className="form-group">
          <label className="form-label">Transfer Notes</label>
          <input className="form-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional reason for transfer" />
        </div>

        <div style={{ background: 'var(--warning-light)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--warning)', display: 'flex', gap: 8 }}>
          <i className="fas fa-info-circle" style={{ marginTop: 1, flexShrink: 0 }} />
          Employee's historical attendance, payroll, and leaves remain in the current branch. All future records will be created under the new branch.
        </div>
      </div>
    </Modal>
  );
}

function TransferHistoryModal({ show, onClose, employee }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!show || !employee?.id) return;
    setLoading(true);
    fetchTransferHistory(employee.id).then(({ data }) => {
      setHistory(data || []);
      setLoading(false);
    });
  }, [show, employee?.id]);

  return (
    <Modal show={show} onClose={onClose} title="Transfer History" width="560px"
      footer={<button className="btn btn-outline" onClick={onClose}>Close</button>}
    >
      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />Loading history…
        </div>
      ) : history.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          <i className="fas fa-history" style={{ fontSize: 24, marginBottom: 10, display: 'block' }} />
          No transfer history for {fullName(employee)}.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {history.map((h, i) => (
            <div key={h.id || i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{h.from_branch}</span>
                  <i className="fas fa-arrow-right" style={{ color: 'var(--primary)', fontSize: 11 }} />
                  <span style={{ color: 'var(--primary)' }}>{h.to_branch}</span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {new Date(h.transferred_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
                {h.from_employee_id && (
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>Old ID: </span>
                    <code style={{ background: 'var(--bg)', padding: '1px 5px', borderRadius: 4 }}>{h.from_employee_id}</code>
                  </div>
                )}
                {h.to_employee_id && (
                  <div>
                    <span style={{ color: 'var(--text-muted)' }}>New ID: </span>
                    <code style={{ background: 'var(--primary-light)', color: 'var(--primary)', padding: '1px 5px', borderRadius: 4 }}>{h.to_employee_id}</code>
                  </div>
                )}
              </div>
              {h.notes && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>{h.notes}</div>}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>By {h.transferred_by}</div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function OutletTransferModal({ show, onClose, employee, tenantId, outlets, transferredBy, onTransferred }) {
  const [destId, setDestId] = useState('');
  const [notes,  setNotes]  = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!show) return;
    setDestId(''); setNotes('');
  }, [show]);

  const destinations = outlets.filter((o) => o.id !== employee?.outlet_id);

  const handleSave = async () => {
    if (!destId) return showToast('Select destination outlet', 'warning');
    const dest = outlets.find((o) => o.id === destId);
    const fromOutlet = outlets.find((o) => o.id === employee?.outlet_id);
    setSaving(true);
    const { error } = await transferEmployeeOutlet({
      tenantId,
      profileId: employee.id,
      toOutletId: destId,
      toOutletName: dest?.name || '',
      fromOutletId: employee?.outlet_id || null,
      fromOutletName: fromOutlet?.name || employee?.outlet_location || '',
      transferredBy,
      notes,
    });
    setSaving(false);
    if (error) return showToast('Transfer failed: ' + error.message, 'error');
    showToast(`${employee.first_name} moved to ${dest?.name}`, 'success');
    onClose();
    onTransferred();
  };

  return (
    <Modal show={show} onClose={onClose} title="Transfer to Outlet" width="480px"
      footer={<>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving || !destId}>
          {saving ? <><div className="spinner" style={{ width: 15, height: 15, borderWidth: 2 }} /> Transferring…</> : <><i className="fas fa-store-alt" /> Transfer</>}
        </button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--primary-light)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 15 }}>
            {getInitials(employee?.first_name, employee?.last_name)}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{fullName(employee)}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Currently: {outlets.find((o) => o.id === employee?.outlet_id)?.name || employee?.outlet_location || 'No outlet assigned'}
            </div>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Transfer To Outlet *</label>
          <select className="form-select" value={destId} onChange={(e) => setDestId(e.target.value)}>
            <option value="">Select destination outlet</option>
            {destinations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Transfer Notes</label>
          <input className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional reason for transfer" />
        </div>

        <div style={{ background: 'var(--warning-light)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--warning)', display: 'flex', gap: 8 }}>
          <i className="fas fa-info-circle" style={{ marginTop: 1, flexShrink: 0 }} />
          Employee's historical attendance, payroll, and leaves stay recorded as-is. This transfer is saved to their outlet history.
        </div>
      </div>
    </Modal>
  );
}

function OutletTransferHistoryModal({ show, onClose, employee }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!show || !employee?.id) return;
    setLoading(true);
    fetchOutletTransferHistory(employee.id).then(({ data }) => {
      setHistory(data || []);
      setLoading(false);
    });
  }, [show, employee?.id]);

  return (
    <Modal show={show} onClose={onClose} title="Outlet Transfer History" width="560px"
      footer={<button className="btn btn-outline" onClick={onClose}>Close</button>}
    >
      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />Loading history…
        </div>
      ) : history.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          <i className="fas fa-history" style={{ fontSize: 24, marginBottom: 10, display: 'block' }} />
          No outlet transfer history for {fullName(employee)}.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {history.map((h) => (
            <div key={h.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{h.from_outlet_name || 'No outlet'}</span>
                  <i className="fas fa-arrow-right" style={{ color: 'var(--primary)', fontSize: 11 }} />
                  <span style={{ color: 'var(--primary)' }}>{h.to_outlet_name}</span>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {new Date(h.transferred_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                </span>
              </div>
              {h.notes && <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>{h.notes}</div>}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                By {h.transferred_by_profile ? fullName(h.transferred_by_profile) : 'Unknown'}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function BulkAssignOutletModal({ show, onClose, tenantId, outlets, transferredBy, onAssigned }) {
  const [employees, setEmployees] = useState([]);
  const [selected,  setSelected]  = useState(new Set());
  const [destId,    setDestId]    = useState('');
  const [notes,     setNotes]     = useState('');
  const [loading,   setLoading]   = useState(false);
  const [saving,    setSaving]    = useState(false);

  useEffect(() => {
    if (!show || !tenantId) return;
    setDestId(''); setNotes('');
    setLoading(true);
    listUnassignedEmployees(tenantId).then(({ data }) => {
      setEmployees(data || []);
      setSelected(new Set((data || []).map((e) => e.id)));
      setLoading(false);
    });
  }, [show, tenantId]);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === employees.length ? new Set() : new Set(employees.map((e) => e.id))));
  };

  const handleSave = async () => {
    if (!destId) return showToast('Select destination outlet', 'warning');
    if (selected.size === 0) return showToast('Select at least one employee', 'warning');
    const dest = outlets.find((o) => o.id === destId);
    setSaving(true);
    const { error } = await bulkAssignOutlet({
      tenantId,
      profileIds: [...selected],
      toOutletId: destId,
      toOutletName: dest?.name || '',
      transferredBy,
      notes,
    });
    setSaving(false);
    if (error) return showToast('Bulk assign failed: ' + error.message, 'error');
    showToast(`${selected.size} employee(s) assigned to ${dest?.name}`, 'success');
    onClose();
    onAssigned();
  };

  return (
    <Modal show={show} onClose={onClose} title="Assign Unassigned Employees to an Outlet" width="560px"
      footer={<>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving || !destId || selected.size === 0}>
          {saving ? <><div className="spinner" style={{ width: 15, height: 15, borderWidth: 2 }} /> Assigning…</> : <><i className="fas fa-people-arrows" /> Assign {selected.size > 0 ? `(${selected.size})` : ''}</>}
        </button>
      </>}
    >
      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />Loading unassigned employees…
        </div>
      ) : employees.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          <i className="fas fa-check-circle" style={{ fontSize: 24, marginBottom: 10, display: 'block', color: 'var(--success)' }} />
          Every active employee already has an outlet assigned.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="form-group">
            <label className="form-label">Assign To Outlet *</label>
            <select className="form-select" value={destId} onChange={(e) => setDestId(e.target.value)}>
              <option value="">Select outlet</option>
              {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Notes</label>
            <input className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional — e.g. initial outlet setup" />
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label className="form-label" style={{ margin: 0 }}>Unassigned Employees ({employees.length})</label>
              <button className="btn btn-outline btn-sm" onClick={toggleAll} type="button">
                {selected.size === employees.length ? 'Deselect All' : 'Select All'}
              </button>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
              {employees.map((e) => (
                <label key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--border-light)', cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                  <span style={{ flex: 1 }}>{fullName(e)}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{e.department || '—'}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── L1 SPOCs (Raniwala) ─────────────────────────────────────────────────────
// Who is whose L1 (profiles.l1_spoc_id, 20261024_1), and moving people from
// one L1 to another. Left: the L1s; right: the picked L1's people, tick and
// move. New links are set on the Add / Edit Employee form.
function L1Avatar({ p, size = 34 }) {
  return (
    <div className="emp-avatar" style={{ width: size, height: size, flexShrink: 0, background: `linear-gradient(135deg, ${getAvatarColor(p.id)})` }}>
      {getInitials(p.first_name, p.last_name)}
    </div>
  );
}

function L1SpocModal({ show, onClose, tenantId, employees, onChanged }) {
  const [members,  setMembers]  = useState([]);
  const [l1s,      setL1s]      = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [saving,   setSaving]   = useState(false);
  const [activeId, setActiveId] = useState(null);
  const [ticked,   setTicked]   = useState(new Set());
  const [moveTo,   setMoveTo]   = useState('');
  const [search,   setSearch]   = useState('');

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    const { members: m, l1s: l, error } = await listL1Assignments(tenantId);
    if (error) showToast('Could not load L1s: ' + error.message, 'error');
    setMembers(m);
    setL1s(l);
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { if (show) { setSearch(''); load(); } }, [show, load]);

  const peopleOf = (id) => members.filter((m) => m.l1_spoc_id === id);
  const q = search.trim().toLowerCase();
  const hit = (p) => !q || `${fullName(p)} ${p.employee_id || ''}`.toLowerCase().includes(q);
  // An L1 stays listed when the search matches them or anyone under them.
  const shownL1s = l1s.filter((l) => hit(l) || peopleOf(l.id).some(hit));
  const active = shownL1s.find((l) => l.id === activeId) || shownL1s[0] || null;
  const activePeople = active ? peopleOf(active.id).filter((p) => hit(active) || hit(p)) : [];

  // Changing L1 or search starts a fresh selection.
  useEffect(() => { setTicked(new Set()); setMoveTo(''); }, [active?.id, search]);

  const l1Ids = new Set(l1s.map((l) => l.id));
  const tickedIds = [...ticked];
  const allTicked = activePeople.length > 0 && activePeople.every((p) => ticked.has(p.id));
  const toggle = (id) => setTicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const move = async () => {
    if (!tickedIds.length || !moveTo) return;
    const target = moveTo === '__none__' ? null : moveTo;
    setSaving(true);
    const { error } = await setEmployeeL1(tickedIds, target);
    setSaving(false);
    if (error) return showToast('Could not change the L1: ' + error.message, 'error');
    const to = target ? [...l1s, ...employees].find((p) => p.id === target) : null;
    const who = tickedIds.length === 1 ? '1 employee' : `${tickedIds.length} employees`;
    showToast(to ? `${who} moved to ${fullName(to)}` : `L1 removed for ${who}`, 'success');
    setTicked(new Set());
    setMoveTo('');
    load();
    onChanged?.();
  };

  const sub = (p) => [p.designation, p.department].filter(Boolean).join(' · ') || '—';

  return (
    <Modal show={show} onClose={onClose} title="L1 SPOCs" width="920px"
      footer={<button className="btn btn-outline" onClick={onClose}>Close</button>}
    >
      {loading && !l1s.length ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          <div className="spinner" style={{ margin: '0 auto 12px' }} />Loading L1s…
        </div>
      ) : l1s.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          <i className="fas fa-user-friends" style={{ fontSize: 24, marginBottom: 10, display: 'block' }} />
          No L1s yet. Pick an L1 SPOC on an employee's Add / Edit Employee form.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <span className="badge badge-info">{l1s.length} L1{l1s.length === 1 ? '' : 's'}</span>
              <span className="badge badge-secondary">{members.length} people under an L1</span>
            </div>
            <input
              className="form-input"
              style={{ marginLeft: 'auto', maxWidth: 280 }}
              placeholder="🔍 Find an employee or L1 by name / code"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {/* L1 list */}
            <div style={{ flex: '1 1 240px', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 460, overflowY: 'auto' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>L1 SPOC</div>
              {shownL1s.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: 8 }}>No match.</div>}
              {shownL1s.map((l) => {
                const on = active?.id === l.id;
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setActiveId(l.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', width: '100%',
                      padding: '10px 12px', borderRadius: 8, cursor: 'pointer', font: 'inherit', color: 'inherit',
                      border: `1px solid ${on ? 'var(--primary)' : 'var(--border)'}`,
                      background: on ? 'var(--primary-light)' : 'var(--surface)',
                    }}
                  >
                    <L1Avatar p={l} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{fullName(l)}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {l.employee_id ? `#${l.employee_id}` : ''}
                        {l.status !== 'Active' && <span style={{ color: 'var(--danger)', fontWeight: 600 }}> · Inactive</span>}
                      </div>
                    </div>
                    <span className="badge badge-info" title="People under this L1">{peopleOf(l.id).length}</span>
                  </button>
                );
              })}
            </div>

            {/* People under the picked L1 */}
            {active && (
              <div style={{ flex: '3 1 380px', minWidth: 0, border: '1px solid var(--border)', borderRadius: 8, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                  <L1Avatar p={active} size={40} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>
                      {fullName(active)}{active.employee_id ? ` (#${active.employee_id})` : ''}
                      {active.status !== 'Active' && <span className="badge badge-danger" style={{ marginLeft: 8 }}>Inactive — move their people</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {[active.designation, active.department, active.outlet_location].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                </div>

                <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', fontSize: 12, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={allTicked}
                    onChange={() => setTicked(allTicked ? new Set() : new Set(activePeople.map((p) => p.id)))}
                  />
                  Select all · {activePeople.length} {activePeople.length === 1 ? 'person' : 'people'} under this L1
                </label>

                <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {activePeople.map((p) => (
                    <label key={p.id} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', cursor: 'pointer',
                      borderBottom: '1px solid var(--border)', background: ticked.has(p.id) ? 'var(--primary-light)' : undefined,
                    }}>
                      <input type="checkbox" checked={ticked.has(p.id)} onChange={() => toggle(p.id)} />
                      <L1Avatar p={p} size={30} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{fullName(p)}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub(p)}</div>
                      </div>
                      {p.employee_id && <code style={{ fontSize: 11, background: 'var(--bg)', padding: '2px 6px', borderRadius: 4 }}>#{p.employee_id}</code>}
                    </label>
                  ))}
                </div>

                {/* Move bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '12px 14px', background: 'var(--bg)', borderRadius: '0 0 8px 8px' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, marginRight: 'auto' }}>
                    {tickedIds.length ? `${tickedIds.length} selected` : <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>Tick people to move them</span>}
                  </span>
                  <select
                    className="form-select"
                    style={{ width: 'auto', minWidth: 220 }}
                    value={moveTo}
                    disabled={!tickedIds.length || saving}
                    onChange={(e) => setMoveTo(e.target.value)}
                  >
                    <option value="">Move to L1…</option>
                    <optgroup label="Current L1s">
                      {l1s.filter((l) => l.id !== active.id && l.status === 'Active' && !ticked.has(l.id)).map((l) => (
                        <option key={l.id} value={l.id}>{fullName(l)}{l.employee_id ? ` (#${l.employee_id})` : ''} — {peopleOf(l.id).length} people</option>
                      ))}
                    </optgroup>
                    <optgroup label="Make someone else L1">
                      {employees.filter((e) => !l1Ids.has(e.id) && !ticked.has(e.id)).map((e) => (
                        <option key={e.id} value={e.id}>{fullName(e)}{e.employee_id ? ` (#${e.employee_id})` : ''}</option>
                      ))}
                    </optgroup>
                    <option value="__none__">No L1 (remove)</option>
                  </select>
                  <button className="btn btn-primary" disabled={!tickedIds.length || !moveTo || saving} onClick={move}>
                    {saving ? 'Saving…' : moveTo === '__none__' ? 'Remove L1' : 'Move'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

function TempPasswordModal({ show, onClose, empName, username, password, passwordLabel = 'Temporary Password', note = '' }) {
  const [copied, setCopied] = useState(false);
  const hasPassword = !!password;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(`Username: ${username}\nPassword: ${password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Modal show={show} onClose={onClose} title="Employee Credentials" width="440px"
      footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}
    >
      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 44, color: 'var(--success)', marginBottom: 12 }}>
          <i className="fas fa-user-shield" />
        </div>
        <h3 style={{ marginBottom: 6 }}>{empName}</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Share these login credentials with the employee
        </p>
      </div>
      <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius-md)', padding: 16, position: 'relative' }}>
        {hasPassword && (
          <button
            onClick={copyToClipboard}
            style={{
              position: 'absolute', right: 10, top: 10, border: 'none', background: 'none',
              cursor: 'pointer', color: copied ? 'var(--success)' : 'var(--text-muted)'
            }}
            title="Copy to clipboard"
          >
            <i className={`fas ${copied ? 'fa-check' : 'fa-copy'}`} />
          </button>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, fontSize: 13 }}>
          <span style={{ color: 'var(--text-muted)' }}>Username</span>
          <strong>{username}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
          <span style={{ color: 'var(--text-muted)' }}>{passwordLabel}</span>
          <strong style={{ fontFamily: 'monospace', color: hasPassword ? 'var(--primary)' : 'var(--warning)' }}>
            {hasPassword ? password : '—'}
          </strong>
        </div>
      </div>
      {note ? (
        <p style={{ fontSize: 11, color: 'var(--warning)', marginTop: 12, textAlign: 'center' }}>
          <i className="fas fa-exclamation-triangle" /> {note}
        </p>
      ) : (
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12, textAlign: 'center' }}>
          <i className="fas fa-info-circle" style={{ color: 'var(--primary)' }} />{' '}
          You can view these credentials anytime from the employee list.
        </p>
      )}
    </Modal>
  );
}

const EMPTY_FORM = {
  first_name: '', middle_name: '', last_name: '', email: '', phone: '',
  department: '', designation: '', division: '', divisionNew: '', join_date: '', date_of_birth: '', ctc: '',
  salary_ctc: '', actual_gross: '',
  bank_acc: '', pan: '', aadhar: '', role: 'employee',
  weekly_holiday: 'Sunday', shift_id: '', leave_allocation: 0, opening_earned_leave: '',
  country: 'India', passport_number: '', work_permit_number: '', work_permit_expiry: '',
  compliance_enabled: false,
  pf_enabled: false, pf_number: '', pf_amount: '',
  esic_enabled: false, esic_number: '', esic_amount: '',
  employee_id: '', outlet_location: '', outlet_id: '', probation_months: 0, manager_id: '', hod_id: '', l1_spoc_id: '',
  essl_employee_code: '', overtime_applicable: false, comp_off_eligible: false,
};

// Label an employee's role in the Reporting Manager / HOD dropdowns.
const roleLabel = (role) => ({
  admin: 'HR', management: 'Management', hod: 'HOD', manager: 'Manager',
}[role] || 'Employee');

function getComplianceStatus(emp) {
  if (!emp.compliance_enabled) return 'na';
  if (emp.pf_enabled && emp.pf_number) return 'compliant';
  return 'partial';
}

const COMPLIANCE_BADGE = {
  compliant: { label: 'PF Enrolled', cls: 'badge-success' },
  partial:   { label: 'Compliance',  cls: 'badge-warning' },
  na:        { label: 'N/A',         cls: 'badge-secondary' },
};

// What the punch machine has for the code typed in the Add/Edit form. Found:
// every machine detail (name, department, location, shift, left date,
// enrolled/first punch, totals) plus the last 10 punch days — next to what
// CrewCore recorded when the code already belongs to an employee. Not found:
// says so, and that this code's upcoming punches will land here and in
// attendance on their own once it punches. Codes are unique per employee.
const UPC = (v) => (v == null || v === '' ? '—' : String(v).toUpperCase());
const fmtDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase() : '—');

function EsslLookupCard({ lookup, editId, onFillName, onUseCode, onCheckNow, showUseCode, showFillName }) {
  if (!lookup) return null;
  const box = (tone, children) => (
    <div style={{ marginTop: 8, padding: '10px 12px', borderRadius: 8, border: `1px solid var(--${tone})`, background: `var(--${tone}-light)`, fontSize: 12 }}>
      {children}
    </div>
  );
  if (lookup.checking) {
    return box('primary', <><i className="fas fa-spinner fa-spin" /> Checking code {lookup.code} on the punch machine…</>);
  }
  if (lookup.notFound) {
    return box('warning', <>
      <div style={{ fontWeight: 700 }}><i className="fas fa-fingerprint" /> CODE {lookup.code} IS NOT ON THE PUNCH MACHINE YET</div>
      <div style={{ marginTop: 2 }}>
        {lookup.checkedLive ? 'Checked the machine live just now. ' : ''}
        Save the employee with this code — as soon as {lookup.code} is enrolled and punches, the upcoming records show up here, on the ESSL Records page and in attendance automatically (checked every 2 minutes).
      </div>
      {onCheckNow && <button type="button" className="btn btn-sm btn-outline" style={{ marginTop: 6 }} onClick={onCheckNow}><i className="fas fa-rotate" /> Check machine again</button>}
    </>);
  }
  const m = lookup.machine || {};
  const s = lookup.stats;
  const days = lookup.recentDays || [];
  const takenByOther = lookup.holder && lookup.holder.id !== editId;
  const isThisEmployee = lookup.holder && lookup.holder.id === editId;
  return box(takenByOther ? 'danger' : 'success', <>
    <div style={{ fontWeight: 700, marginBottom: 4 }}>
      <i className="fas fa-fingerprint" /> FOUND ON PUNCH MACHINE · CODE {lookup.code}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '2px 12px' }}>
      <div><span style={{ color: 'var(--text-muted)' }}>NAME:</span> <strong>{UPC(m.name)}</strong></div>
      <div><span style={{ color: 'var(--text-muted)' }}>DEPARTMENT:</span> {UPC(m.department)}</div>
      <div><span style={{ color: 'var(--text-muted)' }}>LOCATION:</span> {UPC(m.location)}</div>
      <div><span style={{ color: 'var(--text-muted)' }}>SHIFT:</span> {UPC(m.shift)}</div>
      <div><span style={{ color: 'var(--text-muted)' }}>STATUS:</span> {m.left_on ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>LEFT {fmtDay(m.left_on)}</span> : 'ACTIVE'}</div>
      <div><span style={{ color: 'var(--text-muted)' }}>DAYS PUNCHED:</span> {s ? `${s.days_punched} (${s.days_this_month} THIS MONTH)` : '0'}</div>
      <div><span style={{ color: 'var(--text-muted)' }}>FIRST PUNCH:</span> {fmtDay(s?.first_date)}</div>
      <div><span style={{ color: 'var(--text-muted)' }}>LAST PUNCH:</span> {fmtDay(s?.last_date)}</div>
    </div>
    {days.length > 0 && (
      <table style={{ width: '100%', marginTop: 8, fontSize: 11, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
            <th>DATE</th><th>IN</th><th>OUT</th><th>PUNCHES</th>{lookup.holder && <th>CREWCORE</th>}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date} style={{ borderTop: '1px solid var(--border)' }}>
              <td>{fmtDay(d.date)}</td>
              <td>{d.first_in || '—'}</td>
              <td>{d.last_out || <span style={{ color: 'var(--warning)' }}>NO OUT</span>}</td>
              <td>{d.punch_count > 0 ? d.punch_count : '—'}</td>
              {lookup.holder && <td>{d.crewcore ? `${UPC(d.crewcore.status)}${d.crewcore.total_hours ? ` · ${d.crewcore.total_hours}H` : ''}` : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    )}
    {takenByOther && (
      <div style={{ marginTop: 6, color: 'var(--danger)', fontWeight: 600 }}>
        Already linked to {`${lookup.holder.first_name || ''} ${lookup.holder.last_name || ''}`.trim().toUpperCase()} (EMP {lookup.holder.employee_id || '—'}). A code can belong to one employee only.
      </div>
    )}
    {!lookup.holder && (
      <div style={{ marginTop: 6 }}>Not linked to anyone yet — on save, all of these punches (from the go-live date) are added to this employee's attendance straight away.</div>
    )}
    {isThisEmployee && (
      <div style={{ marginTop: 6 }}>Linked to this employee — new punches sync automatically every 2 minutes.</div>
    )}
    {!takenByOther && (showFillName || showUseCode || onCheckNow) && (
      <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {showUseCode && <button type="button" className="btn btn-sm btn-outline" onClick={onUseCode}>Use as ESSL code</button>}
        {showFillName && m.name && <button type="button" className="btn btn-sm btn-outline" onClick={onFillName}>Fill name from machine</button>}
        {onCheckNow && <button type="button" className="btn btn-sm btn-outline" onClick={onCheckNow}><i className="fas fa-rotate" /> Check machine now</button>}
      </div>
    )}
  </>);
}

export default function EmployeesPage() {
  const { tenant, profile } = useAuth();
  const isManager = profile?.role === 'manager';
  // Raniwala doesn't want Leave/CTC/Compliance surfaced on this list — those
  // stay payroll-only for them, unlike every other tenant.
  const showFinanceCols = !isManager && !isRaniwalaTenant(tenant);
  // HR Support (no payroll) adds employees, so it gets the whole employee form
  // incl. salary (20261021_8), but no increments, salary history or
  // withholding here.
  const hrSupport = isHrSupport(profile);
  // Salary in employee_salaries (HR + the employee only), not on the profile —
  // tenants.salary_private, migration 20261014_4.
  const salaryPrivate = !!tenant?.salary_private;
  const [salaryEmp, setSalaryEmp] = useState(null);

  // Outlet scoping — follows whatever outlet HR currently has selected app-wide;
  // selectOutlet lets HR switch it right here instead of going to the Outlets page.
  const { selectedOutletId: outletId, selectedOutletName: outletName, outlets, selectOutlet } = useOutletView();

  // ---- filter state ----
  // Seeded from ?q= so the global header search can land HR directly on a
  // pre-filtered list (e.g. clicking an employee result there) rather than
  // requiring them to retype the name here.
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [deptFilter, setDeptFilter] = useState('');
  const [divisionFilter, setDivisionFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const debouncedSearch = useDebounce(search, 350);

  // ---- pagination ----
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const totalPages = Math.max(1, Math.ceil(totalCount / EMPLOYEE_PAGE_SIZE));

  // ---- data ----
  const [employees, setEmployees] = useState([]);
  const [managerOptions, setManagerOptions] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [divisions, setDivisions] = useState([]);
  // Department options for the filter bar only, narrowed to the currently
  // selected outlet + division (Outlet -> Division -> Department cascade) —
  // distinct from `departments` above, which stays the full tenant-wide
  // master list for the Add/Edit Employee form's Department dropdown.
  const [filterDepartments, setFilterDepartments] = useState([]);
  // Division options for the Add/Edit Employee form's Division dropdown —
  // narrowed to whatever department is currently selected in that form
  // (Department -> Division cascade), refetched by the effect below whenever
  // `form.department` changes. Distinct from `divisions` above, which is
  // outlet-scoped and feeds the list page's filter bar instead.
  const [allDivisions, setAllDivisions] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [clockedInSet, setClockedInSet] = useState(new Set());
  const [importProgress, setImportProgress] = useState(null); // null | { current, total }
  const [allowPlaceholderLogins, setAllowPlaceholderLogins] = useState(false);
  const [allowMissingCtc, setAllowMissingCtc] = useState(false);

  // ---- modal ----
  const [showModal, setShowModal] = useState(false);
  const [editEmp, setEditEmp] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [tempCreds, setTempCreds] = useState(null);
  const [prefillReferralId, setPrefillReferralId] = useState(null); // set when opened via "Convert to Employee" from the recruitment pipeline
  const [resettingId, setResettingId] = useState(null);
  const [extraOutletIds, setExtraOutletIds] = useState([]); // multi-outlet clock-in access, existing employees only

  // ---- punch-machine lookup (ESSL mirror) ----
  // Raniwala's EMP code IS the ESSL code, so for them the lookup falls back to
  // the EMP code field when the ESSL field is empty.
  const isRaniwala = isRaniwalaTenant(tenant);
  // Punch-machine data is HR-only (RLS + essl-code-lookup enforce it too);
  // managers using this page never get the lookup.
  const isHr = profile?.role === 'admin' || profile?.role === 'superadmin';
  const [esslLookup, setEsslLookup] = useState(null);
  const lookupCode = useDebounce(
    isHr ? String(form.essl_employee_code || (isRaniwala ? form.employee_id : '') || '').trim().toUpperCase() : '',
    400,
  );

  // ---- transfer ----
  const [transferEmp,   setTransferEmp]   = useState(null);
  const [historyEmp,    setHistoryEmp]    = useState(null);
  const [outletTransferEmp, setOutletTransferEmp] = useState(null);
  const [outletHistoryEmp,  setOutletHistoryEmp]  = useState(null);
  const [showBulkAssign, setShowBulkAssign] = useState(false);
  const [showL1Spocs, setShowL1Spocs] = useState(false);

  // ---- promotion history ----
  const [promotionEmp,  setPromotionEmp]  = useState(null);

  // Reset to page 1 whenever filters change
  useEffect(() => { setPage(1); }, [debouncedSearch, deptFilter, divisionFilter, statusFilter, outletId]);

  const fetchData = useCallback(async () => {
    if (!tenant) return;
    setLoading(true);
    try {
      const [empRes, deptRes, divisionRes, filterDeptRes, shiftRes, attRes, managerRes] = await Promise.all([
        listEmployees(tenant.id, { page, search: debouncedSearch, department: deptFilter, division: divisionFilter, status: statusFilter, outletId, managerId: isManager ? profile?.id : '' }),
        listDepartments(tenant.id),
        listDivisions(tenant.id, outletId),
        listDistinctDepartments(tenant.id, { outletId, division: divisionFilter }),
        listShifts(tenant.id),

        supabase
          .from('attendance')
          .select('profile_id, punches(punch_type)')
          .eq('tenant_id', tenant.id)
          .eq('date', todayStr()),
        listActiveEmployees(tenant.id),
      ]);
      const withPay = salaryPrivate && !isManager ? await withSalaries(tenant, empRes) : empRes;
      setEmployees(withPay.data);
      setTotalCount(empRes.count);
      setDepartments((deptRes.data || []).map((d) => d.name));
      const nextDivisions = divisionRes.data || [];
      setDivisions(nextDivisions);
      const nextFilterDepartments = filterDeptRes.data || [];
      setFilterDepartments(nextFilterDepartments);
      // Outlet/division changed and the current selection no longer applies
      // (e.g. switching from Delhi to Mumbai while "B2C (DELHI)" was picked)
      // — clear it back to "All" instead of silently filtering to zero rows.
      if (divisionFilter && !nextDivisions.includes(divisionFilter)) setDivisionFilter('');
      if (deptFilter && !nextFilterDepartments.includes(deptFilter)) setDeptFilter('');
      setShifts(shiftRes.data || []);
      // Reporting Manager / HOD can be any active employee, not just those
      // already holding a manager/HR role.
      setManagerOptions(managerRes.data || []);

      // Build set of profile_ids who are currently clocked in (more ins than outs today)
      const working = new Set();
      (attRes.data || []).forEach((rec) => {
        const ins  = (rec.punches || []).filter((p) => p.punch_type === 'in').length;
        const outs = (rec.punches || []).filter((p) => p.punch_type === 'out').length;
        if (ins > outs) working.add(rec.profile_id);
      });
      setClockedInSet(working);
    } finally {
      setLoading(false);
    }
  }, [tenant, page, debouncedSearch, deptFilter, divisionFilter, statusFilter, outletId, isManager, profile?.id, salaryPrivate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openModal = (emp = null, prefill = null) => {
    setEditEmp(emp);
    setPrefillReferralId(prefill?.referral_id || null);
    // A new employee starts in the outlet being viewed; their code follows it.
    const newForm = { ...EMPTY_FORM, outlet_id: outletId || '' };
    setForm(prefill && !emp ? { ...newForm, ...prefill } : emp ? {
      first_name: emp.first_name || '',
      middle_name: emp.middle_name || '',
      last_name: emp.last_name || '',
      email: emp.email || '',
      phone: emp.phone || '',
      department: emp.department || '',
      designation: emp.designation || '',
      division: emp.division || '',
      divisionNew: '',
      join_date: emp.join_date || '',
      date_of_birth: emp.date_of_birth || '',
      ctc: emp.ctc || '',
      salary_ctc: emp.salary_ctc ?? '',
      actual_gross: emp.actual_gross ?? '',
      bank_acc: emp.bank_acc || '',
      pan: emp.pan || '',
      aadhar: emp.aadhar || '',
      role: emp.role || 'employee',
      weekly_holiday: emp.weekly_holiday || 'Sunday',
      shift_id: emp.shift_id || '',
      leave_allocation: emp.leave_allocation || 0,
      country: emp.country || 'India',
      passport_number: emp.passport_number || '',
      work_permit_number: emp.work_permit_number || '',
      work_permit_expiry: emp.work_permit_expiry || '',
      compliance_enabled: emp.compliance_enabled || false,
      pf_enabled:  emp.pf_enabled  || false,
      pf_number:   emp.pf_number   || '',
      pf_amount:   emp.pf_amount   || '',
      esic_enabled: emp.esic_enabled || false,
      esic_number:  emp.esic_number  || '',
      esic_amount:  emp.esic_amount  || '',
      employee_id:      emp.employee_id      || '',
      outlet_location:  emp.outlet_location  || '',
      probation_months: emp.probation_months ?? 0,
      manager_id: emp.manager_id || '',
      hod_id: emp.hod_id || '',
      l1_spoc_id: emp.l1_spoc_id || '',
      essl_employee_code: emp.essl_employee_code || '',
      overtime_applicable: !!emp.overtime_applicable,
      comp_off_eligible: !!emp.comp_off_eligible,
    } : newForm);
    setExtraOutletIds([]);
    if (emp) listProfileOutletAccess(emp.id).then(({ data }) => setExtraOutletIds(data || []));
    setShowModal(true);
  };

  // Department -> Division cascade for the Add/Edit Employee form: whenever
  // the selected department changes (including on initial open), refetch the
  // Division dropdown scoped to just that department. If the division
  // currently on the form no longer belongs to the newly-fetched list (e.g.
  // HR switched departments mid-edit), clear it back to "Select" instead of
  // silently saving a division that doesn't actually exist under this
  // department — same "clear stale selection" behavior as the filter bar
  // above. This never fires on a fresh initial load with an unrelated
  // division, since the employee's own current department+division combo is
  // always a match for the very query that just ran.
  useEffect(() => {
    if (!tenant || !showModal) return;
    let cancelled = false;
    listDivisions(tenant.id, '', form.department).then(({ data }) => {
      if (cancelled) return;
      const next = data || [];
      setAllDivisions(next);
      setForm((f) => (
        f.division && f.division !== '__new__' && !next.includes(f.division)
          ? { ...f, division: '', divisionNew: '' }
          : f
      ));
    });
    return () => { cancelled = true; };
  }, [tenant, showModal, form.department]);

  // Opened via "Convert to Employee →" on the Recruitment Pipeline page,
  // which navigates here with router state instead of a prop, since the two
  // pages aren't otherwise connected.
  useEffect(() => {
    const prefill = location.state?.prefillFromReferral;
    if (!prefill) return;
    openModal(null, prefill);
    navigate(location.pathname, { replace: true }); // clear router state so a refresh doesn't re-trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opened from the ESSL Records page: ?edit=<profile id> opens that
  // employee's Edit form, ?newEssl=<code> opens Add Employee prefilled with
  // what the punch machine has for that code.
  useEffect(() => {
    const editId = searchParams.get('edit');
    const newEssl = searchParams.get('newEssl');
    if (!tenant || (!editId && !newEssl)) return;
    (async () => {
      if (editId) {
        const { data } = await supabase.from('profiles').select('*').eq('id', editId).eq('tenant_id', tenant.id).maybeSingle();
        // Same salary merge as the list, or the form opens with an empty gross.
        const withPay = data && salaryPrivate ? await withSalaries(tenant, { data: [data] }) : { data: [data] };
        if (data) openModal(withPay.data[0]);
      } else {
        const code = newEssl.trim().toUpperCase();
        const [{ data: found }, { data: depts }] = await Promise.all([lookupEsslCode(tenant.id, code), listDepartments(tenant.id)]);
        const machineDept = found?.machine?.department || '';
        const dept = (depts || []).map((d) => d.name).find((n) => String(n).toUpperCase() === machineDept);
        openModal(null, {
          ...splitMachineName(found?.machine?.name),
          essl_employee_code: code,
          employee_id: isRaniwala ? code : '',
          department: dept || '',
        });
      }
      navigate(location.pathname, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant]);

  // Stored copy first (instant). If the machine isn't known there yet — e.g.
  // enrolled since the last 2-minute poll — ask the machine feed live, then
  // read again. `force` is the card's "Check machine now" button.
  const [esslCheckNonce, setEsslCheckNonce] = useState(0);
  useEffect(() => {
    if (!showModal || !tenant || !lookupCode) { setEsslLookup(null); return; }
    let cancelled = false;
    const force = esslCheckNonce > 0;
    (async () => {
      let { data } = await lookupEsslCode(tenant.id, lookupCode);
      if (cancelled) return;
      if (data?.machine && !force) { setEsslLookup(data); return; }
      setEsslLookup({ code: lookupCode, checking: true, previous: data });
      const { data: live } = await refreshEsslFromMachine(lookupCode);
      if (cancelled) return;
      if (live?.live) ({ data } = await lookupEsslCode(tenant.id, lookupCode));
      if (cancelled) return;
      setEsslLookup(data || { code: lookupCode, notFound: true, checkedLive: !!live?.live, checkedAt: live?.checkedAt });
    })();
    return () => { cancelled = true; };
  }, [showModal, tenant, lookupCode, esslCheckNonce]);
  useEffect(() => { setEsslCheckNonce(0); }, [lookupCode]);

  const saveEmployee = async () => {
    if (!form.first_name || !form.last_name) return showToast('First and last name required', 'error');
    if (!form.email && !form.phone) return showToast('Either email or phone number is required', 'error');
    if (form.phone && !/^\d{10}$/.test(form.phone.trim())) return showToast('Phone number must be exactly 10 digits', 'error');
    if (!form.department) return showToast('Department is mandatory', 'error');
    if (!form.join_date) return showToast('Joining date is mandatory', 'error');
    // TEMP: bank details optional pre-launch — restore mandatory check before go-live.
    if (form.bank_acc && !/^\d{9,18}$/.test(form.bank_acc.trim())) return showToast('Bank account number must be 9-18 digits', 'error');
    if (!form.ctc || parseFloat(form.ctc) <= 0) return showToast(salaryPrivate ? 'Valid Monthly Gross Salary is required' : 'Valid Monthly CTC is required', 'error');
    // Outlet-coded company (IndWell): the employee code comes from the outlet.
    if (!editEmp && !form.outlet_id && outlets.some((o) => o.employee_code_prefix)) {
      return showToast('Select the outlet — the employee code is made from it', 'error');
    }
    // Raniwala: weekly off, holidays and shift come from the outlet, and the
    // EMP code is the ESSL code that brings their machine punches in.
    if (!editEmp && isRaniwala && form.role !== 'admin') {
      if (!form.outlet_id) return showToast('Select the outlet — weekly off, holidays and shift times come from it', 'error');
      if (!(form.employee_id || '').trim()) return showToast('Employee ID is mandatory — it is also their ESSL machine code', 'error');
    }
    if (salaryPrivate && !(parseFloat(form.salary_ctc) > 0) && (!editEmp || Number(editEmp.salary_ctc) > 0)) {
      return showToast('Monthly CTC is required — enter it as well as the gross', 'error');
    }
    if (salaryPrivate && form.actual_gross !== '' && form.actual_gross != null
        && !(parseFloat(form.actual_gross) > 0 && parseFloat(form.actual_gross) < parseFloat(form.ctc))) {
      return showToast('Actual gross must be below the monthly gross (leave it empty if they are paid the full gross)', 'error');
    }
    const openingEarnedLeave = parseFloat(form.opening_earned_leave) || 0;
    if (!editEmp && isRaniwala && (openingEarnedLeave < 0 || openingEarnedLeave > 60 || (openingEarnedLeave * 2) % 1 !== 0)) {
      return showToast('Earned Leave on joining must be 0 to 60 days, in steps of 0.5', 'error');
    }

    const profileData = {
      first_name: form.first_name.trim(),
      middle_name: (form.middle_name || '').trim(),
      last_name: form.last_name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      department: form.department,
      designation: form.designation.trim(),
      // "__new__" is the dropdown's "+ Add new division…" sentinel — resolve
      // it to whatever was typed in the companion text field before saving.
      division: (form.division === '__new__' ? form.divisionNew : form.division).trim(),
      join_date: form.join_date || null,
      date_of_birth: form.date_of_birth || null,
      ctc: parseFloat(form.ctc) || 0,
      bank_acc: form.bank_acc.trim(),
      pan: form.pan.trim(),
      aadhar: form.aadhar.trim(),
      country: (form.country || 'India').trim(),
      passport_number: (form.passport_number || '').trim(),
      work_permit_number: (form.work_permit_number || '').trim(),
      work_permit_expiry: form.work_permit_expiry || null,
      role: form.role || 'employee',
      weekly_holiday: form.weekly_holiday,
      shift_id: form.shift_id || null,
      leave_allocation: parseInt(form.leave_allocation, 10) || 0,
      compliance_enabled: form.compliance_enabled || false,
      pf_enabled:  form.compliance_enabled ? (form.pf_enabled || false) : false,
      // Raniwala's PF / ESIC follow the salary rules, not these ticks, so the
      // UAN and ESIC number are kept as typed (the payslip prints them).
      pf_number:   isRaniwala || (form.compliance_enabled && form.pf_enabled) ? (form.pf_number || '').trim() : '',
      pf_amount:   form.compliance_enabled && form.pf_enabled ? (parseFloat(form.pf_amount) || 0) : 0,
      esic_enabled: form.compliance_enabled && form.pf_enabled ? (form.esic_enabled || false) : false,
      esic_number:  isRaniwala || (form.compliance_enabled && form.pf_enabled && form.esic_enabled) ? (form.esic_number || '').trim() : '',
      esic_amount:  form.compliance_enabled && form.pf_enabled && form.esic_enabled ? (parseFloat(form.esic_amount) || 0) : 0,
      employee_id:      (form.employee_id || '').trim().toUpperCase() || null,
      outlet_location:  (form.outlet_location || '').trim(),
      probation_months: parseInt(form.probation_months, 10) || 0,
      manager_id: form.manager_id || null,
      hod_id: form.hod_id || null,
      essl_employee_code: (form.essl_employee_code || '').trim() || null,
      overtime_applicable: !!form.overtime_applicable,
      comp_off_eligible: !!form.comp_off_eligible,
    };
    // Raniwala L1 SPOC — kept off profileData, which also goes to the
    // create-employee-user edge function; set by the profile update instead.
    const l1SpocId = form.l1_spoc_id || null;
    // Salary-private tenant: the salary is saved separately below (with its
    // CTC, actual gross and history), never on the profile row.
    if (salaryPrivate) profileData.ctc = 0;
    const saveSalary = async (profileId, isNew) => {
      if (!salaryPrivate || !profileId) return;
      const { error: salErr } = await setEmployeeSalary({
        profileId,
        gross: parseFloat(form.ctc) || null,
        ctc: salaryField(form.salary_ctc, editEmp?.salary_ctc),
        actualGross: salaryField(form.actual_gross, editEmp?.actual_gross),
        effectiveFrom: isNew ? (form.join_date || null) : null,
        source: isNew ? 'new employee' : 'employee form',
      });
      if (salErr) showToast('Employee saved, but the salary did not save: ' + salErr.message, 'warning');
    };

    setSaving(true);
    try {
      if (editEmp) {
        const newEmail = profileData.email;
        const newPhone = profileData.phone;
        const emailChanged = newEmail !== (editEmp.email || '');
        const phoneChanged = newPhone !== (editEmp.phone || '');

        if (emailChanged && newEmail && !isValidEmail(newEmail)) {
          throw new Error('Enter a valid email address');
        }
        if (emailChanged && !newEmail) {
          showToast("Email left blank — can't remove a login email here, so it was left unchanged", 'warning');
        }

        // Email/phone double as the employee's Auth login identity, not just
        // profile fields, so each gets its own edge-function call (service-role
        // Auth admin API) instead of the plain profiles update below — and
        // neither one touches their password. Email goes first: if an account
        // that logged in via phone-placeholder is also getting a real email in
        // this same save, updateEmployeePhone needs to see that new email
        // already on the profile row to skip re-deriving the old placeholder.
        if (emailChanged && newEmail) {
          const { error: emailErr } = await updateEmployeeEmail(editEmp.id, newEmail);
          if (emailErr) throw new Error('Failed to update email: ' + emailErr.message);
        }
        if (phoneChanged && newPhone) {
          const { error: phoneErr } = await updateEmployeePhone(editEmp.id, newPhone);
          if (phoneErr) throw new Error('Failed to update phone: ' + phoneErr.message);
        }

        const { email: _skipEmail, phone: _skipPhone, ...restProfileData } = profileData;
        const { error } = await updateEmployee(editEmp.id, isRaniwala ? { ...restProfileData, l1_spoc_id: l1SpocId } : restProfileData);
        if (error) throw new Error('Update failed: ' + error.message);
        const { error: accessErr } = await setProfileOutletAccess(tenant.id, editEmp.id, extraOutletIds);
        if (accessErr) throw new Error('Employee saved, but clock-in outlet access failed: ' + accessErr.message);
        await saveSalary(editEmp.id, false);
        showToast('Employee updated', 'success');
        setShowModal(false);

        // Their login identity just changed — show HR the credentials the
        // employee now actually signs in with, same as the "Show Credentials"
        // button (password is untouched, so it's still whatever was on file).
        if ((emailChanged && newEmail) || (phoneChanged && newPhone)) {
          const { password, label, note } = resolveEmployeeCredentials(editEmp);
          setTempCreds({
            empName: fullName(profileData),
            username: newEmail || newPhone,
            password,
            passwordLabel: label,
            note,
          });
        }
      } else {
        // login_email is only for the Auth account (real email, or a phone-derived
        // placeholder when no email was entered — see resolveLoginEmail). The
        // credentials modal shows the phone number itself, not that placeholder,
        // since that's what the employee actually types in on the login page.
        // The outlet is picked here (Transfer moves it later); the branch text follows it.
        const newOutlet = outlets.find((o) => o.id === form.outlet_id);
        const createData = newOutlet ? { ...profileData, outlet_id: newOutlet.id, outlet_location: newOutlet.name } : profileData;
        const { tempPassword, userId } = await createEmployee(tenant?.id, { ...createData, login_email: resolveLoginEmail(createData) });
        // The create-employee-user edge function only writes a fixed field
        // list that doesn't include these — set them straight after.
        if (userId) {
          const { error: extraErr } = await updateEmployee(userId, {
            // Also written by the edge function, but an older deployed copy
            // dropped them (21 Oct 2026) — set here too so they always stick.
            date_of_birth: profileData.date_of_birth,
            division: profileData.division,
            overtime_applicable: profileData.overtime_applicable,
            comp_off_eligible: profileData.comp_off_eligible,
            probation_months: profileData.probation_months,
            manager_id: profileData.manager_id,
            hod_id: profileData.hod_id,
            ...(isRaniwala && l1SpocId ? { l1_spoc_id: l1SpocId } : {}),
            ...(newOutlet ? { outlet_id: newOutlet.id } : {}),
          });
          if (extraErr) showToast('Employee created, but date of birth / division / reporting manager / HOD / L1 / overtime / comp off / probation settings failed to save: ' + extraErr.message, 'warning');
          await saveSalary(userId, true);
          // Raniwala: HR gives the opening Earned Leave; the 1.5 a month starts
          // on the 1st of next month (20261028_2).
          if (isRaniwala && openingEarnedLeave > 0) {
            const { data: leaveTypes } = await listLeaveTypes(tenant.id);
            const earned = leaveTypes.find((t) => t.name === 'Earned Leave');
            const { error: leaveErr } = earned
              ? await allocateLeave(userId, earned.id, openingEarnedLeave, 'Opening balance given on joining')
              : { error: { message: 'Earned Leave type not found' } };
            if (leaveErr) showToast('Employee created, but the Earned Leave balance failed to save — add it from Leave Balances: ' + leaveErr.message, 'warning');
          }
        }
        setShowModal(false);
        setTempCreds({
          empName: fullName(profileData),
          username: profileData.email || profileData.phone,
          password: tempPassword,
        });

        // "Send to Induction FMS" (recruitment SOP step 8) — this hire came from
        // the Recruitment Pipeline, so auto-start onboarding and advance the
        // candidate's stage instead of leaving HR to do both by hand.
        if (prefillReferralId && userId) {
          const { error: onbErr } = await startOnboardingProcess(tenant.id, userId, { referral_id: prefillReferralId }, profile.id);
          if (onbErr) showToast('Employee created, but onboarding could not be auto-started: ' + onbErr.message, 'warning');
          await advanceReferralStage(prefillReferralId, 'Sent to Induction');
          setPrefillReferralId(null);
        }
      }
      fetchData();
    } catch (err) {
      showToast(err.message || 'Something went wrong', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    let rows;
    try {
      rows = await parseImportFile(file);
    } catch (parseErr) {
      showToast('Failed to parse file: ' + (parseErr.message || 'Unknown error'), 'error');
      e.target.value = '';
      return;
    }

    if (!rows.length) {
      showToast('No data rows found in file', 'error');
      e.target.value = '';
      return;
    }

    setImportProgress({ current: 0, total: rows.length });
    let result;
    try {
      result = await runBulkImport({
        tenantId: tenant?.id,
        rows,
        onProgress: (current, total) => setImportProgress({ current, total }),
        allowPlaceholderLogins,
        allowMissingCtc,
      });
    } finally {
      setImportProgress(null);
    }

    const {
      successCount, updateCount, skipCount, failCount, failErrors, managerAssigned,
      departmentsCreated, departmentsMerged, outletsCreated, outletsMerged, duplicatesInFile, manualReview,
    } = result;
    const parts = [`${successCount} imported`];
    if (updateCount > 0) parts.push(`${updateCount} updated`);
    if (skipCount > 0) parts.push(`${skipCount} skipped (already complete)`);
    if (failCount > 0) parts.push(`${failCount} failed`);
    if (managerAssigned > 0) parts.push(`${managerAssigned} manager(s) assigned`);
    if (duplicatesInFile > 0) parts.push(`${duplicatesInFile} duplicate rows merged`);
    if (departmentsCreated?.length) parts.push(`${departmentsCreated.length} department(s) created`);
    if (departmentsMerged?.length) parts.push(`${departmentsMerged.length} department spelling(s) normalized`);
    if (outletsCreated?.length) parts.push(`${outletsCreated.length} outlet(s) created`);
    if (outletsMerged?.length) parts.push(`${outletsMerged.length} outlet spelling(s) normalized`);
    const summary = parts.join(', ');

    if (failCount > 0) {
      showToast(`Import complete: ${summary}. Errors: ${failErrors.join(' | ')}`, 'error');
    } else {
      showToast(`Import complete: ${summary}`, successCount > 0 ? 'success' : 'info');
    }

    // Non-blocking issues the sheet had (malformed emails, etc.) — worth a
    // separate heads-up so admins can go fix the source data, but never
    // block/skip a row that's otherwise fine.
    if (manualReview?.length) {
      const preview = manualReview.slice(0, 5).join(' | ');
      const more = manualReview.length > 5 ? ` (+${manualReview.length - 5} more)` : '';
      showToast(`Needs a look: ${preview}${more}`, 'warning');
    }

    fetchData();
    e.target.value = '';
  };

  const toggleStatus = async (emp) => {
    const newStatus = emp.status === 'Active' ? 'Inactive' : 'Active';
    const { error } = await setEmployeeStatus(emp.id, newStatus);
    if (error) return showToast('Failed to update status', 'error');
    showToast(`Employee ${newStatus === 'Active' ? 'activated' : 'deactivated'}`, 'info');
    fetchData();
  };

  const toggleWithholding = async (emp) => {
    let reason = '';
    if (!emp.is_withheld) {
      reason = prompt(`Reason for withholding ${fullName(emp)}'s salary?`, '') || '';
      if (reason === null) return;
    } else if (!confirm(`Release ${fullName(emp)}'s salary? They'll be included in the next payroll run again.`)) {
      return;
    }
    const { error } = await setEmployeeWithholding(emp.id, !emp.is_withheld, reason);
    if (error) return showToast('Failed to update withholding', 'error');
    showToast(emp.is_withheld ? 'Salary released' : 'Salary withheld', emp.is_withheld ? 'success' : 'warning');
    fetchData();
  };

  const deleteEmp = async (emp) => {
    if (!confirm(
      `Permanently delete ${fullName(emp)}?\n\n` +
      `This also PERMANENTLY DELETES their entire attendance history, payslips, advances, ` +
      `and leave records — not just the employee record. This cannot be undone.\n\n` +
      `If you just want to offboard them while keeping their records, use the "Toggle Status" button instead to mark them Inactive.`
    )) return;
    const { error } = await removeEmployee(emp.id);
    if (error) return showToast('Delete failed: ' + error.message, 'error');
    showToast('Employee deleted', 'success');
    if (employees.length === 1 && page > 1) setPage(page - 1);
    else fetchData();
  };

  const showCredentials = (emp) => {
    // employee_current_passwords reflects the employee's live password once
    // they've set their own (RLS: superadmin, or an admin viewing their own
    // tenant — see 20260901_1_hr_current_password_read.sql). resolveEmployeeCredentials
    // falls back to temp_password only while it's still actually valid (they
    // haven't changed it yet) — see its doc comment for the third, "changed
    // but never recorded" case this used to get wrong.
    const { password, label, note } = resolveEmployeeCredentials(emp);
    setTempCreds({
      empName: fullName(emp),
      username: emp.email || emp.phone,
      password,
      passwordLabel: label,
      note,
    });
  };

  const handleResetPassword = async (emp) => {
    if (!confirm(
      `Reset ${fullName(emp)}'s password?\n\n` +
      `Their current password stops working immediately. A new temporary password ` +
      `will be generated and they'll be required to set their own on next login.`
    )) return;
    setResettingId(emp.id);
    try {
      const { tempPassword } = await resetEmployeePassword(emp.id);
      showToast(`Password reset for ${fullName(emp)}`, 'success');
      setTempCreds({
        empName: fullName(emp),
        username: emp.email || emp.phone,
        password: tempPassword,
      });
      fetchData();
    } catch (err) {
      showToast('Reset failed: ' + err.message, 'error');
    } finally {
      setResettingId(null);
    }
  };

  return (
    <>
      <Header
        title={outletId ? `Employees — ${outletName || 'Outlet'}` : isManager ? 'My Team' : 'Employees'}
        breadcrumb={outletId
          ? <>{totalCount} employees at this outlet · <Link to="/outlets">All Outlets</Link></>
          : isManager ? `${totalCount} direct report${totalCount === 1 ? '' : 's'}` : `${totalCount} employees`}
      />
      <div className="page-content">
        <div className="filter-bar">
          {outlets.length > 0 && (
            <select
              className="form-select"
              value={outletId || ''}
              onChange={(e) => selectOutlet(e.target.value || null)}
              title="Location (Outlet)"
            >
              <option value="">All Outlets (Combined)</option>
              {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          {divisions.length > 0 && (
            <select className="form-select" value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value)}>
              <option value="">All Divisions</option>
              {divisions.map((d) => <option key={d}>{d}</option>)}
            </select>
          )}
          <select className="form-select" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
            <option value="">All Departments</option>
            {filterDepartments.map((d) => <option key={d}>{d}</option>)}
          </select>
          <select className="form-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All Status</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>
          <input
            className="form-input"
            placeholder="🔍 Search name, EMP code, email, department…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ minWidth: 220 }}
          />
          {!isManager && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              {/* Bulk import is platform-superadmin only — tenant HR no longer
                  gets an Import button, only superadmin does bulk sheet imports. */}
              {profile?.role === 'superadmin' && (
                <>
                  {importProgress && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                      <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                      Importing {importProgress.current} / {importProgress.total}…
                    </div>
                  )}
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}
                    title="Rows with no email or phone are normally rejected (nothing to log in with). Check this to create them anyway with a placeholder login — useful for a biometric-only import where contact info comes later."
                  >
                    <input
                      type="checkbox"
                      checked={allowPlaceholderLogins}
                      onChange={(e) => setAllowPlaceholderLogins(e.target.checked)}
                      disabled={!!importProgress}
                    />
                    Allow rows without email/phone
                  </label>
                  <label
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer' }}
                    title="New employees are normally rejected without a Monthly CTC. Check this to create them anyway with CTC = 0 — useful for a roster sheet with no salary column, to be filled in later from HR records."
                  >
                    <input
                      type="checkbox"
                      checked={allowMissingCtc}
                      onChange={(e) => setAllowMissingCtc(e.target.checked)}
                      disabled={!!importProgress}
                    />
                    Allow missing CTC (defaults to 0)
                  </label>
                  <button
                    className="btn btn-outline"
                    disabled={!!importProgress}
                    onClick={() => document.getElementById('import-csv').click()}
                  >
                    <i className="fas fa-file-import" /> Import CSV / XLSX
                  </button>
                  <input id="import-csv" type="file" accept=".csv,.txt,.xlsx,.xls,.xlsm" style={{ display: 'none' }} onChange={handleImport} disabled={!!importProgress} />
                  <button className="btn btn-outline" disabled={!!importProgress} onClick={downloadSampleCSV}>
                    <i className="fas fa-file-csv" /> Sample CSV
                  </button>
                </>
              )}
              {outlets.length > 0 && (
                <button className="btn btn-outline" onClick={() => setShowBulkAssign(true)} title="Assign employees who don't have an outlet yet">
                  <i className="fas fa-people-arrows" /> Assign Unassigned to Outlet
                </button>
              )}
              {isRaniwala && (
                <button className="btn btn-outline" onClick={() => setShowL1Spocs(true)} title="Current L1s, the people under each, and moving people to another L1">
                  <i className="fas fa-user-friends" /> L1 SPOCs
                </button>
              )}
              <button className="btn btn-primary" disabled={!!importProgress} onClick={() => openModal()}>
                <i className="fas fa-plus" /> Add Employee
              </button>
            </div>
          )}
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div className="spinner" style={{ margin: '0 auto 16px' }} />Loading employees…
          </div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Employee</th><th>Department</th><th>Designation</th>
                    {showFinanceCols && <th>Leaves</th>}
                    {showFinanceCols && <th>Monthly CTC</th>}
                    {showFinanceCols && <th>Compliance</th>}
                    <th>Status</th><th>Today</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.length === 0 ? (
                    <tr>
                      <td colSpan={showFinanceCols ? 9 : 6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
                        {debouncedSearch || deptFilter || divisionFilter || statusFilter
                          ? 'No employees match your filters.'
                          : isManager
                            ? 'No one reports to you yet.'
                            : 'No employees yet. Click "Add Employee" to get started.'}
                      </td>
                    </tr>
                  ) : employees.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <div className="emp-cell">
                          <div className="emp-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(e.id)})` }}>
                            {getInitials(e.first_name, e.last_name)}
                          </div>
                          <div>
                            <div className="emp-name">{fullName(e)}</div>
                            <div className="emp-role">{e.email || ''}</div>
                            {e.employee_id && (
                              <code style={{ fontSize: 10, color: 'var(--primary)', background: 'var(--primary-light)', padding: '0 5px', borderRadius: 3, marginTop: 2, display: 'inline-block' }}>
                                {e.employee_id}
                              </code>
                            )}
                            {e.essl_employee_code && (
                              <code
                                title="ESSL punch-machine employee ID"
                                style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg)', border: '1px solid var(--border)', padding: '0 5px', borderRadius: 3, marginTop: 2, marginLeft: 4, display: 'inline-block' }}
                              >
                                ESSL: {e.essl_employee_code}
                              </code>
                            )}
                            {e.outlet_location && (
                              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{e.outlet_location}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>{e.department || '—'}</td>
                      <td>
                        {e.designation || '—'}
                        {e.division && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{e.division}</div>
                        )}
                        {salaryPrivate && !isManager && !(Number(e.ctc) > 0) && (
                          <div style={{ marginTop: 3 }}>
                            <span className="badge badge-danger" style={{ fontSize: 10 }} title="No monthly gross saved yet. Open Edit and enter it.">Salary not set</span>
                          </div>
                        )}
                        {(e.overtime_applicable || e.comp_off_eligible) && (
                          <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
                            {e.overtime_applicable && <span className="badge badge-info" style={{ fontSize: 10 }} title="Paid overtime for extra hours">OT</span>}
                            {e.comp_off_eligible && <span className="badge badge-warning" style={{ fontSize: 10 }} title="Earns comp off for working a weekly off / holiday">Comp Off</span>}
                          </div>
                        )}
                      </td>
                      {showFinanceCols && <td>{typeof e.leave_allocation === 'number' ? e.leave_allocation : (e.leave_allocation || 0)}</td>}
                      {showFinanceCols && <td>{fmt(e.ctc)}</td>}
                      {showFinanceCols && (
                        <td>
                          {(() => {
                            const cs = getComplianceStatus(e);
                            const { label, cls } = COMPLIANCE_BADGE[cs];
                            const tip = !e.compliance_enabled
                              ? 'Compliance not enabled'
                              : `PF: ${e.pf_enabled ? (e.pf_number || 'no number') : 'N/A'} | ESIC: ${e.esic_enabled ? (e.esic_number || 'no number') : 'N/A'}`;
                            return <span className={`badge ${cls}`} title={tip}>{label}</span>;
                          })()}
                        </td>
                      )}
                      <td><span className={`badge ${e.status === 'Active' ? 'badge-success' : 'badge-danger'}`}>{e.status}</span></td>
                      <td>
                        {clockedInSet.has(e.id)
                          ? <span className="badge badge-success" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff', display: 'inline-block' }} />Working</span>
                          : <span className="badge badge-secondary" style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {!isManager && <button className="btn btn-outline btn-icon btn-sm" onClick={() => openModal(e)} title="Edit"><i className="fas fa-edit" /></button>}
                          {!isManager && !hrSupport && <button className="btn btn-outline btn-icon btn-sm" onClick={() => setPromotionEmp(e)} title="Promotion / Increment History" style={{ color: 'var(--primary)' }}><i className="fas fa-level-up-alt" /></button>}
                          {salaryPrivate && !isManager && !hrSupport && <button className="btn btn-outline btn-icon btn-sm" onClick={() => setSalaryEmp(e)} title="Salary history — gross, CTC, pay by month, arrears, advances" style={{ color: 'var(--success)' }}><i className="fas fa-indian-rupee-sign" /></button>}
                          <button className="btn btn-outline btn-icon btn-sm" onClick={() => showCredentials(e)} title="Show Credentials"><i className="fas fa-key" /></button>
                          {!isManager && (
                            <button
                              className="btn btn-outline btn-icon btn-sm"
                              onClick={() => handleResetPassword(e)}
                              disabled={resettingId === e.id}
                              title="Reset Password"
                              style={{ color: 'var(--warning)' }}
                            >
                              {resettingId === e.id
                                ? <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                                : <i className="fas fa-lock-open" />}
                            </button>
                          )}
                          {!isManager && tenant?.group_code && (
                            <button className="btn btn-outline btn-icon btn-sm" onClick={() => setTransferEmp(e)} title="Transfer to another branch" style={{ color: 'var(--primary)' }}>
                              <i className="fas fa-exchange-alt" />
                            </button>
                          )}
                          {tenant?.group_code && (
                            <button className="btn btn-outline btn-icon btn-sm" onClick={() => setHistoryEmp(e)} title="Transfer history" style={{ color: 'var(--text-muted)' }}>
                              <i className="fas fa-history" />
                            </button>
                          )}
                          {!isManager && outlets.length > 0 && (
                            <button className="btn btn-outline btn-icon btn-sm" onClick={() => setOutletTransferEmp(e)} title="Transfer to outlet" style={{ color: 'var(--primary)' }}>
                              <i className="fas fa-store-alt" />
                            </button>
                          )}
                          {outlets.length > 0 && (
                            <button className="btn btn-outline btn-icon btn-sm" onClick={() => setOutletHistoryEmp(e)} title="Outlet transfer history" style={{ color: 'var(--text-muted)' }}>
                              <i className="fas fa-map-marked-alt" />
                            </button>
                          )}
                          {!isManager && <button className="btn btn-outline btn-icon btn-sm" onClick={() => toggleStatus(e)} title="Toggle Status"><i className="fas fa-power-off" /></button>}
                          {!isManager && !hrSupport && (
                            <button
                              className="btn btn-outline btn-icon btn-sm"
                              onClick={() => toggleWithholding(e)}
                              title={e.is_withheld ? `Withheld: ${e.withheld_reason || 'no reason given'} — click to release` : 'Withhold salary'}
                              style={{ color: e.is_withheld ? 'var(--warning)' : undefined }}
                            >
                              <i className={`fas ${e.is_withheld ? 'fa-pause-circle' : 'fa-hand-paper'}`} />
                            </button>
                          )}
                          {!isManager && <button className="btn btn-outline btn-icon btn-sm" style={{ color: 'var(--danger)' }} onClick={() => deleteEmp(e)} title="Delete"><i className="fas fa-trash" /></button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={page} totalPages={totalPages} totalCount={totalCount} onPageChange={setPage} />
          </div>
        )}
      </div>

      <Modal show={showModal} onClose={() => setShowModal(false)} title={editEmp ? 'Edit Employee' : 'Add Employee'}
        width="600px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setShowModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveEmployee} disabled={saving}>
            {saving ? <><div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Saving…</> : <><i className="fas fa-check" /> Save</>}
          </button>
        </>}
      >
        <div style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 8 }}>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Employee ID{isRaniwala && !editEmp ? ' *' : ''}</label>
              <input
                className="form-input"
                value={form.employee_id}
                onChange={(e) => {
                  const employeeId = e.target.value.toUpperCase();
                  // Raniwala: EMP code and ESSL code are the same number, so
                  // the ESSL field follows it until HR types something else there.
                  const followEssl = isRaniwala && (!form.essl_employee_code || form.essl_employee_code === form.employee_id);
                  setForm({ ...form, employee_id: employeeId, ...(followEssl ? { essl_employee_code: employeeId } : {}) });
                }}
                placeholder="e.g. MCMU1042"
                style={{ fontFamily: 'monospace', fontWeight: 700, letterSpacing: 1 }}
              />
              <div className="form-hint">Outlet(2) + Location(2) + Number · e.g. MCMU1042</div>
            </div>
            {!editEmp && outlets.length > 0 ? (
              <div className="form-group">
                <label className="form-label">Outlet{isRaniwala || outlets.some((o) => o.employee_code_prefix) ? ' *' : ''}</label>
                <select className="form-select" value={form.outlet_id} onChange={(e) => setForm({ ...form, outlet_id: e.target.value })}>
                  <option value="">Select outlet</option>
                  {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                {outlets.find((o) => o.id === form.outlet_id)?.employee_code_prefix && (
                  <div className="form-hint">Leave Employee ID blank to get the next {outlets.find((o) => o.id === form.outlet_id).employee_code_prefix} code</div>
                )}
              </div>
            ) : (
              <div className="form-group">
                <label className="form-label">Branch Name</label>
                <input
                  className="form-input"
                  value={form.outlet_location}
                  onChange={(e) => setForm({ ...form, outlet_location: e.target.value })}
                  placeholder="e.g. Mumbai Bandra, Delhi CP"
                />
              </div>
            )}
          </div>
          <div className="form-row form-row-3">
            <div className="form-group"><label className="form-label">First Name *</label><input className="form-input" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">Middle Name</label><input className="form-input" value={form.middle_name} onChange={(e) => setForm({ ...form, middle_name: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">Last Name *</label><input className="form-input" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} /></div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Email Address</label>
              <input className="form-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <div className="form-hint">
                {editEmp ? 'Changing this updates their sign-in email too. Their password is unaffected.' : 'Employee logs in with this, or with their phone number if left blank'}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Phone {!form.email && '*'}</label>
              <input
                className="form-input"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })}
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit mobile number"
              />
              {!form.email && (
                <div className="form-hint">
                  {editEmp ? 'They log in with this — changing it updates their sign-in username too.' : 'Used as login username since no email was entered'}
                </div>
              )}
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Department *</label>
              <select className="form-select" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })}>
                <option value="">Select</option>
                {departments.map((d) => <option key={d}>{d}</option>)}
              </select>
            </div>
            <div className="form-group"><label className="form-label">Designation</label><input className="form-input" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} /></div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Division</label>
              {form.division === '__new__' ? (
                <input
                  className="form-input"
                  autoFocus
                  placeholder="Enter new division name"
                  value={form.divisionNew}
                  onChange={(e) => setForm({ ...form, divisionNew: e.target.value })}
                />
              ) : (
                <select
                  className="form-select"
                  value={form.division}
                  onChange={(e) => setForm({ ...form, division: e.target.value, divisionNew: '' })}
                >
                  <option value="">Select</option>
                  {allDivisions.map((d) => <option key={d}>{d}</option>)}
                  {form.division && !allDivisions.includes(form.division) && (
                    <option value={form.division}>{form.division}</option>
                  )}
                  <option value="__new__">+ Add new division…</option>
                </select>
              )}
            </div>
          </div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Date of Joining *</label><input className="form-input" type="date" value={form.join_date} onChange={(e) => setForm({ ...form, join_date: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">{isRaniwala ? 'Monthly Gross Salary (₹) *' : 'Monthly CTC (₹) *'}</label><input className="form-input" type="number" min="0" value={form.ctc} onChange={(e) => setForm({ ...form, ctc: e.target.value })} />{isRaniwala && <div className="form-hint">Basic, HRA, PF and ESIC are worked out from this{hrSupport ? '.' : ' — see Payroll → Salary Structure.'}</div>}</div>
          </div>
          {salaryPrivate && (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Monthly CTC (₹) *</label>
                <input
                  className="form-input" type="number" min="0" value={form.salary_ctc}
                  placeholder="Enter the CTC"
                  onChange={(e) => setForm({ ...form, salary_ctc: e.target.value })}
                />
                <div className="form-hint">Cost to company, as HR has it. Not worked out from the gross.</div>
              </div>
              <div className="form-group">
                <label className="form-label">Actual Gross (₹)</label>
                <input className="form-input" type="number" min="0" value={form.actual_gross} placeholder="Only if paid below the gross" onChange={(e) => setForm({ ...form, actual_gross: e.target.value })} />
                <div className="form-hint">
                  {parseFloat(form.actual_gross) > 0 && parseFloat(form.actual_gross) < parseFloat(form.ctc)
                    ? `Gross Advance ₹${(parseFloat(form.ctc) - parseFloat(form.actual_gross)).toLocaleString('en-IN')} a month. `
                    : ''}
                  PF / ESIC stay on the monthly gross; payroll deducts the difference as the Gross Advance. Seen only by HR and the employee.
                </div>
              </div>
            </div>
          )}
          <div className="form-row">
            <div className="form-group"><label className="form-label">Date of Birth</label><input className="form-input" type="date" value={form.date_of_birth} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} /></div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">ESSL / Biometric Employee Code</label>
              <input className="form-input" value={form.essl_employee_code} onChange={(e) => setForm({ ...form, essl_employee_code: e.target.value.toUpperCase() })} placeholder="Employee ID as set on the punch machine" style={{ fontFamily: 'monospace', fontWeight: 700 }} />
              <div className="form-hint">
                {isRaniwala
                  ? 'Same as the EMP code. On save, every punch the machine has for this code is added to attendance straight away.'
                  : 'Links this employee to their punch-machine ID so attendance from the ESSL device syncs automatically.'}
              </div>
              <EsslLookupCard
                lookup={esslLookup}
                editId={editEmp?.id}
                onFillName={() => setForm((f) => ({ ...f, ...splitMachineName(esslLookup?.machine?.name) }))}
                onUseCode={() => setForm((f) => ({ ...f, essl_employee_code: esslLookup.code }))}
                onCheckNow={() => setEsslCheckNonce((n) => n + 1)}
                showUseCode={!form.essl_employee_code}
                showFillName={!editEmp && !form.first_name}
              />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Bank Account Number</label>
            <input
              className="form-input"
              value={form.bank_acc}
              onChange={(e) => setForm({ ...form, bank_acc: e.target.value.replace(/\D/g, '').slice(0, 18) })}
              inputMode="numeric"
              maxLength={18}
              placeholder="Enter bank account number"
            />
            <div className="form-hint">9-18 digit account number, numbers only.</div>
          </div>

          {/* Raniwala: PF and ESIC are worked out by payroll, HR only keeps the numbers. */}
          {isRaniwala && (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">UAN Number</label>
                <input className="form-input" value={form.pf_number} placeholder="e.g. 100123456789"
                  onChange={(e) => setForm({ ...form, pf_number: e.target.value })} />
                <div className="form-hint">Printed on the payslip in a month PF is deducted.</div>
              </div>
              <div className="form-group">
                <label className="form-label">ESIC Number</label>
                <input className="form-input" value={form.esic_number} placeholder="e.g. 2014567890"
                  onChange={(e) => setForm({ ...form, esic_number: e.target.value })} />
                <div className="form-hint">Printed on the payslip under the UAN in a month ESIC is deducted.</div>
              </div>
            </div>
          )}

          {/* Compliance Section */}
          {!isRaniwala && <div className="form-group" style={{ marginTop: 4 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={form.compliance_enabled}
                onChange={(e) => setForm({ ...form, compliance_enabled: e.target.checked, pf_enabled: false, esic_enabled: false })}
              />
              <span className="form-label" style={{ margin: 0 }}>Compliance</span>
            </label>
          </div>}

          {!isRaniwala && form.compliance_enabled && (
            <div className="form-group" style={{ marginLeft: 20 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={form.pf_enabled}
                  onChange={(e) => setForm({ ...form, pf_enabled: e.target.checked, esic_enabled: e.target.checked ? form.esic_enabled : false })}
                />
                <span className="form-label" style={{ margin: 0 }}>PF Account</span>
              </label>

              {form.pf_enabled && (
                <>
                  <div className="form-row" style={{ marginTop: 10 }}>
                    <div className="form-group">
                      <label className="form-label">PF Amount (₹)</label>
                      <input
                        className="form-input"
                        type="number" min="0"
                        value={form.pf_amount}
                        onChange={(e) => setForm({ ...form, pf_amount: e.target.value })}
                        placeholder="e.g. 1800"
                      />
                      <div className="form-hint">Auto at payroll: 12% if CTC ≤ ₹15,000, else ₹1,800</div>
                    </div>
                    <div className="form-group">
                      {/* Raniwala files PF against the employee's UAN, so HR knows it by that name. */}
                      <label className="form-label">{isRaniwalaTenant(tenant) ? 'UAN Number' : 'PF Number'}</label>
                      <input
                        className="form-input"
                        value={form.pf_number}
                        onChange={(e) => setForm({ ...form, pf_number: e.target.value })}
                        placeholder={isRaniwalaTenant(tenant) ? 'e.g. 100123456789' : 'e.g. MH/BAN/1234567/000/0000001'}
                      />
                    </div>
                  </div>

                  <div className="form-group" style={{ marginLeft: 20 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                      <input
                        type="checkbox"
                        checked={form.esic_enabled}
                        onChange={(e) => setForm({ ...form, esic_enabled: e.target.checked })}
                      />
                      <span className="form-label" style={{ margin: 0 }}>ESIC</span>
                    </label>

                    {form.esic_enabled && (
                      <div className="form-row" style={{ marginTop: 10 }}>
                        <div className="form-group">
                          <label className="form-label">ESIC Amount (₹)</label>
                          <input
                            className="form-input"
                            type="number" min="0"
                            value={form.esic_amount}
                            onChange={(e) => setForm({ ...form, esic_amount: e.target.value })}
                            placeholder="e.g. 325"
                          />
                        </div>
                        <div className="form-group">
                          <label className="form-label">ESIC Number</label>
                          <input
                            className="form-input"
                            value={form.esic_number}
                            onChange={(e) => setForm({ ...form, esic_number: e.target.value })}
                            placeholder="ESIC registration number"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '16px 0' }} />
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Weekly Holiday</label>
              <select className="form-select" value={form.weekly_holiday} onChange={(e) => setForm({ ...form, weekly_holiday: e.target.value })}>
                {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Flexible'].map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Default Shift</label>
              <select className="form-select" value={form.shift_id} onChange={(e) => setForm({ ...form, shift_id: e.target.value })}>
                <option value="">Company Default</option>
                {shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start_time}-{s.end_time})</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Probation Period (months)</label>
              <input className="form-input" type="number" min="0" max="24" value={form.probation_months}
                onChange={(e) => setForm({ ...form, probation_months: e.target.value })} />
              <div className="form-hint">Set 0 if no probation. Employee earns 1 leave per full-attendance month during probation.</div>
            </div>
            <div className="form-group">
              <label className="form-label">Overtime</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 6 }}>
                <input type="checkbox" checked={!!form.overtime_applicable}
                  onChange={(e) => setForm({ ...form, overtime_applicable: e.target.checked })} />
                <span>Apply overtime for this employee</span>
              </label>
              <div className="form-hint">
                {isRaniwalaTenant(tenant)
                  ? 'Paid for time beyond the 8h 30m day: 2h+ extra = 2h, 3h–4h59m = 3h, 5h+ = 8h (a full shift).'
                  : 'Only ticked employees get extra hours calculated as overtime pay when payroll is generated.'}
              </div>
            </div>
          </div>
          {tenant?.auto_comp_off_on_weekly_off_worked && (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Comp Off</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 6 }}>
                  <input type="checkbox" checked={!!form.comp_off_eligible}
                    onChange={(e) => setForm({ ...form, comp_off_eligible: e.target.checked })} />
                  <span>Earn comp off for working a weekly off / holiday</span>
                </label>
                <div className="form-hint">4h–4h59m worked earns a half-day comp off; 5h or more earns a full day.</div>
              </div>
            </div>
          )}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">User Role</label>
              <select className="form-select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="employee">Employee</option>
                {(!hrSupport || form.role === 'admin') && <option value="admin">HR</option>}
                <option value="manager">Manager</option>
                {isRaniwalaTenant(tenant) && <option value="hod">HOD</option>}
                {isRaniwalaTenant(tenant) && <option value="management">Management</option>}
              </select>
              <div className="form-hint">
                {isRaniwalaTenant(tenant)
                  ? 'HR has full access. Manager sees and approves their own team. HOD is the Reporting Manager of managers and sees their whole team. Management gives final approval on leaves over 5 days.'
                  : 'HR has full access. Manager can approve leaves and manage attendance.'}
              </div>
            </div>
          </div>
          {(() => {
            // Raniwala: only Managers and HODs can be picked (change an employee's
            // role to Manager first to make them selectable). The currently saved
            // pick stays listed so editing never silently drops it.
            const raniwalaPick = (m, current) => !isRaniwalaTenant(tenant)
              || ['manager', 'hod'].includes(m.role) || m.id === current;
            return (
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Reporting Manager</label>
              <select className="form-select" value={form.manager_id} onChange={(e) => setForm({ ...form, manager_id: e.target.value })}>
                <option value="">None</option>
                {managerOptions.filter((m) => (!editEmp || m.id !== editEmp.id) && raniwalaPick(m, form.manager_id)).map((m) => (
                  <option key={m.id} value={m.id}>{fullName(m)}{m.employee_id ? ` (#${m.employee_id})` : ''} — {roleLabel(m.role)}</option>
                ))}
              </select>
              <div className="form-hint">
                {isRaniwalaTenant(tenant)
                  ? 'Lists all Managers and HODs. To add someone here, set their User Role to Manager first.'
                  : 'Any employee can be set as the reporting manager. Used for approvals, 1:1s, KRAs, PIPs, and review routing.'}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">{isRaniwalaTenant(tenant) ? 'Reporting HOD' : 'HOD'}</label>
              <select className="form-select" value={form.hod_id} onChange={(e) => setForm({ ...form, hod_id: e.target.value })}>
                <option value="">None</option>
                {/* Raniwala: the reporting manager can also be the HOD (one approval covers both stages). */}
                {managerOptions.filter((m) => (!editEmp || m.id !== editEmp.id) && (isRaniwalaTenant(tenant) || m.id !== form.manager_id) && raniwalaPick(m, form.hod_id)).map((m) => (
                  <option key={m.id} value={m.id}>{fullName(m)}{m.employee_id ? ` (#${m.employee_id})` : ''} — {roleLabel(m.role)}</option>
                ))}
              </select>
              <div className="form-hint">Head of department. Optional — leave as None if not applicable. Used as the fallback approver when there is no reporting manager.</div>
            </div>
          </div>
            );
          })()}
          {isRaniwala && (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">L1 SPOC (Reporting)</label>
                <select className="form-select" value={form.l1_spoc_id} onChange={(e) => setForm({ ...form, l1_spoc_id: e.target.value })}>
                  <option value="">None</option>
                  {form.l1_spoc_id && !managerOptions.some((m) => m.id === form.l1_spoc_id) && (
                    <option value={form.l1_spoc_id}>Current L1 (inactive)</option>
                  )}
                  {managerOptions.filter((m) => !editEmp || m.id !== editEmp.id).map((m) => (
                    <option key={m.id} value={m.id}>{fullName(m)}{m.employee_id ? ` (#${m.employee_id})` : ''}{m.department ? ` — ${m.department}` : ''}</option>
                  ))}
                </select>
                <div className="form-hint">
                  For staff who can't use the app: the L1 sees their attendance and leave and sends leave / regularize requests for them.
                  Not an approver. Leave as None if not needed. See all L1s with the <b>L1 SPOCs</b> button.
                </div>
              </div>
            </div>
          )}
          {editEmp && outlets.length > 1 && (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Additional Clock-in Outlets</label>
                <div style={{
                  border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px',
                  maxHeight: 140, overflowY: 'auto', display: 'grid', gap: 6,
                }}>
                  {outlets.filter((o) => o.id !== editEmp?.outlet_id).map((o) => (
                    <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={extraOutletIds.includes(o.id)}
                        onChange={(e) => setExtraOutletIds(e.target.checked
                          ? [...extraOutletIds, o.id]
                          : extraOutletIds.filter((id) => id !== o.id))}
                      />
                      {o.name}
                    </label>
                  ))}
                </div>
                <div className="form-hint">
                  Beyond their home outlet ({outlets.find((o) => o.id === editEmp?.outlet_id)?.name || 'none'}), this employee can clock in/out
                  from any outlet checked here — useful for HR or staff who regularly visit other branches.
                </div>
              </div>
            </div>
          )}
          {isRaniwala && !editEmp ? (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Earned Leave on Joining (days)</label>
                <input className="form-input" type="number" min="0" max="60" step="0.5" placeholder="0"
                  value={form.opening_earned_leave}
                  onChange={(e) => setForm({ ...form, opening_earned_leave: e.target.value })} />
                <div className="form-hint">The balance they start with. 1.5 days are added automatically on the 1st of every month from next month.</div>
              </div>
            </div>
          ) : (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Annual Leave Allocation</label>
                <input className="form-input" type="number" min="0" value={form.leave_allocation}
                  onChange={(e) => setForm({ ...form, leave_allocation: e.target.value })} />
                <div className="form-hint">Annual leaves (post-probation). Set 0 if using earned-leave only.</div>
              </div>
            </div>
          )}
        </div>
      </Modal>

      <TempPasswordModal
        show={!!tempCreds}
        onClose={() => setTempCreds(null)}
        empName={tempCreds?.empName}
        username={tempCreds?.username}
        password={tempCreds?.password}
        passwordLabel={tempCreds?.passwordLabel}
        note={tempCreds?.note}
      />

      <TransferModal
        show={!!transferEmp}
        onClose={() => setTransferEmp(null)}
        employee={transferEmp}
        currentTenantId={tenant?.id}
        groupCode={tenant?.group_code}
        onTransferred={fetchData}
      />

      <TransferHistoryModal
        show={!!historyEmp}
        onClose={() => setHistoryEmp(null)}
        employee={historyEmp}
      />

      <OutletTransferModal
        show={!!outletTransferEmp}
        onClose={() => setOutletTransferEmp(null)}
        employee={outletTransferEmp}
        tenantId={tenant?.id}
        outlets={outlets}
        transferredBy={profile?.id}
        onTransferred={fetchData}
      />

      <OutletTransferHistoryModal
        show={!!outletHistoryEmp}
        onClose={() => setOutletHistoryEmp(null)}
        employee={outletHistoryEmp}
      />

      <BulkAssignOutletModal
        show={showBulkAssign}
        onClose={() => setShowBulkAssign(false)}
        tenantId={tenant?.id}
        outlets={outlets}
        transferredBy={profile?.id}
        onAssigned={fetchData}
      />

      <L1SpocModal
        show={showL1Spocs}
        onClose={() => setShowL1Spocs(false)}
        tenantId={tenant?.id}
        employees={managerOptions}
        onChanged={fetchData}
      />

      <SalaryHistoryModal
        show={!!salaryEmp}
        onClose={() => setSalaryEmp(null)}
        employee={salaryEmp}
        tenantId={tenant?.id}
      />

      <PromotionModal
        show={!!promotionEmp}
        onClose={() => setPromotionEmp(null)}
        employee={promotionEmp}
        tenantId={tenant?.id}
        currentUserId={profile?.id}
        salaryPrivate={salaryPrivate}
        onSaved={fetchData}
      />
    </>
  );
}

// ── Promotion / Increment History Modal ─────────────────────────────────────

const inr = (v) => `₹${Number(v || 0).toLocaleString('en-IN')}`;

// "Increment: ₹x (y%)" under a new-salary box.
function IncrementHint({ from, to }) {
  if (!(to > 0) || !(from > 0)) return null;
  return (
    <div className="form-hint" style={{ color: to >= from ? 'var(--success)' : 'var(--danger)' }}>
      Increment: ₹{Number(to - from).toLocaleString('en-IN')} ({((to - from) / from * 100).toFixed(1)}%)
    </div>
  );
}

// "(+₹x)" after a history line's old → new figure.
function ChangeTag({ from, to }) {
  const diff = Number(to) - Number(from);
  if (!diff) return null;
  return (
    <span style={{ color: diff > 0 ? 'var(--success)' : 'var(--danger)', marginLeft: 6 }}>
      ({diff > 0 ? '+' : '−'}{inr(Math.abs(diff))})
    </span>
  );
}

// Salary-private tenant (Raniwala): `employee.ctc` is the monthly gross (see
// mergeSalaries) and the CTC is `salary_ctc`, so the form shows and sets both.
function PromotionModal({ show, onClose, employee, tenantId, currentUserId, salaryPrivate, onSaved }) {
  const [history, setHistory]     = useState([]);
  const [loading, setLoading]     = useState(false);
  const [showForm, setShowForm]   = useState(false);
  const [saving,   setSaving]     = useState(false);
  const [form, setForm] = useState({
    effectiveDate:  '',
    newDesignation: '',
    newGross:       '',
    newCtc:         '',
    notes:          '',
  });
  // Current pay, refreshed after a save (the `employee` row is the list's copy).
  const [current, setCurrent] = useState({ gross: 0, ctc: 0 });

  useEffect(() => {
    if (!show || !employee) return;
    const gross = Number(employee.ctc) || 0;
    setCurrent(salaryPrivate
      ? { gross, ctc: Number(employee.salary_ctc) || 0 }
      : { gross: 0, ctc: gross });
    setShowForm(false);
    setLoading(true);
    listEmployeePromotions(employee.id)
      .then(({ data }) => setHistory(data || []))
      .finally(() => setLoading(false));
  }, [show, employee, salaryPrivate]);

  const formGross = parseFloat(form.newGross) || 0;
  const formCtc   = parseFloat(form.newCtc) || 0;
  // A box left empty keeps the current figure; the CTC is never worked out
  // from the gross.
  const nextGross = formGross || current.gross;
  const nextCtc   = formCtc || current.ctc;

  const handleSave = async () => {
    if (!form.effectiveDate) return showToast('Effective date is required', 'error');
    if (salaryPrivate) {
      if (!form.newDesignation && !formGross && !formCtc) return showToast('Enter new designation, new gross and/or new CTC', 'error');
    } else if (!form.newDesignation && !formCtc) {
      return showToast('Enter new designation and/or new CTC', 'error');
    }
    setSaving(true);
    try {
      const salaryChanged = salaryPrivate && (formGross > 0 || formCtc > 0);
      const { error } = await recordPromotion(tenantId, employee.id, {
        effectiveDate:  form.effectiveDate,
        oldDesignation: employee.designation,
        newDesignation: form.newDesignation || employee.designation,
        oldCtc:         current.ctc,
        newCtc:         salaryPrivate ? (salaryChanged ? nextCtc : null) : (formCtc || current.ctc),
        oldGross:       current.gross,
        newGross:       salaryChanged ? nextGross : null,
        notes:          form.notes,
        createdBy:      currentUserId,
        salaryPrivate,
      });
      if (error) throw error;
      showToast('Promotion recorded and profile updated', 'success');
      if (salaryPrivate ? salaryChanged : formCtc > 0) {
        setCurrent(salaryPrivate ? { gross: nextGross, ctc: nextCtc } : { gross: 0, ctc: formCtc });
      }
      setShowForm(false);
      setForm({ effectiveDate: '', newDesignation: '', newGross: '', newCtc: '', notes: '' });
      const { data } = await listEmployeePromotions(employee.id);
      setHistory(data || []);
      onSaved();
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal show={show} onClose={onClose} title={`Promotions — ${fullName(employee)}`} width="580px"
      footer={
        showForm
          ? <>
              <button className="btn btn-outline" onClick={() => setShowForm(false)} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? <><div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Saving…</> : <><i className="fas fa-check" /> Record Promotion</>}
              </button>
            </>
          : <>
              <button className="btn btn-outline" onClick={onClose}>Close</button>
              <button className="btn btn-primary" onClick={() => setShowForm(true)}>
                <i className="fas fa-plus" /> New Promotion / Increment
              </button>
            </>
      }
    >
      {showForm ? (
        <div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Effective Date *</label>
              <input type="date" className="form-input" value={form.effectiveDate}
                onChange={e => setForm({ ...form, effectiveDate: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">New Designation</label>
              <input className="form-input" placeholder={employee?.designation || ''}
                value={form.newDesignation}
                onChange={e => setForm({ ...form, newDesignation: e.target.value })} />
            </div>
          </div>
          {salaryPrivate && (
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Current Monthly Gross</label>
                <input className="form-input" disabled value={inr(current.gross)} />
              </div>
              <div className="form-group">
                <label className="form-label">New Monthly Gross (₹)</label>
                <input type="number" min="0" className="form-input" placeholder="Enter new gross"
                  value={form.newGross} onChange={e => setForm({ ...form, newGross: e.target.value })} />
                <IncrementHint from={current.gross} to={formGross} />
              </div>
            </div>
          )}
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">{salaryPrivate ? 'Current Monthly CTC' : 'Current CTC'}</label>
              <input className="form-input" disabled value={inr(current.ctc)} />
            </div>
            <div className="form-group">
              <label className="form-label">New Monthly CTC (₹)</label>
              <input type="number" min="0" className="form-input"
                placeholder="Enter new CTC"
                value={form.newCtc} onChange={e => setForm({ ...form, newCtc: e.target.value })} />
              <IncrementHint from={current.ctc} to={formCtc} />
              {salaryPrivate && <div className="form-hint">Payroll runs on the gross. Left empty, the CTC stays as it is.</div>}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Notes</label>
            <textarea className="form-input" rows={2} style={{ resize: 'none', fontSize: 13 }}
              placeholder="e.g. Annual appraisal, promoted to Senior Engineer…"
              value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
      ) : loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><div className="spinner" style={{ margin: '0 auto' }} /></div>
      ) : (<>
        {salaryPrivate && (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '10px 14px', marginBottom: 12, border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}>
            <div><span style={{ color: 'var(--text-muted)' }}>Current Monthly Gross</span><br /><strong style={{ fontSize: 15 }}>{inr(current.gross)}</strong></div>
            <div><span style={{ color: 'var(--text-muted)' }}>Current Monthly CTC</span><br /><strong style={{ fontSize: 15 }}>{inr(current.ctc)}</strong></div>
          </div>
        )}
        {history.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
          <i className="fas fa-level-up-alt" style={{ fontSize: 28, marginBottom: 8, display: 'block' }} />
          No promotion history yet. Click "New Promotion / Increment" to record one.
        </div>
      ) : (
        <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
          {history.map((p, i) => (
            <div key={p.id} style={{
              border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px',
              marginBottom: 10, background: i === 0 ? 'var(--primary-light, #eff6ff)' : 'var(--bg-card)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <strong style={{ fontSize: 14 }}>
                  {new Date(p.effective_date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  {i === 0 && <span className="badge badge-success" style={{ marginLeft: 8, fontSize: 10 }}>Latest</span>}
                </strong>
                {!salaryPrivate && p.increment_amount > 0 && (
                  <span style={{ color: 'var(--success)', fontWeight: 700 }}>
                    +₹{Number(p.increment_amount).toLocaleString('en-IN')}
                  </span>
                )}
              </div>
              {p.old_designation !== p.new_designation && (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{p.old_designation}</span>
                  {' → '}
                  <strong>{p.new_designation}</strong>
                </div>
              )}
              {p.old_gross && p.new_gross && (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Gross: {inr(p.old_gross)} → <strong>{inr(p.new_gross)}</strong>
                  <ChangeTag from={p.old_gross} to={p.new_gross} />
                </div>
              )}
              {p.old_ctc && p.new_ctc && (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  CTC: {inr(p.old_ctc)} → <strong>{inr(p.new_ctc)}</strong>
                  {salaryPrivate && <ChangeTag from={p.old_ctc} to={p.new_ctc} />}
                </div>
              )}
              {p.notes && <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>{p.notes}</div>}
              {p.created_by_profile && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  Recorded by: {fullName(p.created_by_profile)}
                </div>
              )}
            </div>
          ))}
        </div>
        )}
      </>)}
    </Modal>
  );
}
