const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/sqlite');
const payment = require('../services/payment');
const email = require('../services/email');
const shipping = require('../services/shipping');
const { signAdminToken, requireAdmin } = require('../middleware/adminAuth');
const { signInvoiceToken } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { normalizeWhatsappNumber } = require('../services/phone');

const { deleteImages } = require('../services/reviewImages');

const router = express.Router();

/** An order may only move toward the customer once it is a real order: not cancelled, and COD or actually paid. */
function assertFulfillable(order) {
  if (order.status === 'cancelled') throw Object.assign(new Error('This order is cancelled'), { status: 400 });
  if (!db.isPaymentSettled(order)) throw Object.assign(new Error('Payment has not been received for this order yet — it cannot be shipped or delivered.'), { status: 400 });
}

// ── Admin auth ─────────────────────────────────────────
// Single admin account, credentials come from .env (see .env.example).
// ADMIN_PASSWORD_HASH is a bcrypt hash — generate one with:
//   node scripts/hash-password.js "your-new-password"

// POST /api/admin/login  { email, password }
router.post('/login', asyncRoute(async (req, res) => {
  const { email: inputEmail, password } = req.body || {};
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminHash = process.env.ADMIN_PASSWORD_HASH;
  if (!adminEmail || !adminHash) {
    return res.status(500).json({ error: 'Admin account is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD_HASH in .env.' });
  }
  if (String(inputEmail || '').toLowerCase() !== adminEmail.toLowerCase()) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  const ok = await bcrypt.compare(String(password || ''), adminHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password' });
  res.json({ token: signAdminToken() });
}));

// Everything below requires a valid admin token.
router.use(requireAdmin);

// GET /api/admin/settings/whatsapp — number shown to customers on the Custom Tee section
router.get('/settings/whatsapp', asyncRoute(async (req, res) => {
  const saved = normalizeWhatsappNumber(db.getSetting('admin_whatsapp'));
  const fromEnv = normalizeWhatsappNumber(process.env.ADMIN_WHATSAPP);
  res.json({ number: saved, active: saved || fromEnv, source: saved ? 'admin' : fromEnv ? 'env' : null });
}));

// PUT /api/admin/settings/whatsapp  { number }  — blank clears it (falls back to ADMIN_WHATSAPP in .env)
router.put('/settings/whatsapp', asyncRoute(async (req, res) => {
  const raw = String((req.body || {}).number ?? '').trim();
  if (!raw) {
    await db.setSetting('admin_whatsapp', null);
    return res.json({ number: null });
  }
  const number = normalizeWhatsappNumber(raw);
  if (!number) return res.status(400).json({ error: 'Enter a valid WhatsApp number with country code, e.g. 919876543210' });
  await db.setSetting('admin_whatsapp', number);
  res.json({ number });
}));

// GET /api/admin/stats — quick dashboard numbers
router.get('/stats', asyncRoute(async (req, res) => {
  res.json(db.orderStats());
}));

// GET /api/admin/orders?status=pending&limit=50&offset=0
router.get('/orders', asyncRoute(async (req, res) => {
  const { status, limit, offset } = req.query;
  res.json(db.listAllOrders({
    status: status || undefined,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  }));
}));

// POST /api/admin/orders/:id/invoice-link — short-lived PDF link the admin panel can open in a new tab
router.post('/orders/:id/invoice-link', asyncRoute(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ url: `/api/orders/${order.id}/invoice?t=${signInvoiceToken(order.id)}` });
}));

// GET /api/admin/orders/:id
router.get('/orders/:id', asyncRoute(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
}));

// POST /api/admin/orders/:id/ship — attach a manual AWB (marks shipped), or retry Shiprocket auto-booking (stays confirmed until pickup)
router.post('/orders/:id/ship', asyncRoute(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  assertFulfillable(order);
  const { awbCode, courierName, trackingUrl } = req.body || {};

  let bookingResult;
  if (awbCode) {
    // Admin is entering a manually-booked AWB (e.g. booked directly on the courier's site).
    const safeUrl = /^https?:\/\//i.test(String(trackingUrl || '')) ? String(trackingUrl) : null;
    bookingResult = { mock: false, manual: true, awbCode, courierName: courierName || 'Manual', trackingUrl: safeUrl, status: 'booked' };
  } else {
    // Retry automatic booking via the configured shipping provider.
    bookingResult = await shipping.createShipment(order);
  }
  // Merge rather than replace, so the delivery estimate set at order creation isn't lost.
  if (!awbCode) {
    // Retry of the automatic Shiprocket booking: the courier hasn't picked anything up yet,
    // so the order stays "confirmed" and flips to "shipped" by itself on the first pickup scan.
    const retried = await db.updateOrder(order.id, { shipment: { ...order.shipment, ...bookingResult, bookedAt: new Date().toISOString(), bookingError: undefined } });
    return res.json(retried);
  }
  // Admin entered a manually-booked AWB and is explicitly saying it has gone out.
  const shipment = { ...order.shipment, ...bookingResult, shippedAt: new Date().toISOString() };
  const updated = await db.updateOrder(order.id, { status: 'shipped', shipment });
  const { subject, html } = email.shippedEmail(updated);
  email.sendEmail({ to: updated.address.email, subject, html }).catch(() => {});
  res.json(updated);
}));

