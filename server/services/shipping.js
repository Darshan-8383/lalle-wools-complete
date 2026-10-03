/**
 * Shipping Service — Shiprocket-ready
 * ------------------------------------
 * Shiprocket is the most common shipping aggregator for Indian D2C brands
 * (it books Delhivery/Bluedart/Ecom Express/etc. under one API), so this
 * file is wired for it. If SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD are not
 * set in .env, every function below falls back to a realistic MOCK so the
 * whole checkout flow still works end-to-end during development.
 *
 * To go live:
 *   1. Create a Shiprocket account: https://www.shiprocket.in
 *   2. Add a pickup address in their dashboard, note its "pickup location" name
 *   3. Put SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD / SHIPROCKET_PICKUP_LOCATION
 *      in your .env
 *   4. That's it — this file already calls the real endpoints once creds exist.
 *
 * Swap to Delhivery/Pickrr/etc. instead? Keep the exported function names
 * identical (checkServiceability, createShipment, trackShipment) and just
 * change what's inside — nothing else in the codebase needs to change.
 */

const SHIPROCKET_BASE = 'https://apiv2.shiprocket.in/v1/external';

const isConfigured = () =>
  Boolean(process.env.SHIPROCKET_EMAIL && process.env.SHIPROCKET_PASSWORD);

let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const res = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Shiprocket auth failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  cachedToken = data.token;
  tokenExpiresAt = Date.now() + 9 * 24 * 60 * 60 * 1000; // token is valid ~10 days
  return cachedToken;
}

/**
 * Check whether a pincode is serviceable and estimate cost/ETA.
 * @param {{pickupPincode?: string, deliveryPincode: string, codAmount?: number, weightKg?: number}} params
 */
async function checkServiceability({ pickupPincode, deliveryPincode, codAmount = 0, weightKg = 0.3 }) {
  if (!isConfigured()) {
    // ---- No courier API configured: we can't know a real ETA, so give an honest, flat estimate
    // (not a made-up per-PIN number). Set up Shiprocket for real per-PIN estimates and COD checks.
    const isValid = /^[1-9][0-9]{5}$/.test(String(deliveryPincode || ''));
    if (!isValid) return { serviceable: false, reason: 'Invalid PIN code' };
    return {
      serviceable: true,
      mock: true,
      etaDays: 5,
      etaLabel: '5-7 business days',
      codAvailable: true,
      shippingFee: 0,
    };
  }

  const token = await getToken();
  const params = new URLSearchParams({
    pickup_postcode: pickupPincode || process.env.SHIPROCKET_PICKUP_PINCODE || '',
    delivery_postcode: deliveryPincode,
    cod: codAmount > 0 ? '1' : '0',
    weight: String(weightKg),
  });
  const res = await fetch(`${SHIPROCKET_BASE}/courier/serviceability/?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Shiprocket serviceability check failed: ${res.status}`);
  const data = await res.json();
  const couriers = data?.data?.available_courier_companies || [];
  if (!couriers.length) return { serviceable: false, reason: 'No courier available for this PIN code' };
  const cheapest = couriers.reduce((a, b) => (a.rate < b.rate ? a : b));
  return {
    serviceable: true,
    mock: false,
    etaDays: Number(cheapest.estimated_delivery_days) || 5,
    etaLabel: cheapest.etd || `${cheapest.estimated_delivery_days} days`,
    codAvailable: couriers.some((c) => c.cod === 1),
    shippingFee: Math.round(cheapest.rate),
    courierName: cheapest.courier_name,
  };
}

/**
 * Ask Shiprocket to assign a courier + AWB to an already-created shipment, then request pickup.
 * Order creation alone does NOT give an AWB, and without an AWB there is nothing to track.
 * Both steps are best-effort: if either fails the order stays booked and the background
 * sync (services/tracking.js) retries assigning the AWB later.
 * @returns {Promise<{awbCode: string|null, courierName: string|null}>}
 */
async function assignAwbAndPickup(shipmentId) {
  const token = await getToken();
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  let awbCode = null;
  let courierName = null;
  const res = await fetch(`${SHIPROCKET_BASE}/courier/assign/awb`, {
    method: 'POST', headers, body: JSON.stringify({ shipment_id: shipmentId }),
  });
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    const d = data?.response?.data || {};
    awbCode = d.awb_code || null;
    courierName = d.courier_name || null;
  } else {
    console.error(`[shipping] AWB assign failed for shipment ${shipmentId}: ${res.status}`);
  }
  if (awbCode) {
    const pr = await fetch(`${SHIPROCKET_BASE}/courier/generate/pickup`, {
      method: 'POST', headers, body: JSON.stringify({ shipment_id: [shipmentId] }),
    }).catch((e) => ({ ok: false, status: e.message }));
    if (!pr.ok) console.error(`[shipping] pickup request failed for shipment ${shipmentId}: ${pr.status}`);
  }
  return { awbCode, courierName };
}

