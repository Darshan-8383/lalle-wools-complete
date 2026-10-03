const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-pay-test-'));
process.env.LALLEWOOLS_DB_FILE = path.join(tmp, 'store.sqlite');
process.env.LALLEWOOLS_CATALOG_FILE = path.join(tmp, 'products.json');
fs.copyFileSync(path.join(__dirname, '..', 'server', 'data', 'products.json'), process.env.LALLEWOOLS_CATALOG_FILE);
process.env.JWT_SECRET = 'test-secret-' + 'x'.repeat(40);
process.env.NODE_ENV = 'test';
// Fake gateway keys: enough for signature maths. Nothing here ever contacts Razorpay.
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = 'fake_secret_for_tests';
delete process.env.SMTP_HOST;

const db = require('../server/db/sqlite');
const { app } = require('../server/index');
const { expireUnpaidOrders } = require('../server/services/housekeeping');

let server, base;
test.before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

const sign = (orderId, paymentId) => crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const verify = (body) => fetch(base + '/api/payment/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let n = 0;
async function makeOnlineOrder({ razorpayOrderId, qty = 1 } = {}) {
  const product = db.listProducts().find((p) => p.stock > 5);
  const order = await db.createOrderWithStockDecrement({
    items: [{ id: product.id, sku: product.sku, name: product.name, price: product.price, size: 'M', qty, weightGrams: 300 }],
    address: { name: 'T', phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
    amounts: { subtotal: product.price * qty, codFee: 0, total: product.price * qty, currency: 'INR' },
    payment: { method: 'online', status: 'awaiting_payment', razorpayOrderId: razorpayOrderId || `order_fake_${++n}` },
    customerId: null,
  });
  return { order, product };
}

test('verify: a valid signature for a DIFFERENT razorpay order cannot mark this order paid (replay attack)', async () => {
  const victim = (await makeOnlineOrder({ razorpayOrderId: 'order_victim' })).order;
  // Attacker legitimately paid their own cheap order "order_attacker" and holds a genuinely valid signature for it.
  const res = await verify({ orderId: victim.id, gatewayOrderId: 'order_attacker', gatewayPaymentId: 'pay_attacker', signature: sign('order_attacker', 'pay_attacker') });
  assert.equal(res.status, 400);
  const after = db.getOrder(victim.id);
  assert.notEqual(after.payment.status, 'paid');
  assert.notEqual(after.status, 'confirmed');
});

test('verify: correct payment confirms the order, and repeating it is harmless', async () => {
  const { order } = await makeOnlineOrder({ razorpayOrderId: 'order_ok' });
  const body = { orderId: order.id, gatewayOrderId: 'order_ok', gatewayPaymentId: 'pay_ok', signature: sign('order_ok', 'pay_ok') };
  const first = await verify(body);
  assert.equal(first.status, 200);
  assert.ok(['confirmed', 'shipped_pending_pickup'].includes(db.getOrder(order.id).status)); // mock shipment booking may already have advanced it
  const paidAt = db.getOrder(order.id).payment.paidAt;
  const second = await verify(body);
  assert.equal(second.status, 200);
  assert.equal(db.getOrder(order.id).payment.paidAt, paidAt, 'a replayed verify must not rewrite the payment');
});

test('verify: a bad signature is rejected and marks the attempt failed', async () => {
  const { order } = await makeOnlineOrder({ razorpayOrderId: 'order_bad' });
  const res = await verify({ orderId: order.id, gatewayOrderId: 'order_bad', gatewayPaymentId: 'pay_x', signature: 'deadbeef' });
  assert.equal(res.status, 400);
  assert.equal(db.getOrder(order.id).payment.status, 'failed');
});

const MIN = 60 * 1000;
test('expiry: abandoned online orders are cancelled and their stock released; COD and young orders are untouched', async () => {
  const unpaid = await makeOnlineOrder({ razorpayOrderId: 'order_stale', qty: 2 });
  const product = unpaid.product;
  const cod = await db.createOrderWithStockDecrement({
    items: [{ id: product.id, sku: product.sku, name: product.name, price: product.price, size: 'M', qty: 1, weightGrams: 300 }],
    address: { name: 'T', phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
    amounts: { subtotal: product.price, codFee: 40, total: product.price + 40, currency: 'INR' },
    payment: { method: 'cod', status: 'cod_pending' }, customerId: null,
  });
  const stockWhileHeld = db.getProduct(product.id).stock;

  // 10 minutes in: still within the payment window, nothing may be touched.
  assert.equal(await expireUnpaidOrders({ now: Date.now() + 10 * MIN }), 0);
  assert.equal(db.getOrder(unpaid.order.id).status, 'pending');

  // 3 hours later: the unpaid online order expires, the COD order (which is a real order) does not.
  assert.ok(await expireUnpaidOrders({ now: Date.now() + 180 * MIN }) >= 1);
  assert.equal(db.getOrder(unpaid.order.id).status, 'cancelled');
  assert.equal(db.getOrder(unpaid.order.id).payment.status, 'expired');
  assert.equal(db.getOrder(cod.id).status, 'pending');
  assert.ok(db.getProduct(product.id).stock >= stockWhileHeld + 2, 'at least the 2 reserved units came back (other abandoned test orders on this product release theirs too)');
});

test('late payment on an expired order is refunded, not resurrected', async () => {
  const { order } = await makeOnlineOrder({ razorpayOrderId: 'order_late' });
  await expireUnpaidOrders({ now: Date.now() + 180 * MIN });
  assert.equal(db.getOrder(order.id).status, 'cancelled');
  // "mock_payment_" ids take the refund service's no-network path, so this test never contacts Razorpay.
  const res = await verify({ orderId: order.id, gatewayOrderId: 'order_late', gatewayPaymentId: 'mock_payment_late', signature: sign('order_late', 'mock_payment_late') });
  assert.equal(res.status, 409);
  const after = db.getOrder(order.id);
  assert.equal(after.status, 'cancelled', 'must stay cancelled — its stock was already given back');
  assert.equal(after.payment.status, 'refunded');
});
