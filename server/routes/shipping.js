const express = require('express');
const crypto = require('crypto');
const shipping = require('../services/shipping');
const tracking = require('../services/tracking');
const db = require('../db/sqlite');
const { optionalAuth, canAccessOrder } = require('../middleware/auth');

const router = express.Router();

// POST /api/shipping/check-pincode  { pincode, amount, weightKg }
router.post('/check-pincode', async (req, res) => {
  try {
    const { pincode, amount = 0, weightKg = 0.3 } = req.body || {};
    const result = await shipping.checkServiceability({
      deliveryPincode: pincode,
      codAmount: amount,
      weightKg,
    });
    res.json(result);
  } catch (err) {
    console.error('[shipping] check-pincode failed:', err);
    res.status(500).json({ error: 'Could not check serviceability right now' });
  }
});

// GET /api/shipping/pincode/:pin — city/state for a PIN code (used to auto-fill checkout)
router.get('/pincode/:pin', async (req, res) => {
  try {
    const result = await shipping.lookupPincode(req.params.pin);
    res.json(result);
  } catch (err) {
    // Lookup is a convenience; the client falls back to manual entry on any failure.
    console.error('[shipping] pincode lookup failed:', err.message);
    res.status(502).json({ found: false, reason: 'PIN lookup is unavailable, please enter your city manually' });
  }
});

// GET /api/shipping/track/:orderId
// Pulls live tracking from Shiprocket, saves any change to the order, and returns it.
// Until the courier has actually picked the parcel up, the customer is told it's being
// prepared — never "shipped" just because the order was placed or a courier was booked.
router.get('/track/:orderId', optionalAuth, async (req, res) => {
  try {
    const found = db.getOrder(req.params.orderId);
    if (!found || !canAccessOrder(req, found)) return res.status(404).json({ error: 'Order not found' });
    const synced = await tracking.syncOrderTracking(req.params.orderId);
    if (!synced) return res.status(404).json({ error: 'Order not found' });
    const { order, tracking: t } = synced;
    const handedOver = ['shipped', 'delivered'].includes(order.status);
    if (!handedOver || !t) {
      return res.json({
        stage: 'processing', stageLabel: 'Packed — waiting for courier pickup', live: false, checkpoints: [],
        message: 'Tracking details appear here once the courier picks up your order',
      });
    }
    res.json(t);
  } catch (err) {
    console.error('[shipping] track failed:', err);
    res.status(500).json({ error: 'Could not fetch tracking right now' });
  }
});

// POST /api/shipping/webhook — Shiprocket pushes status changes here (Settings > API > Webhooks).
// Set SHIPROCKET_WEBHOOK_TOKEN in .env and put the same value as the token in Shiprocket.
// We never trust the payload's status: it only tells us WHICH order to refresh from the live API.
router.post('/webhook', async (req, res) => {
  const expected = process.env.SHIPROCKET_WEBHOOK_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Webhook not configured' });
  const given = String(req.get('x-api-key') || '');
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });

  const body = req.body || {};
  const ref = String(body.order_id || body.channel_order_id || '');
  res.status(200).json({ received: true }); // answer fast; Shiprocket retries on slow replies
  if (!ref) return;
  tracking.syncOrderTracking(ref).catch((e) => console.error('[shipping] webhook sync failed:', e.message));
});

module.exports = router;
