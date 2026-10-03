/* ═══════════════════════════════════════
   LALLEWOOLS — script.js (Full Rebuild)
═══════════════════════════════════════ */
'use strict';

/* ──────────────────────────────────────
   SMALL HELPERS
────────────────────────────────────── */
/** Escape text before putting it in HTML (product names/descriptions can be edited in the admin panel). */
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const BRAND = 'LALLEWOOLS';

/** Responsive image: small WebP when the optimiser has produced one (npm run optimize-images), original otherwise. */
const IMG_WIDTHS = [480, 800, 1200];
function webpUrl(path, w) { return path.replace(/\.(jpe?g|png)$/i, `.w${w}.webp`); }
function imgTag(path, { alt = '', cls = '', sizes = '50vw', eager = false } = {}) {
  if (!path) return '';
  const canOptimise = /\.(jpe?g|png)$/i.test(path);
  const srcset = canOptimise ? IMG_WIDTHS.map((w) => `${webpUrl(path, w)} ${w}w`).join(', ') : '';
  const src = canOptimise ? webpUrl(path, 800) : path;
  // If the .webp doesn't exist (new image not optimised yet) fall back to the original, once.
  return `<img src="${esc(src)}"${srcset ? ` srcset="${esc(srcset)}" sizes="${sizes}"` : ''} alt="${esc(alt)}" class="${cls}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" onerror="if(!this.dataset.fb){this.dataset.fb=1;this.removeAttribute('srcset');this.src='${esc(path)}'}else{this.style.display='none'}">`;
}
const HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
const badgeLabel = (b) => (b === 'launch' ? 'LAUNCH OFFER' : String(b).toUpperCase());
const discountPct = (p) => (p.oldPrice && p.oldPrice > p.price ? Math.round((1 - p.price / p.oldPrice) * 100) : 0);
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
function safeParse(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : fallback; } catch (e) { return fallback; } }

/* ──────────────────────────────────────
   DATA
   PRODUCTS is now loaded from the backend (GET /api/products) in
   loadProducts() below, so prices/stock live in one place (server/data
   /products.js) instead of being hardcoded in the browser. FALLBACK_PRODUCTS
   keeps the site fully working even if the API is unreachable (e.g. static
   hosting preview without the Node server running).
────────────────────────────────────── */

let PRODUCTS = [];
let catalogError = false;

/** Fetch the live catalog from the backend (never cached, retried once).
 *  If the server is unreachable the shop shows a clear "try again" state: showing old
 *  hard-coded prices would let someone put a wrong price in their bag. */
async function loadProducts() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fresh = await Api.getProducts();
      if (Array.isArray(fresh)) { PRODUCTS = fresh; catalogError = false; return; }
    } catch (err) {
      console.warn('[LALLEWOOLS] Could not load products (attempt ' + (attempt + 1) + '):', err.message);
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  catalogError = true;
}

/* ──────────────────────────────────────
   CART & WISHLIST STATE
────────────────────────────────────── */
let cart = safeParse('lallewools_cart', []);
let wishlist = safeParse('lallewools_wishlist', []);
let selectedProductSize = 'M';
let currentPaymentMethod = '';
let storeConfig = { onlinePayments: true, shippingFee: 50 }; // refreshed from /api/config when checkout opens
let lastPlacedOrderId = null;

function saveCart() { try { localStorage.setItem('lallewools_cart', JSON.stringify(cart)); } catch (e) { /* private mode / full storage */ } }
function saveWishlist() { try { localStorage.setItem('lallewools_wishlist', JSON.stringify(wishlist)); } catch (e) { /* ignore */ } }
const shippingFee = () => (Number.isFinite(storeConfig.shippingFee) ? storeConfig.shippingFee : 50);
function getTotal() { return cart.reduce((sum, i) => sum + i.price * i.qty, 0); }

/* ──────────────────────────────────────
   CART UI
────────────────────────────────────── */
function cartMrp(item) { return item.oldPrice && item.oldPrice > item.price ? item.oldPrice : item.price; }
function updateCartUI() {
  const count = cart.reduce((s, i) => s + i.qty, 0);
  const el = document.getElementById('cart-count');
  el.textContent = count;
  el.classList.toggle('visible', count > 0);
  const hc = document.getElementById('cart-header-count');
  if (hc) hc.textContent = count ? `(${count})` : '';

  const itemsEl = document.getElementById('cart-items');
  const detailsEl = document.getElementById('cart-price-details');
  const checkoutBtn = document.getElementById('cart-checkout-btn');
  if (!cart.length) {
    itemsEl.innerHTML = '<div class="cart-empty"><strong>Your bag is empty</strong>Add something dope.</div>';
    detailsEl.innerHTML = '';
    checkoutBtn.disabled = true;
    return;
  }
  checkoutBtn.disabled = false;
  itemsEl.innerHTML = cart.map(item => {
    const mrp = cartMrp(item), off = mrp > item.price ? Math.round((1 - item.price / mrp) * 100) : 0;
    return `
      <div class="cart-item">
        <div class="cart-item-img">${item.image ? imgTag(item.image, { alt: item.name, sizes: '90px' }) : esc(item.emoji)}</div>
        <div class="cart-item-info">
          <div class="cart-item-name">${esc(item.name)}</div>
          <div class="cart-item-sub">${item.size !== 'NA' ? 'Size: ' + esc(item.size) : ''}</div>
          <div class="cart-item-price-row">
            <span class="cart-item-price">${inr(item.price * item.qty)}</span>
            ${off ? `<span class="cart-item-mrp">${inr(mrp * item.qty)}</span><span class="cart-item-off">${off}% OFF</span>` : ''}
          </div>
          <div class="cart-item-controls">
            <div class="qty-stepper">
              <button type="button" onclick="changeCartQty(${item.id},'${esc(item.size)}',-1)" aria-label="Decrease quantity">−</button>
              <span>${item.qty}</span>
              <button type="button" onclick="changeCartQty(${item.id},'${esc(item.size)}',1)" aria-label="Increase quantity">+</button>
            </div>
          </div>
        </div>
        <button type="button" class="cart-item-x" onclick="removeFromCart(${item.id},'${esc(item.size)}')" aria-label="Remove ${esc(item.name)}">✕</button>
      </div>`;
  }).join('');

  const total = getTotal();
  const mrpTotal = cart.reduce((s, i) => s + cartMrp(i) * i.qty, 0);
  const saved = mrpTotal - total;
  detailsEl.innerHTML = `
    ${saved > 0 ? `<div class="pd-row"><span>Total MRP</span><span>${inr(mrpTotal)}</span></div><div class="pd-row save"><span>Discount</span><span>−${inr(saved)}</span></div>` : ''}
    <div class="pd-row"><span>Shipping</span><span>${inr(shippingFee())}</span></div>
    <div class="pd-row total"><span>Total</span><span>${inr(total + shippingFee())}</span></div>`;
}

function changeCartQty(productId, size, delta) {
  const item = cart.find(i => i.id === productId && i.size === size);
  if (!item) return;
  item.qty = Math.min(10, item.qty + delta);
  if (item.qty <= 0) { removeFromCart(productId, size); return; }
  saveCart(); updateCartUI();
}

function addToCart(productId, size) {
  const p = PRODUCTS.find(pr => pr.id === productId);
  if (!p) return;
  const existing = cart.find(i => i.id === productId && i.size === (size || 'NA'));
  if (existing) { existing.qty++; }
  else { cart.push({ id: productId, name: p.name, price: p.price, oldPrice: p.oldPrice || null, emoji: p.emoji, image: p.image || null, size: size || 'NA', qty: 1 }); }
  saveCart(); updateCartUI();
  // Phones: stay on the page and confirm with a toast (Myntra-style); desktop opens the bag drawer.
  if (isMobile()) { showToast('Added to bag'); return; }
  showToast('✓ Added — ' + p.name);
  document.getElementById('cart-sidebar').classList.add('open');
  document.getElementById('cart-overlay-bg').classList.add('open');
  document.body.classList.add('no-scroll');
}

function removeFromCart(id, size) {
  cart = cart.filter(i => !(i.id === id && i.size === size));
  saveCart(); updateCartUI();
}

/* ──────────────────────────────────────
   WISHLIST UI
────────────────────────────────────── */
function updateWishlistUI() {
  const count = wishlist.length;
  const el = document.getElementById('wishlist-count');
  el.textContent = count;
  el.classList.toggle('visible', count > 0);
  document.getElementById('wishlist-btn').classList.toggle('has-items', count > 0);
  const bn = document.getElementById('bn-wishlist-count');
  if (bn) { bn.textContent = count; bn.classList.toggle('visible', count > 0); }

  const itemsEl = document.getElementById('wishlist-items');
  if (!wishlist.length) {
    itemsEl.innerHTML = '<div class="cart-empty"><strong>Your wishlist is empty</strong>Tap ♡ on any product to save it.</div>';
    return;
  }
  itemsEl.innerHTML = wishlist.map(item => `
    <div class="cart-item">
      <div class="cart-item-img" onclick="closeWishlistPanel();openProductModal(${item.id})">${item.image ? imgTag(item.image, { alt: item.name, sizes: '90px' }) : esc(item.emoji)}</div>
      <div class="cart-item-info">
        <div class="cart-item-name">${esc(item.name)}</div>
        <div class="cart-item-price-row"><span class="cart-item-price">${inr(item.price)}</span></div>
        <div style="display:flex;gap:16px">
          <button type="button" class="cart-item-remove is-accent" onclick="moveToCart(${item.id})">MOVE TO BAG</button>
        </div>
      </div>
      <button type="button" class="cart-item-x" onclick="removeFromWishlist(${item.id})" aria-label="Remove ${esc(item.name)} from wishlist">✕</button>
    </div>
  `).join('');
}

function toggleWishlist(productId) {
  const p = PRODUCTS.find(pr => pr.id === productId);
  if (!p) return;
  const idx = wishlist.findIndex(i => i.id === productId);
  if (idx > -1) { wishlist.splice(idx, 1); showToast('Removed from wishlist'); }
  else { wishlist.push({ id: p.id, name: p.name, price: p.price, emoji: p.emoji, image: p.image || null }); showToast('Added to wishlist'); }
  saveWishlist(); updateWishlistUI();
  // update all wish buttons
  const nowWished = wishlist.some(i => i.id === productId);
  document.querySelectorAll(`[data-wish-id="${productId}"]`).forEach(btn => {
    btn.classList.toggle('wished', nowWished);
    btn.setAttribute('aria-pressed', String(nowWished));
    if (btn.classList.contains('pdp-wish')) btn.querySelector('.wl-text').textContent = nowWished ? 'WISHLISTED' : 'WISHLIST';
  });
}

function removeFromWishlist(id) { wishlist = wishlist.filter(i => i.id !== id); saveWishlist(); updateWishlistUI(); }
function moveToCart(id) {
  const p = PRODUCTS.find(pr => pr.id === id);
  // Tees need a size: send the shopper to the product page instead of guessing "M" for them.
  if (p && p.type === 'clothing') { closeWishlistPanel(); openProductModal(id); showToast('Pick a size to add to bag'); return; }
  addToCart(id, 'NA'); removeFromWishlist(id);
}
function isWishlisted(id) { return wishlist.some(i => i.id === id); }