/**
 * Create a shipment / forward order once payment is confirmed.
 * @param {object} order - full order record from db.js
 */
async function createShipment(order) {
  if (!isConfigured()) {
    // In production a fake booking is worse than a failed one: the order would be marked
    // "shipped" with a made-up AWB and never appear in Shiprocket. Fail loudly instead so the
    // error is stored on the order (shipment.bookingError) and the order stays "confirmed".
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Shiprocket is not configured (set SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD) - order was NOT sent to Shiprocket');
    }
    // ---- MOCK (development only): pretend we booked a courier ----
    return {
      mock: true,
      awbCode: 'MOCKAWB' + order.id,
      courierName: 'Mock Express',
      shipmentId: 'MOCKSHIP' + order.id,
      trackingUrl: `https://example.com/track/MOCKAWB${order.id}`,
      status: 'booked',
    };
  }

  const token = await getToken();
  const totalWeightKg = Math.max(
    0.1,
    (order.items.reduce((sum, i) => sum + (i.weightGrams || 250) * i.qty, 0)) / 1000
  );

  const payload = {
    order_id: order.id,
    order_date: new Date(order.createdAt).toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16), // "YYYY-MM-DD HH:mm"
    pickup_location: process.env.SHIPROCKET_PICKUP_LOCATION || 'Primary',
    billing_customer_name: order.address.name,
    billing_last_name: '',
    billing_address: order.address.line1,
    billing_address_2: order.address.line2 || '',
    billing_city: order.address.city,
    billing_pincode: order.address.pincode,
    billing_state: order.address.state,
    billing_country: 'India',
    billing_email: order.address.email || 'noemail@lallewools.com',
    billing_phone: String(order.address.phone).replace(/\D/g, '').slice(-10),
    shipping_is_billing: true,
    order_items: order.items.map((i) => ({
      name: i.name,
      sku: i.sku || `LW-${i.id}`,
      units: i.qty,
      selling_price: i.price,
    })),
    payment_method: order.payment.method === 'cod' ? 'COD' : 'Prepaid',
    // For COD this is the amount the courier collects, so it must include the COD fee.
    sub_total: order.amounts.total != null ? order.amounts.total : order.amounts.subtotal,
    length: 30,
    breadth: 24,
    height: 3,
    weight: Number(totalWeightKg.toFixed(2)),
  };

  const res = await fetch(`${SHIPROCKET_BASE}/orders/create/adhoc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Shiprocket order create failed: ${res.status} ${errText}`);
  }
  const data = await res.json();
  if (!data || !data.order_id) {
    throw new Error(`Shiprocket did not create the order: ${JSON.stringify(data).slice(0, 300)}`);
  }
  let awbCode = data.awb_code || null;
  let courierName = null;
  if (!awbCode && data.shipment_id) {
    try {
      ({ awbCode, courierName } = await assignAwbAndPickup(data.shipment_id));
    } catch (e) {
      console.error('[shipping] AWB assignment errored (will be retried by the sync job):', e.message);
    }
  }
  return {
    mock: false,
    shipmentId: data.shipment_id,
    shiprocketOrderId: data.order_id,
    status: 'booked',
    awbCode,
    courierName,
  };
}

/**
 * Cancel the Shiprocket order so no courier is sent (and no freight is charged) for a cancelled order.
 * Never throws: a failure here must not block the customer's cancellation/refund, it is returned
 * so the caller can store it on the order for the admin to see.
 * @returns {Promise<{cancelled: boolean, skipped?: boolean, error?: string}>}
 */
