/* ═══════════════════════════════════════
   LALLEWOOLS — reviews.js
   1. Myntra-style "Ratings & Reviews" on every product page: rating summary with a 5→1 star
      breakdown, a customer-photo strip, "with photos" filter, and a review form with photo upload.
   2. The Community section: reviews the admin highlighted, shown with their photos.

   Anyone can read reviews. Only a logged-in customer whose order for the product has been DELIVERED can write
   one (the server enforces it; the form is just hidden otherwise). Photos are shrunk to ~1200px JPEG here in the
   browser before upload, which also strips EXIF data such as GPS location.
   Relies on helpers from script.js / api.js (esc, fmtDate, showToast, Api, pdpProduct, ...), which load first.
═══════════════════════════════════════ */
'use strict';

const REVIEW_MAX_PHOTOS = 3;
const RV_INITIAL = 4;          // reviews shown before "VIEW ALL"
const RV_STRIP_MAX = 5;        // thumbnails in the customer-photo strip
let rvState = null;            // { productId, data, elig, filter, showAll }
let reviewDraft = { rating: 0, photos: [] };

/* ───────────── Product page: summary + list ───────────── */

function rvStarsHTML(rating) {
  const r = Math.round(Number(rating) || 0);
  return `<span class="rv-stars" role="img" aria-label="${r} out of 5 stars">${'★'.repeat(r)}<span class="rv-stars-off">${'★'.repeat(5 - r)}</span></span>`;
}
const rvTone = (n) => (n >= 4 ? 'good' : n === 3 ? 'mid' : 'low');

async function loadPdpReviews(productId) {
  const box = document.getElementById('pdp-reviews');
  if (!box) return;
  try {
    const [data, elig] = await Promise.all([
      Api.getReviews(productId),
      getCustomerToken() ? Api.reviewEligibility(productId).catch(() => ({ canReview: false })) : Promise.resolve({ canReview: false, reason: 'login' }),
    ]);
    if (!pdpProduct || pdpProduct.id !== productId || !document.getElementById('pdp-reviews')) return; // modal moved on
    rvState = { productId, data, elig, filter: 'all', showAll: false };
    renderPdpReviews();
  } catch (e) {
    if (document.getElementById('pdp-reviews')) box.innerHTML = '<div class="pdp-label"><span>RATINGS &amp; REVIEWS</span></div><div class="rv-empty">Reviews could not be loaded right now.</div>';
  }
}

function rvAllPhotos() {
  return rvState.data.reviews.flatMap((r) => r.images);
}

