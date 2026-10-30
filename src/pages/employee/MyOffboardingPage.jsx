import { useEffect, useState, useCallback } from 'react';
import Header from '@/components/Header';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { fetchMyProcess, updateTaskStatus, exitCountdown } from '@/services/offboardingService';
import { fmt } from '@/lib/helpers';

const STATUS_BADGE = { 'In Progress': 'badge-info', Completed: 'badge-success', Cancelled: 'badge-danger' };

export function MyOffboardingContent() {
  const { profile } = useAuth();
  const [process, setProcess] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    try {
      const { data } = await fetchMyProcess(profile.id);
      setProcess(data);
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleMarkDone = async (taskId) => {
    const { error } = await updateTaskStatus(taskId, 'Done');
    if (error) return showToast('Failed: ' + error.message, 'error');
    fetchData();
  };

  return (
    <div className="page-content">
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>
        ) : !process ? (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <i className="fas fa-door-open" style={{ fontSize: 32, marginBottom: 12, display: 'block' }} />
            No exit checklist has been assigned to you.
          </div>
        ) : (
          <div className="card">
            <div className="card-header">
              <h3>Offboarding <span className={`badge ${STATUS_BADGE[process.status]}`} style={{ marginLeft: 8 }}>{process.status}</span></h3>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{process.applied_on ? `Applied on ${fmt.date(process.applied_on)} · ` : ''}Exit date {fmt.date(process.exit_date)}{exitCountdown(process) ? ` · ${exitCountdown(process)}` : ''}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Task</th><th>Category</th><th>Status</th><th>Action</th></tr></thead>
                <tbody>
                  {(process.tasks || []).length === 0 ? (
                    <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16 }}>No tasks yet.</td></tr>
                  ) : process.tasks.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{t.title}</div>
                        {t.description && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t.description}</div>}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t.category}</td>
                      <td><span className={`badge ${t.status === 'Done' ? 'badge-success' : t.status === 'In Progress' ? 'badge-info' : 'badge-warning'}`}>{t.status}</span></td>
                      <td>
                        {t.status !== 'Done' && (
                          <button className="btn btn-outline btn-sm" onClick={() => handleMarkDone(t.id)}>Mark Done</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
  );
}

export default function MyOffboardingPage() {
  return (
    <>
      <Header title="My Offboarding" breadcrumb="Your exit checklist" />
      <MyOffboardingContent />
    </>
  );
}
