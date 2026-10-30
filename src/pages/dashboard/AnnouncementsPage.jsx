import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import Header from '@/components/Header';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import {
  KINDS, announcementState,
  listAnnouncements, listManagedAnnouncements, createAnnouncement, updateAnnouncement,
  publishAnnouncement, archiveAnnouncement, restoreAnnouncement, setAnnouncementPinned, deleteAnnouncement,
  getAnnouncementReceipts, acknowledgeAnnouncement, listMyAcknowledgements, countAcknowledgements,
  setAutoBirthdayPosts, readSeenAnnouncements, markAnnouncementsSeen,
} from '@/services/announcementService';
import { listDepartments, listOutlets } from '@/services/tenantService';
import { fullName, getInitials, getAvatarColor } from '@/lib/helpers';
import BirthdayCardsPanel from './BirthdayCardsPanel';
import './AnnouncementsPage.css';

const STATE = {
  draft: { label: 'Draft', badge: 'badge-secondary' },
  scheduled: { label: 'Scheduled', badge: 'badge-info' },
  live: { label: 'Live', badge: 'badge-success' },
  expired: { label: 'Expired', badge: 'badge-secondary' },
  archived: { label: 'Archived', badge: 'badge-secondary' },
};

const fmt = (iso, withTime = true) => new Date(iso).toLocaleString('en-IN', {
  day: 'numeric', month: 'short', ...(withTime && { hour: 'numeric', minute: '2-digit' }),
});

export default function AnnouncementsPage() {
  const { tenant, profile } = useAuth();
  const isAdmin = profile?.role === 'admin' || profile?.role === 'superadmin';
  const [params, setParams] = useSearchParams();
  const hasCards = isAdmin && !!tenant?.birthday_card;
  const tab = isAdmin && params.get('tab') === 'manage' ? 'manage'
    : hasCards && params.get('tab') === 'birthdays' ? 'birthdays' : 'feed';
  const [editing, setEditing] = useState(null); // null | 'new' | row
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  return (
    <>
      <Header
        title="Announcements"
        breadcrumb="News, updates and important notices"
        actions={isAdmin && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <i className="fas fa-pen-to-square" /> Write announcement
          </button>
        )}
      />
      {isAdmin && (
        <div className="tab-bar-wrap">
          <div className="tabs">
            <button className={`tab-btn ${tab === 'feed' ? 'active' : ''}`} onClick={() => setParams({})}>Feed</button>
            <button className={`tab-btn ${tab === 'manage' ? 'active' : ''}`} onClick={() => setParams({ tab: 'manage' })}>Manage</button>
            {hasCards && (
              <button className={`tab-btn ${tab === 'birthdays' ? 'active' : ''}`} onClick={() => setParams({ tab: 'birthdays' })}>
                <i className="fas fa-cake-candles" /> Birthday cards
              </button>
            )}
          </div>
        </div>
      )}
      <div className="page-content" style={isAdmin ? { paddingTop: 8 } : undefined}>
        {tab === 'feed'
          ? <Feed key={reloadKey} tenant={tenant} profile={profile} focusId={params.get('item')} />
          : tab === 'birthdays'
            ? <BirthdayCardsPanel tenant={tenant} />
            : <Manage key={reloadKey} tenant={tenant} onEdit={setEditing} onChanged={reload} />}
      </div>
      <Composer
        value={editing}
        tenant={tenant}
        profile={profile}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); reload(); }}
      />
    </>
  );
}

// ───────────────────────────── feed ─────────────────────────────

