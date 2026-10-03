'use strict';

let adminToken = localStorage.getItem('lallewools_admin_token') || null;

async function adminFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) { adminLogout(); throw new Error('Session expired, please log in again'); }
  if (!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}

async function adminLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    const res = await fetch(`${API_BASE}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    adminToken = data.token;
    localStorage.setItem('lallewools_admin_token', adminToken);
    showDashboard();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

function adminLogout() {
  adminToken = null;
  localStorage.removeItem('lallewools_admin_token');
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  loadStats();
  loadOrders();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.getElementById('tab-orders').classList.toggle('hidden', name !== 'orders');
  document.getElementById('tab-products').classList.toggle('hidden', name !== 'products');
  document.getElementById('tab-settings').classList.toggle('hidden', name !== 'settings');
  document.getElementById('tab-reviews').classList.toggle('hidden', name !== 'reviews');
  if (name === 'reviews') loadReviews();
  if (name === 'products') loadProducts();
  if (name === 'settings') loadWhatsapp();
}

const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loadReviews() {
  const tbody = document.getElementById('reviews-body');
  tbody.innerHTML = '<tr><td colspan="8" class="muted">Loading…</td></tr>';
  try {
    const list = await adminFetch('/admin/reviews');
    tbody.innerHTML = list.length ? list.map((r) => `
      <tr>
        <td>${escHtml(r.productName)}</td>
        <td>${escHtml(r.reviewerName)}</td>
        <td>${'★'.repeat(r.rating)}<span class="muted">${'★'.repeat(5 - r.rating)}</span></td>
        <td style="max-width:320px;white-space:pre-line;overflow-wrap:anywhere">${escHtml(r.body) || '<span class="muted">(no text)</span>'}</td>
        <td>${r.images.map((u) => `<a href="${escHtml(u)}" target="_blank" rel="noopener"><img src="${escHtml(u)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:6px;margin-right:4px"></a>`).join('')}</td>
        <td class="muted">${new Date(r.createdAt).toLocaleDateString('en-IN')}</td>
        <td><button class="btn ${r.featured ? '' : 'secondary'}" onclick="toggleFeatureReview(${r.id}, ${!r.featured})">${r.featured ? '★ Highlighted' : '☆ Highlight'}</button></td>
        <td><button class="btn danger" onclick="deleteReview(${r.id})">Delete</button></td>
      </tr>`).join('') : '<tr><td colspan="8" class="muted">No reviews yet.</td></tr>';
  } catch (err) { tbody.innerHTML = `<tr><td colspan="8" style="color:var(--red)">${escHtml(err.message)}</td></tr>`; }
}

async function toggleFeatureReview(id, featured) {
  try { await adminFetch(`/admin/reviews/${id}/feature`, { method: 'PATCH', body: JSON.stringify({ featured }) }); loadReviews(); }
  catch (err) { alert(err.message); }
}

async function deleteReview(id) {
  if (!confirm('Delete this review and its photos? This cannot be undone.')) return;
  try { await adminFetch(`/admin/reviews/${id}`, { method: 'DELETE' }); loadReviews(); }
  catch (err) { alert(err.message); }
}

async function loadWhatsapp() {
  const msg = document.getElementById('wa-msg');
  msg.textContent = '';
  try {
    const d = await adminFetch('/admin/settings/whatsapp');
    document.getElementById('wa-number').value = d.number || '';
    if (!d.number && d.active) { msg.style.color = 'var(--dim)'; msg.textContent = 'Currently using ADMIN_WHATSAPP from .env: ' + d.active; }
    else if (!d.active) { msg.style.color = 'var(--dim)'; msg.textContent = 'Not set \u2014 the Custom Tee section is hidden on the storefront.'; }
  } catch (err) { msg.style.color = 'var(--red)'; msg.textContent = err.message; }
}

async function saveWhatsapp() {
  const msg = document.getElementById('wa-msg');
  try {
    const d = await adminFetch('/admin/settings/whatsapp', { method: 'PUT', body: JSON.stringify({ number: document.getElementById('wa-number').value }) });
    document.getElementById('wa-number').value = d.number || '';
    msg.style.color = 'var(--lime)';
    msg.textContent = d.number ? 'Saved. Custom Tee now opens WhatsApp ' + d.number + '.' : 'Cleared.';
    if (!d.number) loadWhatsapp();
  } catch (err) { msg.style.color = 'var(--red)'; msg.textContent = err.message; }
}

function testWhatsapp() {
  const n = document.getElementById('wa-number').value.replace(/\D/g, '');
  const msg = document.getElementById('wa-msg');
  if (n.length < 10) { msg.style.color = 'var(--red)'; msg.textContent = 'Enter a number first.'; return; }
  window.open('https://wa.me/' + (n.length === 10 ? '91' + n : n), '_blank', 'noopener');
}

function money(n) { return '₹' + Number(n).toLocaleString('en-IN'); }

async function loadStats() {
  try {
    const stats = await adminFetch('/admin/stats');
    document.getElementById('stats-row').innerHTML = `
      <div class="stat-card"><div class="num">${stats.totalOrders}</div><div class="label">Total Orders</div></div>
      <div class="stat-card"><div class="num">${money(stats.totalRevenue)}</div><div class="label">Revenue</div></div>
      <div class="stat-card"><div class="num">${stats.pendingOrders}</div><div class="label">Pending</div></div>
    `;
  } catch (err) { console.error(err); }
}

async function loadOrders() {
  const status = document.getElementById('status-filter').value;
  const tbody = document.getElementById('orders-body');
  tbody.innerHTML = '<tr><td colspan="6" class="muted">Loading…</td></tr>';
  try {
    const orders = await adminFetch(`/admin/orders${status ? `?status=${status}` : ''}`);
    if (!orders.length) { tbody.innerHTML = '<tr><td colspan="6" class="muted">No orders yet</td></tr>'; return; }
    tbody.innerHTML = orders.map(orderRow).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">${escHtml(err.message)}</td></tr>`;
  }
}

