// Raniwala birthday card (migrations 20261028_4/_5): HR's pink balloon template with the photo
// and "Dear <Name>," removed (public/brand/raniwala-birthday-card.jpg), drawn back on a canvas
// from {template, name, photo}. HR previews it on Announcements > Birthday cards and saves it with
// Download to share on WhatsApp; it is not posted in the app/website.
//
// Positions are in the original 1418 px artwork, scaled to the canvas.

const TEMPLATES = {
  raniwala: {
    src: '/brand/raniwala-birthday-card.jpg',
    base: 1418,
    photo: { x: 593, y: 248, w: 358, h: 328 },
    // "Dear Rahul," started at x 613 with its baseline at y 655; the body lines end near x 1210.
    name: { x: 613, y: 655, maxW: 600, size: 55, font: '"Playfair Display", Georgia, "Times New Roman", serif', color: '#8C6248' },
    fallbackMotif: '/brand/raniwala-motif.png',
  },
};

/** The name the daily post puts on the card: given names in proper case (Postgres initcap). */
export const cardName = (p) => [p?.first_name, p?.middle_name]
  .map((x) => (x || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ')
  .toLowerCase().replace(/(^|[^a-z0-9])([a-z])/g, (m, sep, c) => sep + c.toUpperCase());

const images = new Map();
function loadImage(src) {
  if (!images.has(src)) {
    images.set(src, new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // signed storage URLs: keeps the canvas exportable
      img.onload = () => resolve(img);
      img.onerror = () => { images.delete(src); reject(new Error('Image failed to load')); };
      img.src = src;
    }));
  }
  return images.get(src);
}

// object-fit: cover into the photo box; a tall photo is cut nearer the top so the face stays in.
function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const sw = w / scale, sh = h / scale;
  ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) * 0.25, sw, sh, x, y, w, h);
}

/**
 * Draws the card onto `canvas` (its width/height set by the caller).
 * `photoUrl` may be null: a blush frame with the Raniwala motif stands in until HR uploads one.
 */
export async function drawBirthdayCard(canvas, { template = 'raniwala', name, photoUrl }) {
  const T = TEMPLATES[template];
  if (!T) throw new Error('Unknown card template');
  const k = canvas.width / T.base;
  const [bg, photo] = await Promise.all([
    loadImage(T.src),
    photoUrl ? loadImage(photoUrl).catch(() => null) : Promise.resolve(null),
    document.fonts?.load(`italic 400 ${T.name.size}px "Playfair Display"`).catch(() => null),
  ]);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);

  const p = { x: T.photo.x * k, y: T.photo.y * k, w: T.photo.w * k, h: T.photo.h * k };
  if (photo) {
    drawCover(ctx, photo, p.x, p.y, p.w, p.h);
  } else {
    ctx.fillStyle = 'rgba(255, 247, 249, 0.7)';
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.strokeStyle = 'rgba(201, 162, 91, 0.8)';
    ctx.lineWidth = Math.max(1, 3 * k);
    ctx.strokeRect(p.x, p.y, p.w, p.h);
    const motif = await loadImage(T.fallbackMotif).catch(() => null);
    if (motif) {
      const m = Math.min(p.w, p.h) * 0.5;
      ctx.globalAlpha = 0.55;
      ctx.drawImage(motif, p.x + (p.w - m) / 2, p.y + (p.h - m) / 2, m, m);
      ctx.globalAlpha = 1;
    }
  }

  const text = `Dear ${name || ''},`;
  let size = T.name.size * k;
  ctx.font = `italic 400 ${size}px ${T.name.font}`;
  const maxW = T.name.maxW * k;
  const w = ctx.measureText(text).width;
  if (w > maxW) { size *= maxW / w; ctx.font = `italic 400 ${size}px ${T.name.font}`; }
  ctx.fillStyle = T.name.color;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, T.name.x * k, T.name.y * k);
}

/** Squares and shrinks HR's photo to a ~600 px JPEG before upload (keeps storage tiny). */
export async function compressPhoto(file, max = 600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file is not a picture.'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}
