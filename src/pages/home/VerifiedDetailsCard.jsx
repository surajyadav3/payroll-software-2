import { useCallback, useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { showToast } from '@/components/Toast';
import { useAuth } from '@/context/AuthContext';
import {
  listMyVerificationRequests, submitVerificationRequest, cancelVerificationRequest,
} from '@/services/verificationRequestService';
import { fmt, isRaniwalaTenant } from '@/lib/helpers';

/**
 * Employee self-service for Bank / PAN / Aadhar on the web Welcome tab —
 * same flow as the CrewCore app's Profile tab. An edit never touches
 * profiles: it's staged in profile_verification_requests as Pending, and
 * only HR's approval (review_verification_request) applies it and stamps
 * *_verified_at. Values are masked on screen; the full value only appears
 * in the employee's own edit form.
 *
 * Raniwala (20261024_3): the employee verifies their own details, DOB
 * included — Verify applies the values at once and marks them Verified; the
 * request row is kept as HR's record of what was filled.
 */

const GROUPS = {
  bank: { label: 'Bank Details', fields: ['bank_acc', 'bank_name', 'ifsc_code'], verifiedKey: 'bank_verified_at' },
  pan: { label: 'PAN', fields: ['pan'], verifiedKey: 'pan_verified_at' },
  aadhar: { label: 'Aadhaar', fields: ['aadhar'], verifiedKey: 'aadhar_verified_at' },
  dob: { label: 'Date of Birth', fields: ['date_of_birth'], verifiedKey: 'dob_verified_at' },
};

const mask = (v, keep = 4) => {
  const s = String(v || '').replace(/\s+/g, '');
  if (!s) return '';
  return s.length <= keep ? s : `${'•'.repeat(Math.min(s.length - keep, 8))}${s.slice(-keep)}`;
};

const summarize = (group, value) => {
  if (!value) return '';
  if (group === 'bank') return [value.bank_name, value.bank_acc && `A/c ${mask(value.bank_acc)}`, value.ifsc_code].filter(Boolean).join(' · ');
  if (group === 'pan') return mask(value.pan);
  if (group === 'dob') return value.date_of_birth ? fmt.date(value.date_of_birth) : '';
  return mask(value.aadhar);
};

function StatusBadge({ status, verifiedAt }) {
  if (status === 'pending') return <span className="badge badge-warning"><i className="fas fa-hourglass-half" /> Pending verification</span>;
  if (status === 'verified') {
    return <span className="badge badge-success" title={`Verified on ${fmt.date(verifiedAt)}`}><i className="fas fa-check-circle" /> Verified</span>;
  }
  return <span className="badge badge-secondary"><i className="fas fa-circle-exclamation" /> Not verified</span>;
}

const REQUEST_BADGE = { Pending: 'badge-warning', Approved: 'badge-success', Rejected: 'badge-danger' };

function validate(group, form) {
  if (group === 'bank') {
    const acc = form.bank_acc.trim();
    if (!/^\d{9,18}$/.test(acc)) return { error: 'Bank account number must be 9-18 digits.' };
    if (!form.bank_name.trim()) return { error: 'Please enter the bank name.' };
    const ifsc = form.ifsc_code.trim().toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return { error: 'Enter a valid IFSC code (e.g. SBIN0001234).' };
    return { value: { bank_acc: acc, bank_name: form.bank_name.trim(), ifsc_code: ifsc } };
  }
  if (group === 'pan') {
    const pan = form.pan.trim().toUpperCase();
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) return { error: 'Enter a valid PAN (e.g. ABCDE1234F).' };
    return { value: { pan } };
  }
  if (group === 'dob') {
    const dob = form.date_of_birth;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || '')) return { error: 'Please enter your date of birth.' };
    if (dob >= new Date().toISOString().slice(0, 10)) return { error: 'Date of birth must be in the past.' };
    return { value: { date_of_birth: dob } };
  }
  const aadhar = form.aadhar.replace(/\s+/g, '');
  if (!/^\d{12}$/.test(aadhar)) return { error: 'Aadhaar number must be 12 digits.' };
  return { value: { aadhar } };
}