/* ──────────────────────────────────────
   INTRO (LOGO GLITCH)
────────────────────────────────────── */
function initFabricCanvas() {
  const canvas = document.getElementById('fabric-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const lines = Array.from({ length: 50 }, () => ({
    x: Math.random() * canvas.width, y: Math.random() * canvas.height,
    vx: (Math.random() - 0.5) * 0.6, vy: (Math.random() - 0.5) * 0.6,
    len: Math.random() * 100 + 30, angle: Math.random() * Math.PI,
    vangle: (Math.random() - 0.5) * 0.008, opacity: Math.random() * 0.4 + 0.1
  }));
  let animId;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    lines.forEach(l => {
      l.x += l.vx; l.y += l.vy; l.angle += l.vangle;
      if (l.x < 0 || l.x > canvas.width) l.vx *= -1;
      if (l.y < 0 || l.y > canvas.height) l.vy *= -1;
      ctx.strokeStyle = `rgba(200,255,0,${l.opacity})`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(l.x + Math.cos(l.angle) * l.len, l.y + Math.sin(l.angle) * l.len);
      ctx.stroke();
    });
    animId = requestAnimationFrame(draw);
  }
  draw();
  return animId;
}

function startIntro() {
  const overlay = document.getElementById('intro-overlay');
  // Show the logo intro only on the first page view of a visit — repeat taps on "Home" shouldn't replay it.
  let seen = false;
  try { seen = sessionStorage.getItem('lw_intro') === '1'; sessionStorage.setItem('lw_intro', '1'); } catch (e) { /* ignore */ }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (seen || reduced) { overlay.style.display = 'none'; animateHero(); return; }
  const animId = initFabricCanvas();
  document.body.classList.add('no-scroll');
  let finished = false;
  const done = () => {
    if (finished) return; finished = true;
    overlay.style.display = 'none';
    document.body.classList.remove('no-scroll');
    cancelAnimationFrame(animId);
    animateHero();
  };
  overlay.addEventListener('click', () => { overlay.classList.add('fade-out'); setTimeout(done, 300); }, { once: true }); // tap to skip
  setTimeout(() => { overlay.classList.add('fade-out'); setTimeout(done, 800); }, 2200);
}

function animateHero() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const els = document.querySelectorAll('.hero-eyebrow,.hero-title,.hero-subtitle,.hero-cta-group');
  els.forEach((el, i) => {
    el.style.cssText = `opacity:0;transform:translateY(32px);transition:opacity .8s ease ${i*0.15}s,transform .8s ease ${i*0.15}s`;
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.opacity='1'; el.style.transform='translateY(0)'; }));
  });
}

/* ──────────────────────────────────────
   HERO SLIDER
────────────────────────────────────── */
let currentSlide = 0;
const slides = () => document.querySelectorAll('.hero-slide');
const dots = () => document.querySelectorAll('.slider-dots .dot');

function goSlide(n) {
  slides().forEach((s, i) => s.classList.toggle('active', i === n));
  dots().forEach((d, i) => d.classList.toggle('active', i === n));
  currentSlide = n;
}
function slideHero(dir) {
  const len = slides().length;
  goSlide((currentSlide + dir + len) % len);
}

let sliderInterval = null;
function startSlider() { stopSlider(); if (slides().length > 1) sliderInterval = setInterval(() => slideHero(1), 5000); }
function stopSlider() { clearInterval(sliderInterval); sliderInterval = null; }
function initHeroSlider() {
  const el = document.getElementById('hero-slider');
  if (!el) return;
  startSlider();
  el.addEventListener('mouseenter', stopSlider);
  el.addEventListener('mouseleave', startSlider);
  // Swipe left/right on phones
  let x0 = null, y0 = null;
  el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; stopSlider(); }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 !== null) {
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) slideHero(dx < 0 ? 1 : -1);
    }
    x0 = null; startSlider();
  }, { passive: true });
  document.addEventListener('visibilitychange', () => (document.hidden ? stopSlider() : startSlider()));
}

/* ──────────────────────────────────────
   THEME TOGGLE
────────────────────────────────────── */
function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (localStorage.getItem('lallewools_theme') === 'light')
    document.documentElement.setAttribute('data-theme', 'light');
  btn.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) { document.documentElement.removeAttribute('data-theme'); localStorage.setItem('lallewools_theme','dark'); }
    else { document.documentElement.setAttribute('data-theme','light'); localStorage.setItem('lallewools_theme','light'); }
  });
}

/* ──────────────────────────────────────
   NAVBAR
────────────────────────────────────── */
function initNavbar() {
  const nav = document.getElementById('navbar');
  window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 40), { passive: true });
}

/* ──────────────────────────────────────
   MOBILE MENU
────────────────────────────────────── */
function closeMobileMenu() {
  document.getElementById('mobile-menu').classList.remove('open');
  document.getElementById('mobile-menu-backdrop').classList.remove('open');
  document.getElementById('hamburger').classList.remove('open');
  document.body.classList.remove('no-scroll');
}
function initMobileMenu() {
  const btn = document.getElementById('hamburger');
  const menu = document.getElementById('mobile-menu');
  btn.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    document.getElementById('mobile-menu-backdrop').classList.toggle('open', open);
    btn.classList.toggle('open', open);
    document.body.classList.toggle('no-scroll', open);
  });
  document.getElementById('mobile-close').addEventListener('click', closeMobileMenu);
}

/* ──────────────────────────────────────
   SEARCH
────────────────────────────────────── */
function openSearch() {
  document.getElementById('search-overlay').classList.add('open');
  document.body.classList.add('no-scroll');
  setTimeout(() => document.getElementById('search-input').focus(), 150);
}
function closeSearch() {
  document.getElementById('search-overlay').classList.remove('open');
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
  syncScrollLock();
}
function fillSearch(term) {
  const input = document.getElementById('search-input');
  input.value = term;
  input.dispatchEvent(new Event('input'));
  input.focus();
}

function initSearch() {
  document.getElementById('nav-search-bar').addEventListener('click', openSearch);
  document.getElementById('search-close').addEventListener('click', closeSearch);
  let t;
  document.getElementById('search-input').addEventListener('input', () => { clearTimeout(t); t = setTimeout(runSearch, 120); });
}

function runSearch() {
  const q = document.getElementById('search-input').value.toLowerCase().trim();
  const resultsEl = document.getElementById('search-results');
  if (!q) { resultsEl.innerHTML = ''; return; }
  const words = q.split(/\s+/);
  const hay = (p) => `${p.name} ${p.category} tee tshirt t-shirt clothing`.toLowerCase();
  const results = PRODUCTS.filter(p => words.every(w => hay(p).includes(w))).slice(0, 12);
  if (!results.length) { resultsEl.innerHTML = '<div class="sr-empty">No results found. Try “tee” or “oversized”.</div>'; return; }
  resultsEl.innerHTML = results.map(p => `
    <div class="search-result-item" role="button" tabindex="0" onclick="closeSearchAndOpen(${p.id})">
      <div class="sr-thumb">${p.image ? imgTag(p.image, { alt: '', sizes: '48px' }) : esc(p.emoji)}</div>
      <div>
        <div class="sr-name">${esc(p.name)}</div>
        <div class="sr-sub">Clothing · ${inr(p.price)}</div>
      </div>
    </div>`).join('');
}

function closeSearchAndOpen(id) {
  closeSearch();
  setTimeout(() => openProductModal(id), 150);
}

/* ──────────────────────────────────────
   CART SIDEBAR
────────────────────────────────────── */
function openCartPanel() {
  document.getElementById('cart-sidebar').classList.add('open');
  document.getElementById('cart-overlay-bg').classList.add('open');
  document.body.classList.add('no-scroll');
}
function closeCartPanel() {
  document.getElementById('cart-sidebar').classList.remove('open');
  document.getElementById('cart-overlay-bg').classList.remove('open');
  syncScrollLock();
}
function openWishlistPanel() {
  document.getElementById('wishlist-sidebar').classList.add('open');
  document.getElementById('cart-overlay-bg').classList.add('open');
  document.body.classList.add('no-scroll');
}
function closeWishlistPanel() {
  document.getElementById('wishlist-sidebar').classList.remove('open');
  document.getElementById('cart-overlay-bg').classList.remove('open');
  syncScrollLock();
}
/** Unlock page scroll only when nothing full-screen is still open. */
function syncScrollLock() {
  const anyOpen = document.querySelector('.modal-overlay.open,#cart-sidebar.open,#wishlist-sidebar.open,#search-overlay.open,#mobile-menu.open,#profile-page.open');
  document.body.classList.toggle('no-scroll', Boolean(anyOpen));
}
function initCart() {
  document.getElementById('cart-btn').addEventListener('click', openCartPanel);
  document.getElementById('cart-close').addEventListener('click', closeCartPanel);
  document.getElementById('cart-overlay-bg').addEventListener('click', () => { closeCartPanel(); closeWishlistPanel(); });
}
function initWishlist() {
  document.getElementById('wishlist-btn').addEventListener('click', openWishlistPanel);
  document.getElementById('wishlist-close').addEventListener('click', closeWishlistPanel);
}