function Feed({ tenant, profile, focusId }) {
  const [items, setItems] = useState([]);
  const [acks, setAcks] = useState({});
  const [loading, setLoading] = useState(true);
  const [acking, setAcking] = useState(null);
  const [seen] = useState(readSeenAnnouncements);
  const [kind, setKind] = useState('all');

  useEffect(() => {
    if (!tenant || !profile) return;
    let cancelled = false;
    Promise.all([listAnnouncements(tenant.id), listMyAcknowledgements(tenant.id, profile.id)]).then(([a, k]) => {
      if (cancelled) return;
      if (a.error) showToast(a.error.message || 'Failed to load announcements', 'error');
      setItems(a.data);
      setAcks(k.data || {});
      setLoading(false);
      // Everything on screen now counts as seen next time (the dots stay for this visit).
      markAnnouncementsSeen(a.data.map((x) => x.id));
    });
    return () => { cancelled = true; };
  }, [tenant, profile]);

  const acknowledge = async (id) => {
    setAcking(id);
    const { error } = await acknowledgeAnnouncement(id, profile.id, tenant.id);
    setAcking(null);
    if (error) return showToast('Could not save: ' + error.message, 'error');
    setAcks((m) => ({ ...m, [id]: new Date().toISOString() }));
    showToast('Thanks — acknowledged.', 'success');
  };

  if (loading) return <div className="loading-screen" style={{ minHeight: 240 }}><div className="spinner" /></div>;
  if (!items.length) {
    return (
      <div className="card"><div className="empty-state">
        <div className="empty-icon"><i className="fas fa-bullhorn" /></div>
        <h3>No announcements yet</h3>
        <p>Company news and updates will appear here.</p>
      </div></div>
    );
  }
  const toAck = items.filter((a) => a.requires_ack && !acks[a.id]).length;
  const fresh = items.filter((a) => !seen.has(a.id)).length;
  const kindOf = (a) => (KINDS[a.kind] ? a.kind : 'update');
  const counts = items.reduce((m, a) => { m[kindOf(a)] = (m[kindOf(a)] || 0) + 1; return m; }, {});
  const shown = kind === 'all' ? items : items.filter((a) => kindOf(a) === kind);
  return (
    <div className="an-feed">
      <div className="an-summary">
        <div className="an-summary-stat"><b>{items.length}</b><span>live now</span></div>
        <div className={`an-summary-stat ${fresh ? 'hot' : ''}`}><b>{fresh}</b><span>new since your last visit</span></div>
        <div className={`an-summary-stat ${toAck ? 'warn' : ''}`}><b>{toAck}</b><span>waiting for your acknowledgement</span></div>
      </div>
      <div className="an-filters" role="tablist">
        <button className={`an-filter ${kind === 'all' ? 'active' : ''}`} onClick={() => setKind('all')}>All <span>{items.length}</span></button>
        {Object.entries(KINDS).filter(([k]) => counts[k]).map(([k, K]) => (
          <button key={k} className={`an-filter ${kind === k ? 'active' : ''}`} style={{ '--k': K.accent }} onClick={() => setKind(k)}>
            <i className={`fas ${K.icon}`} /> {K.label} <span>{counts[k]}</span>
          </button>
        ))}
      </div>
      {shown.map((a) => (
        <Post key={a.id} a={a} isNew={!seen.has(a.id)} focused={a.id === focusId}
          acknowledgedAt={acks[a.id]} acking={acking === a.id} onAcknowledge={acknowledge} />
      ))}
    </div>
  );
}

function Post({ a, isNew, focused, acknowledgedAt, acking, onAcknowledge }) {
  const K = KINDS[a.kind] || KINDS.update;
  const body = a.body || a.message || '';
  const long = body.length > 400;
  const [open, setOpen] = useState(focused || !long);
  const ref = useRef(null);
  // Opened from Home / a notification: bring that post into view.
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [focused]);
  const authorName = a.author ? fullName(a.author) : a.auto_key ? 'CrewCore' : 'HR';
  return (
    <article ref={ref} className={`an-post ${focused ? 'focused' : ''}`} style={{ '--k': K.accent }}>
      <div className="an-post-head">
        <span className="an-kind"><i className={`fas ${K.icon}`} /> {K.label}</span>
        {a.pinned && <span className="an-meta"><i className="fas fa-thumbtack" /> Pinned</span>}
        {isNew && <span className="an-new">New</span>}
        {a.requires_ack && !acknowledgedAt && <span className="an-must">Please acknowledge</span>}
      </div>
      <h3 className="an-title">{a.title}</h3>
      <div className="an-byline">
        <span className="an-avatar" style={{ background: `linear-gradient(135deg, ${getAvatarColor(a.created_by || a.id)})` }}>
          {a.author ? getInitials(a.author.first_name, a.author.last_name) : <i className="fas fa-building" />}
        </span>
        <span>{authorName}</span>
        <span className="an-dot" />
        <span>{fmt(a.publish_at || a.created_at)}</span>
        {a.expires_at && <><span className="an-dot" /><span>until {fmt(a.expires_at)}</span></>}
      </div>
      {body && <p className={`an-body ${open ? '' : 'clamped'}`}>{body}</p>}
      {(!open || a.requires_ack) && (
        <div className="an-actions">
          {!open && <button className="btn btn-outline btn-sm" onClick={() => setOpen(true)}>Read more</button>}
          {a.requires_ack && (acknowledgedAt
            ? <span className="badge badge-success"><i className="fas fa-circle-check" /> Acknowledged {fmt(acknowledgedAt, false)}</span>
            : <button className="btn btn-primary btn-sm" disabled={acking} onClick={() => onAcknowledge(a.id)}>
                <i className="fas fa-check" /> {acking ? 'Saving…' : 'I have read this'}
              </button>)}
        </div>
      )}
    </article>
  );
}