function orderRow(o) {
  return `
    <tr class="order-row" onclick="toggleOrderDetail('${escHtml(o.id)}')">
      <td><b>${escHtml(o.id)}</b></td>
      <td>${escHtml(o.address.name)}</td>
      <td>${money(o.amounts.total)}</td>
      <td>${escHtml(o.payment.method.toUpperCase())} · ${escHtml(o.payment.status)}</td>
      <td><span class="status-pill status-${escHtml(o.status)}">${escHtml(o.status.replace(/_/g, ' '))}</span></td>
      <td class="muted">${new Date(o.createdAt).toLocaleDateString('en-IN')}</td>
    </tr>
    <tr id="detail-${escHtml(o.id)}" class="hidden"><td colspan="6">${orderDetailHtml(o)}</td></tr>
  `;
}

function orderDetailHtml(o) {
  const items = o.items.map(i => `${escHtml(i.name)}${i.size !== 'NA' ? ` (${escHtml(i.size)})` : ''} × ${Number(i.qty) || 0} — ${money(i.price * i.qty)}`).join('<br>');
  const canShip = ['confirmed', 'cod_confirmed', 'shipped_pending_pickup'].includes(o.status) || o.status === 'confirmed';
  const canCancel = !['cancelled', 'delivered'].includes(o.status);
  const canDeliver = o.status === 'shipped';
  return `
    <div class="order-detail">
      <div class="row"><span class="muted">Items</span><span style="text-align:right">${items}</span></div>
      <div class="row"><span class="muted">Ship to</span><span style="text-align:right">${escHtml(o.address.name)}<br>${escHtml(o.address.line1)}${o.address.line2 ? ', ' + escHtml(o.address.line2) : ''}, ${escHtml(o.address.city)} - ${escHtml(o.address.pincode)}, ${escHtml(o.address.state)}<br>${escHtml(o.address.phone)}</span></div>
      ${o.shipment && o.shipment.awbCode ? `<div class="row"><span class="muted">AWB</span><span>${escHtml(o.shipment.awbCode)} (${escHtml(o.shipment.courierName || 'courier')})</span></div>` : ''}
      ${o.shipment && o.shipment.bookingError ? `<div class="row"><span class="muted">Shiprocket</span><span style="text-align:right;color:var(--red)">Not booked: ${escHtml(o.shipment.bookingError)}<br><small>Click Mark Shipped and leave AWB blank to retry.</small></span></div>` : ''}
      ${o.shipment && o.shipment.cancelError ? `<div class="row"><span class="muted">Shiprocket</span><span style="text-align:right;color:var(--red)">Order cancelled here but NOT cancelled in Shiprocket — cancel it in their dashboard.<br><small>${escHtml(o.shipment.cancelError)}</small></span></div>` : ''}
      ${o.payment.method !== 'cod' && !o.payment.paidAt && !o.payment.gatewayPaymentId
        ? `<div class="row"><span class="muted">Payment</span><span style="color:var(--red)">Not received — this order is not confirmed and cannot be shipped.</span></div>`
        : `<div class="row"><span class="muted">Invoice</span><span><a href="#" onclick="event.stopPropagation();openInvoice('${escHtml(o.id)}');return false" style="color:var(--lime)">View PDF</a></span></div>`}
      <div style="margin-top:.75rem">
        ${o.status === 'confirmed' || o.status === 'shipped_pending_pickup' ? `<button class="btn" onclick="event.stopPropagation();shipOrder('${escHtml(o.id)}')">Mark Shipped</button>` : ''}
        ${canDeliver ? `<button class="btn" onclick="event.stopPropagation();deliverOrder('${escHtml(o.id)}')">Mark Delivered</button>` : ''}
        ${canCancel ? `<button class="btn danger" onclick="event.stopPropagation();cancelOrder('${escHtml(o.id)}')">Cancel & Refund</button>` : ''}
      </div>
    </div>
  `;
}

