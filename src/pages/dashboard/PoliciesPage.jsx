import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import {
  POLICY_CATEGORIES,
  listPolicies, listManagedPolicies, createPolicy, updatePolicy, publishPolicyVersion, setPolicyStatus, deletePolicy,
  acknowledgePolicy, listMyAcknowledgements, countAcknowledgements, recordPolicyDownload, fetchPolicyAudit,
} from '@/services/policyService';
import { listColleagues } from '@/services/employeeService';
import { fullName } from '@/lib/helpers';

const isImageAttachment = (name, url) => /\.(jpe?g|png|gif|webp|heic|heif)(\?|$)/i.test(name || url || '');

// Supabase public storage URLs honour ?download=<name> by sending a
// Content-Disposition: attachment header — a plain <a download> is ignored
// cross-origin, so this is what actually makes the browser save the file.
const downloadUrl = (url, name) =>
  `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(name || 'policy')}`;

const fmtStamp = (ts) => new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

const STATUS = {
  draft: { label: 'Draft', badge: 'badge-secondary' },
  published: { label: 'Live', badge: 'badge-success' },
  archived: { label: 'Archived', badge: 'badge-secondary' },
};

function SourceBadge({ source }) {
  if (!source) return null;
  return (
    <span className={`badge ${source === 'app' ? 'badge-purple' : 'badge-info'}`} style={{ fontSize: 10, marginLeft: 6 }}>
      <i className={`fas ${source === 'app' ? 'fa-mobile-screen' : 'fa-desktop'}`} style={{ marginRight: 3 }} />
      {source === 'app' ? 'Phone' : 'Web'}
    </span>
  );
}

const AUDIT_FILTERS = ['All', 'Acknowledged', 'Not Acknowledged', 'Downloaded'];

