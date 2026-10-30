import { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import {
  listChecklistItems, createChecklistItem, deleteChecklistItem,
  listProcesses, startProcess, updateProcess, updateTaskStatus, exitCountdown,
} from '@/services/offboardingService';
import { listActiveEmployees } from '@/services/employeeService';
import { fullName, fmt, todayStr } from '@/lib/helpers';

const STATUS_BADGE = { 'In Progress': 'badge-info', Completed: 'badge-success', Cancelled: 'badge-danger' };
const emptyStartForm = () => ({ profile_id: '', reason: '', applied_on: todayStr(), exit_date: '', notes: '' });

function StatusCell({ process }) {
  const countdown = exitCountdown(process);
  return (
    <>
      <span className={`badge ${STATUS_BADGE[process.status]}`}>{process.status}</span>
      {countdown && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{countdown}</div>}
    </>
  );
}

export default function OffboardingPage() {
  const { tenant, profile } = useAuth();
  const [tab, setTab] = useState('processes');
  const [items, setItems] = useState([]);
  const [processes, setProcesses] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);

  const [newItem, setNewItem] = useState({ title: '', description: '', category: 'General' });

  const [showStartModal, setShowStartModal] = useState(false);
  const [startForm, setStartForm] = useState(emptyStartForm);

  const [activeProcess, setActiveProcess] = useState(null);

  const fetchData = useCallback(async () => {
    if (!tenant) return;
    setLoading(true);
    try {
      const [itemsRes, procRes, empRes] = await Promise.all([
        listChecklistItems(tenant.id), listProcesses(tenant.id), listActiveEmployees(tenant.id),
      ]);
      setItems(itemsRes.data);
      setProcesses(procRes.data);
      setEmployees(empRes.data);
    } finally {
      setLoading(false);
    }
  }, [tenant]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (activeProcess) {
      const fresh = processes.find((p) => p.id === activeProcess.id);
      if (fresh) setActiveProcess(fresh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processes]);

  const handleAddItem = async () => {
    if (!newItem.title.trim()) return showToast('Title is required', 'error');
    const { error } = await createChecklistItem(tenant.id, newItem);
    if (error) return showToast('Failed: ' + error.message, 'error');
    setNewItem({ title: '', description: '', category: 'General' });
    fetchData();
  };

  const handleStart = async () => {
    if (!startForm.profile_id) return showToast('Select an employee', 'error');
    if (!startForm.exit_date) return showToast('Enter the exit date (last day)', 'error');
    const { error } = await startProcess(tenant.id, startForm.profile_id, startForm, profile.id);
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast('Offboarding started', 'success');
    setShowStartModal(false);
    setStartForm(emptyStartForm());
    fetchData();
  };

  const handleProcessStatus = async (id, status) => {
    const { error } = await updateProcess(id, { status });
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast(status === 'Cancelled' ? 'Offboarding cancelled' : 'Offboarding reopened', 'success');
    fetchData();
  };

  const handleExitDate = async (id, exitDate) => {
    if (!exitDate) return;
    const { error } = await updateProcess(id, { exit_date: exitDate });
    if (error) return showToast('Failed: ' + error.message, 'error');
    showToast('Exit date updated', 'success');
    fetchData();
  };

  const handleTaskStatus = async (id, status) => {
    const { error } = await updateTaskStatus(id, status);
    if (error) return showToast('Failed: ' + error.message, 'error');
    fetchData();
  };

  return (
    <>
      <Header title="Offboarding" breadcrumb="Exit checklists and tracking"
        actions={<button className="btn btn-primary" onClick={() => setShowStartModal(true)}><i className="fas fa-plus" style={{ marginRight: 6 }} />Start Offboarding</button>}
      />
      <div className="page-content">
        <div className="filter-bar">
          <button className={`btn btn-sm ${tab === 'processes' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('processes')}>Offboarding</button>
          <button className={`btn btn-sm ${tab === 'checklist' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('checklist')}>Checklist Library</button>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>
        ) : tab === 'checklist' ? (
          <div className="card">
            <div className="card-header"><h3>Checklist Items</h3></div>
            <div className="card-body">
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <input className="form-input" placeholder="Task title" style={{ flex: '1 1 160px' }} value={newItem.title} onChange={(e) => setNewItem({ ...newItem, title: e.target.value })} />
                <input className="form-input" placeholder="Category" style={{ flex: '1 1 120px', maxWidth: 160 }} value={newItem.category} onChange={(e) => setNewItem({ ...newItem, category: e.target.value })} />
                <button className="btn btn-primary btn-sm" onClick={handleAddItem}>Add</button>
              </div>
              {items.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No checklist items yet — add the tasks every exiting employee should complete (e.g. return laptop, revoke access).</p>
              ) : items.map((item) => (
                <div key={item.id} className="settings-list-row">
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{item.title} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· {item.category}</span></div>
                    {item.description && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{item.description}</div>}
                  </div>
                  <button className="btn btn-outline btn-icon btn-sm" style={{ color: 'var(--danger)' }} onClick={async () => { await deleteChecklistItem(item.id); fetchData(); }}><i className="fas fa-trash" /></button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Employee</th><th>Status</th><th>Applied On</th><th>Exit Date</th><th>Tasks</th><th>Actions</th></tr></thead>
                <tbody>
                  {processes.length === 0 ? (
                    <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No offboarding processes started yet.</td></tr>
                  ) : processes.map((p) => {
                    const done = p.tasks?.filter((t) => t.status === 'Done').length || 0;
                    const total = p.tasks?.length || 0;
                    return (
                      <tr key={p.id}>
                        <td>{fullName(p.profile)}</td>
                        <td><StatusCell process={p} /></td>
                        <td>{fmt.date(p.applied_on)}</td>
                        <td>{fmt.date(p.exit_date)}</td>
                        <td>{done}/{total}</td>
                        <td><button className="btn btn-outline btn-sm" onClick={() => setActiveProcess(p)}>Manage</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <Modal show={showStartModal} onClose={() => setShowStartModal(false)} title="Start Offboarding" width="440px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setShowStartModal(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={handleStart}>Start</button>
        </>}
      >
        <div className="form-group">
          <label className="form-label">Employee *</label>
          <select className="form-select" value={startForm.profile_id} onChange={(e) => setStartForm({ ...startForm, profile_id: e.target.value })}>
            <option value="">Select employee</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{fullName(e)}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Reason</label>
          <input className="form-input" value={startForm.reason} onChange={(e) => setStartForm({ ...startForm, reason: e.target.value })} placeholder="e.g. Resignation, Termination" />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Applied On</label>
            <input className="form-input" type="date" value={startForm.applied_on} onChange={(e) => setStartForm({ ...startForm, applied_on: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Exit Date (last day) *</label>
            <input className="form-input" type="date" value={startForm.exit_date} onChange={(e) => setStartForm({ ...startForm, exit_date: e.target.value })} />
          </div>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: -4 }}>
          Status stays In Progress until the exit date. The day after, it changes to Completed on its own and the employee is set Inactive.
        </p>
        <div className="form-group">
          <label className="form-label">Notes</label>
          <textarea className="form-input" rows={3} value={startForm.notes} onChange={(e) => setStartForm({ ...startForm, notes: e.target.value })} />
        </div>
      </Modal>

      <Modal show={!!activeProcess} onClose={() => setActiveProcess(null)} title={activeProcess ? `Offboarding — ${fullName(activeProcess.profile)}` : ''} width="560px"
        footer={<button className="btn btn-outline" onClick={() => setActiveProcess(null)}>Close</button>}
      >
        {activeProcess && (
          <>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Status</label>
                <div><StatusCell process={activeProcess} /></div>
              </div>
              <div className="form-group">
                <label className="form-label">Applied On</label>
                <div style={{ fontSize: 13 }}>{fmt.date(activeProcess.applied_on)}</div>
              </div>
              <div className="form-group">
                <label className="form-label">Exit Date (last day)</label>
                <input key={activeProcess.exit_date} className="form-input" type="date" defaultValue={activeProcess.exit_date}
                  disabled={activeProcess.status === 'Cancelled'}
                  onBlur={(e) => e.target.value !== activeProcess.exit_date && handleExitDate(activeProcess.id, e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--text-muted)', flex: '1 1 200px' }}>
                {activeProcess.status === 'Cancelled'
                  ? 'This offboarding is cancelled.'
                  : 'Status follows the exit date: In Progress until then, Completed (employee Inactive) the day after.'}
              </span>
              {activeProcess.status === 'Cancelled' ? (
                <button className="btn btn-outline btn-sm" onClick={() => handleProcessStatus(activeProcess.id, 'In Progress')}>Reopen</button>
              ) : (
                <button className="btn btn-outline btn-sm" style={{ color: 'var(--danger)' }}
                  onClick={() => confirm(`Cancel the offboarding for ${fullName(activeProcess.profile)}?${activeProcess.status === 'Completed' ? ' They will be set Active again.' : ''}`) && handleProcessStatus(activeProcess.id, 'Cancelled')}>
                  Cancel Offboarding
                </button>
              )}
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Task</th><th>Category</th><th>Status</th></tr></thead>
                <tbody>
                  {(activeProcess.tasks || []).length === 0 ? (
                    <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16 }}>No tasks on this process.</td></tr>
                  ) : activeProcess.tasks.map((t) => (
                    <tr key={t.id}>
                      <td style={{ fontSize: 13 }}>{t.title}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.category}</td>
                      <td>
                        <select className="form-select" style={{ fontSize: 12, padding: '4px 8px' }} value={t.status} onChange={(e) => handleTaskStatus(t.id, e.target.value)}>
                          <option>Pending</option>
                          <option>In Progress</option>
                          <option>Done</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