// ───────────────────────────── manage (HR) ─────────────────────────────

function Manage({ tenant, onEdit, onChanged }) {
  const { refreshProfile } = useAuth();
  const [rows, setRows] = useState([]);
  const [ackCounts, setAckCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('active');
  const [receipts, setReceipts] = useState(null);
  const [busy, setBusy] = useState(null);
  const [autoBirthdays, setAutoBirthdays] = useState(!!tenant?.auto_birthday_posts);

  const load = useCallback(async () => {
    if (!tenant) return;
    const [{ data, error }, { data: counts }] = await Promise.all([listManagedAnnouncements(tenant.id), countAcknowledgements(tenant.id)]);
    if (error) showToast(error.message || 'Failed to load', 'error');
    setRows(data);
    setAckCounts(counts || {});
    setLoading(false);
  }, [tenant]);

  useEffect(() => { load(); }, [load]);

  const run = async (id, fn, ok) => {
    setBusy(id);
    const { error } = await fn();
    setBusy(null);
    if (error) return showToast(error.message || 'Could not update', 'error');
    showToast(ok, 'success');
    load();
    onChanged?.();
  };

  const toggleBirthdays = async () => {
    const next = !autoBirthdays;
    setAutoBirthdays(next);
    const { error } = await setAutoBirthdayPosts(tenant.id, next);
    if (error) { setAutoBirthdays(!next); return showToast(error.message, 'error'); }
    showToast(next ? 'Birthday posts on — one goes out on each birthday.' : 'Automatic birthday posts off.', 'success');
    refreshProfile?.();
  };

  const counts = useMemo(() => {
    const c = { active: 0, draft: 0, scheduled: 0, archived: 0, all: rows.length };
    rows.forEach((r) => {
      const s = announcementState(r);
      if (s === 'live') c.active++;
      else if (s === 'expired') c.archived++;
      else c[s]++;
    });
    return c;
  }, [rows]);

  const visible = rows.filter((r) => {
    const s = announcementState(r);
    if (filter === 'all') return true;
    if (filter === 'active') return s === 'live';
    if (filter === 'archived') return s === 'archived' || s === 'expired';
    return s === filter;
  });

  if (loading) return <div className="loading-screen" style={{ minHeight: 240 }}><div className="spinner" /></div>;

  return (
    <>
      <div className="filter-bar">
        {[['active', 'Live'], ['scheduled', 'Scheduled'], ['draft', 'Drafts'], ['archived', 'Archived'], ['all', 'All']].map(([k, l]) => (
          <button key={k} className={`btn btn-sm ${filter === k ? 'btn-primary' : 'btn-outline'}`} onClick={() => setFilter(k)}>
            {l} <span style={{ opacity: 0.7 }}>{counts[k]}</span>
          </button>
        ))}
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
          title="Every day, a Birthday post for each person whose birthday it is, shown to their branch (no notification).">
          <input type="checkbox" checked={autoBirthdays} onChange={toggleBirthdays} />
          <i className="fas fa-cake-candles" style={{ color: KINDS.birthday.accent }} /> Automatic birthday posts
        </label>
      </div>

      {!visible.length ? (
        <div className="card"><div className="empty-state">
          <div className="empty-icon"><i className="fas fa-bullhorn" /></div>
          <h3>Nothing here</h3>
          <p>Write an announcement — publish it now, schedule it, or save it as a draft.</p>
        </div></div>
      ) : (
        <div className="card an-manage">
          {visible.map((a) => {
            const s = announcementState(a);
            const K = KINDS[a.kind] || KINDS.update;
            return (
              <div key={a.id} className="an-mrow" style={{ '--k': K.accent }}>
                <span className="an-micon"><i className={`fas ${K.icon}`} /></span>
                <div className="an-mmain">
                  <div className="an-mtitle">
                    <span>{a.title}</span>
                    <span className={`badge ${STATE[s].badge}`}>{STATE[s].label}</span>
                    {a.pinned && <i className="fas fa-thumbtack" title="Pinned" />}
                  </div>
                  <div className="an-msub">
                    {K.label} · {a.audience === 'all' ? 'Everyone'
                      : a.audience === 'departments' ? a.audience_departments.join(', ')
                      : `${a.audience_outlets.length} branch${a.audience_outlets.length === 1 ? '' : 'es'}`}
                    {' · '}{a.author ? fullName(a.author) : a.auto_key ? 'Automatic' : 'Admin'}
                    {' · '}{s === 'scheduled' ? `goes out ${fmt(a.publish_at)}` : fmt(a.publish_at || a.created_at)}
                    {a.expires_at && s !== 'expired' && ` · until ${fmt(a.expires_at)}`}
                  </div>
                </div>
                <div className="an-mack">
                  {a.requires_ack ? (
                    <button className="btn btn-outline btn-sm" onClick={() => setReceipts(a)} disabled={s === 'draft'} title="See who acknowledged">
                      <i className="fas fa-users" /> {ackCounts[a.id] || 0} acknowledged
                    </button>
                  ) : <span className="an-mnone">No acknowledgement needed</span>}
                </div>
                <div className="an-mactions">
                  {s !== 'archived' && <button className="btn btn-outline btn-sm" onClick={() => onEdit(a)}>Edit</button>}
                  {s === 'draft' && (
                    <button className="btn btn-primary btn-sm" disabled={busy === a.id}
                      onClick={() => run(a.id, () => publishAnnouncement(a.id), 'Published — the audience is notified.')}>
                      <i className="fas fa-paper-plane" /> Publish
                    </button>
                  )}
                  {(s === 'live' || s === 'scheduled') && (
                    <button className="btn btn-outline btn-sm btn-icon" title={a.pinned ? 'Unpin' : 'Pin to the top'} disabled={busy === a.id}
                      onClick={() => run(a.id, () => setAnnouncementPinned(a.id, !a.pinned), a.pinned ? 'Unpinned.' : 'Pinned to the top.')}>
                      <i className="fas fa-thumbtack" />
                    </button>
                  )}
                  {s !== 'archived' && s !== 'draft' && (
                    <button className="btn btn-outline btn-sm" disabled={busy === a.id}
                      onClick={() => run(a.id, () => archiveAnnouncement(a.id), 'Archived — removed from everyone’s feed.')}>
                      <i className="fas fa-box-archive" /> Archive
                    </button>
                  )}
                  {s === 'archived' && (
                    <button className="btn btn-outline btn-sm" disabled={busy === a.id}
                      onClick={() => run(a.id, () => restoreAnnouncement(a.id), 'Restored as a draft.')}>
                      <i className="fas fa-rotate-left" /> Restore
                    </button>
                  )}
                  {(s === 'draft' || s === 'archived' || s === 'expired') && (
                    <button className="btn btn-outline btn-sm btn-icon" style={{ color: 'var(--danger)' }} title="Delete permanently" disabled={busy === a.id}
                      onClick={() => { if (confirm(`Delete "${a.title}" permanently? This can't be undone.`)) run(a.id, () => deleteAnnouncement(a.id), 'Deleted.'); }}>
                      <i className="fas fa-trash" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <ReceiptsModal a={receipts} onClose={() => setReceipts(null)} />
    </>
  );
}

function ReceiptsModal({ a, onClose }) {
  const [rows, setRows] = useState(null);
  const id = a?.id;
  // Keyed on the id only: onClose is a fresh function on every parent render.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setRows(null);
    getAnnouncementReceipts(id).then(({ data, error }) => {
      if (cancelled) return;
      if (error) showToast(error.message, 'error');
      setRows(data);
    });
    return () => { cancelled = true; };
  }, [id]);
  const pending = (rows || []).filter((r) => !r.acknowledged_at);
  const done = (rows || []).filter((r) => r.acknowledged_at);
  return (
    <Modal show={!!a} onClose={onClose} title={a ? `Acknowledged: ${a.title}` : ''} width="560px">
      {!rows ? <div style={{ textAlign: 'center', padding: 24 }}><div className="spinner" style={{ margin: '0 auto' }} /></div> : (
        <>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
            {done.length} of {rows.length} people in the audience have acknowledged.
          </p>
          <div className="form-label">Not yet ({pending.length})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
            {pending.map((r) => <span key={r.profile_id} className="badge badge-secondary">{r.name}</span>)}
            {!pending.length && <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Everyone has acknowledged.</span>}
          </div>
          <div className="form-label">Acknowledged ({done.length})</div>
          <div className="table-wrap"><table><tbody>
            {done.map((r) => (
              <tr key={r.profile_id}><td>{r.name}<div className="emp-role">{r.department}</div></td><td style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-muted)' }}>{fmt(r.acknowledged_at)}</td></tr>
            ))}
          </tbody></table></div>
        </>
      )}
    </Modal>
  );
}

// ───────────────────────────── composer ─────────────────────────────

const toLocalInput = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

function blankForm() {
  return { title: '', body: '', kind: 'update', audience: 'all', departments: [], outlets: [], pinned: false, requiresAck: false, expiresAt: '', when: 'now', at: '' };
}

function Composer({ value, tenant, profile, onClose, onSaved }) {
  const editing = value && value !== 'new' ? value : null;
  const [f, setF] = useState(blankForm);
  const [saving, setSaving] = useState(false);
  const [departments, setDepartments] = useState([]);
  const [outlets, setOutlets] = useState([]);

  useEffect(() => {
    if (!value) return;
    setF(editing ? {
      title: editing.title, body: editing.body || editing.message || '', kind: editing.kind, audience: editing.audience,
      departments: editing.audience_departments || [], outlets: editing.audience_outlets || [],
      pinned: editing.pinned, requiresAck: editing.requires_ack, expiresAt: toLocalInput(editing.expires_at), when: 'now', at: '',
    } : blankForm());
  }, [value, editing]);

  useEffect(() => {
    if (!value || !tenant || (departments.length && outlets.length)) return;
    Promise.all([listDepartments(tenant.id), listOutlets(tenant.id)]).then(([d, o]) => {
      setDepartments((d.data || []).map((x) => x.name).filter(Boolean).sort());
      setOutlets((o.data || []).filter((x) => x.is_active !== false).map((x) => ({ id: x.id, name: x.name })));
    });
  }, [value, tenant, departments.length, outlets.length]);

  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const toggleIn = (k, v) => setF((s) => ({ ...s, [k]: s[k].includes(v) ? s[k].filter((x) => x !== v) : [...s[k], v] }));
  const canChooseWhen = !editing || editing.status === 'draft';
  const audienceMissing = (f.audience === 'departments' && !f.departments.length) || (f.audience === 'outlets' && !f.outlets.length);

  const submit = async () => {
    if (!f.title.trim()) return showToast('Give it a title.', 'error');
    if (audienceMissing) return showToast('Pick at least one department or branch.', 'error');
    if (canChooseWhen && f.when === 'at' && !f.at) return showToast('Pick when it goes out.', 'error');
    if (f.expiresAt && f.when === 'at' && f.at && new Date(f.expiresAt) <= new Date(f.at)) return showToast('"Hide after" must be after the scheduled time.', 'error');
    setSaving(true);
    try {
      if (editing) {
        const { error } = await updateAnnouncement(editing.id, f);
        if (error) return showToast(error.message, 'error');
        if (editing.status === 'draft' && f.when !== 'draft') {
          const { error: pubErr } = await publishAnnouncement(editing.id, f.when === 'at' ? f.at : null);
          if (pubErr) return showToast(pubErr.message, 'error');
        }
        showToast(editing.status === 'draft' && f.when === 'now' ? 'Published — the audience is notified.' : 'Saved.', 'success');
      } else {
        const { error } = await createAnnouncement({ tenantId: tenant.id, createdBy: profile.id, form: f });
        if (error) return showToast(error.message, 'error');
        showToast(f.when === 'now' ? 'Published — the audience is notified.' : f.when === 'at' ? 'Scheduled.' : 'Draft saved.', 'success');
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const chip = (active) => ({
    borderRadius: 999, padding: '6px 14px', fontSize: 13, cursor: 'pointer', border: '1px solid',
    borderColor: active ? 'var(--primary)' : 'var(--border)', background: active ? 'var(--primary-light)' : 'var(--surface)',
    color: active ? 'var(--primary-dark)' : 'var(--text-secondary)', fontFamily: 'inherit',
  });

  return (
    <Modal show={!!value} onClose={onClose} width="640px"
      title={editing ? 'Edit announcement' : 'Write announcement'}
      footer={<>
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={saving}>
          <i className="fas fa-paper-plane" /> {saving ? 'Saving…' : !canChooseWhen ? 'Save' : f.when === 'now' ? 'Publish now' : f.when === 'at' ? 'Schedule' : 'Save draft'}
        </button>
      </>}
    >
      <div className="form-group">
        <label className="form-label">Type</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {Object.entries(KINDS).map(([k, K]) => (
            <button type="button" key={k} onClick={() => set('kind', k)} style={{
              ...chip(f.kind === k), borderRadius: 12, padding: '10px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            }}>
              <i className={`fas ${K.icon}`} style={{ fontSize: 16, color: K.accent }} />{K.label}
            </button>
          ))}
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Title *</label>
        <input className="form-input" maxLength={200} value={f.title} onChange={(e) => set('title', e.target.value)}
          placeholder={f.kind === 'birthday' ? 'e.g. Happy birthday, Riya!' : 'e.g. Office closed on Monday for Diwali'} />
      </div>
      <div className="form-group">
        <label className="form-label">Message</label>
        <textarea className="form-textarea" rows={6} maxLength={20000} value={f.body} onChange={(e) => set('body', e.target.value)}
          placeholder="Write it like you would say it. Line breaks are kept." />
      </div>
      <div className="form-group">
        <label className="form-label">Who should see it</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[['all', 'Everyone'], ['departments', 'Departments'], ['outlets', 'Branches']].map(([k, l]) => (
            <button type="button" key={k} style={chip(f.audience === k)} onClick={() => set('audience', k)}>{l}</button>
          ))}
        </div>
        {f.audience !== 'all' && (
          <div style={{ marginTop: 10, maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 12, padding: 8 }}>
            {(f.audience === 'departments' ? departments.map((d) => ({ id: d, name: d })) : outlets).map((o) => (
              <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 14, cursor: 'pointer' }}>
                <input type="checkbox"
                  checked={(f.audience === 'departments' ? f.departments : f.outlets).includes(o.id)}
                  onChange={() => toggleIn(f.audience === 'departments' ? 'departments' : 'outlets', o.id)} />
                {o.name}
              </label>
            ))}
            {!(f.audience === 'departments' ? departments : outlets).length && <div className="form-hint" style={{ padding: 8 }}>None set up yet.</div>}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginBottom: 16, fontSize: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={f.pinned} onChange={(e) => set('pinned', e.target.checked)} /> Pin to the top
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={f.requiresAck} onChange={(e) => set('requiresAck', e.target.checked)} /> People must acknowledge it
        </label>
      </div>
      {canChooseWhen && (
        <div className="form-group">
          <label className="form-label">When</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            {[['now', 'Publish now'], ['at', 'Schedule'], ['draft', 'Save as draft']].map(([k, l]) => (
              <button type="button" key={k} style={chip(f.when === k)} onClick={() => set('when', k)}>{l}</button>
            ))}
            {f.when === 'at' && (
              <input type="datetime-local" className="form-input" style={{ width: 230 }} value={f.at} onChange={(e) => set('at', e.target.value)} />
            )}
          </div>
        </div>
      )}
      <div className="form-group" style={{ marginBottom: 0 }}>
        <label className="form-label">Hide after (optional)</label>
        <input type="datetime-local" className="form-input" style={{ maxWidth: 260 }} value={f.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} />
        <div className="form-hint">Useful for events — it leaves the feed afterwards and stays in Manage for the record.</div>
      </div>
    </Modal>
  );
}
