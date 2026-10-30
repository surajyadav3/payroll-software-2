import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import Header from '@/components/Header';
import CareersSettingsCard from '@/components/CareersSettingsCard';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/context/FeatureContext';
import { JOB_TYPES, listJobPostings, createJobPosting, updateJobPosting, deleteJobPosting } from '@/services/hiringService';
import { fmt, timeAgo } from '@/lib/helpers';

const POSTING_STATUS_BADGE = { Open: 'badge-success', 'On Hold': 'badge-warning', Closed: 'badge-danger' };

const EMPTY_POSTING_FORM = {
  title: '', department: '', location: '', employment_type: 'Full-time', experience_required: '',
  openings: 1, description: '', responsibilities: '', requirements: '', referral_bonus: '', closing_date: '',
};

function PostingModal({ show, onClose, posting, onSaved }) {
  const { tenant, profile } = useAuth();
  const [form, setForm] = useState(EMPTY_POSTING_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!show) return;
    setForm(posting ? {
      title: posting.title, department: posting.department, location: posting.location,
      employment_type: posting.employment_type, experience_required: posting.experience_required,
      openings: posting.openings, description: posting.description, responsibilities: posting.responsibilities,
      requirements: posting.requirements, referral_bonus: posting.referral_bonus || '', closing_date: posting.closing_date || '',
    } : EMPTY_POSTING_FORM);
  }, [show, posting]);

  const handleSave = async () => {
    if (!form.title.trim()) return showToast('Job title is required', 'error');
    if (!form.description.trim()) return showToast('Job description is required', 'error');
    setSaving(true);
    const payload = {
      title: form.title.trim(),
      department: form.department.trim(),
      location: form.location.trim(),
      employment_type: form.employment_type,
      experience_required: form.experience_required.trim(),
      openings: parseInt(form.openings, 10) || 1,
      description: form.description.trim(),
      responsibilities: form.responsibilities.trim(),
      requirements: form.requirements.trim(),
      referral_bonus: parseFloat(form.referral_bonus) || 0,
      closing_date: form.closing_date || null,
    };
    const { error } = posting
      ? await updateJobPosting(posting.id, payload)
      : await createJobPosting({ ...payload, tenant_id: tenant.id, created_by: profile.id });
    setSaving(false);
    if (error) return showToast('Failed to save posting: ' + error.message, 'error');
    showToast(posting ? 'Posting updated' : 'Job posting published', 'success');
    onSaved();
    onClose();
  };

  return (
    <Modal show={show} onClose={onClose} title={posting ? 'Edit Job Posting' : 'New Job Posting'} width="600px"
      footer={<>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <><div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Saving…</> : <><i className="fas fa-check" /> {posting ? 'Save' : 'Publish'}</>}
        </button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Job Title *</label>
            <input className="form-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Department</label>
            <input className="form-input" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Location</label>
            <input className="form-input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. Mumbai / Remote" />
          </div>
          <div className="form-group">
            <label className="form-label">Employment Type</label>
            <select className="form-select" value={form.employment_type} onChange={(e) => setForm({ ...form, employment_type: e.target.value })}>
              {JOB_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Experience Required</label>
            <input className="form-input" value={form.experience_required} onChange={(e) => setForm({ ...form, experience_required: e.target.value })} placeholder="e.g. 2-4 years" />
          </div>
          <div className="form-group">
            <label className="form-label">Openings</label>
            <input className="form-input" type="number" min="1" value={form.openings} onChange={(e) => setForm({ ...form, openings: e.target.value })} />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Job Description *</label>
          <textarea className="form-input" rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What is this role about?" />
        </div>
        <div className="form-group">
          <label className="form-label">Responsibilities</label>
          <textarea className="form-input" rows={3} value={form.responsibilities} onChange={(e) => setForm({ ...form, responsibilities: e.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label">Requirements</label>
          <textarea className="form-input" rows={3} value={form.requirements} onChange={(e) => setForm({ ...form, requirements: e.target.value })} />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Referral Bonus (₹)</label>
            <input className="form-input" type="number" min="0" value={form.referral_bonus} onChange={(e) => setForm({ ...form, referral_bonus: e.target.value })} placeholder="Optional" />
          </div>
          <div className="form-group">
            <label className="form-label">Closing Date</label>
            <input className="form-input" type="date" value={form.closing_date} onChange={(e) => setForm({ ...form, closing_date: e.target.value })} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default function HiringPage() {
  const { tenant, profile, refreshProfile } = useAuth();
  const canManage = profile?.role === 'admin';
  const { isEnabled } = useFeatures();

  const [tab, setTab] = useState('open');
  const [postings, setPostings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(new Set());
  const [postingModal, setPostingModal] = useState(null); // 'new' | posting object | null

  const fetchPostings = useCallback(async () => {
    if (!tenant) return;
    setLoading(true);
    const { data, error } = await listJobPostings(tenant.id);
    if (error) showToast('Failed to load job postings: ' + error.message, 'error');
    else setPostings(data);
    setLoading(false);
  }, [tenant]);

  useEffect(() => { fetchPostings(); }, [fetchPostings]);

  const toggleExpand = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const openPostings = postings.filter((p) => p.status === 'Open');

  const handlePostingStatus = async (posting, status) => {
    const { error } = await updateJobPosting(posting.id, { status });
    if (error) return showToast('Failed to update: ' + error.message, 'error');
    fetchPostings();
  };

  const handleDeletePosting = async (posting) => {
    if (!confirm(`Delete "${posting.title}"? This also removes any referrals against it.`)) return;
    const { error } = await deleteJobPosting(posting.id);
    if (error) return showToast('Delete failed: ' + error.message, 'error');
    showToast('Posting deleted', 'success');
    fetchPostings();
  };

  const TABS = canManage ? [{ id: 'open', label: 'Open Positions' }, { id: 'manage', label: 'Manage Postings' }] : [];

  return (
    <>
      <Header
        title="Hiring"
        breadcrumb="Open positions at your company"
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {TABS.length > 0 && (
              <div style={{ display: 'flex', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    style={{
                      padding: '6px 14px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                      background: tab === t.id ? 'var(--primary)' : 'transparent',
                      color: tab === t.id ? '#fff' : 'var(--text-muted)',
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            {canManage && tab === 'manage' && (
              <button className="btn btn-primary btn-sm" onClick={() => setPostingModal('new')}>
                <i className="fas fa-plus" /> New Posting
              </button>
            )}
            <Link to="/refer" className="btn btn-outline btn-sm"><i className="fas fa-user-plus" /> My Referrals</Link>
          </div>
        }
      />

      <div className="page-content">
        {canManage && isEnabled('careers_page') && <CareersSettingsCard tenant={tenant} onSaved={refreshProfile} />}
        {loading ? (
          <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…
          </div>
        ) : (
          <>
            {tab === 'open' && (
              openPostings.length === 0 ? (
                <div className="card" style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
                  No open positions right now — check back soon.
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
                  {openPostings.map((p) => (
                    <div key={p.id} className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div>
                        <h3 style={{ margin: '0 0 6px' }}>{p.title}</h3>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <span className="badge badge-info">{p.employment_type}</span>
                          {p.department && <span className="badge">{p.department}</span>}
                          {p.location && <span className="badge">{p.location}</span>}
                        </div>
                      </div>
                      {p.experience_required && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}><i className="fas fa-briefcase" style={{ marginRight: 6 }} />{p.experience_required}</div>}
                      {p.referral_bonus > 0 && (
                        <div style={{ fontSize: 12, color: 'var(--success)', background: 'var(--success-light)', padding: '5px 10px', borderRadius: 6 }}>
                          <i className="fas fa-gift" /> Refer &amp; earn {fmt(p.referral_bonus)}
                        </div>
                      )}
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                        {expanded.has(p.id) ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, whiteSpace: 'pre-wrap' }}>
                            <div>{p.description}</div>
                            {p.responsibilities && <div><strong>Responsibilities</strong><br />{p.responsibilities}</div>}
                            {p.requirements && <div><strong>Requirements</strong><br />{p.requirements}</div>}
                          </div>
                        ) : (
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>
                            {p.description}
                          </div>
                        )}
                        <button className="btn btn-outline btn-sm" style={{ marginTop: 8 }} onClick={() => toggleExpand(p.id)}>
                          {expanded.has(p.id) ? 'Show less' : 'View full JD'}
                        </button>
                      </div>
                      <Link to={`/refer?job=${p.id}`} className="btn btn-primary" style={{ marginTop: 'auto', textAlign: 'center' }}>
                        <i className="fas fa-user-plus" /> Refer a Candidate
                      </Link>
                    </div>
                  ))}
                </div>
              )
            )}

            {tab === 'manage' && canManage && (
              <div className="card">
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Title</th><th>Department</th><th>Type</th><th>Openings</th><th>Status</th><th>Posted</th><th>Actions</th></tr></thead>
                    <tbody>
                      {postings.length === 0 ? (
                        <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No job postings yet.</td></tr>
                      ) : postings.map((p) => (
                        <tr key={p.id}>
                          <td style={{ fontWeight: 600 }}>{p.title}</td>
                          <td>{p.department || '—'}</td>
                          <td>{p.employment_type}</td>
                          <td>{p.openings}</td>
                          <td><span className={`badge ${POSTING_STATUS_BADGE[p.status] || 'badge'}`}>{p.status}</span></td>
                          <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{timeAgo(p.created_at)}</td>
                          <td>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <button className="btn btn-outline btn-icon btn-sm" title="Edit" onClick={() => setPostingModal(p)}><i className="fas fa-edit" /></button>
                              {p.status !== 'Closed' ? (
                                <button className="btn btn-outline btn-icon btn-sm" title="Close posting" onClick={() => handlePostingStatus(p, 'Closed')}><i className="fas fa-times-circle" /></button>
                              ) : (
                                <button className="btn btn-outline btn-icon btn-sm" title="Reopen" onClick={() => handlePostingStatus(p, 'Open')}><i className="fas fa-undo" /></button>
                              )}
                              {p.status === 'Open' && (
                                <button className="btn btn-outline btn-icon btn-sm" title="Put on hold" onClick={() => handlePostingStatus(p, 'On Hold')}><i className="fas fa-pause" /></button>
                              )}
                              <button className="btn btn-outline btn-icon btn-sm" style={{ color: 'var(--danger)' }} title="Delete" onClick={() => handleDeletePosting(p)}><i className="fas fa-trash" /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <PostingModal
        show={!!postingModal}
        onClose={() => setPostingModal(null)}
        posting={postingModal === 'new' ? null : postingModal}
        onSaved={fetchPostings}
      />
    </>
  );
}
