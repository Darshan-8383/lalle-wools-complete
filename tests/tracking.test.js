const test = require('node:test');
const assert = require('node:assert/strict');

for (const k of ['SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD']) delete process.env[k];
const { planTrackingUpdate } = require('../server/services/tracking');

const baseOrder = (over = {}) => ({
  id: 'LW1', status: 'confirmed',
  shipment: { awbCode: 'AWB1', shipmentId: 9, status: 'booked', bookedAt: '2026-10-01T10:00:00.000Z' },
  ...over,
});
const live = (stage, extra = {}) => ({ live: true, stage, courierName: 'Delhivery', checkpoints: [], ...extra });

test('a booked-but-not-picked-up shipment never makes the order "shipped"', () => {
  const plan = planTrackingUpdate(baseOrder(), live('booked'));
  assert.ok(!plan || plan.status === 'confirmed');
  assert.ok(!plan || !plan.shipment.shippedAt);
});

test('legacy shipped_pending_pickup orders go back to confirmed until a real pickup scan', () => {
  const plan = planTrackingUpdate(baseOrder({ status: 'shipped_pending_pickup' }), live('booked'));
  assert.equal(plan.status, 'confirmed');
});

test('courier pickup scan flips the order to shipped, using the courier scan time', () => {
  const at = '2026-10-02T08:30:00.000Z';
  const plan = planTrackingUpdate(baseOrder(), live('picked_up', { checkpoints: [{ status: 'Shipment Picked Up', at }] }));
  assert.equal(plan.status, 'shipped');
  assert.equal(plan.becameShipped, true);
  assert.equal(plan.shipment.shippedAt, at);
});

test('already shipped orders do not re-trigger the shipped email', () => {
  const o = baseOrder({ status: 'shipped', shipment: { awbCode: 'AWB1', shippedAt: '2026-10-02T08:30:00.000Z', status: 'picked_up' } });
  const plan = planTrackingUpdate(o, live('in_transit'));
  assert.ok(!plan || plan.becameShipped === false);
});

test('delivered scan completes the order with the delivery time', () => {
  const o = baseOrder({ status: 'shipped', shipment: { awbCode: 'AWB1', shippedAt: '2026-10-02T08:30:00.000Z' } });
  const at = '2026-10-05T12:00:00.000Z';
  const plan = planTrackingUpdate(o, live('delivered', { checkpoints: [{ status: 'Delivered', at }] }));
  assert.equal(plan.status, 'delivered');
  assert.equal(plan.shipment.deliveredAt, at);
});

test('non-live (manual / mock) tracking and cancelled orders never change status', () => {
  assert.equal(planTrackingUpdate(baseOrder(), { live: false, stage: 'delivered', checkpoints: [] }), null);
  assert.equal(planTrackingUpdate(baseOrder({ status: 'cancelled' }), live('picked_up')), null);
});

test('a courier RTO never moves a shipped order backwards', () => {
  const o = baseOrder({ status: 'shipped', shipment: { awbCode: 'AWB1', shippedAt: '2026-10-02T08:30:00.000Z' } });
  const plan = planTrackingUpdate(o, live('returned'));
  assert.equal(plan.status, 'shipped');
  assert.equal(plan.shipment.status, 'returned');
});