/* Bottom tab bar (phones) */
function bnSetActive(name) {
  document.querySelectorAll('.bn-item').forEach(b => b.classList.toggle('active', b.dataset.bn === name));
}
function bnGo(name) {
  closeCartPanel(); closeWishlistPanel(); closeProductModal();
  if (name === 'home') { window.scrollTo({ top: 0, behavior: 'smooth' }); }
  else {
    const el = document.getElementById('clothing-section');
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - (document.getElementById('navbar').offsetHeight || 56) + 1, behavior: 'smooth' });
  }
  bnSetActive(name);
}
function initBottomNav() {
  const map = { 'clothing-section': 'tees' };
  const sections = ['clothing-section'].map(id => document.getElementById(id)).filter(Boolean);
  const onScroll = () => {
    const probe = window.innerHeight * 0.35;
    let active = 'home';
    for (const sec of sections) { const r = sec.getBoundingClientRect(); if (r.top < probe && r.bottom > probe) active = map[sec.id]; }
    bnSetActive(active);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ──────────────────────────────────────
   PRODUCT CARD HTML (with mockup tee)
────────────────────────────────────── */
function productCardHTML(p) {
  const badge = p.badge ? `<div class="product-badge badge-${esc(p.badge)}">${esc(badgeLabel(p.badge))}</div>` : '';
  const off = discountPct(p);
  const wished = isWishlisted(p.id);
  const soldOut = typeof p.stock === 'number' && p.stock <= 0;

  let visual;
  if (p.image) {
    visual = `<div class="card-tee-wrap card-photo-wrap">${imgTag(p.image, { alt: p.name, cls: 'card-product-img', sizes: '(max-width:768px) 48vw, 260px' })}</div>`;
  } else {
    const designTxt = esc(p.designText || p.emoji).replace(/\n/g, '<br>');
    visual = `<div class="card-tee-wrap"><div class="card-mockup-tee"><div class="card-mockup-body" style="background:${esc(p.teeColor || '#fff')}"><div class="card-mockup-design" style="color:${esc(p.designColor || '#0A0A0A')}">${designTxt}</div></div></div></div>`;
  }

  return `
    <div class="product-card" role="link" tabindex="0" aria-label="${esc(p.name)}, ${inr(p.price)}" onclick="openProductModal(${p.id})" onkeydown="if(event.key==='Enter')openProductModal(${p.id})">
      <div class="product-img">
        <div class="product-img-inner${p.image ? '' : ' has-mockup'}">${visual}</div>
        ${badge}
        <button type="button" class="product-wish-btn ${wished ? 'wished' : ''}" data-wish-id="${p.id}" aria-pressed="${wished}" aria-label="Add ${esc(p.name)} to wishlist"
          onclick="event.stopPropagation();toggleWishlist(${p.id})">${HEART_SVG}</button>
        ${soldOut ? '<div class="product-sold">SOLD OUT</div>' : `<div class="product-quick-add" onclick="event.stopPropagation();openProductModal(${p.id})">+ ADD TO BAG</div>`}
      </div>
      <div class="product-info">
        <div class="product-brand">${BRAND}</div>
        <div class="product-name">${esc(p.name)}</div>
        <div class="product-price-row">
          <span class="product-price">${inr(p.price)}</span>
          ${off ? `<span class="product-price-old">${inr(p.oldPrice)}</span><span class="product-off">(${off}% OFF)</span>` : ''}
        </div>
      </div>
    </div>`;
}

function gradientForProduct(p) {
  return { artist:'linear-gradient(135deg,#1a1a2e,#16213e)', gaming:'linear-gradient(135deg,#0d1b2a,#1b4332)', streetwear:'linear-gradient(135deg,#1a1a1a,#2d2d2d)', movies:'linear-gradient(135deg,#1a0a2e,#2d1a4d)', minimal:'linear-gradient(135deg,#111,#1c1c1c)', fan:'linear-gradient(135deg,#0f1923,#1a3a5c)', originals:'linear-gradient(135deg,#0a2e1a,#1a4d2a)', custom:'linear-gradient(135deg,#2e1a0a,#4d3520)' }[p.category] || 'linear-gradient(135deg,#161616,#202020)';
}

/* ──────────────────────────────────────
   RENDER SECTIONS
────────────────────────────────────── */
function skeletonCards(n = 4) {
  return Array.from({ length: n }, () => '<div class="product-card skeleton-card" aria-hidden="true"><div class="product-img"></div><div class="sk-line" style="width:60%"></div><div class="sk-line" style="width:90%"></div><div class="sk-line" style="width:40%"></div></div>').join('');
}
function showCatalogLoading() {
  ['trending-grid', 'clothing-grid'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = skeletonCards(id === 'trending-grid' ? 3 : 4); });
}
function gridHTML(list, emptyMsg) {
  if (catalogError) return '<div class="grid-state">We couldn\'t load the shop right now.<br><button type="button" class="btn-primary" onclick="retryCatalog()">TRY AGAIN</button></div>';
  if (!list.length) return `<div class="grid-state">${emptyMsg}</div>`;
  return list.map(productCardHTML).join('');
}
async function retryCatalog() {
  showCatalogLoading();
  await loadProducts();
  renderAll();
}
function renderAll() { renderTrending(); renderClothing(currentClothingFilter); renderCategoryThumbs(); }

let currentClothingFilter = 'all';
function renderTrending() {
  const trending = PRODUCTS.filter(p => p.type === 'clothing' && (p.badge === 'hot' || p.badge === 'new' || p.badge === 'launch')).slice(0, 6);
  document.getElementById('trending-grid').innerHTML = gridHTML(trending, 'New drops are on the way.');
}
function renderClothing(filter = 'all') {
  currentClothingFilter = filter;
  const filtered = PRODUCTS.filter(p => p.type === 'clothing' && (filter === 'all' || p.category === filter));
  document.getElementById('clothing-grid').innerHTML = gridHTML(filtered, 'Nothing in this category yet — check back soon.');
}
/** Category circles use a real product photo when we have one. */
function renderCategoryThumbs() {
  const pick = (type) => PRODUCTS.find(p => p.type === type && p.image);
  const setThumb = (key, p) => {
    const chip = document.querySelector(`.cat-chip[data-cat="${key}"] .cat-icon`);
    if (chip && p) chip.innerHTML = imgTag(p.image, { alt: '', sizes: '64px' });
  };
  setThumb('tees', pick('clothing'));
  const teePick = pick('clothing');
  setThumb('drops', PRODUCTS.find(p => p.type === 'clothing' && p.image && p !== teePick && (p.badge === 'new' || p.badge === 'hot' || p.badge === 'launch')) || teePick);
}

/* ──────────────────────────────────────
   FILTERS
────────────────────────────────────── */
function initFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderClothing(btn.dataset.filter);
      btn.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    });
  });
}

/* ──────────────────────────────────────
   PRODUCT MODAL (with mockup display)
────────────────────────────────────── */
const CLOTHING_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
// Garment measurements in inches (half chest, length from HPS) — from the size chart
const SIZE_CHART = {
  S:   { chest: 21, length: 27.5 },
  M:   { chest: 22, length: 28.5 },
  L:   { chest: 23, length: 29.5 },
  XL:  { chest: 24, length: 30.5 },
  XXL: { chest: 25, length: 31.5 }
};
let pdpProduct = null, pdpAdded = false;

function openProductModal(id) {
  const p = PRODUCTS.find(pr => pr.id === id);
  if (!p) return;
  pdpProduct = p; pdpAdded = false;
  selectedProductSize = '';                       // shoppers must choose a size themselves (as on Myntra)
  const isTee = p.type === 'clothing';
  const off = discountPct(p);
  const wished = isWishlisted(p.id);
  const soldOut = typeof p.stock === 'number' && p.stock <= 0;

  let media;
  if (p.image) {
    media = imgTag(p.image, { alt: p.name, sizes: '(max-width:768px) 100vw, 420px', eager: true });
  } else if (isTee) {
    const designTxt = esc(p.designText || p.emoji).replace(/\n/g, '<br>');
    media = `<div class="pdp-fallback" style="background:${gradientForProduct(p)}"><div style="position:relative;width:180px;height:215px"><div style="width:100%;height:100%;background:${esc(p.teeColor || '#fff')};clip-path:polygon(20% 0%,80% 0%,100% 13%,100% 100%,0% 100%,0% 13%);display:flex;align-items:center;justify-content:center;box-shadow:0 12px 48px rgba(0,0,0,.6)"><div style="font-size:1.6rem;font-weight:800;text-align:center;color:${esc(p.designColor || '#0A0A0A')};font-family:'Space Grotesk',sans-serif;line-height:1.2">${designTxt}</div></div></div></div>`;
  } else {
    media = `<div class="pdp-fallback" style="background:${gradientForProduct(p)}">${esc(p.emoji)}</div>`;
  }

  const sizeBlock = isTee ? `
    <div class="pdp-section">
      <div class="pdp-label"><span>SELECT SIZE</span></div>
      <div class="pdp-sizes" id="pdp-sizes" role="radiogroup" aria-label="Size">
        ${CLOTHING_SIZES.map(sz => `<div class="pdp-size-col"><button type="button" class="pdp-size" role="radio" aria-checked="false" onclick="selectModalSize(this,'${sz}')">${sz}</button><div class="pdp-size-meas"><span>Chest ${SIZE_CHART[sz].chest}"</span><span>Length ${SIZE_CHART[sz].length}"</span></div></div>`).join('')}
      </div>
      <div class="pdp-size-note">Measurements in inches (half chest · length from HPS). Handcrafted product, may vary by +/- 5%.</div>
      <div class="pdp-size-error" id="pdp-size-error" role="alert">Please select a size</div>
    </div>` : '';

  document.getElementById('product-modal-content').innerHTML = `
    <div class="pdp">
      <div class="pdp-media">${media}${p.badge ? `<div class="product-badge badge-${esc(p.badge)}">${esc(badgeLabel(p.badge))}</div>` : ''}</div>
      <div class="pdp-info">
        <div class="pdp-brand">${BRAND}</div>
        <h2 class="pdp-name">${esc(p.name)}</h2>
        <div class="pdp-price-row">
          <span class="pdp-price">${inr(p.price)}</span>
          ${off ? `<span class="pdp-old">MRP ${inr(p.oldPrice)}</span><span class="pdp-off">(${off}% OFF)</span>` : ''}
        </div>
        <div class="pdp-tax">inclusive of all taxes</div>
        ${sizeBlock}
        <div class="pdp-section">
          <div class="pdp-label"><span>DELIVERY OPTIONS</span></div>
          <div class="pdp-pin">
            <input type="text" id="pdp-pin" inputmode="numeric" maxlength="6" placeholder="Enter PIN code" autocomplete="postal-code" aria-label="PIN code"
              oninput="this.value=this.value.replace(/\\D/g,'')" onkeydown="if(event.key==='Enter')checkPdpPin()">
            <button type="button" onclick="checkPdpPin()">CHECK</button>
          </div>
          <div class="pdp-pin-result" id="pdp-pin-result" aria-live="polite"></div>
          <ul class="pdp-perks">
            <li>🚚 Flat ₹50 shipping on every order</li>
            <li>💵 Cash on delivery available</li>
            <li>↩️ 7-day easy returns</li>
          </ul>
        </div>
        <div class="pdp-section">
          <div class="pdp-label"><span>PRODUCT DETAILS</span></div>
          <p class="pdp-desc">${esc(p.desc)}</p>
        </div>
        <div class="pdp-section" id="pdp-reviews" aria-live="polite">
          <div class="pdp-label"><span>RATINGS &amp; REVIEWS</span></div>
          <div class="rv-loading">Loading reviews…</div>
        </div>
        <div class="pdp-bar">
          <button type="button" class="pdp-wish ${wished ? 'wished' : ''}" data-wish-id="${p.id}" aria-pressed="${wished}" onclick="toggleWishlist(${p.id})">${HEART_SVG}<span class="wl-text">${wished ? 'WISHLISTED' : 'WISHLIST'}</span></button>
          <button type="button" class="pdp-share" aria-label="Share this product" title="Share this product" onclick="shareProduct(${p.id})">${SHARE_SVG}</button>
          <button type="button" class="pdp-add" id="pdp-add" ${soldOut ? 'disabled' : ''} onclick="pdpAddToBag()">${soldOut ? 'SOLD OUT' : '🛍 ADD TO BAG'}</button>
        </div>
      </div>
    </div>`;

  setProductUrl(p.id);
  const modal = document.getElementById('product-modal');
  modal.classList.add('open');
  modal.querySelector('.modal-box').scrollTop = 0;
  loadPdpReviews(p.id);
}