/** Invoices are protected, so a plain link can't carry the admin login. Ask the server for a short-lived link instead. */
async function openInvoice(id) {
  const w = window.open('', '_blank');
  try {
    const { url } = await adminFetch(`/admin/orders/${encodeURIComponent(id)}/invoice-link`, { method: 'POST' });
    if (w) w.location = url; else window.location = url;
  } catch (err) { if (w) w.close(); alert(err.message); }
}

function toggleOrderDetail(id) {
  document.getElementById(`detail-${id}`).classList.toggle('hidden');
}

async function shipOrder(id) {
  const awb = prompt('AWB / tracking number — this marks the order SHIPPED now.\nLeave blank to (re)book via Shiprocket: the order stays "confirmed" and flips to "shipped" by itself when the courier picks it up.');
  if (awb === null) return; // cancelled the prompt
  let courierName, trackingUrl;
  if (awb.trim()) {
    courierName = prompt('Courier name (e.g. India Post, DTDC):') || undefined;
    trackingUrl = prompt('Courier tracking link, if any (optional — customers will see it):') || undefined;
  }
  try {
    await adminFetch(`/admin/orders/${id}/ship`, {
      method: 'POST',
      body: JSON.stringify(awb.trim() ? { awbCode: awb.trim(), courierName, trackingUrl } : {}),
    });
    loadOrders();
  } catch (err) { alert(err.message); }
}

async function deliverOrder(id) {
  try { await adminFetch(`/admin/orders/${id}/deliver`, { method: 'POST' }); loadOrders(); }
  catch (err) { alert(err.message); }
}

async function cancelOrder(id) {
  if (!confirm('Cancel this order and refund the customer if paid?')) return;
  try { await adminFetch(`/admin/orders/${id}/cancel`, { method: 'POST' }); loadOrders(); loadStats(); }
  catch (err) { alert(err.message); }
}

async function loadProducts() {
  const tbody = document.getElementById('products-body');
  tbody.innerHTML = '<tr><td colspan="7" class="muted">Loading…</td></tr>';
  try {
    const products = await adminFetch('/admin/products');
    if (!products.length) { tbody.innerHTML = '<tr><td colspan="7" class="muted">No products yet — click "+ Add Product" to create one.</td></tr>'; return; }
    tbody.innerHTML = products.map(productRow).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">${escHtml(err.message)}</td></tr>`;
  }
}

function productRow(p) {
  const thumb = p.image
    ? `<img src="${escHtml(p.image)}" class="product-thumb" onerror="this.remove()">`
    : (p.emoji || '—');
  return `
    <tr>
      <td>${thumb}</td>
      <td>${escHtml(p.name)}<div class="muted" style="font-size:.75rem">${escHtml(p.sku)}</div></td>
      <td>${escHtml(p.type)}</td>
      <td>${money(p.price)}</td>
      <td>${p.stock}</td>
      <td>${p.active ? '✅' : '—'}</td>
      <td>
        <button class="btn secondary" onclick="openProductForm(${escHtml(JSON.stringify(p))})">Edit</button>
        <button class="btn danger" onclick="deleteProductRow(${Number(p.id)}, ${escHtml(JSON.stringify(p.name))})">Delete</button>
      </td>
    </tr>
  `;
}

