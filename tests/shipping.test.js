const test = require('node:test');
const assert = require('node:assert/strict');

// Make sure these tests exercise the "no gateway / no Shiprocket" paths.
for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD']) delete process.env[k];

const shipping = require('../server/services/shipping');
const payment = require('../server/services/payment');

test('classifyStatus maps courier text to stable stages', () => {
  assert.equal(shipping.classifyStatus('Out For Delivery'), 'out_for_delivery');
  assert.equal(shipping.classifyStatus('Delivered'), 'delivered');
  assert.equal(shipping.classifyStatus('Shipment Picked Up'), 'picked_up');
  assert.equal(shipping.classifyStatus('RTO Initiated'), 'returned');
  assert.equal(shipping.classifyStatus('Reached at destination hub'), 'in_transit');
});

test('manual shipments report only what we actually know, with no invented scans', async () => {
  const order = {
    createdAt: '2026-09-01T10:00:00.000Z',
    shipment: { awbCode: 'ABC123', manual: true, courierName: 'India Post', shippedAt: '2026-09-02T10:00:00.000Z', trackingUrl: 'https://example.com/t' },
  };
  const t = await shipping.trackShipment('ABC123', order);
  assert.equal(t.live, false);
  assert.equal(t.stage, 'booked');
  assert.equal(t.trackingUrl, 'https://example.com/t');
  assert.equal(t.checkpoints.length, 2);
});

test('lookupPincode rejects malformed PINs without any network call', async () => {
  for (const bad of ['', '12345', '012345', 'abcdef', null]) {
    const r = await shipping.lookupPincode(bad);
    assert.equal(r.found, false);
  }
});

test('online payment is unavailable without gateway keys (no fake success)', async () => {
  assert.equal(payment.isConfigured(), false);
  await assert.rejects(() => payment.createPaymentOrder({ orderId: 'X', amountRupees: 100 }), /not available/);
  assert.equal(payment.verifyPaymentSignature({ gatewayOrderId: 'o', gatewayPaymentId: 'p', signature: 'mock_signature' }), false);
  await assert.rejects(() => payment.refundPayment({ gatewayPaymentId: 'pay_real', amountRupees: 100 }), /not configured/);
});

test('production without Shiprocket keys refuses to fake a booking', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(() => shipping.createShipment({ id: 'X', items: [], amounts: {} }), /not configured/);
  } finally {
    process.env.NODE_ENV = prev;
  }
});

test('cancelShipment is skipped (never throws) without Shiprocket keys or for manual shipments', async () => {
  assert.deepEqual(await shipping.cancelShipment({ shipment: { shiprocketOrderId: 5 } }), { cancelled: false, skipped: true });
  assert.deepEqual(await shipping.cancelShipment({ shipment: { manual: true } }), { cancelled: false, skipped: true });
  assert.deepEqual(await shipping.cancelShipment({}), { cancelled: false, skipped: true });
});