function pdpAddToBag() {
  const p = pdpProduct; if (!p) return;
  if (pdpAdded) { closeProductModal(); openCartPanel(); return; }       // button became "GO TO BAG"
  if (p.type === 'clothing' && !selectedProductSize) {
    const group = document.getElementById('pdp-sizes');
    document.getElementById('pdp-size-error').style.display = 'block';
    group.classList.remove('shake'); void group.offsetWidth; group.classList.add('shake');
    group.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  addToCart(p.id, p.type === 'clothing' ? selectedProductSize : 'NA');
  pdpAdded = true;
  const btn = document.getElementById('pdp-add');
  if (btn) btn.textContent = '➜ GO TO BAG';
  if (!isMobile()) closeProductModal();                                  // desktop: addToCart already opened the bag drawer
}

async function checkPdpPin() {
  const pin = document.getElementById('pdp-pin').value.trim();
  const out = document.getElementById('pdp-pin-result');
  if (!/^[1-9][0-9]{5}$/.test(pin)) { out.style.color = 'var(--red)'; out.textContent = 'Enter a valid 6-digit PIN code'; return; }
  out.style.color = 'var(--text-dim)'; out.textContent = 'Checking…';
  try {
    const [est, place] = await Promise.all([
      Api.checkPincode(pin, pdpProduct ? pdpProduct.price : 0, 0.3),
      Api.lookupPincode(pin).catch(() => null),
    ]);
    if (!est.serviceable) { out.style.color = 'var(--red)'; out.textContent = est.reason || 'Sorry, we can\'t deliver to this PIN code yet.'; return; }
    const where = place && place.found ? `${place.city} ${pin}` : pin;
    out.style.color = 'var(--success)';
    out.textContent = `✓ Delivery to ${where} in ${est.etaLabel}${est.codAvailable ? ' · Cash on delivery available' : ''}`;
  } catch (e) {
    out.style.color = 'var(--red)'; out.textContent = 'Could not check right now. Please try again.';
  }
}

function closeProductModal() {
  document.getElementById('product-modal').classList.remove('open');
  setProductUrl(null);
}

/* ── Shareable product links: yoursite.com/?product=ID ── */
const SHARE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>';

function productShareUrl(id) {
  return location.origin + location.pathname + '?product=' + encodeURIComponent(id);
}
// Keep the address bar pointing at the open product (and clean it up when the modal closes).
function setProductUrl(id) {
  try {
    const params = new URLSearchParams(location.search);
    if (id == null) params.delete('product'); else params.set('product', id);
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  } catch (e) { /* non-critical */ }
}
async function shareProduct(id) {
  const p = PRODUCTS.find(pr => pr.id === id);
  if (!p) return;
  const url = productShareUrl(id);
  const data = { title: p.name, text: `${p.name} — ${inr(p.price)} | LALLEWOOLS`, url };
  if (navigator.share) {
    try { await navigator.share(data); return; }
    catch (e) { if (e && e.name === 'AbortError') return; /* otherwise fall through to copy */ }
  }
  try {
    await navigator.clipboard.writeText(url);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (_) { window.prompt('Copy this link:', url); }
    ta.remove();
  }
  showToast('Product link copied');
}
// Open the product named in the link (?product=ID) once the catalogue has loaded.
function openProductFromUrl() {
  const raw = new URLSearchParams(location.search).get('product');
  if (raw == null) return;
  const id = Number(raw);
  if (Number.isFinite(id) && PRODUCTS.some(pr => pr.id === id)) openProductModal(id);
  else { setProductUrl(null); showToast('That product is no longer available'); }
}
function selectModalSize(btn, size) {
  selectedProductSize = size;
  pdpAdded = false;
  const add = document.getElementById('pdp-add'); if (add && !add.disabled) add.textContent = '🛍 ADD TO BAG';
  document.querySelectorAll('.pdp-size').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-checked', 'false'); });
  btn.classList.add('active'); btn.setAttribute('aria-checked', 'true');
  const err = document.getElementById('pdp-size-error'); if (err) err.style.display = 'none';
}

/* ──────────────────────────────────────
   EMAIL VERIFICATION
────────────────────────────────────── */
function showVerifyEmailModal(addr) {
  document.getElementById('verify-email-text').textContent = addr
    ? `Before you can place an order, please confirm ${addr}. We've sent you a link — open it, then come back here.`
    : "Before you can place an order, please confirm your email. We've sent you a link — open it, then come back here.";
  const msg = document.getElementById('verify-email-msg'); msg.textContent = '';
  document.getElementById('verify-email-modal').classList.add('open');
}
function closeVerifyEmailModal() { document.getElementById('verify-email-modal').classList.remove('open'); }

async function resendVerificationEmail(evt) {
  const msg = document.getElementById('verify-email-msg') && document.getElementById('verify-email-modal').classList.contains('open')
    ? document.getElementById('verify-email-msg') : null;
  const say = (text, bad) => { if (msg) { msg.style.color = bad ? 'var(--red,#ff5c5c)' : 'var(--lime,#C8FF00)'; msg.textContent = text; } else showToast(text); };
  try {
    const r = await Api.resendVerification();
    say(r.alreadyVerified ? 'Your email is already confirmed.' : '📧 Sent! Check your inbox (and spam folder).', false);
    if (r.alreadyVerified) renderVerifyBanner({ emailVerified: true });
  } catch (err) { say(err.message, true); }
}

async function verifyEmailContinue() {
  const msg = document.getElementById('verify-email-msg');
  try {
    const { user } = await Api.me();
    if (user.emailVerified) { closeVerifyEmailModal(); openCheckout(); return; }
    msg.style.color = 'var(--red,#ff5c5c)';
    msg.textContent = "We can't see the confirmation yet. Open the link in the email, then tap this again.";
  } catch (err) { msg.style.color = 'var(--red,#ff5c5c)'; msg.textContent = err.message; }
}

/** Profile overview: a gentle reminder while the address is unconfirmed. */
function renderVerifyBanner(user) {
  const el = document.getElementById('pf-verify-banner');
  if (!el) return;
  el.innerHTML = user && user.email && user.emailVerified === false
    ? `<div style="background:var(--surface2,#1a1a1a);border:1px solid var(--border,#333);border-radius:10px;padding:.75rem 1rem;font-size:.85rem;margin:1rem 0">
         ✉️ Please confirm <b>${escHtml(user.email)}</b> — we emailed you a link.
         <a href="#" onclick="resendVerificationEmail();return false" style="color:var(--lime,#C8FF00);margin-left:.4rem">Resend email</a>
       </div>`
    : '';
}

/** The emailed link sends people back to /?email_verified=1 (or 0 if it was invalid/expired). */
function handleEmailVerifiedLanding() {
  const flag = new URLSearchParams(location.search).get('email_verified');
  if (flag === null) return;
  history.replaceState(null, '', location.pathname + location.hash);
  if (flag === '1') showToast('✅ Email confirmed — thank you!');
  else showToast('⚠ That confirmation link is invalid or has expired. Log in and tap "Resend email".');
}

/* ──────────────────────────────────────
   TRACK ORDER (logged in, or order ID + phone number)
────────────────────────────────────── */
function openTrackOrderModal(e) {
  if (e) e.preventDefault();
  document.getElementById('track-order-modal').classList.add('open');
  document.getElementById('track-order-error').textContent = '';
  document.getElementById('track-order-result').innerHTML = '';
}
function closeTrackOrderModal() {
  document.getElementById('track-order-modal').classList.remove('open');
}

async function submitTrackOrder() {
  const errEl = document.getElementById('track-order-error');
  const resultEl = document.getElementById('track-order-result');
  errEl.textContent = ''; resultEl.innerHTML = '';
  const orderId = document.getElementById('track-order-id').value.trim().toUpperCase();
  if (!orderId) { errEl.textContent = 'Please enter your Order ID'; return; }
  const phone = (document.getElementById('track-order-phone')?.value || '').replace(/\D/g, '').slice(-10);
  if (!getCustomerToken() && phone.length !== 10) { errEl.textContent = 'Please enter the 10-digit phone number used on the order'; return; }
  try {
    await Api.getOrder(orderId, phone); // just confirm it exists (and is yours) before switching modals
    closeTrackOrderModal();
    openOrderDetailModal(orderId, phone); // reuse the same rich Amazon/Myntra-style detail view
  } catch (err) {
    errEl.textContent = err.message || 'Order not found. Please check your Order ID.';
  }
}

/* ──────────────────────────────────────
   ACCOUNT (login / signup / order history)
────────────────────────────────────── */
let accountMode = 'login'; // email form: 'login' | 'signup'
let pendingCheckoutAfterLogin = false; // set by openCheckout() when it redirects a guest to log in first

let googleReady = false;   // Google script loaded + initialised

function openAccountModal() {
  if (getCustomerToken()) {
    closeMobileMenuSafe();
    openProfilePage();
    return;
  }
  document.getElementById('account-modal').classList.add('open');
  accountMode = 'login';
  renderAccountFormMode();
  document.getElementById('account-guest-view').style.display = '';
  setupLoginOptions();
}
function closeMobileMenuSafe() { if (typeof closeMobileMenu === 'function') closeMobileMenu(); }
function closeAccountModal() {
  document.getElementById('account-modal').classList.remove('open');
  document.getElementById('account-error').textContent = '';
  pendingCheckoutAfterLogin = false;
}

/** Fetches what the server offers (Google client id) and shows/hides the options. */
async function setupLoginOptions() {
  try { storeConfig = { ...storeConfig, ...(await Api.getConfig()) }; } catch (e) { /* keep last known */ }
  if (storeConfig.googleClientId) initGoogleLogin(storeConfig.googleClientId);
}

/* ── Google ── */
function initGoogleLogin(clientId) {
  const wrap = document.getElementById('google-login-wrap');
  const render = () => {
    try {
      if (!googleReady) {
        google.accounts.id.initialize({ client_id: clientId, callback: onGoogleCredential, ux_mode: 'popup' });
        googleReady = true;
      }
      const slot = document.getElementById('google-btn-slot');
      slot.innerHTML = '';
      const width = Math.min(320, Math.max(220, slot.parentElement.clientWidth || 300));
      google.accounts.id.renderButton(slot, { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill', width });
      wrap.style.display = '';
    } catch (err) {
      wrap.style.display = 'none'; // Google blocked/unavailable — email login still works
    }
  };
  if (window.google && google.accounts && google.accounts.id) return render();
  if (document.getElementById('gsi-script')) { document.getElementById('gsi-script').addEventListener('load', render); return; }
  const tag = document.createElement('script');
  tag.id = 'gsi-script';
  tag.src = 'https://accounts.google.com/gsi/client';
  tag.async = true;
  tag.onload = render;
  tag.onerror = () => { wrap.style.display = 'none'; };
  document.head.appendChild(tag);
}

async function onGoogleCredential(response) {
  const errEl = document.getElementById('account-error');
  errEl.textContent = '';
  try {
    const result = await Api.googleLogin(response.credential);
    completeLogin(result);
  } catch (err) {
    errEl.textContent = err.message;
  }
}

/* ── Shared: runs after ANY successful login (Google or email) ── */
function completeLogin(result) {
  localStorage.setItem('lallewools_customer_token', result.token);
  const first = (result.user.name || '').trim().split(' ')[0];
  showToast(first ? `👋 Welcome, ${first}!` : '👋 Welcome to LALLEWOOLS!');
  if (result.verificationEmailSent) setTimeout(() => showToast(`📧 We emailed a confirmation link to ${result.user.email}`), 3000);
  if (pendingCheckoutAfterLogin) {
    pendingCheckoutAfterLogin = false;
    closeAccountModal();
    openCheckout();
  } else {
    closeAccountModal();
    // Google sign-ups can arrive without a name — take them straight to Profile Details to add one.
    openProfilePage(result.isNewUser && !first ? 'details' : 'overview');
  }
}

function toggleAccountMode(e) {
  e.preventDefault();
  accountMode = accountMode === 'login' ? 'signup' : 'login';
  renderAccountFormMode();
}

function renderAccountFormMode() {
  const isSignup = accountMode === 'signup';
  document.getElementById('account-form-title').textContent = isSignup ? 'Create Account' : 'Log In';
  document.getElementById('acc-name').style.display = isSignup ? '' : 'none';
  document.getElementById('acc-phone').style.display = isSignup ? '' : 'none';
  document.getElementById('account-submit-btn').textContent = isSignup ? 'CREATE ACCOUNT' : 'LOG IN';
  document.getElementById('account-toggle-text').innerHTML = isSignup
    ? `Already have an account? <a href="#" onclick="toggleAccountMode(event)" style="color:var(--lime,#C8FF00)">Log in</a>`
    : `New here? <a href="#" onclick="toggleAccountMode(event)" style="color:var(--lime,#C8FF00)">Create an account</a>`;
  document.getElementById('account-error').textContent = '';
}

async function submitAccountForm() {
  const errEl = document.getElementById('account-error');
  errEl.textContent = '';
  const email = document.getElementById('acc-email').value.trim();
  const password = document.getElementById('acc-password').value;
  try {
    let result;
    if (accountMode === 'signup') {
      const name = document.getElementById('acc-name').value.trim();
      const phone = document.getElementById('acc-phone').value.trim();
      if (!name || !email || !password) throw new Error('Please fill in all required fields');
      result = await Api.signup({ name, email, password, phone });
    } else {
      if (!email || !password) throw new Error('Please enter your email and password');
      result = await Api.login({ email, password });
    }
    completeLogin(result);
  } catch (err) {
    errEl.textContent = err.message;
  }
}

function accountLogout() {
  localStorage.removeItem('lallewools_customer_token');
  if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
  closeAccountModal();
  pfOrders = []; pfUser = null; pfSection = 'overview';
  closeProfilePage();
  showToast('Logged out');
}

/* ──────────────────────────────────────
   PROFILE PAGE (Myntra-style)
   Desktop: sidebar + panel. Phones: menu list → full-screen section with a back arrow.
────────────────────────────────────── */
let pfSection = 'overview';
let pfOrders = [];
let pfOrderFilter = 'all';
let pfUser = null;
const PF_TITLES = { overview: 'My Account', orders: 'Orders', details: 'Profile Details', addresses: 'Addresses', security: 'Password' };

const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';

function openProfilePage(section) {
  const page = document.getElementById('profile-page');
  page.classList.add('open');
  document.body.classList.add('no-scroll');
  page.scrollTop = 0;
  pfShow(section || 'overview');
  loadProfileOrders();
  loadProfileForm();
}
function closeProfilePage() {
  document.getElementById('profile-page').classList.remove('open');
  syncScrollLock();
}
function pfBack() {
  if (pfSection !== 'overview') pfShow('overview'); else closeProfilePage();
}
function pfShow(name) {
  pfSection = name;
  const page = document.getElementById('profile-page');
  page.dataset.sec = name;
  ['overview', 'orders', 'details', 'addresses', 'security'].forEach(id => {
    document.getElementById('pf-sec-' + id).hidden = id !== name;
  });
  document.querySelectorAll('.pf-nav button').forEach(b => b.classList.toggle('active', b.dataset.pf === name));
  document.getElementById('pf-topbar-title').textContent = PF_TITLES[name] || 'My Account';
  page.scrollTop = 0;
}

/** Same entry point as before: refreshes the order list (also called after a cancel). */
function showLoggedInAccountView() { openProfilePage(pfSection); }

async function loadProfileOrders() {
  const listEl = document.getElementById('account-orders-list');
  if (!pfOrders.length) listEl.innerHTML = '<p class="pf-muted">Loading…</p>';
  try {
    pfOrders = await Api.myOrders();
    renderProfileOrders();
    renderProfileOverview();
    renderProfileAddresses();
  } catch (err) {
    accountLogout();
    openAccountModal();
  }
}

/* What the customer is told about an order. "Shipped" only ever appears once the courier has
   really picked the parcel up (the server flips status to 'shipped' on Shiprocket's pickup scan);
   a placed/confirmed/booked order is shown as "Order confirmed". */
function orderStatusInfo(o) {
  const eta = o.shipment && o.shipment.estimatedDeliveryDate ? shortDate(o.shipment.estimatedDeliveryDate) : '';
  switch (o.status) {
    case 'delivered':
      return { text: `Delivered${o.shipment && o.shipment.deliveredAt ? ' on ' + shortDate(o.shipment.deliveredAt) : ''}`, sub: 'Your order has been delivered', tone: 'ok', group: 'delivered' };
    case 'cancelled':
      return { text: 'Cancelled', sub: o.payment && o.payment.status === 'refunded' ? 'Refund processed' : '', tone: 'bad', group: 'cancelled' };
    case 'shipped':
      return { text: 'Shipped', sub: eta ? `Arriving by ${eta}` : 'On its way to you', tone: 'info', group: 'active' };
    case 'pending':
      return { text: 'Awaiting payment', sub: 'Complete payment to confirm your order', tone: 'warn', group: 'active' };
    default: // confirmed (and the legacy shipped_pending_pickup)
      return { text: 'Order confirmed', sub: eta ? `Expected delivery by ${eta}` : 'We are packing your order', tone: 'info', group: 'active' };
  }
}

function pfFilter(f) {
  pfOrderFilter = f;
  document.querySelectorAll('#pf-chips .pf-chip').forEach(c => c.classList.toggle('active', c.dataset.f === f));
  renderProfileOrders();
}

function renderProfileOrders() {
  const listEl = document.getElementById('account-orders-list');
  const q = (document.getElementById('pf-order-search').value || '').trim().toLowerCase();
  const rows = pfOrders.filter(o => {
    if (pfOrderFilter !== 'all' && orderStatusInfo(o).group !== pfOrderFilter) return false;
    if (!q) return true;
    return o.id.toLowerCase().includes(q) || o.items.some(i => String(i.name).toLowerCase().includes(q));
  });
  if (!pfOrders.length) {
    listEl.innerHTML = '<div class="pf-empty"><b>No orders yet</b>When you place an order it will show up here, with live delivery tracking.</div>';
    return;
  }
  if (!rows.length) {
    listEl.innerHTML = '<div class="pf-empty"><b>No matching orders</b>Try a different search or filter.</div>';
    return;
  }
  listEl.innerHTML = rows.map(renderAccountOrderCard).join('');
}

/** An online order that has been started but not paid for yet: not confirmed, not shipping, not invoiced. */
function isAwaitingPayment(o) {
  return o.status === 'pending' && o.payment && o.payment.method !== 'cod' && o.payment.status !== 'paid';
}

function renderAccountOrderCard(o) {
  const st = orderStatusInfo(o);
  const items = o.items.map(i => `
    <div class="pf-item" onclick="openOrderDetailModal('${escHtml(o.id)}')">
      <div class="pf-item-img">${i.image ? `<img src="${escHtml(i.image)}" alt="" loading="lazy" onerror="this.remove()">` : escHtml(i.emoji || '')}</div>
      <div class="pf-item-info">
        <div class="pf-item-name">${escHtml(i.name)}</div>
        <div class="pf-item-meta">${i.size && i.size !== 'NA' ? `Size: ${escHtml(i.size)} · ` : ''}Qty: ${Number(i.qty) || 1}</div>
        <div class="pf-status ${st.tone}"><span class="pf-dot"></span><span>${escHtml(st.text)}</span></div>
        ${st.sub ? `<div class="pf-status-sub">${escHtml(st.sub)}</div>` : ''}
      </div>
      <span class="pf-chev">›</span>
    </div>`).join('');
  return `
    <div class="pf-order">
      <div class="pf-order-head">
        <span>Order <b>${escHtml(o.id)}</b> · ${escHtml(fmtDate(o.createdAt))}</span>
        <span>Total <b>₹${Number(o.amounts.total).toLocaleString('en-IN')}</b></span>
      </div>
      ${items}
    </div>`;
}

function renderProfileOverview() {
  const active = pfOrders.filter(o => orderStatusInfo(o).group === 'active').length;
  document.getElementById('pf-tile-orders').textContent = pfOrders.length
    ? `${pfOrders.length} order${pfOrders.length > 1 ? 's' : ''}${active ? ` · ${active} on the way` : ''}`
    : 'Check order status & tracking';
  const addrCount = pfAddressList().length;
  document.getElementById('pf-tile-addr').textContent = addrCount ? `${addrCount} saved` : "Places you've ordered to";
  const recent = pfOrders[0];
  document.getElementById('pf-recent').innerHTML = recent
    ? `<h3>Latest order</h3>${renderAccountOrderCard(recent)}` : '';
}

function pfAddressList() {
  const seen = new Map();
  pfOrders.forEach(o => {
    const a = o.address || {};
    const key = [a.line1, a.pincode].map(x => String(x || '').trim().toLowerCase()).join('|');
    if (!a.line1 || seen.has(key)) { if (seen.has(key)) seen.get(key).count++; return; }
    seen.set(key, { ...a, count: 1 });
  });
  return [...seen.values()];
}

function renderProfileAddresses() {
  const el = document.getElementById('pf-addresses');
  const list = pfAddressList();
  el.innerHTML = list.length ? list.map(a => `
    <div class="pf-addr">
      <b>${escHtml(a.name)}</b>
      ${escHtml(a.line1)}${a.line2 ? ', ' + escHtml(a.line2) : ''}<br>
      ${escHtml(a.city)}, ${escHtml(a.state)} - ${escHtml(a.pincode)}<br>
      Mobile: ${escHtml(a.phone)}<br>
      <span class="pf-addr-tag">Used on ${a.count} order${a.count > 1 ? 's' : ''}</span>
    </div>`).join('')
    : '<div class="pf-empty"><b>No saved addresses</b>Your delivery addresses will appear here after your first order.</div>';
}

async function loadProfileForm() {
  try {
    const { user } = await Api.me();
    pfUser = user;
    renderVerifyBanner(user);
    document.getElementById('prof-name').value = user.name || '';
    document.getElementById('prof-email').value = user.email || '';
    document.getElementById('prof-phone').value = user.phone || '';
    // Google accounts start without a password; let them add one instead of "changing" a non-existent one.
    document.getElementById('password-heading').textContent = user.hasPassword ? 'Change Password' : 'Set a Password (optional)';
    document.getElementById('prof-current-password').parentElement.style.display = user.hasPassword ? '' : 'none';
    document.getElementById('prof-password-section').style.display = (user.hasPassword || user.email) ? '' : 'none';
    const name = (user.name || '').trim();
    const sub = [user.email, user.phone].filter(Boolean).join(' · ');
    document.getElementById('pf-avatar').textContent = (name || user.email || 'L').charAt(0);
    document.getElementById('pf-hello-name').textContent = name || 'Welcome';
    document.getElementById('pf-hello-sub').textContent = sub;
    document.getElementById('pf-side-sub').textContent = name || user.email || '';
  } catch (err) { /* ignore — form just stays blank */ }
}

async function saveProfile() {
  const errEl = document.getElementById('profile-error');
  errEl.textContent = '';
  const name = document.getElementById('prof-name').value.trim();
  const phoneEl = document.getElementById('prof-phone');
  const payload = { name };
  if (!phoneEl.disabled) payload.phone = phoneEl.value.trim();
  try {
    await Api.updateProfile(payload);
    showToast('✓ Profile updated');
    loadProfileForm();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function savePassword() {
  const errEl = document.getElementById('password-error');
  errEl.textContent = '';
  const currentEl = document.getElementById('prof-current-password');
  const currentPassword = currentEl.value;
  const newPassword = document.getElementById('prof-new-password').value;
  const needsCurrent = currentEl.parentElement.style.display !== 'none';
  if ((needsCurrent && !currentPassword) || !newPassword) { errEl.textContent = needsCurrent ? 'Please fill in both fields' : 'Please enter a new password'; return; }
  try {
    await Api.changePassword({ currentPassword, newPassword });
    currentEl.value = '';
    document.getElementById('prof-new-password').value = '';
    loadProfileForm(); // a Google/phone account now has a password, so the form switches to "Change Password"
    showToast('✓ Password updated');
  } catch (err) {
    errEl.textContent = err.message;
  }
}

/* ──────────────────────────────────────
   ORDER DETAIL (Amazon/Myntra-style timeline view)
   Shared by "My Orders" click-through and guest Track Order.
────────────────────────────────────── */
const ORDER_TIMELINE_STEPS = ['placed', 'confirmed', 'shipped', 'delivered'];

function timelineStepIndex(order) {
  if (order.status === 'delivered') return 3;
  if (order.status === 'shipped') return 2; // only after the courier has really picked it up
  if (['confirmed', 'cod_confirmed'].includes(order.status) || order.payment.status === 'paid' || order.payment.status === 'cod_confirmed') return 1;
  return 0;
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function buildOrderDetailHTML(order, tracking) {
  if (order.status === 'cancelled') {
    return buildCancelledOrderHTML(order);
  }

  let stepIdx = timelineStepIndex(order);
  if (tracking && tracking.delivered) stepIdx = 3;
  else if (tracking && tracking.live && stepIdx < 2 && ['picked_up', 'in_transit', 'out_for_delivery'].includes(tracking.stage)) stepIdx = 2;
  const stepDates = [
    fmtDate(order.createdAt),
    fmtDate(order.payment.confirmedAt || order.payment.paidAt || order.createdAt),
    fmtDate(order.shipment?.shippedAt),
    fmtDate(order.shipment?.deliveredAt || (tracking && tracking.delivered && tracking.checkpoints.length ? tracking.checkpoints[tracking.checkpoints.length - 1].at : '')),
  ];
  const stepLabels = ['Order Placed', 'Confirmed', 'Shipped', 'Delivered'];

  const awaitingPayment = isAwaitingPayment(order);
  const timelineHTML = awaitingPayment ? `
    <div style="background:rgba(255,154,92,.1);border:1px solid var(--discount,#ff9a5c);border-radius:10px;padding:.75rem 1rem;font-size:.9rem;margin:1rem 0">
      ⏳ <b>Payment not completed.</b> This order is not confirmed yet. It is confirmed automatically the moment your payment is received — if you were charged, this page updates within a few minutes. Unpaid orders are released after 30 minutes.
    </div>` : `
    <div style="display:flex;align-items:flex-start;margin:1.25rem 0">
      ${stepLabels.map((label, i) => `
        <div style="flex:1;text-align:center;position:relative">
          ${i > 0 ? `<div style="position:absolute;top:11px;left:-50%;width:100%;height:2px;background:${i <= stepIdx ? 'var(--lime,#C8FF00)' : 'var(--border,#333)'};z-index:0"></div>` : ''}
          <div style="width:24px;height:24px;border-radius:50%;margin:0 auto;position:relative;z-index:1;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;
            background:${i <= stepIdx ? 'var(--lime,#C8FF00)' : 'var(--surface2,#1a1a1a)'};color:${i <= stepIdx ? '#0A0A0A' : 'var(--text-dim)'};border:2px solid ${i <= stepIdx ? 'var(--lime,#C8FF00)' : 'var(--border,#333)'}">
            ${i <= stepIdx ? '✓' : i + 1}
          </div>
          <div style="font-size:.7rem;margin-top:.4rem;color:${i <= stepIdx ? 'inherit' : 'var(--text-dim)'}">${label}</div>
          <div style="font-size:.65rem;color:var(--text-dim)">${i <= stepIdx ? stepDates[i] : ''}</div>
        </div>
      `).join('')}
    </div>
  `;

  const deliveryBanner = awaitingPayment ? '' : order.status === 'delivered'
    ? `<div style="background:rgba(200,255,0,.1);border:1px solid var(--lime,#C8FF00);border-radius:10px;padding:.75rem 1rem;font-size:.9rem;margin-bottom:.5rem">📦 Delivered on ${fmtDate(order.shipment?.deliveredAt)}</div>`
    : order.shipment?.estimatedDeliveryDate
      ? `<div style="background:var(--surface2,#1a1a1a);border-radius:10px;padding:.75rem 1rem;font-size:.9rem;margin-bottom:.5rem">🚚 Arriving by <strong>${fmtDate(order.shipment.estimatedDeliveryDate)}</strong>${order.shipment.etaLabel ? ` (${esc(order.shipment.etaLabel)})` : ''}</div>`
      : '';

  const shipment = order.shipment || {};
  const awb = shipment.awbCode;
  const courier = (tracking && tracking.courierName) || shipment.courierName;
  const trackUrl = tracking && tracking.trackingUrl && /^https?:\/\//i.test(tracking.trackingUrl) ? tracking.trackingUrl : null;

  const handedToCourier = ['shipped', 'delivered'].includes(order.status);
  const shipmentHTML = awb && handedToCourier ? `
    <div style="background:var(--surface2,#1a1a1a);border-radius:10px;padding:.75rem 1rem;margin:.5rem 0">
      ${tracking && tracking.stageLabel ? `<div style="font-weight:700;margin-bottom:.35rem">${esc(tracking.stageLabel)}</div>` : ''}
      <div style="font-size:.85rem"><b>Tracking ID (AWB):</b> ${esc(awb)}${courier ? ` · ${esc(courier)}` : ''}</div>
      ${trackUrl ? `<a href="${esc(trackUrl)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:.4rem;font-size:.8rem;color:var(--lime,#C8FF00)">Track on courier site ↗</a>` : ''}
    </div>` : (['confirmed', 'shipped_pending_pickup'].includes(order.status) ? `<div style="font-size:.85rem;color:var(--text-dim);margin:.5rem 0">📦 Your order is confirmed and being packed. Tracking details appear here as soon as the courier picks it up.</div>` : '');

  const checkpoints = tracking && Array.isArray(tracking.checkpoints) ? tracking.checkpoints : [];
  const checkpointsHTML = checkpoints.length
    ? `<h4 style="margin:.75rem 0 .25rem">Shipment activity</h4>
       <div style="margin:.25rem 0 .75rem">
        ${checkpoints.slice().reverse().map((c, i) => `
          <div style="display:flex;gap:.6rem;padding:.4rem 0;border-bottom:1px solid var(--border,#333)">
            <div style="width:8px;height:8px;border-radius:50%;margin-top:.35rem;flex-shrink:0;background:${i === 0 ? 'var(--lime,#C8FF00)' : 'var(--border,#555)'}"></div>
            <div style="flex:1;font-size:.8rem">
              <div style="${i === 0 ? 'font-weight:600' : ''}">${esc(c.status)}</div>
              ${c.detail ? `<div style="color:var(--text-dim)">${esc(c.detail)}</div>` : ''}
              ${c.location ? `<div style="color:var(--text-dim)">${esc(c.location)}</div>` : ''}
            </div>
            <div style="font-size:.72rem;color:var(--text-dim);white-space:nowrap">${esc(fmtDateTime(c.at))}</div>
          </div>`).join('')}
       </div>
       ${tracking.live === false ? '<div style="font-size:.72rem;color:var(--text-dim)">Live courier scans aren\'t available for this shipment — use the AWB above on the courier\'s website for detailed updates.</div>' : ''}`
    : '';

  const itemsHTML = order.items.map(i => `
    <div style="display:flex;gap:.75rem;align-items:center;padding:.5rem 0;border-bottom:1px solid var(--border,#333)">
      <div style="width:48px;height:48px;border-radius:8px;overflow:hidden;background:var(--surface2,#1a1a1a);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:1.3rem">
        ${i.image ? `<img src="${esc(i.image)}" style="width:100%;height:100%;object-fit:cover" onerror="this.remove()">` : esc(i.emoji || '')}
      </div>
      <div style="flex:1;font-size:.85rem">
        <div>${esc(i.name)}${i.size !== 'NA' ? ` · ${esc(i.size)}` : ''}</div>
        <div style="color:var(--text-dim)">Qty ${Number(i.qty) || 0} × ₹${i.price.toLocaleString('en-IN')}</div>
      </div>
      <div style="font-size:.85rem;font-weight:600">₹${(i.price * i.qty).toLocaleString('en-IN')}</div>
    </div>
  `).join('');

  const canCancel = ['pending', 'confirmed'].includes(order.status);

  return `
    <div class="od-head">
      <h3>${esc(order.id)}</h3>
      <span>Placed ${fmtDate(order.createdAt)}</span>
    </div>
    ${deliveryBanner}
    ${timelineHTML}
    ${shipmentHTML}
    ${checkpointsHTML}
    <h4 style="margin-bottom:.25rem">Items</h4>
    ${itemsHTML}
    <div style="display:flex;justify-content:space-between;font-size:.85rem;padding:.5rem 0">
      <span class="muted" style="color:var(--text-dim)">Subtotal</span><span>₹${order.amounts.subtotal.toLocaleString('en-IN')}</span>
    </div>
    ${order.amounts.shippingFee ? `<div style="display:flex;justify-content:space-between;font-size:.85rem"><span style="color:var(--text-dim)">Shipping</span><span>₹${order.amounts.shippingFee}</span></div>` : ''}
    ${order.amounts.codFee ? `<div style="display:flex;justify-content:space-between;font-size:.85rem"><span style="color:var(--text-dim)">COD Fee</span><span>₹${order.amounts.codFee}</span></div>` : ''}
    <div style="display:flex;justify-content:space-between;font-weight:700;padding:.35rem 0;border-top:1px solid var(--border,#333);margin-top:.35rem">
      <span>Total</span><span>₹${order.amounts.total.toLocaleString('en-IN')}</span>
    </div>
    <div style="font-size:.85rem;margin-top:.5rem"><b>Payment:</b> ${order.payment.method.toUpperCase()} · ${order.payment.status.replace(/_/g, ' ')}</div>

    <h4 style="margin-top:1rem;margin-bottom:.25rem">Shipping Address</h4>
    <div style="font-size:.85rem;color:var(--text-dim)">
      ${esc(order.address.name)}<br>${esc(order.address.line1)}${order.address.line2 ? ', ' + esc(order.address.line2) : ''}<br>
      ${esc(order.address.city)}, ${esc(order.address.state)} - ${esc(order.address.pincode)}<br>${esc(order.address.phone)}
    </div>

    <div style="display:flex;gap:.75rem;margin-top:1.25rem">
      ${awaitingPayment ? '' : `<button type="button" class="btn-ghost" style="flex:1;text-align:center" onclick="openInvoice('${esc(order.id)}')">VIEW INVOICE</button>`}
      ${canCancel ? `<button class="btn-primary" style="flex:1;background:var(--red,#ff5c5c)" onclick="cancelOrderFromDetail('${order.id}')">CANCEL ORDER</button>` : ''}
    </div>
  `;
}

function buildCancelledOrderHTML(order) {
  const itemsHTML = order.items.map(i => `${esc(i.name)} × ${Number(i.qty) || 0}`).join(', ');
  const refundLine = order.payment.status === 'refunded'
    ? `<div style="font-size:.85rem;margin-top:.5rem">💸 Refund of ₹${order.amounts.total.toLocaleString('en-IN')} has been processed.</div>`
    : '';
  return `
    <div class="od-head">
      <h3>${esc(order.id)}</h3>
      <span>Placed ${fmtDate(order.createdAt)}</span>
    </div>
    <div style="background:rgba(255,92,92,.1);border:1px solid var(--red,#ff5c5c);border-radius:10px;padding:.75rem 1rem;font-size:.9rem;margin:1rem 0">
      ❌ This order was cancelled.${refundLine}
    </div>
    <div style="font-size:.85rem;color:var(--text-dim);margin-bottom:.75rem">${itemsHTML}</div>
    <div style="display:flex;justify-content:space-between;font-weight:700;padding:.35rem 0;border-top:1px solid var(--border,#333)">
      <span>Total</span><span>₹${order.amounts.total.toLocaleString('en-IN')}</span>
    </div>
    ${(order.payment.method === 'cod' || order.payment.paidAt || order.payment.gatewayPaymentId) ? `<button type="button" class="btn-ghost" style="display:block;width:100%;text-align:center;margin-top:1rem" onclick="openInvoice('${esc(order.id)}')">VIEW INVOICE</button>` : ''}
  `;
}

let detailGuestPhone = ''; // phone a logged-out visitor typed to prove the order is theirs

/** Invoices are protected; ask the server for a short-lived link, then open it. */
async function openInvoice(orderId) {
  const w = window.open('', '_blank');
  try {
    const { url } = await Api.invoiceLink(orderId, detailGuestPhone);
    if (w) w.location = url; else window.location = url;
  } catch (err) { if (w) w.close(); alert(err.message || 'Could not open the invoice'); }
}

async function openOrderDetailModal(orderId, guestPhone) {
  detailGuestPhone = guestPhone || '';
  document.getElementById('order-detail-modal').classList.add('open');
  const bodyEl = document.getElementById('order-detail-body');
  bodyEl.innerHTML = '<p style="color:var(--text-dim)">Loading…</p>';
  try {
    let order = await Api.getOrder(orderId, detailGuestPhone);
    let tracking = null;
    if (order.shipment && order.shipment.awbCode && order.status !== 'cancelled') {
      // The server pulls live status from Shiprocket and updates the order while doing this,
      // so re-read the order afterwards to show the freshest state (e.g. confirmed → shipped).
      try { tracking = await Api.trackOrder(orderId, detailGuestPhone); order = await Api.getOrder(orderId, detailGuestPhone); } catch (e) { /* tracking is optional */ }
    }
    bodyEl.innerHTML = buildOrderDetailHTML(order, tracking);
  } catch (err) {
    bodyEl.innerHTML = `<p style="color:var(--red,#ff5c5c)">${escHtml(err.message)}</p>`;
  }
}

function trackJustPlacedOrder() {
  const id = lastPlacedOrderId;
  closeCheckout();
  if (id) openOrderDetailModal(id);
}

function closeOrderDetailModal() {
  document.getElementById('order-detail-modal').classList.remove('open');
  // Opening an order refreshes tracking on the server, so re-pull the list to show the latest status.
  if (document.getElementById('profile-page').classList.contains('open')) loadProfileOrders();
  syncScrollLock();
}

async function cancelOrderFromDetail(orderId) {
  if (!confirm('Cancel this order? If already paid, a refund will be issued.')) return;
  try {
    if (getCustomerToken()) {
      await Api.cancelOrder(orderId);
    } else {
      // Guest tracking a guest order (no login) — confirm identity via the phone number on the order.
      const phone = prompt('Enter the phone number used on this order, to confirm it\'s yours:');
      if (!phone) return;
      await Api.cancelOrder(orderId, phone.trim());
    }
    showToast('Order cancelled');
    openOrderDetailModal(orderId); // refresh in place to show the cancelled state
  } catch (err) {
    showToast('⚠ ' + err.message);
  }
}

async function cancelMyOrder(orderId) {
  if (!confirm('Cancel this order? If already paid, a refund will be issued.')) return;
  try {
    await Api.cancelOrder(orderId);
    showToast('Order cancelled');
    showLoggedInAccountView();
  } catch (err) {
    showToast('⚠ ' + err.message);
  }
}

/* ──────────────────────────────────────
   CHECKOUT
────────────────────────────────────── */
let checkoutStep = 1;

async function openCheckout() {
  if (!cart.length) { showToast('Your bag is empty!'); return; }
  if (!getCustomerToken()) {
    // Require login before checkout — close the cart, prompt the account
    // modal instead, and remember to resume straight into checkout once
    // they log in or create an account.
    closeCartPanel();
    pendingCheckoutAfterLogin = true;
    showToast('🔒 Please log in to continue to checkout');
    openAccountModal();
    return;
  }
  // If the shop requires confirmed emails, stop here (politely) instead of letting the customer fill in the whole form.
  try {
    if (storeConfig.emailVerificationRequired === undefined) storeConfig = { ...storeConfig, ...(await Api.getConfig()) };
    if (storeConfig.emailVerificationRequired) {
      const { user } = await Api.me();
      if (!user.emailVerified) { closeCartPanel(); showVerifyEmailModal(user.email); return; }
    }
  } catch (e) { /* if this check fails, the server still enforces it when the order is placed */ }
  closeCartPanel();
  checkoutStep = 1;
  updateCheckoutStep(1);
  currentPaymentMethod = '';
  applyPaymentAvailability();
  document.getElementById('co-subtotal').textContent = '₹' + getTotal().toLocaleString('en-IN');
  document.getElementById('co-shipping').textContent = '₹' + shippingFee();
  document.getElementById('co-total').textContent = '₹' + (getTotal() + shippingFee()).toLocaleString('en-IN');
  document.getElementById('checkout-modal').classList.add('open');
}
function closeCheckout() {
  document.getElementById('checkout-modal').classList.remove('open');
  document.body.classList.remove('no-scroll');
  if (checkoutStep === 4) { cart = []; saveCart(); updateCartUI(); checkoutStep = 1; }
}

function updateCheckoutStep(n) {
  checkoutStep = n;
  // Update panes
  document.querySelectorAll('.checkout-pane').forEach((p, i) => p.classList.toggle('active', i+1 === n));
  const stepsEl = document.querySelector('.checkout-steps'); if (stepsEl) stepsEl.classList.toggle('is-done', n === 4);
  // Update step indicators
  document.querySelectorAll('.cs-step').forEach((s, i) => {
    s.classList.toggle('active', i+1 === n);
    s.classList.toggle('done', i+1 < n);
  });
  document.querySelectorAll('.cs-line').forEach((l, i) => l.classList.toggle('done', i+1 < n));
}

function collectAddress() {
  return {
    name: document.getElementById('co-name').value.trim(),
    phone: document.getElementById('co-phone').value.trim(),
    line1: document.getElementById('co-addr1').value.trim(),
    line2: document.getElementById('co-addr2').value.trim(),
    city: document.getElementById('co-city').value.trim(),
    pincode: document.getElementById('co-pin').value.trim(),
    state: document.getElementById('co-state').value,
  };
}

async function goCheckoutStep(n) {
  if (n === 2) {
    const a = collectAddress();
    if (!a.name || !a.phone || !a.line1 || !a.city || !a.pincode || !a.state) {
      showToast('⚠ Please fill all required fields'); return;
    }
    updateCheckoutStep(2);
    // Live shipping estimate for the pincode they just entered — this is the
    // same check-pincode endpoint that talks to Shiprocket once configured.
    const etaEl = document.getElementById('shipping-eta');
    etaEl.textContent = 'Checking delivery estimate…';
    try {
      const estimate = await Api.checkPincode(a.pincode, getTotal(), 0.3);
      if (estimate.serviceable) {
        etaEl.textContent = `📦 Estimated delivery: ${estimate.etaLabel} to ${a.pincode}${estimate.mock ? '' : ' via ' + estimate.courierName}`;
        etaEl.style.color = 'var(--lime)';
      } else {
        etaEl.textContent = `⚠ ${estimate.reason || 'We may not be able to deliver to this PIN code yet.'}`;
        etaEl.style.color = 'var(--red)';
      }
    } catch (err) {
      etaEl.textContent = '';
    }
    return;
  }
  if (n === 3) {
    if (!currentPaymentMethod) { showToast('⚠ Please select a payment method'); return; }
    buildOrderReview();
  }
  updateCheckoutStep(n);
}

/* Fetch what the server can actually offer, and grey out online payment if there's no gateway. */
async function applyPaymentAvailability() {
  try { storeConfig = await Api.getConfig(); } catch (e) { /* keep last known */ }
  const opt = document.getElementById('opt-online');
  const note = document.getElementById('online-unavailable');
  if (!opt) return;
  opt.style.display = storeConfig.onlinePayments ? '' : 'none';
  note.style.display = storeConfig.onlinePayments ? 'none' : 'block';
  document.querySelectorAll('.payment-opt').forEach(o => o.classList.remove('selected'));
  document.querySelectorAll('.po-radio').forEach(r => r.classList.remove('checked'));
  document.getElementById('cod-fee-row').style.display = 'none';
}

/* ── PIN code → city/state auto-fill ── */
let pinLookupSeq = 0;
async function onPincodeInput(input) {
  const pin = input.value.replace(/\D/g, '').slice(0, 6);
  if (input.value !== pin) input.value = pin;
  const status = document.getElementById('pin-status');
  if (pin.length < 6) { status.textContent = ''; return; }
  if (!/^[1-9][0-9]{5}$/.test(pin)) { status.textContent = '⚠ Invalid PIN code'; status.style.color = 'var(--red)'; return; }

  const seq = ++pinLookupSeq; // ignore stale responses if they keep typing
  status.textContent = 'Finding your city…';
  status.style.color = 'var(--text-dim)';
  try {
    const r = await Api.lookupPincode(pin);
    if (seq !== pinLookupSeq) return;
    if (!r.found) {
      status.textContent = '⚠ ' + (r.reason || 'PIN code not found') + ' — please enter city and state manually';
      status.style.color = 'var(--red)';
      return;
    }
    document.getElementById('co-city').value = r.city;
    const stateSel = document.getElementById('co-state');
    const match = [...stateSel.options].find(o => o.value.toLowerCase() === String(r.state).toLowerCase());
    if (match) stateSel.value = match.value;
    status.textContent = `✓ ${r.city}, ${r.state}`;
    status.style.color = 'var(--lime)';
  } catch (e) {
    if (seq !== pinLookupSeq) return;
    status.textContent = 'Could not auto-detect city — please enter it manually';
    status.style.color = 'var(--text-dim)';
  }
}

function selectPayment(method) {
  currentPaymentMethod = method;
  // Update UI
  document.querySelectorAll('.payment-opt').forEach(o => o.classList.remove('selected'));
  event.currentTarget.classList.add('selected');
  document.querySelectorAll('.po-radio').forEach(r => r.classList.remove('checked'));
  document.getElementById(`po-${method}`).classList.add('checked');
  // COD fee
  const isCOD = method === 'cod';
  document.getElementById('cod-fee-row').style.display = isCOD ? 'flex' : 'none';
  const total = getTotal() + shippingFee() + (isCOD ? 40 : 0);
  document.getElementById('co-total').textContent = '₹' + total.toLocaleString('en-IN');
}

function buildOrderReview() {
  const name = document.getElementById('co-name').value.trim();
  const addr = `${document.getElementById('co-addr1').value}, ${document.getElementById('co-addr2').value}, ${document.getElementById('co-city').value} - ${document.getElementById('co-pin').value}, ${document.getElementById('co-state').value}`;
  const isCOD = currentPaymentMethod === 'cod';
  const total = getTotal() + shippingFee() + (isCOD ? 40 : 0);

  const paymentLabels = { online:'Online (UPI / Card / Net Banking)', cod:'Cash on Delivery' };

  const itemsHTML = cart.map(i => `
    <div class="order-review-row">
      <span>${i.emoji} ${i.name} ${i.size!=='NA'?'('+i.size+')':''} × ${i.qty}</span>
      <span>₹${(i.price*i.qty).toLocaleString('en-IN')}</span>
    </div>`).join('');

  document.getElementById('order-review-content').innerHTML = `
    <div style="background:var(--surface2);border-radius:12px;padding:16px;margin-bottom:16px">
      ${itemsHTML}
      <div class="order-review-row"><span>Shipping</span><span>₹${shippingFee()}</span></div>
      ${isCOD?'<div class="order-review-row"><span>COD Fee</span><span>₹40</span></div>':''}
      <div class="order-review-row" style="font-weight:800;color:var(--lime);border-top:1px solid var(--border);margin-top:4px;padding-top:12px">
        <span>TOTAL</span><span>₹${total.toLocaleString('en-IN')}</span>
      </div>
    </div>
    <div style="font-size:.85rem;color:var(--text-dim);line-height:1.8">
      <div><strong style="color:var(--text)">Deliver to:</strong> ${name}</div>
      <div>${addr}</div>
      <div style="margin-top:6px"><strong style="color:var(--text)">Payment:</strong> ${paymentLabels[currentPaymentMethod]}</div>
    </div>`;
}

function setPlacingOrder(isPlacing) {
  const btn = document.getElementById('place-order-btn');
  if (!btn) return;
  btn.disabled = isPlacing;
  btn.textContent = isPlacing ? 'PROCESSING…' : 'PLACE ORDER 🎉';
}

function showOrderSuccess(order) {
  lastPlacedOrderId = order.id;
  document.getElementById('order-id-display').textContent = order.id;
  const paidOnline = order.payment && order.payment.method === 'online';
  document.getElementById('order-success-text').textContent = (paidOnline ? 'Payment received — your LALLEWOOLS order is confirmed. ' : 'Your LALLEWOOLS order is confirmed. ')
    + 'We\'ll email you when it ships — you can also track it any time from My Orders or the Track Order link.';
  updateCheckoutStep(4);
  showToast('🎉 Order placed successfully!');
}

/**
 * Real checkout flow:
 *  1. POST /api/orders — server re-prices the cart (never trusts client
 *     prices), validates the address, and either confirms it immediately
 *     (Cash on Delivery) or leaves it "awaiting_payment".
 *  2. For online payment, POST /api/payment/create-order to get a
 *     Razorpay order, open Razorpay's own secure Checkout modal, then
 *     POST /api/payment/verify with what it returns. There is no simulated
 *     payment: if the server has no gateway, online payment is hidden.
 *  3. On success, clear the cart and show the confirmation screen.
 */
async function placeOrder() {
  if (!cart.length) { showToast('Your bag is empty!'); return; }
  setPlacingOrder(true);
  let order = null;
  try {
    const items = cart.map(i => ({ id: i.id, size: i.size, qty: i.qty }));
    const address = collectAddress();
    order = await Api.createOrder({ items, address, paymentMethod: currentPaymentMethod });

    if (currentPaymentMethod === 'cod') {
      cart = []; saveCart(); updateCartUI();
      showOrderSuccess(order);
      return;
    }

    // Online: the order is NOT confirmed yet. It only becomes confirmed (and the success screen only appears)
    // after the server has verified the payment.
    await payForOrderWithRazorpay(order, address);
  } catch (err) {
    // Payment never completed (window closed, gateway error...): the order was never confirmed, so release it
    // right away. The bag is untouched, so the customer can simply try again. Skipped when money may have been
    // taken (err.paymentReceived) — then the server confirms it via verify/webhook, or refunds it.
    if (order && order.payment && order.payment.method === 'online' && !err.paymentReceived) {
      Api.abandonOrder(order.id).catch(() => { /* housekeeping expires it within 30 min anyway */ });
    }
    if (err.code === 'email_unverified') {
      closeCheckout();
      let addr = ''; try { addr = (await Api.me()).user.email || ''; } catch (e) { /* ignore */ }
      showVerifyEmailModal(addr);
    } else {
      showToast('⚠ ' + err.message);
    }
  } finally {
    setPlacingOrder(false);
  }
}

/** Razorpay's checkout script is only fetched when someone actually pays online (keeps every page view lighter). */
let razorpayLoading = null;
function loadRazorpay() {
  if (typeof Razorpay !== 'undefined') return Promise.resolve();
  if (!razorpayLoading) {
    razorpayLoading = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://checkout.razorpay.com/v1/checkout.js';
      el.onload = resolve;
      el.onerror = () => { razorpayLoading = null; reject(new Error('Could not load the payment gateway. Check your connection and try again.')); };
      document.head.appendChild(el);
    });
  }
  return razorpayLoading;
}

function payForOrderWithRazorpay(order, address) {
  return loadRazorpay().then(() => Api.createPaymentOrder(order.id)).then(gw => {
    // Open Razorpay's own secure Checkout modal (card/UPI details never touch our server).
    return new Promise((resolve, reject) => {
      if (typeof Razorpay === 'undefined') {
        reject(new Error('Payment gateway script failed to load. Check your connection and try again.'));
        return;
      }
      let paymentTaken = false;
      const rzp = new Razorpay({
        key: gw.keyId,
        amount: gw.amountPaise,
        currency: gw.currency,
        name: 'LALLEWOOLS',
        description: `Order ${order.id}`,
        order_id: gw.gatewayOrderId,
        prefill: { name: address.name, contact: address.phone, email: address.email || '' },
        theme: { color: '#111111' }, // Razorpay's buttons use white text; brand lime would be unreadable
        handler: function (response) {
          paymentTaken = true;
          Api.verifyPayment({
            orderId: order.id,
            gatewayOrderId: response.razorpay_order_id,
            gatewayPaymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
          }).then((result) => {
            cart = []; saveCart(); updateCartUI();
            showOrderSuccess((result && result.order) || order); // the server's verified copy, not the earlier unpaid one
            resolve();
          }).catch((err) => {
            // The customer may have been charged: do NOT release the order. The gateway webhook confirms it
            // (or the late-payment refund kicks in), so tell them where to look instead of showing an error.
            reject(Object.assign(new Error(err.message + ' — if money was deducted, your order will be confirmed automatically; check My Orders in a few minutes.'), { paymentReceived: true }));
          });
        },
        modal: {
          ondismiss: function () {
            if (paymentTaken) return; // closed after paying — the handler above owns the outcome
            reject(new Error('Payment not completed — your order was not placed. Your bag is still here.'));
          },
        },
      });
      // A failed attempt is NOT the end: Razorpay keeps its window open so the customer can retry with another
      // method. Just tell them; the order is only released when they close the window.
      rzp.on('payment.failed', function (resp) {
        showToast('⚠ ' + (resp.error && resp.error.description ? resp.error.description : 'Payment failed') + ' — you can try again');
      });
      rzp.open();
    });
  });
}

/* ──────────────────────────────────────
   NEWSLETTER
────────────────────────────────────── */
async function subscribeNewsletter() {
  const input = document.getElementById('email-input');
  const btn = document.getElementById('newsletter-btn');
  const msg = document.getElementById('newsletter-msg');
  const email = input.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    msg.textContent = 'Please enter a valid email.';
    msg.style.color = 'var(--red)';
    return;
  }
  btn.disabled = true;
  try {
    await Api.subscribe(email);
    msg.textContent = '🔥 You\'re in the fam! Early drops incoming.';
    msg.style.color = 'var(--success)';
    input.value = '';
  } catch (err) {
    msg.textContent = err.message || 'Could not sign you up right now. Please try again.';
    msg.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
  }
}

/** Admin WhatsApp number (digits, country code) — set by applySiteConfig from ADMIN_WHATSAPP. */
let customTeeWa = null;

/** Opens the admin's WhatsApp chat with a prefilled custom-tee request. */
function openCustomTeeModal() { document.getElementById('custom-tee-modal').classList.add('open'); }
function closeCustomTeeModal() { document.getElementById('custom-tee-modal').classList.remove('open'); }

function openCustomTeeChat(e, kind) {
  if (e) e.preventDefault();
  if (!customTeeWa) { showToast('Custom oversized tees are opening soon — check back shortly!'); return false; }
  const name = (document.getElementById('ct-name')?.value || '').trim().slice(0, 60);
  const idea = (document.getElementById('ct-idea')?.value || '').trim().slice(0, 400);
  if (kind === 'photo') {
    window.open('https://wa.me/' + customTeeWa + '?text=' + encodeURIComponent('Hi LALLEWOOLS! I want my image printed on a custom tee. Sending my image now.'), '_blank', 'noopener');
    return false;
  }
  const lines = ['Hi LALLEWOOLS! I want a custom tee.'];
  if (name) lines.push('Name: ' + name);
  if (idea) lines.push('Idea: ' + idea);
  else lines.push('I will share my design/idea here.');
  window.open('https://wa.me/' + customTeeWa + '?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener');
  return false;
}

/** Footer social links + contact email come from .env (via /api/config); nothing is shown unless you set it. */
function applySiteConfig(cfg) {
  const links = [['instagram', 'Instagram', 'Ig'], ['twitter', 'Twitter', 'Tw'], ['youtube', 'YouTube', 'Yt'], ['discord', 'Discord', 'Dc']]
    .filter(([k]) => cfg.social && /^https?:\/\//.test(cfg.social[k] || ''));
  const mk = (cls, label) => links.map(([k, long, short]) => `<a href="${esc(cfg.social[k])}" target="_blank" rel="noopener noreferrer" ${cls ? `class="${cls}"` : ''} aria-label="${long}">${label ? long : short}</a>`).join('');
  const fs = document.getElementById('footer-social'), cs = document.getElementById('community-social');
  if (links.length) { fs.innerHTML = mk('', false); fs.hidden = false; cs.innerHTML = mk('social-link', true); cs.hidden = false; }
  if (/^\d{11,15}$/.test(cfg.adminWhatsapp || '')) {
    customTeeWa = cfg.adminWhatsapp;
    const sec = document.getElementById('custom-tee-section');
    if (sec) sec.hidden = false;
    document.querySelectorAll('.nav-custom-link').forEach(a => { a.hidden = false; });
  }
  if (cfg.supportEmail) { const a = document.getElementById('footer-contact-link'); a.href = 'mailto:' + cfg.supportEmail; a.hidden = false; }
}

/* ──────────────────────────────────────
   REVEAL ON SCROLL
────────────────────────────────────── */
function initReveal() {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(el => { if (el.isIntersecting) { el.target.classList.add('visible'); observer.unobserve(el.target); } });
  }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });
  document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
}

/* ──────────────────────────────────────
   HELPERS
────────────────────────────────────── */
function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }
function scrollToSection(id) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }

let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show', 'toast-success');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show', 'toast-success'), 2800);
}

// Close modals on outside click (desktop dialogs only — on phones they are full-screen pages)
document.addEventListener('click', e => {
  if (isMobile()) return;
  if (e.target === document.getElementById('product-modal')) closeProductModal();
  if (e.target === document.getElementById('checkout-modal')) closeCheckout();
  if (e.target === document.getElementById('custom-tee-modal')) closeCustomTeeModal();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeSearch(); closeProductModal(); closeCheckout(); closeCartPanel(); closeWishlistPanel(); closeCustomTeeModal();
  // Esc steps back one layer: order detail first, then the profile page itself.
  if (document.getElementById('order-detail-modal').classList.contains('open')) closeOrderDetailModal();
  else if (document.getElementById('profile-page').classList.contains('open')) pfBack();
});

/** One source of truth for the page scroll lock: locked iff something full-screen is open. */
function initScrollLock() {
  const targets = document.querySelectorAll('.modal-overlay,#cart-sidebar,#wishlist-sidebar,#search-overlay,#mobile-menu');
  const obs = new MutationObserver(syncScrollLock);
  targets.forEach(t => obs.observe(t, { attributes: true, attributeFilter: ['class'] }));
}

/* ──────────────────────────────────────
   INIT
────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  initThemeToggle();
  startIntro();
  initNavbar();
  initMobileMenu();
  initSearch();
  initCart();
  initWishlist();
  initBottomNav();
  initHeroSlider();
  initScrollLock();
  initFilters();
  document.getElementById('footer-year').textContent = new Date().getFullYear();

  showCatalogLoading();
  updateCartUI();
  updateWishlistUI();

  handleEmailVerifiedLanding();
  Api.getConfig().then(applySiteConfig).catch(() => {});
  await loadProducts();
  renderAll();
  if (!catalogError) openProductFromUrl();
  loadCommunityReviews(); // not awaited: highlighted reviews must never delay the shop

  // Drop cart/wishlist lines for products that no longer exist, and refresh prices/discounts to the live ones.
  if (!catalogError) {
    cart = cart.filter(i => PRODUCTS.some(p => p.id === i.id)).map(i => { const p = PRODUCTS.find(x => x.id === i.id); return { ...i, price: p.price, oldPrice: p.oldPrice || null, name: p.name }; });
    wishlist = wishlist.filter(i => PRODUCTS.some(p => p.id === i.id));
    saveCart(); saveWishlist(); updateCartUI(); updateWishlistUI();
  }
});
