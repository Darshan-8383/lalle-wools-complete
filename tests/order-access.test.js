const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// Orders hold names, phone numbers and addresses, so only the owner (or a guest who also knows the
// order's phone number) may read them. These tests pin that down.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-access-test-'));
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
const { signCustomerToken, signInvoiceToken } = require('../server/middleware/auth');
const { signAdminToken } = require('../server/middleware/adminAuth');

let server, base, product, owner, stranger, ownerTok, strangerTok, order;
const call = (method, url, body, tok, headers = {}) => fetch(base + url, {
  method,
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test.before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  product = db.listProducts().find((p) => p.stock > 5);
  owner = await db.createUser({ name: 'Owner', email: 'owner@example.com', passwordHash: 'x' });
  stranger = await db.createUser({ name: 'Stranger', email: 'stranger@example.com', passwordHash: 'x' });
  ownerTok = signCustomerToken(owner);
  strangerTok = signCustomerToken(stranger);
  order = await db.createOrderWithStockDecrement({
    items: [{ id: product.id, sku: product.sku, name: product.name, price: product.price, size: 'M', qty: 1, weightGrams: 300 }],
    address: { name: 'T', phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
    amounts: { subtotal: product.price, shippingFee: 50, codFee: 40, total: product.price + 90, currency: 'INR' },
    payment: { method: 'cod', status: 'cod_confirmed' }, customerId: owner.id,
  });
});
test.after(() => new Promise((r) => server.close(r)));

test('an order cannot be read by an anonymous visitor who only knows its id', async () => {
  assert.equal((await call('GET', `/api/orders/${order.id}`)).status, 404);
  assert.equal((await call('GET', `/api/shipping/track/${order.id}`)).status, 404);
});

test('another customer cannot read it, but the owner can', async () => {
  assert.equal((await call('GET', `/api/orders/${order.id}`, undefined, strangerTok)).status, 404);
  const ok = await call('GET', `/api/orders/${order.id}`, undefined, ownerTok);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).id, order.id);
});

test('a guest can track with the order id plus the right phone number only', async () => {
  assert.equal((await call('GET', `/api/orders/${order.id}`, undefined, null, { 'x-order-phone': '9000000000' })).status, 404);
  assert.equal((await call('GET', `/api/orders/${order.id}`, undefined, null, { 'x-order-phone': '+91 98765 43210' })).status, 200);
});

test('invoices need a valid, order-specific link token (or the owner login)', async () => {
  assert.equal((await call('GET', `/api/orders/${order.id}/invoice`)).status, 404);
  assert.equal((await call('GET', `/api/orders/${order.id}/invoice?t=${signInvoiceToken('SOMEOTHERORDER')}`)).status, 404);
  assert.equal((await call('POST', `/api/orders/${order.id}/invoice-link`, {}, strangerTok)).status, 404);
  const link = await call('POST', `/api/orders/${order.id}/invoice-link`, {}, ownerTok);
  assert.equal(link.status, 200);
  const { url } = await link.json();
  const pdf = await call('GET', url);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type') || '', /pdf/);
  // the admin panel gets the same kind of link
  const adminLink = await call('POST', `/api/admin/orders/${order.id}/invoice-link`, {}, signAdminToken());
  assert.equal(adminLink.status, 200);
});

test('only the order owner can start a payment for it, and admin/invoice tokens are not customer sessions', async () => {
  assert.equal((await call('POST', '/api/payment/create-order', { orderId: order.id })).status, 401);
  assert.equal((await call('POST', '/api/payment/create-order', { orderId: order.id }, strangerTok)).status, 404);
  assert.equal((await call('POST', '/api/payment/create-order', { orderId: order.id }, signAdminToken())).status, 401);
  assert.equal((await call('GET', '/api/auth/me', undefined, signInvoiceToken(order.id))).status, 401);
});

test('signup requires an 8+ character password', async () => {
  const short = await call('POST', '/api/auth/signup', { name: 'A', email: 'short@example.com', password: '1234567' });
  assert.equal(short.status, 400);
  const ok = await call('POST', '/api/auth/signup', { name: 'A', email: 'long@example.com', password: '12345678' });
  assert.equal(ok.status, 201);
});

test('customer-typed text is escaped by the admin panel and storefront renderers', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin.js'), 'utf8');
  for (const field of ['address.name', 'address.line1', 'address.city', 'address.state', 'address.phone']) {
    assert.ok(!new RegExp('\\$\\{o\\.' + field.replace('.', '\\.') + '\\}').test(admin), `admin.js prints o.${field} unescaped`);
  }
});
