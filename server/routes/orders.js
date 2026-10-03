const express = require('express');
const db = require('../db/sqlite');
const shipping = require('../services/shipping');
const payment = require('../services/payment');
const email = require('../services/email');
const { streamInvoice } = require('../services/invoice');
const { optionalAuth, requireAuth, canAccessOrder, signInvoiceToken, verifyInvoiceToken, lastTen } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { requireVerifiedEmail } = require('../middleware/verifiedEmail');

const router = express.Router();

const COD_FEE = 40;
const SHIPPING_FEE = 50; // flat delivery charge on every order

/** Recompute cart totals from the live database — never trust client-sent prices. */
function priceCart(items) {
  const priced = [];
  for (const line of items) {
    const product = db.getProduct(line.id);
    if (!product || !product.active) throw Object.assign(new Error(`Product ${line.id} is unavailable`), { status: 400 });
    const qty = Math.max(1, Number(line.qty) || 1);
    priced.push({
      id: product.id,
      sku: product.sku,
      name: product.name,
      price: product.price,
      emoji: product.emoji,
      image: product.image || null,
      size: product.type === 'clothing' ? (line.size || 'M') : 'NA',
      qty,
      weightGrams: product.weightGrams || 250,
    });
  }
  const subtotal = priced.reduce((sum, i) => sum + i.price * i.qty, 0);
  return { priced, subtotal };
}

function validateAddress(address = {}) {
  const required = ['name', 'phone', 'line1', 'city', 'pincode', 'state'];
  const missing = required.filter((k) => !address[k] || !String(address[k]).trim());
  if (missing.length) throw Object.assign(new Error(`Missing address fields: ${missing.join(', ')}`), { status: 400 });
  if (!/^[1-9][0-9]{5}$/.test(String(address.pincode))) throw Object.assign(new Error('Invalid PIN code'), { status: 400 });
  if (!/^[6-9]\d{9}$/.test(String(address.phone).replace(/\D/g, '').slice(-10))) {
    throw Object.assign(new Error('Invalid phone number'), { status: 400 });
  }
}

// POST /api/orders — create a new order. Requires login (the frontend
// prompts the account modal before ever reaching checkout, and this is the
// matching server-side enforcement so the requirement can't be bypassed by
// calling the API directly). Stock is checked & decremented atomically
// inside db.createOrderWithStockDecrement — if two customers race for the
// last unit, only one of them succeeds.
router.post('/', requireAuth, requireVerifiedEmail, asyncRoute(async (req, res) => {
  const { items, address, paymentMethod } = req.body || {};
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('Cart is empty'), { status: 400 });
  if (!['online', 'cod'].includes(paymentMethod)) {
    throw Object.assign(new Error('Invalid payment method'), { status: 400 });
  }
  // Check this BEFORE creating the order, so stock is never reserved for a
  // payment that cannot possibly be taken.
  if (paymentMethod === 'online' && !payment.isConfigured()) {
    throw Object.assign(new Error('Online payments are not available right now. Please choose Cash on Delivery.'), { status: 503 });
  }
  validateAddress(address);
  const { priced, subtotal } = priceCart(items);

  const codFee = paymentMethod === 'cod' ? COD_FEE : 0;
  const total = subtotal + SHIPPING_FEE + codFee;
  const customerId = req.user.sub;

  // Estimate delivery date up front (same serviceability check checkout
  // step 2 already showed the customer) so "My Orders" and the order detail
  // page can show a real expected delivery date, not just a status word.
  const totalWeightKg = Math.max(0.1, priced.reduce((sum, i) => sum + (i.weightGrams || 250) * i.qty, 0) / 1000);
  let initialShipment = { status: 'processing' };
  try {
    const estimate = await shipping.checkServiceability({
      deliveryPincode: address.pincode,
      codAmount: codFee > 0 ? total : 0,
      weightKg: totalWeightKg,
    });
    if (estimate.serviceable) {
      const etaDays = estimate.etaDays || 6;
      initialShipment.estimatedDeliveryDate = new Date(Date.now() + etaDays * 86400000).toISOString();
      initialShipment.etaLabel = estimate.etaLabel;
    }
  } catch (e) {
    // Non-fatal — order still goes through without a delivery estimate, it just won't show one yet.
    console.error('[orders] delivery estimate failed:', e.message);
  }

  const order = await db.createOrderWithStockDecrement({
    items: priced,
    address: {
      name: address.name, phone: address.phone, email: address.email || null,
      line1: address.line1, line2: address.line2 || '', city: address.city,
      pincode: address.pincode, state: address.state,
    },
    amounts: { subtotal, shippingFee: SHIPPING_FEE, codFee, total, currency: 'INR' },
    payment: { method: paymentMethod, status: paymentMethod === 'cod' ? 'cod_pending' : 'awaiting_payment' },
    customerId,
    shipment: initialShipment,
  });

  if (paymentMethod === 'cod') {
    const confirmed = await db.updateOrder(order.id, {
      status: 'confirmed',
      payment: { ...order.payment, status: 'cod_confirmed', confirmedAt: new Date().toISOString() },
    });
    bookShipmentInBackground(confirmed.id);
    sendConfirmationEmail(confirmed);
    return res.status(201).json(confirmed);
  }

  res.status(201).json(order);
}));

