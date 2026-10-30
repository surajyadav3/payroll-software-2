import { useCallback, useEffect, useRef, useState } from 'react';
import { showToast } from '@/components/Toast';
import BirthdayCard from '@/components/BirthdayCard';
import { supabase } from '@/lib/supabase';
import { cardName, compressPhoto } from '@/lib/birthdayCard';
import { listUpcomingBirthdays } from '@/services/profileDetailsService';
import { listBirthdayPhotos, setBirthdayPhoto, birthdayPhotoUrl } from '@/services/announcementService';

// Announcements > Birthday cards (HR, tenants with tenants.birthday_card — migrations 20261028_4/_5):
// the next 30 days of birthdays; HR adds each person's photo, downloads the card and shares it on
// WhatsApp themselves. The card is not posted in the app/website (20261028_5).
const DAYS = 30;

const dayLabel = (diff) => {
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  const d = new Date();
  d.setDate(d.getDate() + diff);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
};

export default function BirthdayCardsPanel({ tenant }) {
  const [rows, setRows] = useState([]);
  const [photos, setPhotos] = useState({});
  const [thumbs, setThumbs] = useState({});
  const [missingDob, setMissingDob] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(null);
  const fileRef = useRef(null);
  const target = useRef(null);

  const load = useCallback(async () => {
    const [{ data, error }, { count }] = await Promise.all([
      listUpcomingBirthdays(DAYS),
      supabase.from('profiles').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant.id).eq('status', 'Active').is('date_of_birth', null),
    ]);
    if (error) showToast(error.message || 'Could not load birthdays', 'error');
    const list = [...data].sort((a, b) => a.diffDays - b.diffDays);
    const { data: map } = await listBirthdayPhotos(list.map((r) => r.profile.id));
    setRows(list);
    setPhotos(map);
    setMissingDob(count || 0);
    setSelected((s) => s || list[0]?.profile.id || null);
    setLoading(false);
  }, [tenant.id]);

  useEffect(() => { load(); }, [load]);

  // Thumbnails for the people who have a photo.
  useEffect(() => {
    Object.entries(photos).forEach(([id, path]) => {
      if (path) birthdayPhotoUrl(path).then((url) => setThumbs((t) => (t[id] === url ? t : { ...t, [id]: url })));
    });
  }, [photos]);

  const pick = (id) => { target.current = id; fileRef.current?.click(); };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const id = target.current;
    if (!file || !id) return;
    setBusy(id);
    try {
      const blob = await compressPhoto(file);
      const { data: path, error } = await setBirthdayPhoto(tenant.id, id, blob, photos[id]);
      if (error) throw error;
      setPhotos((m) => ({ ...m, [id]: path }));
      setSelected(id);
      showToast('Photo saved — it will be on the card.', 'success');
    } catch (err) {
      showToast(err.message || 'Could not save the photo', 'error');
    }
    setBusy(null);
  };

  const remove = async (id) => {
    setBusy(id);
    const { error } = await setBirthdayPhoto(tenant.id, id, null, photos[id]);
    setBusy(null);
    if (error) return showToast(error.message || 'Could not remove the photo', 'error');
    setPhotos((m) => ({ ...m, [id]: null }));
    setThumbs((t) => ({ ...t, [id]: null }));
  };

  if (loading) return <div className="loading-screen" style={{ minHeight: 240 }}><div className="spinner" /></div>;

  const sel = rows.find((r) => r.profile.id === selected);
  const withoutPhoto = rows.filter((r) => !photos[r.profile.id]).length;

  return (
    <div className="bc-wrap">
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
      <div className="bc-note">
        <i className="fas fa-cake-candles" />
        <span>
          Add the person's photo, then <b>Download</b> the card and share it on WhatsApp. The card is not posted in the app.
          {' '}{rows.length ? `${rows.length} birthday${rows.length === 1 ? '' : 's'} in the next ${DAYS} days` : `No birthdays in the next ${DAYS} days`}
          {withoutPhoto > 0 && <>, <b>{withoutPhoto} still without a photo</b></>}.
          {missingDob > 0 && <> {missingDob} active employee{missingDob === 1 ? ' has' : 's have'} no date of birth and get no card — add it on their profile.</>}
        </span>
      </div>

      <div className="bc-grid">
        <div className="card bc-list">
          {!rows.length && <div className="empty-state"><p>Nobody has a birthday in the next {DAYS} days.</p></div>}
          {rows.map((r) => {
            const id = r.profile.id;
            const has = !!photos[id];
            return (
              <div key={id} className={`bc-row ${selected === id ? 'active' : ''}`} onClick={() => setSelected(id)}>
                <span className="bc-thumb">
                  {thumbs[id] && has ? <img src={thumbs[id]} alt="" /> : <i className="fas fa-user" />}
                </span>
                <span className="bc-main">
                  <b>{cardName(r.profile)} <span className="bc-last">{cardName({ first_name: r.profile.last_name })}</span></b>
                  <span>{dayLabel(r.diffDays)}{r.profile.outlet_location ? ` · ${r.profile.outlet_location}` : ''}</span>
                </span>
                <span className="bc-actions" onClick={(e) => e.stopPropagation()}>
                  <button className={`btn btn-sm ${has ? 'btn-outline' : 'btn-primary'}`} disabled={busy === id} onClick={() => pick(id)}>
                    <i className={`fas ${busy === id ? 'fa-spinner fa-spin' : 'fa-camera'}`} /> {has ? 'Change' : 'Add photo'}
                  </button>
                  {has && (
                    <button className="btn btn-sm btn-outline" disabled={busy === id} onClick={() => remove(id)} title="Remove photo">
                      <i className="fas fa-trash" />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        {sel && (
          <div className="bc-preview">
            <div className="bc-preview-head">{dayLabel(sel.diffDays)} · {cardName(sel.profile)}</div>
            <BirthdayCard
              card={{ template: tenant.birthday_card, name: cardName(sel.profile), photo: photos[sel.profile.id] || null }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