async function cancelShipment(order) {
  const s = (order && order.shipment) || {};
  if (!isConfigured() || s.mock || s.manual || !s.shiprocketOrderId) return { cancelled: false, skipped: true };
  try {
    const token = await getToken();
    const res = await fetch(`${SHIPROCKET_BASE}/orders/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ids: [s.shiprocketOrderId] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { cancelled: false, error: `Shiprocket cancel failed: ${res.status} ${body.slice(0, 200)}` };
    }
    return { cancelled: true };
  } catch (e) {
    return { cancelled: false, error: e.message };
  }
}

// Map any courier status text onto a small, stable set of stages the UI can rely on.
function classifyStatus(text = '') {
  const t = String(text).toLowerCase();
  if (/rto|return to origin|returned/.test(t)) return 'returned';
  if (/undeliver|failed|attempt|ndr|exception/.test(t)) return 'attention';
  if (/out for delivery|ofd/.test(t)) return 'out_for_delivery';
  if (/delivered/.test(t)) return 'delivered';
  if (/in transit|reached|arrived|departed|dispatched|hub|shipped|forwarded/.test(t)) return 'in_transit';
  if (/picked|pickup done|collected/.test(t)) return 'picked_up';
  if (/pickup|awb|manifest|booked|label|ready to ship|scheduled/.test(t)) return 'booked';
  return 'in_transit';
}

const STAGE_LABELS = {
  booked: 'Shipment booked',
  picked_up: 'Picked up by courier',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  attention: 'Delivery attempt needs attention',
  returned: 'Returning to seller',
};

/**
 * Track a shipment by AWB. Always returns the same normalized shape:
 *   { awbCode, courierName, stage, stageLabel, trackingUrl, etd, delivered, checkpoints: [{ status, location, at }] }
 * `order` is optional; it is only used to describe shipments that were booked
 * manually/with a placeholder AWB (no courier API to ask).
 */
async function trackShipment(awbCode, order = null) {
  const shipment = (order && order.shipment) || {};

  // Shipments with no live courier feed: manual AWBs, or bookings made while
  // Shiprocket isn't configured. Report what we actually know (our own events)
  // rather than inventing courier scans.
  if (!isConfigured() || String(awbCode).startsWith('MOCKAWB') || shipment.manual) {
    const checkpoints = [];
    if (order) checkpoints.push({ status: 'Order placed', location: '', at: order.createdAt });
    if (shipment.shippedAt) checkpoints.push({ status: `Handed to ${shipment.courierName || 'courier'}${awbCode ? ` (AWB ${awbCode})` : ''}`, location: '', at: shipment.shippedAt });
    if (shipment.deliveredAt) checkpoints.push({ status: 'Delivered', location: '', at: shipment.deliveredAt });
    const stage = shipment.deliveredAt ? 'delivered' : 'booked';
    return {
      awbCode,
      courierName: shipment.courierName || null,
      stage,
      stageLabel: STAGE_LABELS[stage],
      trackingUrl: shipment.manual && shipment.trackingUrl ? shipment.trackingUrl : null,
      etd: shipment.estimatedDeliveryDate || null,
      delivered: stage === 'delivered',
      live: false,
      checkpoints,
    };
  }

  const token = await getToken();
  const res = await fetch(`${SHIPROCKET_BASE}/courier/track/awb/${encodeURIComponent(awbCode)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Shiprocket tracking failed: ${res.status}`);
  const raw = await res.json();
  const td = raw.tracking_data || {};
  const track = Array.isArray(td.shipment_track) ? td.shipment_track[0] || {} : {};
  const activities = Array.isArray(td.shipment_track_activities) ? td.shipment_track_activities : [];

  const checkpoints = activities
    .map((a) => ({
      status: a['sr-status-label'] || a.activity || a.status || 'Update',
      detail: a.activity && a['sr-status-label'] && a.activity !== a['sr-status-label'] ? a.activity : '',
      location: a.location || '',
      at: a.date ? new Date(String(a.date).replace(' ', 'T') + '+05:30').toISOString() : null,
    }))
    .filter((c) => c.at)
    .sort((x, y) => new Date(x.at) - new Date(y.at));

  const currentText = track.current_status || (checkpoints.length ? checkpoints[checkpoints.length - 1].status : '');
  const stage = currentText ? classifyStatus(currentText) : 'booked';
  return {
    awbCode,
    courierName: track.courier_name || null,
    stage,
    stageLabel: currentText || STAGE_LABELS[stage],
    trackingUrl: td.track_url || null,
    etd: track.edd || td.etd || null,
    delivered: stage === 'delivered',
    live: true,
    checkpoints,
  };
}

// ── PIN code → city/state (India Post public API) ─────────────────────
// Results are cached in memory: PIN → place data never changes in practice,
// and this keeps us well clear of the free API's rate limits.
const pinCache = new Map();

async function lookupPincode(pincode) {
  const pin = String(pincode || '').trim();
  if (!/^[1-9][0-9]{5}$/.test(pin)) return { found: false, reason: 'Invalid PIN code' };
  if (pinCache.has(pin)) return pinCache.get(pin);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${pin}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`India Post lookup failed: ${res.status}`);
    const data = await res.json();
    const entry = Array.isArray(data) ? data[0] : null;
    const offices = entry && entry.Status === 'Success' ? entry.PostOffice || [] : [];
    if (!offices.length) {
      const miss = { found: false, reason: 'PIN code not found' };
      pinCache.set(pin, miss); // a genuinely unknown PIN is stable, cache it too
      return miss;
    }
    // "District" is what people mean by city (e.g. "Bengaluru"); fall back to the post office's own block/name.
    const first = offices[0];
    const result = {
      found: true,
      pincode: pin,
      city: first.District || first.Block || first.Name,
      state: first.State,
      areas: [...new Set(offices.map((o) => o.Name).filter(Boolean))].slice(0, 15),
    };
    pinCache.set(pin, result);
    return result;
  } finally {
    clearTimeout(timer); // network errors propagate to the route, and are deliberately NOT cached
  }
}

module.exports = { isConfigured, checkServiceability, createShipment, cancelShipment, assignAwbAndPickup, trackShipment, lookupPincode, classifyStatus, STAGE_LABELS };
