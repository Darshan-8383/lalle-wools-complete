const express = require('express');
const db = require('../db/sqlite');
const payment = require('../services/payment');
const { bookShipmentInBackground, sendConfirmationEmail } = require('./orders');
const { asyncRoute } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/payment/create-order  { orderId }
router.post('/create-order', requireAuth, asyncRoute(async (req, res) => {
  const { orderId } = req.body || {};
  const order = db.getOrder(orderId);
  if (!order || order.customerId !== req.user.sub) return res.status(404).json({ error: 'Order not found' });
  if (order.payment.method === 'cod') return res.status(400).json({ error: 'This order is Cash on Delivery' });
  if (order.payment.status === 'paid') return res.status(400).json({ error: 'Order already paid' });
  if (order.status === 'cancelled') return res.status(400).json({ error: 'This order has expired. Please place a new order.' });
  if (!payment.isConfigured()) return res.status(503).json({ error: 'Online payments are not available right now. Please choose Cash on Delivery.' });

  const gatewayOrder = await payment.createPaymentOrder({
    orderId: order.id,
    amountRupees: order.amounts.total,
    notes: { orderId: order.id, customer: order.address.name },
  });

  await db.updateOrder(order.id, {
    payment: { ...order.payment, razorpayOrderId: gatewayOrder.gatewayOrderId },
  });

  res.json({
    keyId: gatewayOrder.keyId,
    gatewayOrderId: gatewayOrder.gatewayOrderId,
    amountPaise: gatewayOrder.amountPaise,
    currency: gatewayOrder.currency,
    orderId: order.id,
    customer: { name: order.address.name, phone: order.address.phone, email: order.address.email },
  });
}));

/**
 * Money arrived for an order we had already cancelled (the checkout sat open past the expiry, so its stock
 * was released). Don't resurrect the order — give the money straight back.
 */
async function refundLatePayment(order, gatewayPaymentId) {
  try {
    const refund = await payment.refundPayment({ gatewayPaymentId, amountRupees: order.amounts.total });
    await db.updateOrder(order.id, { payment: { ...order.payment, status: 'refunded', gatewayPaymentId, refund } });
    console.warn(`[payment] late payment on cancelled order ${order.id} was refunded automatically`);
  } catch (err) {
    // The one case a human must act on: log loudly with everything needed to refund by hand in the Razorpay dashboard.
    await db.updateOrder(order.id, { payment: { ...order.payment, status: 'paid_after_cancel_NEEDS_REFUND', gatewayPaymentId } });
    console.error(`[payment] !!! MANUAL REFUND NEEDED: order ${order.id}, Razorpay payment ${gatewayPaymentId}, ₹${order.amounts.total}:`, err.message);
  }
}

// POST /api/payment/verify  { orderId, gatewayOrderId, gatewayPaymentId, signature }
router.post('/verify', asyncRoute(async (req, res) => {
  const { orderId, gatewayOrderId, gatewayPaymentId, signature } = req.body || {};
  const order = db.getOrder(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // The signature only proves "Razorpay says payment P was made against Razorpay-order G". It says nothing about
  // WHICH of our orders G belongs to — so G must be the Razorpay order WE created for this exact order. Without this
  // check, paying a cheap order and replaying its signature would "verify" any other order.
  if (!order.payment.razorpayOrderId || gatewayOrderId !== order.payment.razorpayOrderId) {
    return res.status(400).json({ error: 'Payment does not match this order', verified: false });
  }

  const ok = payment.verifyPaymentSignature({ gatewayOrderId, gatewayPaymentId, signature });
  if (!ok) {
    if (order.payment.status !== 'paid') await db.updateOrder(orderId, { payment: { ...order.payment, status: 'failed' } });
    return res.status(400).json({ error: 'Payment verification failed', verified: false });
  }

  if (order.payment.status === 'paid') return res.json({ verified: true, order }); // idempotent: no second email/shipment

  if (order.status === 'cancelled') {
    await refundLatePayment(order, gatewayPaymentId);
    return res.status(409).json({ error: 'Your payment arrived after this order expired, so it has been refunded. Please place the order again.', verified: false });
  }

  const updated = await db.updateOrder(orderId, {
    status: 'confirmed',
    payment: {
      ...order.payment,
      status: 'paid',
      gatewayOrderId,
      gatewayPaymentId,
      paidAt: new Date().toISOString(),
    },
  });
  sendConfirmationEmail(updated);
  bookShipmentInBackground(orderId);
  res.json({ verified: true, order: updated });
}));

// POST /api/payment/webhook — Razorpay server-to-server confirmation (belt & suspenders vs. verify)
// Configure this URL in Razorpay Dashboard > Settings > Webhooks.
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const ok = payment.verifyWebhookSignature(req.body, signature);
    if (!ok) return res.status(400).send('invalid signature');

    const event = JSON.parse(req.body.toString('utf-8'));
    if (event.event === 'payment.captured') {
      const entity = event.payload?.payment?.entity;
      const gatewayOrderId = entity?.order_id;
      const order = db.findOrderByRazorpayOrderId(gatewayOrderId);
      if (order && order.payment.status !== 'paid' && order.status === 'cancelled') {
        await refundLatePayment(order, entity?.id);
      } else if (order && order.payment.status !== 'paid') {
        const updated = await db.updateOrder(order.id, {
          status: 'confirmed',
          payment: { ...order.payment, status: 'paid', gatewayPaymentId: entity?.id || order.payment.gatewayPaymentId, paidAt: new Date().toISOString() },
        });
        sendConfirmationEmail(updated);
        bookShipmentInBackground(order.id);
      }
    } else if (event.event === 'payment.failed') {
      const gatewayOrderId = event.payload?.payment?.entity?.order_id;
      const order = db.findOrderByRazorpayOrderId(gatewayOrderId);
      if (order && order.payment.status !== 'paid') {
        await db.updateOrder(order.id, { payment: { ...order.payment, status: 'failed' } });
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[payment] webhook error:', err);
    res.status(500).send('webhook error');
  }
});

module.exports = router;
