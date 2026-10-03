/**
 * Tracking sync — keeps our order records in step with what Shiprocket reports.
 *
 * Rule: an order is only "shipped" once the courier has ACTUALLY picked the parcel up
 * (Shiprocket reports picked-up / in-transit / out-for-delivery). Booking a shipment with
 * Shiprocket, getting an AWB, or scheduling a pickup is NOT shipping — until the courier
 * scan arrives the customer sees "Order confirmed / being packed".
 *
 * Driven three ways, all through syncOrderTracking():
 *   - the customer opening an order (GET /api/shipping/track/:id)
 *   - Shiprocket's webhook (POST /api/shipping/webhook)
 *   - a background poll every few minutes (startTrackingSync, wired in index.js)
 */
const db = require('../db/sqlite');
const shipping = require('./shipping');
const email = require('./email');

// Courier stage -> order status. Anything not listed here never changes the order status.
const STAGE_TO_ORDER_STATUS = {
  picked_up: 'shipped',
  in_transit: 'shipped',
  out_for_delivery: 'shipped',
  attention: 'shipped', // courier has it, a delivery attempt failed
  delivered: 'delivered',
};
const SHIPPED_STAGES = new Set(['picked_up', 'in_transit', 'out_for_delivery', 'attention', 'delivered', 'returned']);
const POLL_EVERY_MS = 15 * 60 * 1000;

/**
 * Pure: given an order and a normalized tracking result, return the update to save (or null).
 * Only LIVE courier data can move an order forward; it never moves one backwards.
 */
function planTrackingUpdate(order, tracking) {
  if (!order || !tracking || !tracking.live) return null;
  if (['cancelled', 'delivered'].includes(order.status)) return null;

  const current = order.status === 'shipped_pending_pickup' ? 'confirmed' : order.status; // legacy value
  const next = STAGE_TO_ORDER_STATUS[tracking.stage] || current;
  const shipment = { ...(order.shipment || {}) };
  let changed = false;

  if (tracking.stage && shipment.status !== tracking.stage) { shipment.status = tracking.stage; changed = true; }
  if (tracking.courierName && !shipment.courierName) { shipment.courierName = tracking.courierName; changed = true; }
  if (tracking.trackingUrl && shipment.trackingUrl !== tracking.trackingUrl) { shipment.trackingUrl = tracking.trackingUrl; changed = true; }

  const becameShipped = next === 'shipped' && order.status !== 'shipped';
  if (SHIPPED_STAGES.has(tracking.stage) && !shipment.shippedAt) {
    // Use the courier's own pickup scan time when we have it, so the timeline shows the real date.
    const pickup = (tracking.checkpoints || []).find((c) => ['picked_up', 'in_transit'].includes(shipping.classifyStatus(c.status)));
    shipment.shippedAt = (pickup && pickup.at) || new Date().toISOString();
    changed = true;
  }
  if (next === 'delivered' && !shipment.deliveredAt) {
    const cps = tracking.checkpoints || [];
    shipment.deliveredAt = cps.length ? cps[cps.length - 1].at : new Date().toISOString();
    changed = true;
  }
  if (!changed && next === order.status) return null;
  return { status: next, shipment, becameShipped };
}

/** Fetch live tracking for one order, save any change, send the "shipped" email once. */
async function syncOrderTracking(orderId) {
  let order = db.getOrder(orderId);
  if (!order) return null;
  if (['cancelled'].includes(order.status) || !order.shipment) return { order, tracking: null };

  // Shiprocket sometimes hasn't handed out an AWB at booking time — try again now.
  if (!order.shipment.awbCode && order.shipment.shipmentId && shipping.isConfigured() && !order.shipment.manual && !order.shipment.mock) {
    try {
      const { awbCode, courierName } = await shipping.assignAwbAndPickup(order.shipment.shipmentId);
      if (awbCode) order = await db.updateOrder(order.id, { shipment: { ...order.shipment, awbCode, courierName: courierName || order.shipment.courierName } });
    } catch (e) { console.error(`[tracking] AWB retry failed for ${order.id}:`, e.message); }
  }
  if (!order.shipment.awbCode) return { order, tracking: null };

  const tracking = await shipping.trackShipment(order.shipment.awbCode, order);
  const plan = planTrackingUpdate(order, tracking);
  if (plan) {
    const { becameShipped, ...patch } = plan;
    order = await db.updateOrder(order.id, patch);
    if (becameShipped) {
      const { subject, html } = email.shippedEmail(order);
      email.sendEmail({ to: order.address.email, subject, html }).catch((e) => console.error('[email] shipped email failed:', e.message));
    }
  }
  return { order, tracking };
}

/** Background pass over every order that Shiprocket might have news about. */
async function syncActiveShipments() {
  if (!shipping.isConfigured()) return 0;
  const active = ['confirmed', 'shipped_pending_pickup', 'shipped']
    .flatMap((status) => db.listAllOrders({ status, limit: 200 }))
    .filter((o) => o.shipment && (o.shipment.awbCode || o.shipment.shipmentId) && !o.shipment.manual && !o.shipment.mock);
  let n = 0;
  for (const o of active) {
    try { await syncOrderTracking(o.id); n++; } catch (e) { console.error(`[tracking] sync failed for ${o.id}:`, e.message); }
  }
  return n;
}

function startTrackingSync() {
  const tick = () => syncActiveShipments().catch((e) => console.error('[tracking] poll failed:', e.message));
  const first = setTimeout(tick, 30 * 1000);
  const t = setInterval(tick, POLL_EVERY_MS);
  first.unref(); t.unref();
  return () => { clearTimeout(first); clearInterval(t); };
}

module.exports = { planTrackingUpdate, syncOrderTracking, syncActiveShipments, startTrackingSync, STAGE_TO_ORDER_STATUS };