// POST /api/admin/orders/:id/deliver — mark delivered
router.post('/orders/:id/deliver', asyncRoute(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  assertFulfillable(order);
  const shipment = { ...order.shipment, status: 'delivered', deliveredAt: new Date().toISOString() };
  res.json(await db.updateOrder(order.id, { status: 'delivered', shipment }));
}));

// POST /api/admin/orders/:id/cancel — cancel + restock + refund if paid
router.post('/orders/:id/cancel', asyncRoute(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (['cancelled', 'delivered'].includes(order.status)) {
    return res.status(400).json({ error: `Order is already ${order.status}` });
  }

  let paymentUpdate = { ...order.payment };
  if (order.payment.status === 'paid') {
    const refund = await payment.refundPayment({
      gatewayPaymentId: order.payment.gatewayPaymentId,
      amountRupees: order.amounts.total,
    });
    paymentUpdate = { ...paymentUpdate, status: 'refunded', refund };
  }

  const sc = await shipping.cancelShipment(order);
  const shipmentUpdate = sc.error
    ? { ...order.shipment, cancelError: sc.error }
    : sc.cancelled ? { ...order.shipment, status: 'cancelled', cancelledAt: new Date().toISOString(), cancelError: undefined } : order.shipment;
  await db.restoreStock(order.items);
  const updated = await db.updateOrder(order.id, { status: 'cancelled', payment: paymentUpdate, shipment: shipmentUpdate });
  const { subject, html } = email.cancellationEmail(updated);
  email.sendEmail({ to: updated.address.email, subject, html }).catch(() => {});
  res.json(updated);
}));

// ── Review moderation ───────────────────────────────────

// GET /api/admin/reviews — newest first, with product name for context
router.get('/reviews', asyncRoute(async (req, res) => {
  const list = db.listAllReviews({ limit: Number(req.query.limit) || 100, offset: Number(req.query.offset) || 0 });
  res.json(list.map((r) => ({ ...r, productName: (db.getProduct(r.productId) || {}).name || `#${r.productId}` })));
}));

// PATCH /api/admin/reviews/:id/feature  { featured: true|false } — highlight a review in the storefront's Community section
router.patch('/reviews/:id/feature', asyncRoute(async (req, res) => {
  const featured = Boolean((req.body || {}).featured);
  const updated = await db.setReviewFeatured(req.params.id, featured);
  if (!updated) return res.status(404).json({ error: 'Review not found' });
  res.json(updated);
}));

// DELETE /api/admin/reviews/:id — remove a review and its photo files
router.delete('/reviews/:id', asyncRoute(async (req, res) => {
  const removed = await db.deleteReview(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Review not found' });
  deleteImages(removed.images);
  res.json({ deleted: true });
}));

// ── Product management ──────────────────────────────────

// GET /api/admin/subscribers — newsletter list; ?format=csv downloads it for your mailing tool
router.get('/subscribers', asyncRoute(async (req, res) => {
  const list = db.listSubscribers();
  if (req.query.format === 'csv') {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="subscribers.csv"');
    return res.send('email,subscribed_at\n' + list.map((r) => `${r.email},${r.createdAt}`).join('\n') + '\n');
  }
  res.json(list);
}));

// GET /api/admin/products — includes inactive/out-of-stock ones too
router.get('/products', asyncRoute(async (req, res) => {
  res.json(db.listProducts({ includeInactive: true }));
}));

// GET /api/admin/products/export — download the live catalog as products.json
// (drop it into server/data/ and commit it so redeploys keep your prices)
router.get('/products/export', asyncRoute(async (req, res) => {
  const list = db.listProducts({ includeInactive: true }).map((p) => JSON.parse(JSON.stringify(p)));
  res.setHeader('Content-Disposition', 'attachment; filename="products.json"');
  res.type('application/json').send(JSON.stringify(list, null, 2) + '\n');
}));

// POST /api/admin/products — create a brand-new product
// Body: { name, price, type, category?, oldPrice?, emoji?, badge?, sticker?,
//         desc?, image?, teeColor?, designText?, designColor?, size?, sizes?,
//         stock?, weightGrams?, active?, sku? }
router.post('/products', asyncRoute(async (req, res) => {
  const { name, price, type } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Product name is required' });
  if (price === undefined || price === null || Number(price) <= 0) {
    return res.status(400).json({ error: 'A price greater than 0 is required' });
  }
  if (type !== 'clothing') {
    return res.status(400).json({ error: "Type must be 'clothing'" });
  }
  const created = await db.createProduct(req.body);
  res.status(201).json(created);
}));

// PATCH /api/admin/products/:id — edit any field on an existing product
router.patch('/products/:id', asyncRoute(async (req, res) => {
  const updated = await db.updateProduct(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Product not found' });
  res.json(updated);
}));

// DELETE /api/admin/products/:id — permanently remove a product.
// Safe to do at any time: past orders store their own item snapshot
// (name/price/sku captured at purchase time), so order history is
// unaffected even after the product itself is deleted.
router.delete('/products/:id', asyncRoute(async (req, res) => {
  const deleted = await db.deleteProduct(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Product not found' });
  res.json({ deleted: true });
}));

module.exports = router;