// GET /api/orders/:id — the owner (logged in), or a guest who also supplies the order's phone number.
// A wrong id and a wrong phone give the same answer, so this can't be used to discover which order ids exist.
router.get('/:id', optionalAuth, asyncRoute(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order || !canAccessOrder(req, order)) return res.status(404).json({ error: 'Order not found. Check the Order ID and phone number.' });
  res.json(order);
}));

// POST /api/orders/:id/invoice-link — returns a 10-minute link to the PDF (same access rule as viewing the order).
router.post('/:id/invoice-link', optionalAuth, asyncRoute(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order || !canAccessOrder(req, order)) return res.status(404).json({ error: 'Order not found' });
  if (db.isNeverPaid(order)) return res.status(409).json({ error: 'An invoice is available once payment is complete.' });
  res.json({ url: `/api/orders/${order.id}/invoice?t=${signInvoiceToken(order.id)}` });
}));

// GET /api/orders/:id/invoice?t=<token> — PDF invoice. A record of a completed sale, so none until the order is real.
router.get('/:id/invoice', optionalAuth, asyncRoute(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const allowed = verifyInvoiceToken(req.query.t, order.id) || (req.user && canAccessOrder(req, order));
  if (!allowed) return res.status(404).json({ error: 'Order not found' });
  if (db.isNeverPaid(order)) return res.status(409).json({ error: 'An invoice is available once payment is complete.' });
  res.set('Cache-Control', 'private, no-store');
  streamInvoice(order, res);
}));

// POST /api/orders/:id/abandon — the customer closed the payment window without paying.
// The order was never confirmed, so release it right away: stock goes back on the shelf immediately (otherwise the
// customer's own unpaid order would hold it and a retry could fail with "only 0 left"). No email — nothing was placed.
// If money was somehow captured at the same instant, /payment/verify and the webhook refund it automatically.
router.post('/:id/abandon', requireAuth, asyncRoute(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order || order.customerId !== req.user.sub) return res.status(404).json({ error: 'Order not found' });
  if (order.payment.method === 'cod' || order.payment.status === 'paid' || order.status !== 'pending') {
    return res.status(400).json({ error: 'This order is already confirmed and cannot be dropped.' });
  }
  await db.restoreStock(order.items);
  const updated = await db.updateOrder(order.id, { status: 'cancelled', payment: { ...order.payment, status: 'abandoned' } });
  res.json({ abandoned: true, order: updated });
}));

// POST /api/orders/:id/cancel — customer (if it's their order) or guest with matching phone can cancel
// while the order hasn't shipped yet. Restores stock and refunds if paid.
router.post('/:id/cancel', optionalAuth, asyncRoute(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const isOwner = req.user && order.customerId === req.user.sub;
  const phoneMatches = req.body && req.body.phone && lastTen(req.body.phone).length === 10 && lastTen(req.body.phone) === lastTen(order.address.phone);
  if (!isOwner && !phoneMatches) {
    return res.status(403).json({ error: 'We could not verify this order belongs to you' });
  }
  if (!['pending', 'confirmed'].includes(order.status)) {
    return res.status(400).json({ error: `This order can no longer be cancelled (status: ${order.status})` });
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
  email.sendEmail({ to: updated.address.email, subject, html }).catch((e) => console.error('[email] cancellation email failed:', e.message));

  res.json(updated);
}));

/** Fire-and-forget shipment booking so the HTTP response isn't held up by Shiprocket's API. */
function bookShipmentInBackground(orderId) {
  const order = db.getOrder(orderId);
  if (!order) return;
  shipping
    .createShipment(order)
    .then(async (bookingResult) => {
      // Booking with the courier is NOT shipping. The order stays "confirmed" (shown to the
      // customer as "being packed") until Shiprocket reports the parcel as picked up —
      // services/tracking.js flips it to "shipped" and sends the shipped email at that point.
      // Merge onto the existing shipment so the delivery estimate set at order creation survives.
      const shipment = { ...order.shipment, ...bookingResult, bookedAt: new Date().toISOString() };
      await db.updateOrder(orderId, { shipment });
    })
    .catch(async (err) => {
      console.error(`[shipping] failed to book shipment for ${orderId}:`, err.message);
      try {
        await db.updateOrder(orderId, { shipment: { ...order.shipment, bookingError: err.message } });
      } catch (e) { /* best-effort — don't let a logging failure crash anything */ }
    });
}

function sendConfirmationEmail(order) {
  const { subject, html } = email.orderConfirmationEmail(order);
  email.sendEmail({ to: order.address.email, subject, html }).catch((e) => console.error('[email] confirmation email failed:', e.message));
}

module.exports = { router, priceCart, validateAddress, bookShipmentInBackground, sendConfirmationEmail, COD_FEE, SHIPPING_FEE };
