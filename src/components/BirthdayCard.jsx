import { useEffect, useRef, useState } from 'react';
import { drawBirthdayCard } from '@/lib/birthdayCard';
import { birthdayPhotoUrl } from '@/services/announcementService';
import './BirthdayCard.css';

// HR's birthday card preview + Download (`card` = {template, name, photo}, migrations
// 20261028_4/_5). `photoUrl` overrides the stored photo.
export default function BirthdayCard({ card, photoUrl, size = 1080, download = true, className = '' }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const url = photoUrl !== undefined ? photoUrl : await birthdayPhotoUrl(card.photo);
      if (cancelled || !ref.current) return;
      await drawBirthdayCard(ref.current, { template: card.template, name: card.name, photoUrl: url });
      if (!cancelled) setReady(true);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [card.template, card.name, card.photo, photoUrl]);

  const save = (e) => {
    e.preventDefault();
    e.stopPropagation();
    ref.current?.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `Happy Birthday ${card.name || ''}.jpg`.trim();
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/jpeg', 0.92);
  };

  return (
    <div className={`bday-card ${ready ? 'ready' : ''} ${className}`}>
      <canvas ref={ref} width={size} height={size} role="img" aria-label={`Happy Birthday card for ${card.name}`} />
      {download && ready && (
        <button type="button" className="btn btn-outline btn-sm bday-card-save" onClick={save}>
          <i className="fas fa-download" /> Download
        </button>
      )}
    </div>
  );
}