function renderPdpReviews() {
  const box = document.getElementById('pdp-reviews');
  if (!box || !rvState) return;
  const { data, elig, productId, filter, showAll } = rvState;
  const { summary, reviews } = data;
  const photos = rvAllPhotos();
  const withPhotos = reviews.filter((r) => r.images.length);

  // ── Summary: big average on the left, 5→1 star bars on the right (Myntra layout)
  const summaryHTML = summary.count ? `
    <div class="rv-summary">
      <div class="rv-big">
        <div class="rv-big-num">${summary.average.toFixed(1)}<span class="rv-big-star">★</span></div>
        <div class="rv-big-sub">${summary.count} Rating${summary.count === 1 ? '' : 's'}</div>
      </div>
      <div class="rv-bars">
        ${[5, 4, 3, 2, 1].map((n) => {
          const c = summary.breakdown[n] || 0;
          return `<div class="rv-bar-row"><span class="rv-bar-n">${n}<span>★</span></span><span class="rv-bar-track"><span class="rv-bar-fill rv-${rvTone(n)}" style="width:${Math.round((c / summary.count) * 100)}%"></span></span><span class="rv-bar-c">${c}</span></div>`;
        }).join('')}
      </div>
    </div>` : '<div class="rv-empty">No reviews yet — be the first to share a photo once your order arrives.</div>';

  // ── Customer photo strip
  const strip = photos.length ? `
    <div class="rv-sub-label">CUSTOMER PHOTOS (${photos.length})</div>
    <div class="rv-strip rv-strip-grid">
      ${photos.slice(0, RV_STRIP_MAX).map((u, i) => {
        const more = i === RV_STRIP_MAX - 1 && photos.length > RV_STRIP_MAX;
        return `<button type="button" class="rv-photo" data-gi="${i}" onclick="openReviewGallery('all', ${i})" aria-label="View customer photo ${i + 1}"><img src="${esc(u)}" alt="Customer photo" loading="lazy" decoding="async">${more ? `<span class="rv-more">+${photos.length - RV_STRIP_MAX + 1}</span>` : ''}</button>`;
      }).join('')}
    </div>` : '';

  // ── Write-a-review entry point (or why it isn't available)
  let action = '';
  if (elig.canReview) {
    action = `<button type="button" class="rv-write-btn" onclick="openReviewForm(${productId})">📷 RATE &amp; ADD PHOTOS</button><div id="rv-form"></div>`;
  } else if (elig.reason === 'login') {
    action = `<div class="rv-note">Bought this? <a href="#" onclick="event.preventDefault();closeProductModal();openAccountModal()">Log in</a> to rate it and add photos once it's delivered.</div>`;
  } else if (elig.reason === 'not_delivered') {
    action = '<div class="rv-note">You can rate this and add photos once your order for it has been delivered.</div>';
  } else if (elig.reason === 'already_reviewed') {
    action = '<div class="rv-note">✓ You\'ve reviewed this product. Thank you!</div>';
  }

  // ── List with filter chips
  const shownAll = filter === 'photos' ? withPhotos : reviews;
  const shown = showAll ? shownAll : shownAll.slice(0, RV_INITIAL);
  const chips = reviews.length ? `
    <div class="rv-sub-label">CUSTOMER REVIEWS (${reviews.length})</div>
    <div class="rv-chips" role="group" aria-label="Filter reviews">
      <button type="button" class="${filter === 'all' ? 'on' : ''}" aria-pressed="${filter === 'all'}" onclick="setReviewFilter('all')">All</button>
      <button type="button" class="${filter === 'photos' ? 'on' : ''}" aria-pressed="${filter === 'photos'}" onclick="setReviewFilter('photos')">With photos (${withPhotos.length})</button>
    </div>` : '';

  const list = shown.map((r) => `
    <div class="rv-item">
      <div class="rv-item-top">
        <span class="rv-pill rv-${rvTone(r.rating)}">${r.rating} ★</span>
        ${r.featured ? '<span class="rv-pick-badge">⭐ Community pick</span>' : ''}
      </div>
      ${r.body ? `<p class="rv-body">${esc(r.body)}</p>` : ''}
      ${r.images.length ? `<div class="rv-strip">${r.images.map((u, i) => `<button type="button" class="rv-photo" onclick="openReviewGallery(${r.id}, ${i})" aria-label="View customer photo"><img src="${esc(u)}" alt="Customer photo" loading="lazy" decoding="async"></button>`).join('')}</div>` : ''}
      <div class="rv-meta"><span class="rv-name">${esc(r.name)}</span>${r.verified ? '<span class="rv-verified">✓ Verified buyer</span>' : ''}<span class="rv-date">${esc(fmtDate(r.createdAt))}</span></div>
      ${r.mine ? `<button type="button" class="rv-delete" onclick="deleteMyReview(${r.id}, ${productId})">Delete my review</button>` : ''}
    </div>`).join('');

  const more = !showAll && shownAll.length > RV_INITIAL
    ? `<button type="button" class="rv-viewall" onclick="rvShowAll()">VIEW ALL ${shownAll.length} REVIEWS</button>` : '';
  const empty = reviews.length && !shownAll.length ? '<div class="rv-empty">No reviews with photos yet.</div>' : '';

  // Keep an open review form (and what the customer typed) when we re-render for a filter change.
  const openForm = document.getElementById('rv-form');
  const formHTML = openForm ? openForm.innerHTML : '';
  const formText = document.getElementById('rv-text') ? document.getElementById('rv-text').value : '';

  box.innerHTML = `<div class="pdp-label"><span>RATINGS &amp; REVIEWS</span></div>${summaryHTML}${strip}${action}${chips}<div class="rv-list">${list}</div>${empty}${more}`;

  if (formHTML) {
    const f = document.getElementById('rv-form');
    if (f) { f.innerHTML = formHTML; const t = document.getElementById('rv-text'); if (t) t.value = formText; }
  }
}