export default function VerifiedDetailsCard() {
  const { profile, tenant, refreshProfile } = useAuth();
  const [requests, setRequests] = useState([]);
  const [editing, setEditing] = useState(null); // 'bank' | 'pan' | 'aadhar'
  const [form, setForm] = useState({ bank_acc: '', bank_name: '', ifsc_code: '', pan: '', aadhar: '', date_of_birth: '' });
  const [saving, setSaving] = useState(false);
  const selfVerify = isRaniwalaTenant(tenant);

  const load = useCallback(async () => {
    if (!profile?.id) return;
    const { data, error } = await listMyVerificationRequests(profile.id);
    if (error) showToast('Could not load verification requests: ' + error.message, 'error');
    setRequests(data);
    // The signed-in profile is loaded once per session; if HR approved a
    // change since, re-read it so the new value shows as Verified.
    const stale = data.some((r) => {
      // Only recent approvals — an old one whose value HR later edited
      // (which clears *_verified_at) shouldn't trigger a re-read every visit.
      if (r.status !== 'Approved' || !r.reviewed_at || Date.now() - new Date(r.reviewed_at) > 7 * 86400000) return false;
      const verifiedAt = profile[GROUPS[r.field_group]?.verifiedKey];
      return !verifiedAt || new Date(verifiedAt) < new Date(r.reviewed_at);
    });
    if (stale) refreshProfile?.();
  }, [profile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  if (!profile) return null;

  const pendingFor = (group) => requests.find((r) => r.field_group === group && r.status === 'Pending');
  const statusOf = (group) => {
    if (pendingFor(group)) return 'pending';
    return profile[GROUPS[group].verifiedKey] ? 'verified' : 'unverified';
  };

  const openEdit = (group) => {
    setForm({
      bank_acc: profile.bank_acc || '', bank_name: profile.bank_name || '', ifsc_code: profile.ifsc_code || '',
      pan: profile.pan || '', aadhar: profile.aadhar || '', date_of_birth: profile.date_of_birth || '',
    });
    setEditing(group);
  };

  const submit = async () => {
    const group = editing;
    const { value, error: invalid } = validate(group, form);
    if (invalid) return showToast(invalid, 'error');
    const oldValue = Object.fromEntries(GROUPS[group].fields.map((f) => [f, profile[f] || '']));
    // Self-verify: unchanged values are fine — Verify confirms them as correct.
    if (!selfVerify && GROUPS[group].fields.every((f) => (oldValue[f] || '') === value[f])) {
      return showToast('No changes to submit.', 'error');
    }
    setSaving(true);
    try {
      const { error } = await submitVerificationRequest({ tenantId: tenant.id, profileId: profile.id, fieldGroup: group, oldValue, newValue: value });
      if (error) return showToast(error.message || 'Could not submit the request.', 'error');
      showToast(selfVerify ? `${GROUPS[group].label} verified.` : `${GROUPS[group].label} sent to HR for verification.`, 'success');
      setEditing(null);
      load();
      if (selfVerify) refreshProfile?.();
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async (req) => {
    const { error } = await cancelVerificationRequest(req.id);
    if (error) return showToast('Could not withdraw: ' + error.message, 'error');
    showToast('Request withdrawn.', 'success');
    load();
  };

  const row = (group, label, value) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.03em' }}>{label}</div>
      <div style={{ fontSize: 14, marginTop: 2 }}>{value || <span style={{ color: 'var(--text-muted)' }}>-Not Set-</span>}</div>
    </div>
  );

  const section = (group, children) => {
    const pending = pendingFor(group);
    const verifyBtn = selfVerify && statusOf(group) !== 'verified';
    return (
      <div key={group} style={{ borderTop: '1px solid var(--border)', padding: '14px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <strong>{GROUPS[group].label}</strong>
            <StatusBadge status={statusOf(group)} verifiedAt={profile[GROUPS[group].verifiedKey]} />
          </div>
          <button className={`btn btn-sm ${verifyBtn ? 'btn-primary' : 'btn-outline'}`} disabled={!!pending} onClick={() => openEdit(group)}
            title={pending ? 'A change is already waiting for HR review' : undefined}>
            {verifyBtn ? <><i className="fas fa-check" /> Verify</> : <><i className="fas fa-pen" /> Edit</>}
          </button>
        </div>
        {children}
        {pending && (
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Requested change: {summarize(group, pending.new_value)} · submitted {fmt.date(pending.created_at)}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="card" style={{ marginTop: 16, padding: 20 }}>
        <div style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Bank &amp; ID Details</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
            {selfVerify
              ? 'Check each detail, correct it if needed and press Verify. HR keeps a record of what you fill.'
              : 'Changes are sent to HR for verification and only take effect once approved.'}
          </p>
        </div>

        {section('bank', (
          <div className="grid-3" style={{ gap: 16 }}>
            {row('bank', 'Account Number', mask(profile.bank_acc))}
            {row('bank', 'Bank Name', profile.bank_name)}
            {row('bank', 'IFSC Code', profile.ifsc_code)}
          </div>
        ))}
        {section('pan', row('pan', 'PAN Number', mask(profile.pan)))}
        {section('aadhar', row('aadhar', 'Aadhaar Number', mask(profile.aadhar)))}
        {selfVerify && section('dob', row('dob', 'Date of Birth', profile.date_of_birth ? fmt.date(profile.date_of_birth) : ''))}

        {requests.length > 0 && (
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>My verification requests</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Details</th><th>Requested change</th><th>Submitted</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {requests.slice(0, 10).map((r) => (
                    <tr key={r.id}>
                      <td>{GROUPS[r.field_group]?.label || r.field_group}</td>
                      <td>{summarize(r.field_group, r.new_value)}</td>
                      <td>{fmt.date(r.created_at)}</td>
                      <td>
                        <span className={`badge ${REQUEST_BADGE[r.status] || 'badge-secondary'}`}>
                          {r.status === 'Approved' && r.reviewed_by === r.profile_id ? 'Verified' : r.status}
                        </span>
                        {r.reviewed_at && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>on {fmt.date(r.reviewed_at)}</div>}
                      </td>
                      <td>
                        {r.status === 'Pending' && (
                          <button className="btn btn-outline btn-sm" onClick={() => withdraw(r)}>Withdraw</button>
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

      <Modal show={!!editing} onClose={() => setEditing(null)} title={editing ? `${selfVerify ? 'Verify' : 'Update'} ${GROUPS[editing].label}` : ''} width="480px"
        footer={<>
          <button className="btn btn-outline" onClick={() => setEditing(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? (selfVerify ? 'Verifying…' : 'Submitting…') : (selfVerify ? 'Verify' : 'Submit for verification')}
          </button>
        </>}
      >
        {editing === 'bank' && (
          <>
            <div className="form-group">
              <label className="form-label">Account Number</label>
              <input className="form-input" inputMode="numeric" autoComplete="off" value={form.bank_acc}
                onChange={(e) => setForm({ ...form, bank_acc: e.target.value.replace(/\D/g, '') })} />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Bank Name</label>
                <input className="form-input" autoComplete="off" value={form.bank_name} onChange={(e) => setForm({ ...form, bank_name: e.target.value })} />
              </div>
              <div className="form-group">
                <label className="form-label">IFSC Code</label>
                <input className="form-input" autoComplete="off" value={form.ifsc_code} onChange={(e) => setForm({ ...form, ifsc_code: e.target.value.toUpperCase() })} />
              </div>
            </div>
          </>
        )}
        {editing === 'pan' && (
          <div className="form-group">
            <label className="form-label">PAN Number</label>
            <input className="form-input" autoComplete="off" maxLength={10} value={form.pan} onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })} />
          </div>
        )}
        {editing === 'aadhar' && (
          <div className="form-group">
            <label className="form-label">Aadhaar Number</label>
            <input className="form-input" inputMode="numeric" autoComplete="off" maxLength={14} value={form.aadhar}
              onChange={(e) => setForm({ ...form, aadhar: e.target.value.replace(/[^\d ]/g, '') })} />
          </div>
        )}
        {editing === 'dob' && (
          <div className="form-group">
            <label className="form-label">Date of Birth</label>
            <input type="date" className="form-input" max={new Date().toISOString().slice(0, 10)} value={form.date_of_birth}
              onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })} />
          </div>
        )}
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>
          {selfVerify
            ? 'By pressing Verify you confirm these details are correct. They are saved and marked Verified at once.'
            : 'Your current details stay in use until HR approves this change.'}
        </p>
      </Modal>
    </>
  );
}
