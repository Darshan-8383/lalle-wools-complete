const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-verify-test-'));
process.env.LALLEWOOLS_DB_FILE = path.join(tmp, 'store.sqlite');
process.env.LALLEWOOLS_CATALOG_FILE = path.join(tmp, 'products.json');
fs.copyFileSync(path.join(__dirname, '..', 'server', 'data', 'products.json'), process.env.LALLEWOOLS_CATALOG_FILE);
process.env.JWT_SECRET = 'test-secret-' + 'x'.repeat(40);
process.env.NODE_ENV = 'test';
process.env.REQUIRE_EMAIL_VERIFICATION = 'true';
process.env.SITE_URL = 'https://shop.example';
for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'SMTP_HOST']) delete process.env[k];

// Capture outgoing mail instead of printing it (routes call email.sendEmail as a property, so this is seen).
const email = require('../server/services/email');
const sent = [];
email.sendEmail = async (m) => { sent.push(m); return { mock: true }; };

const jwt = require('jsonwebtoken');
const db = require('../server/db/sqlite');
const { app } = require('../server/index');
const { signEmailVerifyToken } = require('../server/middleware/auth');

let server, base, product;
const call = (method, url, body, tok, opts = {}) => fetch(base + url, {
  method, redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body), ...opts,
});
const linkFrom = (mail) => mail.html.match(/href="([^"]+)"/)[1].replace(/&amp;/g, '&');
const orderBody = (qty = 1) => ({
  items: [{ id: product.id, size: 'M', qty }], paymentMethod: 'cod',
  address: { name: 'T', phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
});

test.before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  product = db.listProducts().find((p) => p.stock > 5);
});
test.after(() => new Promise((r) => server.close(r)));

test('signup emails a link built from SITE_URL, and the account starts unverified', async () => {
  sent.length = 0;
  const res = await call('POST', '/api/auth/signup', { name: 'Asha Rao', email: 'Asha@Example.com', password: 'longenough1' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.user.emailVerified, false);
  assert.equal(body.verificationEmailSent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'asha@example.com');
  assert.ok(linkFrom(sent[0]).startsWith('https://shop.example/api/auth/verify-email?token='));
});

test('an unverified customer cannot place an order; clicking the link fixes that', async () => {
  sent.length = 0;
  const signup = await (await call('POST', '/api/auth/signup', { name: 'Ravi', email: 'ravi@example.com', password: 'longenough1' })).json();
  const tok = signup.token;
  const blocked = await call('POST', '/api/orders', orderBody(), tok);
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).code, 'email_unverified');

  const link = linkFrom(sent[0]).replace('https://shop.example', '');
  const hit = await call('GET', link);
  assert.equal(hit.status, 302);
  assert.equal(hit.headers.get('location'), '/?email_verified=1');
  assert.equal((await (await call('GET', '/api/auth/me', undefined, tok)).json()).user.emailVerified, true);

  const ok = await call('POST', '/api/orders', orderBody(), tok);
  assert.equal(ok.status, 201);
});

test('bad, tampered, expired and wrong-purpose links verify nothing', async () => {
  const signup = await (await call('POST', '/api/auth/signup', { name: 'Meena', email: 'meena@example.com', password: 'longenough1' })).json();
  const user = db.findUserByEmail('meena@example.com');
  const secret = process.env.JWT_SECRET;
  const bad = [
    'garbage',
    signEmailVerifyToken(user) + 'x',
    jwt.sign({ purpose: 'verify-email', sub: user.id, email: user.email }, secret, { expiresIn: -10 }),
    jwt.sign({ purpose: 'invoice', sub: user.id, email: user.email }, secret, { expiresIn: '1h' }),
    jwt.sign({ purpose: 'verify-email', sub: user.id, email: 'someone-else@example.com' }, secret, { expiresIn: '1h' }),
    jwt.sign({ purpose: 'verify-email', sub: user.id, email: user.email }, 'wrong-secret', { expiresIn: '1h' }),
  ];
  for (const t of bad) {
    const r = await call('GET', `/api/auth/verify-email?token=${encodeURIComponent(t)}`);
    assert.equal(r.headers.get('location'), '/?email_verified=0', t.slice(0, 20));
  }
  assert.equal(db.findUserByEmail('meena@example.com').emailVerified, false);
  assert.equal((await call('GET', '/api/auth/verify-email')).headers.get('location'), '/?email_verified=0');
  assert.ok(signup.token);
});

