import React, { useEffect, useState, useCallback } from 'react';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import { useFeatures } from '@/context/FeatureContext';
import VerifiedDetailsCard from './VerifiedDetailsCard';
import {
  getMyProfileDetails, upsertProfileDetails, getProfileName, EMPTY_PROFILE_DETAILS,
} from '@/services/profileDetailsService';
import { getInitials, fullName, getAvatarColor, fmt, probationInfo } from '@/lib/helpers';

const GENDERS = ['Male', 'Female', 'Other'];
const MARITAL_STATUSES = ['Single', 'Married', 'Other'];
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const ADDRESS_FIELDS = [
  { key: 'line1', label: 'Address Line 1' },
  { key: 'line2', label: 'Address Line 2' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'pincode', label: 'Pincode' },
  { key: 'country', label: 'Country' },
];

const EMERGENCY_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'relation', label: 'Relation' },
  { key: 'phone', label: 'Phone' },
];

const EDUCATION_FIELDS = [
  { key: 'degree', label: 'Degree' },
  { key: 'branch', label: 'Branch / Specialization' },
  { key: 'institute', label: 'Institute' },
  { key: 'year', label: 'Year' },
  { key: 'percentage', label: 'CGPA / %' },
];

const EXPERIENCE_FIELDS = [
  { key: 'title', label: 'Job Title' },
  { key: 'company', label: 'Company' },
  { key: 'from_date', label: 'From (e.g. May 2025)' },
  { key: 'to_date', label: 'To (e.g. Jul 2025)' },
];

function completionPercent(d) {
  const scalarFields = [
    d.date_of_birth, d.gender, d.marital_status, d.blood_group, d.nationality,
    d.personal_email, d.work_number, d.residence_number,
    d.current_address?.city, d.permanent_address?.city,
    d.about_me, d.about_job, d.hobbies,
  ];
  const filled = scalarFields.filter(Boolean).length;
  const listBonus = [d.emergency_contacts, d.education, d.experience].filter((l) => l?.length).length;
  const total = scalarFields.length + 3;
  return Math.round(((filled + listBonus) / total) * 100);
}

// DOB already on the HR record (profiles.date_of_birth — e.g. Raniwala's
// imported DOBs) fills in until the employee sets their own.
const withHrDob = (d, profile) => (d.date_of_birth || !profile?.date_of_birth ? d : { ...d, date_of_birth: profile.date_of_birth });

function formatAddress(addr) {
  if (!addr) return '';
  return [addr.line1, addr.line2, addr.city, addr.state, addr.pincode, addr.country].filter(Boolean).join(', ');
}

function DetailRow({ label, value }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.03em' }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 2 }}>{value || <span style={{ color: 'var(--text-muted)' }}>-Not Set-</span>}</div>
    </div>
  );
}

function Card({ title, onEdit, children }) {
  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        {onEdit && <button className="btn btn-outline btn-sm" onClick={onEdit}><i className="fas fa-pen" /> Edit</button>}
      </div>
      {children}
    </div>
  );
}

function ListEditorRows({ items, fields, onChange }) {
  const updateItem = (i, key, value) => onChange(items.map((it, idx) => (idx === i ? { ...it, [key]: value } : it)));
  const removeItem = (i) => onChange(items.filter((_, idx) => idx !== i));
  const addItem = () => onChange([...items, Object.fromEntries(fields.map((f) => [f.key, '']))]);

  return (
    <div>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {fields.map((f) => (
            <input
              key={f.key} className="form-input" style={{ flex: 1, minWidth: 110 }} placeholder={f.label}
              value={it[f.key] || ''} onChange={(e) => updateItem(i, f.key, e.target.value)}
            />
          ))}
          <button className="btn btn-outline btn-icon btn-sm" style={{ color: 'var(--danger)' }} onClick={() => removeItem(i)}>
            <i className="fas fa-times" />
          </button>
        </div>
      ))}
      <button className="btn btn-outline btn-sm" onClick={addItem}><i className="fas fa-plus" /> Add</button>
    </div>
  );
}

function ListSummary({ items, render, emptyText }) {
  if (!items?.length) return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>{emptyText}</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it, i) => <div key={i}>{render(it)}</div>)}
    </div>
  );
}