export default function PoliciesPage() {
  const { tenant, profile } = useAuth();
  const isAdmin = profile?.role === 'admin' || profile?.role === 'superadmin';
  const [params, setParams] = useSearchParams();
  const tab = isAdmin && params.get('tab') === 'manage' ? 'manage' : 'library';

  const [policies, setPolicies] = useState([]);
  const [managed, setManaged] = useState([]);
  const [loading, setLoading] = useState(true);
  const [myAcks, setMyAcks] = useState({});
  const [ackCounts, setAckCounts] = useState({});
  const [acking, setAcking] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | policy
  const [versioning, setVersioning] = useState(null); // policy
  const [history, setHistory] = useState(null); // policy
  const [busy, setBusy] = useState(null);

  const [audit, setAudit] = useState(null); // { policy, loading, employees, acks, downloads }
  const [auditFilter, setAuditFilter] = useState('All');
  const [auditSearch, setAuditSearch] = useState('');

  const fetchData = useCallback(async () => {
    if (!tenant || !profile) return;
    try {
      const [{ data, error }, { data: acks }] = await Promise.all([
        listPolicies(tenant.id),
        listMyAcknowledgements(tenant.id, profile.id),
      ]);
      if (error) showToast(error.message || 'Failed to load policies', 'error');
      setPolicies(data || []);
      setMyAcks(acks || {});
      if (isAdmin) {
        const [{ data: counts }, { data: all }] = await Promise.all([countAcknowledgements(tenant.id), listManagedPolicies(tenant.id)]);
        setAckCounts(counts || {});
        setManaged(all || []);
      }
    } catch (err) {
      showToast(err.message || 'Failed to load policies', 'error');
    } finally {
      setLoading(false);
    }
  }, [tenant, profile, isAdmin]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleAcknowledge = async (policy) => {
    setAcking(policy.id);
    const { error } = await acknowledgePolicy(policy.id, profile, tenant.id, policy.title);
    setAcking(null);
    if (error) return showToast('Failed to acknowledge: ' + error.message, 'error');
    const ackedAt = new Date().toISOString();
    setMyAcks((prev) => ({ ...prev, [policy.id]: ackedAt }));
    setAckCounts((prev) => ({ ...prev, [policy.id]: (prev[policy.id] || 0) + 1 }));
    showToast('Acknowledged', 'success');
  };

  const handleDownload = (policy) => {
    // Not awaited — the download itself must never wait on (or fail because of) the audit write.
    recordPolicyDownload(policy.id, profile.id, tenant.id);
  };

  const run = async (id, fn, ok) => {
    setBusy(id);
    const { error } = await fn();
    setBusy(null);
    if (error) return showToast(error.message || 'Could not update', 'error');
    showToast(ok, 'success');
    fetchData();
  };

  const openAudit = async (policy) => {
    setAuditFilter('All');
    setAuditSearch('');
    setAudit({ policy, loading: true, employees: [], acks: {}, downloads: {} });
    const [{ data: employees }, { acks, downloads, error }] = await Promise.all([
      listColleagues(tenant.id),
      fetchPolicyAudit(policy.id),
    ]);
    if (error) {
      showToast('Failed to load acknowledgements: ' + error.message, 'error');
      setAudit(null);
      return;
    }
    setAudit({ policy, loading: false, employees, acks, downloads });
  };

  const auditRows = (() => {
    if (!audit || audit.loading) return [];
    const q = auditSearch.trim().toLowerCase();
    return audit.employees
      .map((emp) => ({ emp, ack: audit.acks[emp.id], dl: audit.downloads[emp.id] }))
      .filter(({ emp, ack, dl }) => {
        if (auditFilter === 'Acknowledged' && !ack) return false;
        if (auditFilter === 'Not Acknowledged' && ack) return false;
        if (auditFilter === 'Downloaded' && !dl) return false;
        if (!q) return true;
        return fullName(emp).toLowerCase().includes(q) || (emp.employee_id || '').toLowerCase().includes(q)
          || (emp.department || '').toLowerCase().includes(q);
      })
      // Pending first — that's who HR needs to chase.
      .sort((a, b) => (!!a.ack - !!b.ack) || fullName(a.emp).localeCompare(fullName(b.emp)));
  })();

  const auditCounts = audit && !audit.loading ? {
    total: audit.employees.length,
    acked: audit.employees.filter((e) => audit.acks[e.id]).length,
    ackedApp: audit.employees.filter((e) => audit.acks[e.id]?.source === 'app').length,
    downloaded: audit.employees.filter((e) => audit.downloads[e.id]).length,
  } : null;

  const cats = useMemo(() => [...new Set(policies.map((p) => p.category))], [policies]);
  const library = policies.filter((p) =>
    (!category || p.category === category)
    && (!search.trim() || `${p.title} ${p.summary || ''} ${p.body || ''}`.toLowerCase().includes(search.trim().toLowerCase())));
  const pendingMine = policies.filter((p) => p.requires_ack && !myAcks[p.id]).length;

  return (
    <>
      <Header
        title="Policies"
        breadcrumb="Company policies — read, download and acknowledge"
        actions={isAdmin && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <i className="fas fa-plus" /> New policy
          </button>
        )}
      />
      {isAdmin && (
        <div className="tab-bar-wrap">
          <div className="tabs">
            <button className={`tab-btn ${tab === 'library' ? 'active' : ''}`} onClick={() => setParams({})}>Library</button>
            <button className={`tab-btn ${tab === 'manage' ? 'active' : ''}`} onClick={() => setParams({ tab: 'manage' })}>Manage</button>
          </div>
        </div>
      )}
      <div className="page-content" style={isAdmin ? { paddingTop: 8 } : undefined}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…
          </div>
        ) : tab === 'manage' ? (
          <ManageTable
            rows={managed} ackCounts={ackCounts} busy={busy}
            onEdit={setEditing} onVersion={setVersioning} onHistory={setHistory} onAudit={openAudit}
            onStatus={(p, status, ok) => run(p.id, () => setPolicyStatus(p.id, status), ok)}
            onDelete={(p) => { if (confirm(`Delete "${p.title}" permanently? Its acknowledgements go with it.`)) run(p.id, () => deletePolicy(p.id), 'Deleted.'); }}
          />
        ) : (
          <>
            <div className="filter-bar">
              <input className="form-input" placeholder="Search policies…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 280 }} />
              <button className={`btn btn-sm ${!category ? 'btn-primary' : 'btn-outline'}`} onClick={() => setCategory('')}>All</button>
              {cats.map((c) => (
                <button key={c} className={`btn btn-sm ${category === c ? 'btn-primary' : 'btn-outline'}`} onClick={() => setCategory(c)}>
                  {POLICY_CATEGORIES[c] || c}
                </button>
              ))}
              {pendingMine > 0 && (
                <span className="badge badge-warning" style={{ marginLeft: 'auto' }}>{pendingMine} to acknowledge</span>
              )}
            </div>
            {library.length === 0 ? (
              <div className="card"><div className="empty-state">
                <div className="empty-icon"><i className="fas fa-book" /></div>
                <h3>{policies.length ? 'No policies match' : 'No policies yet'}</h3>
                <p>{policies.length ? 'Try another search or category.' : 'Company policies will appear here once HR publishes them.'}</p>
              </div></div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {library.map((p) => (
                  <PolicyCard key={p.id} p={p} isAdmin={isAdmin} ackedAt={myAcks[p.id]} acking={acking === p.id}
                    ackCount={ackCounts[p.id] || 0} onAcknowledge={handleAcknowledge} onDownload={handleDownload}
                    onAudit={openAudit} onHistory={setHistory} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <PolicyEditor value={editing} tenant={tenant} profile={profile} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); fetchData(); }} />
      <NewVersionModal policy={versioning} onClose={() => setVersioning(null)}
        onDone={() => { setVersioning(null); fetchData(); }} />
      <HistoryModal policy={history} onClose={() => setHistory(null)} />

      <Modal show={!!audit} onClose={() => setAudit(null)}
        title={audit ? `Policy status — ${audit.policy.title}` : ''} width="760px"
        footer={<button className="btn btn-outline" onClick={() => setAudit(null)}>Close</button>}
      >
        {audit?.loading ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div className="spinner" style={{ margin: '0 auto 12px' }} />Loading…
          </div>
        ) : audit && (
          <>
            {audit.policy.version_no > 1 && (
              <p className="form-hint" style={{ marginTop: 0, marginBottom: 12 }}>
                Showing version {audit.policy.version_no}. Earlier versions&apos; counts are in its history.
              </p>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 14 }}>
              {[
                ['Employees', auditCounts.total, 'var(--text)'],
                ['Acknowledged', auditCounts.acked, 'var(--success)'],
                ['Pending', auditCounts.total - auditCounts.acked, 'var(--warning)'],
                ['Via Phone', auditCounts.ackedApp, 'var(--primary)'],
                ['Downloaded', auditCounts.downloaded, 'var(--text)'],
              ].map(([label, value, color]) => (
                <div key={label} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px' }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color }}>{value}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
              {AUDIT_FILTERS.map((f) => (
                <button key={f} className={`btn btn-sm ${auditFilter === f ? 'btn-primary' : 'btn-outline'}`} onClick={() => setAuditFilter(f)}>{f}</button>
              ))}
              <input className="form-input" placeholder="Search name, EMP code, department…" value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)} style={{ maxWidth: 240, marginLeft: 'auto' }} />
            </div>
            <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr><th>Employee</th><th>Acknowledged</th><th>Downloaded</th></tr>
                </thead>
                <tbody>
                  {auditRows.length === 0 ? (
                    <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20 }}>No employees match</td></tr>
                  ) : auditRows.map(({ emp, ack, dl }) => (
                    <tr key={emp.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{fullName(emp)}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {[emp.employee_id, emp.department].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        {ack ? (
                          <span style={{ color: 'var(--success)' }}>
                            <i className="fas fa-check-circle" /> {fmtStamp(ack.acknowledged_at)}<SourceBadge source={ack.source} />
                          </span>
                        ) : <span className="badge badge-warning">Pending</span>}
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        {dl ? (
                          <span><i className="fas fa-download" style={{ color: 'var(--text-muted)' }} /> {fmtStamp(dl.downloaded_at)}<SourceBadge source={dl.source} /></span>
                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
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

// ───────────────────────────── library card ─────────────────────────────

function PolicyCard({ p, isAdmin, ackedAt, acking, ackCount, onAcknowledge, onDownload, onAudit, onHistory }) {
  const long = (p.body || '').length > 500;
  const [open, setOpen] = useState(!long);
  return (
    <div className="card" style={{ padding: 20, marginBottom: 0 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <span className="badge badge-info">{POLICY_CATEGORIES[p.category] || p.category}</span>
        <span style={{ color: 'var(--text-muted)' }}>
          Version {p.version_no} · {fmtDay(p.published_at || p.created_at)}{p.author ? ` · ${fullName(p.author)}` : ''}
        </span>
        {p.version_history?.length > 0 && (
          <button className="btn btn-outline btn-sm" style={{ marginLeft: 'auto' }} onClick={() => onHistory(p)}>
            <i className="fas fa-clock-rotate-left" /> History
          </button>
        )}
      </div>
      <h3 style={{ margin: '10px 0 0', fontSize: 18, fontWeight: 600 }}>{p.title}</h3>
      {p.summary && <p style={{ margin: '4px 0 0', fontSize: 14, color: 'var(--text-secondary)' }}>{p.summary}</p>}
      {p.version_no > 1 && p.change_note && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 12, background: 'var(--accent-light)', color: 'var(--accent)', fontSize: 13 }}>
          <b>What changed in version {p.version_no}:</b> {p.change_note}
        </div>
      )}
      {p.body && (
        <p style={{
          marginTop: 12, whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6,
          ...(!open && { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
        }}>{p.body}</p>
      )}
      {!open && <button className="btn btn-outline btn-sm" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>Read more</button>}
      {p.pdf_url && (
        <div style={{ marginTop: 12 }}>
          {isImageAttachment(p.pdf_name, p.pdf_url) && (
            <a href={p.pdf_url} target="_blank" rel="noopener noreferrer" onClick={() => onDownload(p)} style={{ display: 'inline-block', marginBottom: 8 }}>
              <img src={p.pdf_url} alt={p.pdf_name || 'Policy photo'} style={{ maxWidth: 320, maxHeight: 220, borderRadius: 8, display: 'block' }} />
            </a>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a className="btn btn-outline btn-sm" href={p.pdf_url} target="_blank" rel="noopener noreferrer" onClick={() => onDownload(p)}>
              <i className={`fas ${isImageAttachment(p.pdf_name, p.pdf_url) ? 'fa-image' : 'fa-file-pdf'}`} /> View{p.pdf_name ? ` — ${p.pdf_name}` : ''}
            </a>
            <a className="btn btn-outline btn-sm" href={downloadUrl(p.pdf_url, p.pdf_name)} onClick={() => onDownload(p)}>
              <i className="fas fa-download" /> Download
            </a>
          </div>
        </div>
      )}
      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        {!p.requires_ack ? (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>For information — no acknowledgement needed</span>
        ) : ackedAt ? (
          <span className="badge badge-success"><i className="fas fa-check-circle" /> Acknowledged {fmtStamp(ackedAt)}</span>
        ) : (
          <button className="btn btn-primary btn-sm" disabled={acking} onClick={() => onAcknowledge(p)}>
            <i className="fas fa-check" /> {acking ? 'Acknowledging…' : 'I have read & acknowledge'}
          </button>
        )}
        {isAdmin && p.requires_ack && (
          <button className="btn btn-outline btn-sm" onClick={() => onAudit(p)}>
            <i className="fas fa-users" /> {ackCount} acknowledged · View who
          </button>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── manage (HR) ─────────────────────────────

function ManageTable({ rows, ackCounts, busy, onEdit, onVersion, onHistory, onAudit, onStatus, onDelete }) {
  const [filter, setFilter] = useState('published');
  const counts = { published: 0, draft: 0, archived: 0 };
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const visible = rows.filter((r) => filter === 'all' || r.status === filter);
  return (
    <>
      <div className="filter-bar">
        {[['published', 'Live'], ['draft', 'Drafts'], ['archived', 'Archived'], ['all', 'All']].map(([k, l]) => (
          <button key={k} className={`btn btn-sm ${filter === k ? 'btn-primary' : 'btn-outline'}`} onClick={() => setFilter(k)}>
            {l} <span style={{ opacity: 0.7 }}>{k === 'all' ? rows.length : counts[k] || 0}</span>
          </button>
        ))}
      </div>
      {!visible.length ? (
        <div className="card"><div className="empty-state">
          <div className="empty-icon"><i className="fas fa-book" /></div>
          <h3>Nothing here</h3>
          <p>Write a policy — save it as a draft first, then publish when it&apos;s ready.</p>
        </div></div>
      ) : (
        <div className="card"><div className="table-wrap"><table>
          <thead><tr><th>Policy</th><th>Status</th><th>Version</th><th>Acknowledged</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id}>
                <td style={{ minWidth: 220 }}>
                  <div className="emp-name">{p.title}</div>
                  <div className="emp-role">{POLICY_CATEGORIES[p.category] || p.category}{p.pdf_name ? ` · ${p.pdf_name}` : ''}</div>
                </td>
                <td><span className={`badge ${STATUS[p.status].badge}`}>{STATUS[p.status].label}</span></td>
                <td style={{ fontSize: 13 }}>
                  v{p.version_no}
                  {p.version_history?.length > 0 && (
                    <button className="btn btn-outline btn-sm" style={{ marginLeft: 6 }} onClick={() => onHistory(p)} title="Version history">
                      <i className="fas fa-clock-rotate-left" />
                    </button>
                  )}
                </td>
                <td>
                  {!p.requires_ack ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Not required</span>
                    : p.status === 'draft' ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
                    : <button className="btn btn-outline btn-sm" onClick={() => onAudit(p)}><i className="fas fa-users" /> {ackCounts[p.id] || 0} · see who</button>}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {p.status !== 'archived' && <button className="btn btn-outline btn-sm" onClick={() => onEdit(p)}>Edit</button>}{' '}
                  {p.status === 'draft' && (
                    <button className="btn btn-primary btn-sm" disabled={busy === p.id} onClick={() => onStatus(p, 'published', 'Published — everyone is notified.')}>
                      <i className="fas fa-paper-plane" /> Publish
                    </button>
                  )}{' '}
                  {p.status === 'published' && (
                    <button className="btn btn-outline btn-sm" disabled={busy === p.id} onClick={() => onVersion(p)} title="Publish the current text as a new version">
                      <i className="fas fa-code-branch" /> New version
                    </button>
                  )}{' '}
                  {p.status === 'published' && (
                    <button className="btn btn-outline btn-sm" disabled={busy === p.id} onClick={() => onStatus(p, 'archived', 'Archived — removed from the library.')}>
                      <i className="fas fa-box-archive" /> Archive
                    </button>
                  )}
                  {p.status === 'archived' && (
                    <button className="btn btn-outline btn-sm" disabled={busy === p.id} onClick={() => onStatus(p, 'published', 'Restored to the library.')}>
                      <i className="fas fa-rotate-left" /> Restore
                    </button>
                  )}{' '}
                  {p.status !== 'published' && (
                    <button className="btn btn-outline btn-sm" style={{ color: 'var(--danger)' }} title="Delete permanently" disabled={busy === p.id} onClick={() => onDelete(p)}>
                      <i className="fas fa-trash" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div></div>
      )}
    </>
  );
}

// ───────────────────────────── editor ─────────────────────────────

function PolicyEditor({ value, tenant, profile, onClose, onSaved }) {
  const editing = value && value !== 'new' ? value : null;
  const [f, setF] = useState({ title: '', category: 'general', summary: '', body: '', requiresAck: true });
  const [pdfFile, setPdfFile] = useState(null);
  const [removeFile, setRemoveFile] = useState(false);
  const [saving, setSaving] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!value) return;
    setF(editing
      ? { title: editing.title, category: editing.category, summary: editing.summary || '', body: editing.body || '', requiresAck: editing.requires_ack }
      : { title: '', category: 'general', summary: '', body: '', requiresAck: true });
    setPdfFile(null);
    setRemoveFile(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [value, editing]);

  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.type.startsWith('image/')) {
      showToast('Only PDF or image files are allowed', 'error');
      e.target.value = '';
      return;
    }
    setPdfFile(file);
    setRemoveFile(false);
  };

  const save = async (publish) => {
    if (!f.title.trim()) return showToast('Title is required', 'error');
    setSaving(publish ? 'publish' : 'save');
    try {
      const { error } = editing
        ? await updatePolicy({ tenantId: tenant.id, id: editing.id, form: f, pdfFile, removeFile })
        : await createPolicy({ tenantId: tenant.id, createdBy: profile.id, form: f, pdfFile, publish });
      if (error) return showToast('Failed: ' + error.message, 'error');
      if (editing && publish && editing.status === 'draft') {
        const { error: pubErr } = await setPolicyStatus(editing.id, 'published');
        if (pubErr) return showToast('Saved, but could not publish: ' + pubErr.message, 'error');
      }
      showToast(
        editing ? (publish && editing.status === 'draft' ? 'Published — everyone is notified.' : 'Saved.')
          : publish ? 'Policy published — everyone is notified.' : 'Draft saved — nobody sees it until you publish.',
        'success',
      );
      onSaved();
    } finally {
      setSaving(null);
    }
  };

  const isLive = editing?.status === 'published';
  return (
    <Modal show={!!value} onClose={onClose} width="640px"
      title={editing ? `Edit policy${isLive ? ` (version ${editing.version_no} is live)` : ''}` : 'New policy'}
      footer={<>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        {(!editing || editing.status === 'draft') ? (
          <>
            <button className="btn btn-outline" onClick={() => save(false)} disabled={!!saving}>
              {saving === 'save' ? 'Saving…' : 'Save draft'}
            </button>
            <button className="btn btn-primary" onClick={() => save(true)} disabled={!!saving}>
              <i className="fas fa-paper-plane" /> {saving === 'publish' ? 'Publishing…' : 'Publish'}
            </button>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => save(false)} disabled={!!saving}>
            <i className="fas fa-check" /> {saving ? 'Saving…' : 'Save changes'}
          </button>
        )}
      </>}
    >
      {isLive && (
        <div className="form-hint" style={{ marginTop: 0, marginBottom: 14, padding: '10px 12px', borderRadius: 12, background: 'var(--surface-hover)' }}>
          Saving fixes the live text in place. To ask everyone to read it again, save first, then use <b>New version</b> in Manage.
        </div>
      )}
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Title *</label>
          <input className="form-input" maxLength={200} value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Leave policy 2026" />
        </div>
        <div className="form-group">
          <label className="form-label">Category</label>
          <select className="form-select" value={f.category} onChange={(e) => set('category', e.target.value)}>
            {Object.entries(POLICY_CATEGORIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Summary</label>
        <input className="form-input" maxLength={300} value={f.summary} onChange={(e) => set('summary', e.target.value)} placeholder="One line people see in the library" />
      </div>
      <div className="form-group">
        <label className="form-label">Policy text</label>
        <textarea className="form-textarea" rows={7} value={f.body} onChange={(e) => set('body', e.target.value)} />
      </div>
      <div className="form-group">
        <label className="form-label">Policy PDF or photo</label>
        {editing?.pdf_url && !removeFile && !pdfFile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 }}>
            <i className="fas fa-paperclip" /> {editing.pdf_name || 'Attachment'}
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setRemoveFile(true)}>Remove</button>
          </div>
        )}
        <input ref={fileInputRef} className="form-input" type="file" accept="application/pdf,image/*" onChange={handleFileChange} />
        {pdfFile && <div className="form-hint">{pdfFile.name}{editing?.pdf_url ? ' — replaces the current file' : ''}</div>}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
        <input type="checkbox" checked={f.requiresAck} onChange={(e) => set('requiresAck', e.target.checked)} />
        Everyone must acknowledge it
      </label>
    </Modal>
  );
}

function NewVersionModal({ policy, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [reask, setReask] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (policy) { setNote(''); setReask(true); } }, [policy]);

  const submit = async () => {
    if (!note.trim()) return showToast('Say what changed — everyone sees it.', 'error');
    setSaving(true);
    const { data, error } = await publishPolicyVersion(policy.id, note.trim(), reask);
    setSaving(false);
    if (error) return showToast(error.message, 'error');
    showToast(`Version ${data} published — everyone is notified.`, 'success');
    onDone();
  };

  return (
    <Modal show={!!policy} onClose={onClose} width="520px" title={policy ? `Publish version ${policy.version_no + 1}` : ''}
      footer={<>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={saving}>
          <i className="fas fa-code-branch" /> {saving ? 'Publishing…' : 'Publish new version'}
        </button>
      </>}
    >
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
        Publishes the text and file currently saved for <b>{policy?.title}</b> as the next version. Edit and save it first if it still needs changes.
      </p>
      <div className="form-group">
        <label className="form-label">What changed *</label>
        <textarea className="form-textarea" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Casual leave raised from 8 to 10 days a year" />
        <div className="form-hint">Shown to everyone at the top of the policy.</div>
      </div>
      {policy?.requires_ack && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={reask} onChange={(e) => setReask(e.target.checked)} />
          Ask everyone to acknowledge again
        </label>
      )}
    </Modal>
  );
}

function HistoryModal({ policy, onClose }) {
  const versions = policy ? [
    { version_no: policy.version_no, change_note: policy.change_note, published_at: policy.published_at, current: true },
    ...[...(policy.version_history || [])].reverse(),
  ] : [];
  return (
    <Modal show={!!policy} onClose={onClose} width="560px" title={policy ? `History — ${policy.title}` : ''}
      footer={<button className="btn btn-outline" onClick={onClose}>Close</button>}>
      <div className="table-wrap"><table>
        <thead><tr><th>Version</th><th>What changed</th><th>Published</th><th>Acknowledged</th></tr></thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.version_no}>
              <td><span className={`badge ${v.current ? 'badge-success' : 'badge-secondary'}`}>v{v.version_no}{v.current ? ' · live' : ''}</span></td>
              <td style={{ fontSize: 13 }}>{v.change_note || (v.version_no === 1 ? 'First version' : '—')}</td>
              <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{v.published_at ? fmtDay(v.published_at) : '—'}</td>
              <td style={{ fontSize: 13 }}>{v.current ? 'see "View who"' : v.ack_count ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </Modal>
  );
}
