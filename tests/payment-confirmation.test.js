const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// An online order is NOT a real order until it is paid. These tests pin that down end to end.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-payconfirm-test-'));
process.env.LALLEWOOLS_DB_FILE = path.join(tmp, 'store.sqlite');
process.env.LALLEWOOLS_CATALOG_FILE = path.join(tmp, 'products.json');
fs.copyFileSync(path.join(__dirname, '..', 'server', 'data', 'products.json'), process.env.LALLEWOOLS_CATALOG_FILE);
process.env.JWT_SECRET = 'test-secret-' + 'x'.repeat(40);
process.env.NODE_ENV = 'test';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = 'fake_secret_for_tests';
delete process.env.SMTP_HOST;

const db = require('../server/db/sqlite');
const { app } = require('../server/index');
const { signCustomerToken } = require('../server/middleware/auth');
const { signAdminToken } = require('../server/middleware/adminAuth');

let server, base, product, user, other, token, otherToken;
const call = (method, url, body, tok) => fetch(base + url, {
  method,
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function unpaidOnlineOrder(customerId) {
  return db.createOrderWithStockDecrement({
    items: [{ id: product.id, sku: product.sku, name: product.name, price: product.price, size: 'M', qty: 1, weightGrams: 300 }],
    address: { name: 'T', phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
    amounts: { subtotal: product.price, shippingFee: 50, codFee: 0, total: product.price + 50, currency: 'INR' },
    payment: { method: 'online', status: 'awaiting_payment' }, customerId,
  });
}

test.before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  product = db.listProducts().find((p) => p.stock > 5);
  user = await db.createUser({ name: 'Buyer', email: 'buyer@example.com', passwordHash: 'x' });
  other = await db.createUser({ name: 'Other', email: 'other@example.com', passwordHash: 'x' });
  token = signCustomerToken(user);
  otherToken = signCustomerToken(other);
});
test.after(() => new Promise((r) => server.close(r)));

test('an unpaid online order stays "pending": no confirmation, and no invoice', async () => {
  const order = await unpaidOnlineOrder(user.id);
  assert.equal(order.status, 'pending');
  assert.equal(order.payment.status, 'awaiting_payment');
  const inv = await call('GET', `/api/orders/${order.id}/invoice`, undefined, token);
  assert.equal(inv.status, 409);
});

test('admin cannot ship or deliver an order whose payment has not been received', async () => {
  const order = await unpaidOnlineOrder(user.id);
  const admin = signAdminToken();
  const ship = await call('POST', `/api/admin/orders/${order.id}/ship`, { awbCode: 'AWB123' }, admin);
  assert.equal(ship.status, 400);
  assert.match((await ship.json()).error, /Payment has not been received/);
  const deliver = await call('POST', `/api/admin/orders/${order.id}/deliver`, {}, admin);
  assert.equal(deliver.status, 400);
  assert.equal(db.getOrder(order.id).status, 'pending');
});

test('unpaid online orders do not count toward the admin order/revenue stats; COD orders do', async () => {
  const before = db.orderStats();
  await unpaidOnlineOrder(user.id);
  assert.deepEqual(db.orderStats(), before, 'an unpaid order must not change the dashboard numbers');
  const cod = await db.createOrderWithStockDecrement({
    items: [{ id: product.id, sku: product.sku, name: product.name, price: product.price, size: 'M', qty: 1, weightGrams: 300 }],
    address: { name: 'T', phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
    amounts: { subtotal: product.price, shippingFee: 50, codFee: 40, total: product.price + 90, currency: 'INR' },
    payment: { method: 'cod', status: 'cod_confirmed' }, customerId: user.id,
  });
  const after = db.orderStats();
  assert.equal(after.totalOrders, before.totalOrders + 1);
  assert.equal(after.totalRevenue, before.totalRevenue + cod.amounts.total);
});

test('closing the payment window releases the order and its stock immediately; it vanishes from My Orders', async () => {
  const stockBefore = db.getProduct(product.id).stock;
  const order = await unpaidOnlineOrder(user.id);
  assert.equal(db.getProduct(product.id).stock, stockBefore - 1);

  const res = await call('POST', `/api/orders/${order.id}/abandon`, undefined, token);
  assert.equal(res.status, 200);
  const after = db.getOrder(order.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(after.payment.status, 'abandoned');
  assert.equal(db.getProduct(product.id).stock, stockBefore, 'the reserved unit is back on the shelf');

  const mine = await (await call('GET', '/api/auth/orders', undefined, token)).json();
  assert.ok(!mine.some((o) => o.id === order.id), 'an order that was never paid for is not shown as an order');
});

test('abandon is owner-only and refuses paid / COD orders', async () => {
  const order = await unpaidOnlineOrder(user.id);
  assert.equal((await call('POST', `/api/orders/${order.id}/abandon`)).status, 401);
  assert.equal((await call('POST', `/api/orders/${order.id}/abandon`, undefined, otherToken)).status, 404);

  await db.updateOrder(order.id, { status: 'confirmed', payment: { ...order.payment, status: 'paid', paidAt: new Date().toISOString() } });
  assert.equal((await call('POST', `/api/orders/${order.id}/abandon`, undefined, token)).status, 400);
  assert.equal(db.getOrder(order.id).status, 'confirmed', 'a paid order can never be dropped by this endpoint');
});