test('resend sends a fresh link, but not twice within a minute, and not once verified', async () => {
  const signup = await (await call('POST', '/api/auth/signup', { name: 'Kiran', email: 'kiran@example.com', password: 'longenough1' })).json();
  sent.length = 0;
  const tooSoon = await call('POST', '/api/auth/resend-verification', undefined, signup.token);
  assert.equal(tooSoon.status, 429);
  assert.equal(sent.length, 0);
  assert.equal((await call('POST', '/api/auth/resend-verification')).status, 401);

  await db.markEmailVerified(signup.user.id, 'kiran@example.com');
  const done = await call('POST', '/api/auth/resend-verification', undefined, signup.token);
  assert.deepEqual(await done.json(), { alreadyVerified: true });
  assert.equal(sent.length, 0);
});

test('someone else cannot squat an unconfirmed address: the real owner can sign up and the squatter is locked out', async () => {
  const squatter = await (await call('POST', '/api/auth/signup', { name: 'Squatter', email: 'victim@example.com', password: 'squatterpass1' })).json();
  const real = await call('POST', '/api/auth/signup', { name: 'Real Owner', email: 'victim@example.com', password: 'ownerpass123' });
  assert.equal(real.status, 201);
  const realBody = await real.json();
  assert.notEqual(realBody.user.id, squatter.user.id);
  // squatter's password no longer works, and their old session is not a valid account anymore
  assert.equal((await call('POST', '/api/auth/login', { email: 'victim@example.com', password: 'squatterpass1' })).status, 401);
  assert.equal((await call('GET', '/api/auth/me', undefined, squatter.token)).status, 404);
  assert.equal((await call('POST', '/api/orders', orderBody(), squatter.token)).status, 401);
});

test('a confirmed (or order-holding) account cannot be taken over by signing up again', async () => {
  const first = await (await call('POST', '/api/auth/signup', { name: 'Owner', email: 'safe@example.com', password: 'ownerpass123' })).json();
  await db.markEmailVerified(first.user.id, 'safe@example.com');
  const again = await call('POST', '/api/auth/signup', { name: 'Intruder', email: 'safe@example.com', password: 'intruderpass1' });
  assert.equal(again.status, 400);
  assert.match((await again.json()).error, /already exists/);
  assert.equal((await call('POST', '/api/auth/login', { email: 'safe@example.com', password: 'ownerpass123' })).status, 200);

  // unverified but already has an order (e.g. an account from before verification existed): also protected
  const legacy = await db.createUser({ name: 'Legacy', email: 'legacy@example.com', passwordHash: 'x' });
  await db.createOrderWithStockDecrement({
    items: [{ id: product.id, sku: product.sku, name: product.name, price: product.price, size: 'M', qty: 1, weightGrams: 300 }],
    address: { name: 'T', phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
    amounts: { subtotal: product.price, shippingFee: 50, codFee: 40, total: product.price + 90, currency: 'INR' },
    payment: { method: 'cod', status: 'cod_confirmed' }, customerId: legacy.id,
  });
  const takeover = await call('POST', '/api/auth/signup', { name: 'Intruder', email: 'legacy@example.com', password: 'intruderpass1' });
  assert.equal(takeover.status, 400);
  assert.ok(db.getUserById(legacy.id));
});

test('verification is not enforced when switched off, and config tells the storefront', async () => {
  assert.equal((await (await call('GET', '/api/config')).json()).emailVerificationRequired, true);
  process.env.REQUIRE_EMAIL_VERIFICATION = 'false';
  try {
    assert.equal((await (await call('GET', '/api/config')).json()).emailVerificationRequired, false);
    const s = await (await call('POST', '/api/auth/signup', { name: 'Free', email: 'free@example.com', password: 'longenough1' })).json();
    assert.equal((await call('POST', '/api/orders', orderBody(), s.token)).status, 201);
  } finally { process.env.REQUIRE_EMAIL_VERIFICATION = 'true'; }
});

test('verification email escapes the customer name', () => {
  const { html } = email.verificationEmail({ name: '<img src=x onerror=alert(1)>', url: 'https://shop.example/x?a=1&b=2' });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&amp;b=2'));
});