export default function WelcomeContent() {
  const { profile, tenant } = useAuth();
  const { isEnabled } = useFeatures();
  const [details, setDetails] = useState(EMPTY_PROFILE_DETAILS);
  const [managerName, setManagerName] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  const fetchDetails = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    const { data, error } = await getMyProfileDetails(profile.id);
    if (error) showToast('Failed to load profile: ' + error.message, 'error');
    setDetails(withHrDob(data || EMPTY_PROFILE_DETAILS, profile));
    setLoading(false);
  }, [profile]);

  useEffect(() => { fetchDetails(); }, [fetchDetails]);

  useEffect(() => {
    if (!profile?.manager_id) { setManagerName(''); return; }
    let cancelled = false;
    getProfileName(profile.manager_id).then(({ data }) => { if (!cancelled) setManagerName(data ? fullName(data) : ''); });
    return () => { cancelled = true; };
  }, [profile?.manager_id]);

  const openModal = (type, extra = {}) => {
    setForm({ ...details, ...extra });
    setModal(type);
  };

  const save = async (patch) => {
    setSaving(true);
    try {
      const { data, error } = await upsertProfileDetails(tenant.id, profile.id, patch);
      if (error) return showToast('Failed: ' + error.message, 'error');
      setDetails(withHrDob(data, profile));
      showToast('Saved', 'success');
      setModal(null);
    } finally {
      setSaving(false);
    }
  };

  if (!profile) return null;
  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}><div className="spinner" style={{ margin: '0 auto 16px' }} />Loading…</div>;
  }

  const pct = completionPercent(details);
  const initials = getInitials(profile.first_name, profile.last_name);
  const avatarColor = getAvatarColor(profile.id);

  return (
    <>
      <div className="page-content">
        {/* Profile banner */}
        <div style={{
          borderRadius: 'var(--radius-lg)', overflow: 'hidden', position: 'relative',
          background: 'linear-gradient(120deg, #312e81, #6d28d9 60%, #db2777)',
          padding: '28px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <div style={{
              width: 76, height: 76, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 26, fontWeight: 700, color: '#fff',
              background: `linear-gradient(135deg, ${avatarColor.split(',')[0]}, ${avatarColor.split(',')[1]})`,
              flexShrink: 0,
            }}>{initials}</div>
            <div>
              <h2 style={{ margin: 0, color: '#fff', fontSize: 24 }}>{fullName(profile)}</h2>
              <div style={{ color: 'rgba(255,255,255,.8)', fontSize: 14, marginTop: 4 }}>
                {profile.designation}{profile.department ? ` · ${profile.department}` : ''}{profile.outlet_location ? ` · ${profile.outlet_location}` : ''}
              </div>
            </div>
          </div>
          <div style={{ textAlign: 'center', color: '#fff' }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{pct}%</div>
            <div style={{ fontSize: 12, opacity: .85 }}>Profile completed</div>
          </div>
        </div>

        {/* Job strip (read-only, sourced from profiles) */}
        <div className="card" style={{ marginTop: 16, padding: '14px 20px', display: 'flex', gap: 32, flexWrap: 'wrap' }}>
          <DetailRow label="Employee ID" value={profile.employee_id} />
          <DetailRow label="Date of Joining" value={fmt.date(profile.join_date)} />
          {(() => {
            const prob = probationInfo(profile.join_date, profile.probation_months);
            if (!prob) return null;
            return (
              <DetailRow label="Probation Period" value={prob.completed
                ? <span style={{ color: 'var(--success)', fontWeight: 600 }}><i className="fas fa-check-circle" /> Completed</span>
                : <span style={{ color: 'var(--warning)', fontWeight: 600 }}>Completes on {fmt.date(prob.endsOn)}</span>} />
            );
          })()}
          <DetailRow label="Reporting Manager" value={managerName} />
        </div>

        {isEnabled('profile_verification') && <VerifiedDetailsCard />}

        {/* Introduce yourself */}
        <div className="card" style={{ marginTop: 16, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div>
              <h3 style={{ margin: 0 }}>Introduce Yourself</h3>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>We'd love to know more about you</p>
            </div>
            <button className="btn btn-outline btn-sm" onClick={() => openModal('about')}><i className="fas fa-pen" /> Edit</button>
          </div>
          {[
            ['About', details.about_me],
            ['What I love about my job', details.about_job],
            ['My interests and hobbies', details.hobbies],
          ].map(([label, value]) => (
            <div key={label} style={{ borderTop: '1px solid var(--border)', padding: '12px 0' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
              <div style={{ fontSize: 14, color: value ? 'var(--text)' : 'var(--text-muted)', marginTop: 4 }}>
                {value || 'Add response'}
              </div>
            </div>
          ))}
        </div>

        <div className="grid-2" style={{ marginTop: 16 }}>
          <Card title="Primary Details" onEdit={() => openModal('primary')}>
            <DetailRow label="Gender" value={details.gender} />
            <DetailRow label="Date of Birth" value={details.date_of_birth ? fmt.date(details.date_of_birth) : ''} />
            <DetailRow label="Marital Status" value={details.marital_status} />
            <DetailRow label="Blood Group" value={details.blood_group} />
            <DetailRow label="Nationality" value={details.nationality} />
            <DetailRow label="Physically Handicapped" value={details.physically_handicapped ? 'Yes' : 'No'} />
          </Card>

          <Card title="Contact Details" onEdit={() => openModal('contact')}>
            <DetailRow label="Work Email" value={profile.email} />
            <DetailRow label="Personal Email" value={details.personal_email} />
            <DetailRow label="Mobile Number" value={profile.phone} />
            <DetailRow label="Work Number" value={details.work_number} />
            <DetailRow label="Residence Number" value={details.residence_number} />
          </Card>

          <Card title="Addresses" onEdit={() => openModal('address')}>
            <DetailRow label="Current Address" value={formatAddress(details.current_address)} />
            <DetailRow label="Permanent Address" value={formatAddress(details.permanent_address)} />
          </Card>

          <Card title="Emergency Contacts" onEdit={() => openModal('emergency')}>
            <ListSummary
              items={details.emergency_contacts}
              emptyText="No emergency contacts added yet."
              render={(c) => (
                <div>
                  <strong>{c.name}</strong>{c.relation ? ` · ${c.relation}` : ''}
                  {c.phone && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{c.phone}</div>}
                </div>
              )}
            />
          </Card>

          <Card title="Education" onEdit={() => openModal('education')}>
            <ListSummary
              items={details.education}
              emptyText="No education details added yet."
              render={(e) => (
                <div>
                  <strong>{e.degree}</strong>{e.branch ? ` · ${e.branch}` : ''}
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    {[e.institute, e.year, e.percentage && `${e.percentage}%`].filter(Boolean).join(' · ')}
                  </div>
                </div>
              )}
            />
          </Card>

          <Card title="Experience" onEdit={() => openModal('experience')}>
            <ListSummary
              items={details.experience}
              emptyText="No experience added yet."
              render={(x) => (
                <div>
                  <strong>{x.title}</strong>{x.company ? `, ${x.company}` : ''}
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                    {[x.from_date, x.to_date].filter(Boolean).join(' - ')}
                  </div>
                </div>
              )}
            />
          </Card>
        </div>
      </div>

      {/* About modal */}
      <Modal show={modal === 'about'} onClose={() => setModal(null)} title="Introduce Yourself" width="560px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setModal(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => save({ about_me: form.about_me || '', about_job: form.about_job || '', hobbies: form.hobbies || '' })} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>}
      >
        <div className="form-group">
          <label className="form-label">About</label>
          <textarea className="form-input" rows={3} value={form.about_me || ''} onChange={(e) => setForm({ ...form, about_me: e.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label">What I love about my job</label>
          <textarea className="form-input" rows={3} value={form.about_job || ''} onChange={(e) => setForm({ ...form, about_job: e.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label">My interests and hobbies</label>
          <textarea className="form-input" rows={3} value={form.hobbies || ''} onChange={(e) => setForm({ ...form, hobbies: e.target.value })} />
        </div>
      </Modal>

      {/* Primary details modal */}
      <Modal show={modal === 'primary'} onClose={() => setModal(null)} title="Primary Details" width="520px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setModal(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => save({
            gender: form.gender || '', date_of_birth: form.date_of_birth || null,
            marital_status: form.marital_status || '', blood_group: form.blood_group || '',
            nationality: form.nationality || '', physically_handicapped: !!form.physically_handicapped,
          })} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>}
      >
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Gender</label>
            <select className="form-select" value={form.gender || ''} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
              <option value="">Select</option>
              {GENDERS.map((g) => <option key={g}>{g}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Date of Birth</label>
            <input type="date" className="form-input" value={form.date_of_birth || ''} onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Marital Status</label>
            <select className="form-select" value={form.marital_status || ''} onChange={(e) => setForm({ ...form, marital_status: e.target.value })}>
              <option value="">Select</option>
              {MARITAL_STATUSES.map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Blood Group</label>
            <select className="form-select" value={form.blood_group || ''} onChange={(e) => setForm({ ...form, blood_group: e.target.value })}>
              <option value="">Select</option>
              {BLOOD_GROUPS.map((b) => <option key={b}>{b}</option>)}
            </select>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Nationality</label>
            <input className="form-input" value={form.nationality || ''} onChange={(e) => setForm({ ...form, nationality: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Physically Handicapped</label>
            <select className="form-select" value={form.physically_handicapped ? 'yes' : 'no'} onChange={(e) => setForm({ ...form, physically_handicapped: e.target.value === 'yes' })}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
        </div>
      </Modal>

      {/* Contact details modal */}
      <Modal show={modal === 'contact'} onClose={() => setModal(null)} title="Contact Details" width="480px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setModal(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => save({
            personal_email: form.personal_email || '', work_number: form.work_number || '', residence_number: form.residence_number || '',
          })} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>}
      >
        <div className="form-group">
          <label className="form-label">Personal Email</label>
          <input className="form-input" type="email" value={form.personal_email || ''} onChange={(e) => setForm({ ...form, personal_email: e.target.value })} />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Work Number</label>
            <input className="form-input" value={form.work_number || ''} onChange={(e) => setForm({ ...form, work_number: e.target.value })} />
          </div>
          <div className="form-group">
            <label className="form-label">Residence Number</label>
            <input className="form-input" value={form.residence_number || ''} onChange={(e) => setForm({ ...form, residence_number: e.target.value })} />
          </div>
        </div>
      </Modal>

      {/* Addresses modal */}
      <Modal show={modal === 'address'} onClose={() => setModal(null)} title="Addresses" width="560px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setModal(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => save({
            current_address: form.current_address || {}, permanent_address: form.permanent_address || {},
          })} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>}
      >
        <h4 style={{ margin: '0 0 8px' }}>Current Address</h4>
        <div className="form-row">
          {ADDRESS_FIELDS.map((f) => (
            <div className="form-group" key={f.key} style={{ minWidth: 140 }}>
              <label className="form-label">{f.label}</label>
              <input className="form-input" value={form.current_address?.[f.key] || ''}
                onChange={(e) => setForm({ ...form, current_address: { ...form.current_address, [f.key]: e.target.value } })} />
            </div>
          ))}
        </div>
        <h4 style={{ margin: '16px 0 8px' }}>Permanent Address</h4>
        <div className="form-row">
          {ADDRESS_FIELDS.map((f) => (
            <div className="form-group" key={f.key} style={{ minWidth: 140 }}>
              <label className="form-label">{f.label}</label>
              <input className="form-input" value={form.permanent_address?.[f.key] || ''}
                onChange={(e) => setForm({ ...form, permanent_address: { ...form.permanent_address, [f.key]: e.target.value } })} />
            </div>
          ))}
        </div>
      </Modal>

      {/* Emergency contacts modal */}
      <Modal show={modal === 'emergency'} onClose={() => setModal(null)} title="Emergency Contacts" width="560px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setModal(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => save({ emergency_contacts: form.emergency_contacts || [] })} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>}
      >
        <ListEditorRows
          items={form.emergency_contacts || []}
          fields={EMERGENCY_FIELDS}
          onChange={(items) => setForm({ ...form, emergency_contacts: items })}
        />
      </Modal>

      {/* Education modal */}
      <Modal show={modal === 'education'} onClose={() => setModal(null)} title="Education" width="640px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setModal(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => save({ education: form.education || [] })} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>}
      >
        <ListEditorRows
          items={form.education || []}
          fields={EDUCATION_FIELDS}
          onChange={(items) => setForm({ ...form, education: items })}
        />
      </Modal>

      {/* Experience modal */}
      <Modal show={modal === 'experience'} onClose={() => setModal(null)} title="Experience" width="640px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setModal(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={() => save({ experience: form.experience || [] })} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>}
      >
        <ListEditorRows
          items={form.experience || []}
          fields={EXPERIENCE_FIELDS}
          onChange={(items) => setForm({ ...form, experience: items })}
        />
      </Modal>
    </>
  );
}
