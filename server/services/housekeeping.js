/**
 * Background clean-up jobs.
 *
 * expireUnpaidOrders: when someone starts an ONLINE payment and then abandons it (closes the tab,
 * payment fails), their order sits in "awaiting_payment" and keeps its stock reserved. Left alone,
 * a popular item could appear "sold out" to everyone else forever. After UNPAID_MAX_AGE_MS we
 * cancel the order and put the stock back. COD orders are never touched.
 */
const db = require('../db/sqlite');

const UNPAID_MAX_AGE_MS = 30 * 60 * 1000;   // Razorpay's own checkout session is shorter than this
const SWEEP_EVERY_MS = 10 * 60 * 1000;

async function expireUnpaidOrders({ now = Date.now(), maxAgeMs = UNPAID_MAX_AGE_MS } = {}) {
  const candidates = db.listAllOrders({ status: 'pending', limit: 500 }).filter((o) =>
    o.payment && o.payment.method !== 'cod' && o.payment.status === 'awaiting_payment' &&
    now - Date.parse(o.createdAt) > maxAgeMs);

  let expired = 0;
  for (const o of candidates) {
    // Re-read right before acting: the customer may have paid in the last few milliseconds.
    const fresh = db.getOrder(o.id);
    if (!fresh || fresh.status !== 'pending' || fresh.payment.status !== 'awaiting_payment') continue;
    await db.updateOrder(fresh.id, { status: 'cancelled', payment: { ...fresh.payment, status: 'expired' } });
    await db.restoreStock(fresh.items);
    expired++;
  }
  return expired;
}

function startHousekeeping() {
  const tick = () => expireUnpaidOrders()
    .then((n) => { if (n) console.log(`[housekeeping] expired ${n} unpaid order(s) and released their stock`); })
    .catch((err) => console.error('[housekeeping] failed:', err.message));
  const t = setInterval(tick, SWEEP_EVERY_MS);
  t.unref();
  return () => clearInterval(t);
}

module.exports = { expireUnpaidOrders, startHousekeeping, UNPAID_MAX_AGE_MS };