function setReviewFilter(f) { if (rvState) { rvState.filter = f; rvState.showAll = false; renderPdpReviews(); } }
function rvShowAll() { if (rvState) { rvState.showAll = true; renderPdpReviews(); } }

/* ───────────── Review form with photo upload ───────────── */

function openReviewForm(productId) {
  reviewDraft = { rating: 0, photos: [] };
  const form = document.getElementById('rv-form');
  if (!form) return;
  form.innerHTML = `
    <div class="rv-form">
      <div class="rv-form-label">Rate this product</div>
      <div class="rv-pick" id="rv-pick" role="radiogroup" aria-label="Rating">
        ${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="false" aria-label="${n} star${n > 1 ? 's' : ''}" data-n="${n}" onclick="setReviewRating(${n})">★</button>`).join('')}
      </div>
      <div class="rv-form-label">Write a review <span class="rv-opt">(optional)</span></div>
      <textarea id="rv-text" maxlength="1000" rows="3" placeholder="How does it fit and feel? Would you buy it again?"></textarea>
      <div class="rv-form-label">Add photos <span class="rv-opt">(up to ${REVIEW_MAX_PHOTOS})</span></div>
      <div class="rv-strip" id="rv-thumbs"></div>
      <input type="file" id="rv-file" accept="image/jpeg,image/png,image/webp" multiple hidden onchange="addReviewPhotos(this)">
      <div class="rv-error" id="rv-error" role="alert"></div>
      <div class="rv-form-actions">
        <button type="button" class="btn-ghost" onclick="document.getElementById('rv-form').innerHTML=''">CANCEL</button>
        <button type="button" class="btn-primary" id="rv-submit" onclick="submitReview(${productId})">SUBMIT</button>
      </div>
    </div>`;
  renderReviewThumbs();
  form.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function setReviewRating(n) {
  reviewDraft.rating = n;
  document.querySelectorAll('#rv-pick button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.n) <= n);
    b.setAttribute('aria-checked', String(Number(b.dataset.n) === n));
  });
}

function renderReviewThumbs() {
  const el = document.getElementById('rv-thumbs');
  if (!el) return;
  el.innerHTML = reviewDraft.photos.map((src, i) => `
    <div class="rv-thumb"><img src="${src}" alt="Selected photo ${i + 1}"><button type="button" aria-label="Remove photo ${i + 1}" onclick="removeReviewPhoto(${i})">✕</button></div>`).join('')
    + (reviewDraft.photos.length < REVIEW_MAX_PHOTOS ? '<button type="button" class="rv-add" onclick="document.getElementById(\'rv-file\').click()" aria-label="Add a photo">📷<span>Add photo</span></button>' : '');
}

function removeReviewPhoto(i) { reviewDraft.photos.splice(i, 1); renderReviewThumbs(); }

/** Shrinks a photo to max 1200px JPEG. Re-drawing on a canvas also drops EXIF (location, device) from the file. */
function compressPhoto(file, maxDim = 1200, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); // flatten transparent PNGs onto white
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read "' + file.name + '". Please use a JPG, PNG or WebP photo.')); };
    img.src = url;
  });
}

async function addReviewPhotos(input) {
  const errEl = document.getElementById('rv-error');
  errEl.textContent = '';
  const room = REVIEW_MAX_PHOTOS - reviewDraft.photos.length;
  const files = Array.from(input.files || []).slice(0, room);
  if (input.files && input.files.length > room) errEl.textContent = `You can add up to ${REVIEW_MAX_PHOTOS} photos.`;
  for (const f of files) {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { errEl.textContent = 'Please choose JPG, PNG or WebP photos.'; continue; }
    try { reviewDraft.photos.push(await compressPhoto(f)); }
    catch (e) { errEl.textContent = e.message; }
  }
  input.value = '';
  renderReviewThumbs();
}

async function submitReview(productId) {
  const errEl = document.getElementById('rv-error');
  const btn = document.getElementById('rv-submit');
  errEl.textContent = '';
  if (!reviewDraft.rating) { errEl.textContent = 'Please choose a star rating.'; return; }
  btn.disabled = true; btn.textContent = 'SUBMITTING…';
  try {
    await Api.postReview({
      productId, rating: reviewDraft.rating,
      body: document.getElementById('rv-text').value.trim(),
      images: reviewDraft.photos,
    });
    showToast('✓ Thanks! Your review is live.');
    loadPdpReviews(productId);
  } catch (e) {
    errEl.textContent = e.message;
    btn.disabled = false; btn.textContent = 'SUBMIT';
  }
}

async function deleteMyReview(id, productId) {
  if (!confirm('Delete your review and its photos?')) return;
  try { await Api.deleteReview(id); showToast('Review deleted'); loadPdpReviews(productId); loadCommunityReviews(); }
  catch (e) { showToast('⚠ ' + e.message); }
}

/* ───────────── Photo viewer (swipe/arrows through a set of photos) ───────────── */

let rvLightbox = null; // { list, i }

/** which = 'all' (every customer photo for this product) or a review id (just that review's photos). */
function openReviewGallery(which, index) {
  if (!rvState) return;
  const list = which === 'all' ? rvAllPhotos() : ((rvState.data.reviews.find((r) => r.id === which) || {}).images || []);
  openReviewPhotoList(list, index);
}

function openReviewPhotoList(list, index) {
  if (!list || !list.length) return;
  closeReviewPhoto(); // clears any open viewer (and rvLightbox) — so set the new state AFTER this
  rvLightbox = { list, i: Math.max(0, Math.min(index || 0, list.length - 1)) };
  const el = document.createElement('div');
  el.id = 'rv-lightbox';
  el.className = 'rv-lightbox';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Customer photos');
  el.addEventListener('click', (e) => { if (e.target === el || e.target.tagName === 'IMG') closeReviewPhoto(); });
  document.body.appendChild(el);
  paintReviewLightbox();
}

function paintReviewLightbox() {
  const el = document.getElementById('rv-lightbox');
  if (!el || !rvLightbox) return;
  const { list, i } = rvLightbox;
  el.innerHTML = `<button type="button" class="rv-lb-close" aria-label="Close photo" onclick="closeReviewPhoto()">✕</button>
    ${list.length > 1 ? '<button type="button" class="rv-lb-nav prev" aria-label="Previous photo" onclick="stepReviewPhoto(-1)">‹</button><button type="button" class="rv-lb-nav next" aria-label="Next photo" onclick="stepReviewPhoto(1)">›</button>' : ''}
    <img src="${esc(list[i])}" alt="Customer photo ${i + 1} of ${list.length}">
    ${list.length > 1 ? `<div class="rv-lb-count">${i + 1} / ${list.length}</div>` : ''}`;
}

function stepReviewPhoto(d) {
  if (!rvLightbox) return;
  const n = rvLightbox.list.length;
  rvLightbox.i = (rvLightbox.i + d + n) % n;
  paintReviewLightbox();
}
function closeReviewPhoto() { const el = document.getElementById('rv-lightbox'); if (el) el.remove(); rvLightbox = null; }
// Capture phase + stopPropagation: Escape must close only the photo viewer, not also the product page behind it
// (script.js closes every open panel on Escape).
document.addEventListener('keydown', (e) => {
  if (!rvLightbox) return;
  if (e.key === 'Escape') { e.stopPropagation(); closeReviewPhoto(); }
  else if (e.key === 'ArrowLeft') stepReviewPhoto(-1);
  else if (e.key === 'ArrowRight') stepReviewPhoto(1);
}, true);
// Swipe on touch screens.
(function () {
  let x0 = null;
  document.addEventListener('touchstart', (e) => { x0 = rvLightbox && e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (x0 === null || !rvLightbox) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) stepReviewPhoto(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

/* ───────────── Community section: highlighted reviews ───────────── */

const CM_BACKDROPS = [
  'linear-gradient(160deg,#1a1a2e,#16213e,#0f3460)', 'linear-gradient(160deg,#0d0d0d,#1a0026)',
  'linear-gradient(160deg,#0a0a0a,#1a1a00)', 'linear-gradient(160deg,#0f0f23,#1a002e)', 'linear-gradient(160deg,#0a1628,#0f2040)',
];

function renderCommunityCard(r) {
  const quote = String(r.body || '').trim();
  const clipped = quote.length > 140 ? quote.slice(0, 137).trimEnd() + '…' : quote;
  const label = `${esc(r.name)} · ${esc(r.productName)}`;
  const open = `onclick="openCommunityReview(${r.productId})" onkeydown="if(event.key==='Enter')openCommunityReview(${r.productId})"`;
  const stars = `<span class="cm-stars" aria-label="${r.rating} out of 5 stars">${'★'.repeat(r.rating)}<span class="rv-stars-off">${'★'.repeat(5 - r.rating)}</span></span>`;
  if (r.image) {
    return `
      <div class="community-card cm-live" role="link" tabindex="0" aria-label="Review by ${label}" ${open}>
        <div class="community-img">
          <img src="${esc(r.image)}" alt="Photo from ${esc(r.name)}'s review of ${esc(r.productName)}" loading="lazy" decoding="async">
          ${r.photoCount > 1 ? `<div class="community-icon">📷 ${r.photoCount}</div>` : ''}
          <div class="community-overlay cm-overlay">${stars}${clipped ? `<p>“${esc(clipped)}”</p>` : ''}<span>${label}</span></div>
        </div>
      </div>`;
  }
  return `
    <div class="community-card cm-live" role="link" tabindex="0" aria-label="Review by ${label}" ${open}>
      <div class="community-img cm-text" style="background:${CM_BACKDROPS[r.id % CM_BACKDROPS.length]}">
        <div class="cm-text-body">${stars}<p>“${esc(clipped || 'Loved it!')}”</p></div>
        <div class="community-overlay cm-overlay"><span>${label}</span></div>
      </div>
    </div>`;
}

function openCommunityReview(productId) {
  if (!PRODUCTS.some((p) => p.id === productId)) { showToast('This product is no longer available'); return; }
  openProductModal(productId);
  // Reviews are at the bottom of the product page — bring them into view.
  setTimeout(() => { const s = document.getElementById('pdp-reviews'); if (s) s.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 350);
}

/** Swaps the placeholder cards for real highlighted reviews. With none highlighted yet, the original cards stay. */
async function loadCommunityReviews() {
  const grid = document.querySelector('#community-section .community-grid');
  if (!grid) return;
  let list;
  try { list = await Api.getFeaturedReviews(); } catch (e) { return; }
  if (!Array.isArray(list) || !list.length) return;
  grid.classList.add('community-live', 'cm-n' + Math.min(list.length, 3));
  grid.innerHTML = list.map(renderCommunityCard).join('');
  const sub = document.getElementById('community-sub');
  if (sub) sub.hidden = false;
}