let editingProductId = null;

/** Open the modal. Pass a product object to edit it, or call with no argument to create a new one. */
function openProductForm(p) {
  editingProductId = p ? p.id : null;
  document.getElementById('product-modal-title').textContent = p ? `Edit — ${p.name}` : 'Add Product';
  document.getElementById('product-form-error').textContent = '';

  document.getElementById('pf-name').value = p?.name || '';
  document.getElementById('pf-type').value = 'clothing';
  document.getElementById('pf-category').value = p?.category || '';
  document.getElementById('pf-sku').value = p?.sku || '';
  document.getElementById('pf-price').value = p?.price ?? '';
  document.getElementById('pf-oldprice').value = p?.oldPrice ?? '';
  document.getElementById('pf-stock').value = p?.stock ?? 0;
  document.getElementById('pf-weight').value = p?.weightGrams ?? 250;
  document.getElementById('pf-emoji').value = p?.emoji || '';
  document.getElementById('pf-badge').value = p?.badge || '';
  document.getElementById('pf-sticker').value = p?.sticker || '';
  document.getElementById('pf-image').value = p?.image || '';
  document.getElementById('pf-desc').value = p?.desc || '';
  document.getElementById('pf-sizes').value = (p?.sizes || ['S', 'M', 'L', 'XL', 'XXL']).join(',');
  document.getElementById('pf-teecolor').value = p?.teeColor || '#0A0A0A';
  document.getElementById('pf-designtext').value = p?.designText || '';
  document.getElementById('pf-designcolor').value = p?.designColor || '#C8FF00';
  document.getElementById('pf-active').checked = p ? !!p.active : true;

  document.getElementById('product-modal-overlay').classList.remove('hidden');
}

function closeProductForm() {
  document.getElementById('product-modal-overlay').classList.add('hidden');
}

async function submitProductForm() {
  const errEl = document.getElementById('product-form-error');
  errEl.textContent = '';

  const name = document.getElementById('pf-name').value.trim();
  const type = document.getElementById('pf-type').value;
  const price = Number(document.getElementById('pf-price').value);
  if (!name) { errEl.textContent = 'Name is required'; return; }
  if (!price || price <= 0) { errEl.textContent = 'Enter a valid price'; return; }

  const payload = {
    name, type,
    category: document.getElementById('pf-category').value.trim() || null,
    sku: document.getElementById('pf-sku').value.trim() || undefined,
    price,
    oldPrice: document.getElementById('pf-oldprice').value ? Number(document.getElementById('pf-oldprice').value) : null,
    stock: Number(document.getElementById('pf-stock').value) || 0,
    weightGrams: Number(document.getElementById('pf-weight').value) || 250,
    emoji: document.getElementById('pf-emoji').value.trim() || null,
    badge: document.getElementById('pf-badge').value || null,
    sticker: document.getElementById('pf-sticker').value.trim() || null,
    image: document.getElementById('pf-image').value.trim() || null,
    desc: document.getElementById('pf-desc').value.trim() || null,
    active: document.getElementById('pf-active').checked,
  };

  payload.sizes = document.getElementById('pf-sizes').value.split(',').map(s => s.trim()).filter(Boolean);
  payload.teeColor = document.getElementById('pf-teecolor').value.trim() || null;
  payload.designText = document.getElementById('pf-designtext').value || null;
  payload.designColor = document.getElementById('pf-designcolor').value.trim() || null;

  try {
    if (editingProductId) {
      await adminFetch(`/admin/products/${editingProductId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await adminFetch('/admin/products', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeProductForm();
    loadProducts();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function deleteProductRow(id, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone. (Past orders are unaffected — they keep their own copy of the product details.)`)) return;
  try {
    await adminFetch(`/admin/products/${id}`, { method: 'DELETE' });
    loadProducts();
  } catch (err) { alert(err.message); }
}

document.addEventListener('DOMContentLoaded', () => {
  if (adminToken) showDashboard();
});

/** Download the live catalog as products.json (commit it to server/data/ to keep prices across redeploys). */
async function exportCatalog() {
  try {
    const data = await adminFetch('/admin/products/export');
    const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'products.json';
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { alert(err.message); }
}
