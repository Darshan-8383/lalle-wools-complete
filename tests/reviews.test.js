const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-reviews-test-'));
process.env.LALLEWOOLS_DB_FILE = path.join(tmp, 'store.sqlite');
process.env.LALLEWOOLS_CATALOG_FILE = path.join(tmp, 'products.json');
process.env.LALLEWOOLS_UPLOAD_DIR = path.join(tmp, 'uploads');
fs.copyFileSync(path.join(__dirname, '..', 'server', 'data', 'products.json'), process.env.LALLEWOOLS_CATALOG_FILE);
process.env.JWT_SECRET = 'test-secret-' + 'x'.repeat(40);
process.env.NODE_ENV = 'test';
for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'SMTP_HOST']) delete process.env[k];

const db = require('../server/db/sqlite');
const { app } = require('../server/index');
const { signCustomerToken } = require('../server/middleware/auth');
const { signAdminToken } = require('../server/middleware/adminAuth');

let server, base, product, buyer, other, buyerToken, otherToken;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const photo = `data:image/jpeg;base64,${JPEG.toString('base64')}`;

const call = (method, url, body, token) => fetch(base + url, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function orderFor(user, status) {
  const order = await db.createOrderWithStockDecrement({
    items: [{ id: product.id, sku: product.sku, name: product.name, price: product.price, size: 'M', qty: 1, weightGrams: 300 }],
    address: { name: user.name, phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
    amounts: { subtotal: product.price, shippingFee: 50, codFee: 40, total: product.price + 90, currency: 'INR' },
    payment: { method: 'cod', status: 'cod_confirmed' }, customerId: user.id,
  });
  return db.updateOrder(order.id, { status });
}

test.before(async () => {
  await db.init();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  product = db.listProducts().find((p) => p.stock > 5);
  buyer = await db.createUser({ name: 'Priya Sharma', email: 'priya@example.com', passwordHash: 'x' });
  other = await db.createUser({ name: 'Rahul', email: 'rahul@example.com', passwordHash: 'x' });
  buyerToken = signCustomerToken(buyer);
  otherToken = signCustomerToken(other);
});
test.after(() => new Promise((r) => server.close(r)));

test('reviewing requires login', async () => {
  const res = await call('POST', '/api/reviews', { productId: product.id, rating: 5 });
  assert.equal(res.status, 401);
});

test('a customer who has not received the product (confirmed/shipped only) cannot review it', async () => {
  await orderFor(buyer, 'shipped');
  const elig = await (await call('GET', `/api/reviews/eligibility/${product.id}`, undefined, buyerToken)).json();
  assert.equal(elig.canReview, false);
  assert.equal(elig.reason, 'not_delivered');
  const res = await call('POST', '/api/reviews', { productId: product.id, rating: 5, body: 'nice' }, buyerToken);
  assert.equal(res.status, 403);
});

test('someone who never bought the product cannot review it', async () => {
  const res = await call('POST', '/api/reviews', { productId: product.id, rating: 1, body: 'spam' }, otherToken);
  assert.equal(res.status, 403);
});

test('after delivery: review with photos is accepted, photos are served, public name is shortened', async () => {
  await orderFor(buyer, 'delivered');
  const res = await call('POST', '/api/reviews', { productId: product.id, rating: 5, body: 'Great fit!', images: [photo, photo] }, buyerToken);
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.name, 'Priya S.');
  assert.equal(created.images.length, 2);
  assert.equal(created.verified, true);

  const img = await fetch(base + created.images[0]);
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /image\/jpeg/);

  const list = await (await call('GET', `/api/reviews/product/${product.id}`)).json();
  assert.equal(list.summary.count, 1);
  assert.equal(list.summary.average, 5);
  const text = JSON.stringify(list);
  assert.ok(!text.includes('priya@example.com'), 'no email in the public list');
  assert.ok(!text.includes('userId'), 'no internal ids in the public list');
});

test('one review per product per customer', async () => {
  const res = await call('POST', '/api/reviews', { productId: product.id, rating: 4 }, buyerToken);
  assert.equal(res.status, 409);
});

test('validation: rating 1-5 required, text length capped, bad photos rejected and leave no files behind', async () => {
  await orderFor(other, 'delivered');
  const dir = process.env.LALLEWOOLS_UPLOAD_DIR;
  const filesBefore = fs.readdirSync(dir).length;
  assert.equal((await call('POST', '/api/reviews', { productId: product.id, rating: 9 }, otherToken)).status, 400);
  assert.equal((await call('POST', '/api/reviews', { productId: product.id, rating: 4, body: 'x'.repeat(1001) }, otherToken)).status, 400);
  const bad = await call('POST', '/api/reviews', { productId: product.id, rating: 4, images: [photo, 'data:image/jpeg;base64,bm90IGFuIGltYWdlIGF0IGFsbCwganVzdCB0ZXh0Li4uLi4='] }, otherToken);
  assert.equal(bad.status, 400);
  assert.equal(fs.readdirSync(dir).length, filesBefore);
});

test('a review can be deleted by its owner only; deleting removes its photo files', async () => {
  const list = await (await call('GET', `/api/reviews/product/${product.id}`, undefined, buyerToken)).json();
  const mine = list.reviews.find((r) => r.mine);
  assert.ok(mine);
  assert.equal((await call('DELETE', `/api/reviews/${mine.id}`, undefined, otherToken)).status, 404);
  const file = path.join(process.env.LALLEWOOLS_UPLOAD_DIR, path.basename(mine.images[0]));
  assert.ok(fs.existsSync(file));
  assert.equal((await call('DELETE', `/api/reviews/${mine.id}`, undefined, buyerToken)).status, 200);
  assert.ok(!fs.existsSync(file));
});

test('admin can list and delete any review; customers cannot reach the admin routes', async () => {
  const created = await (await call('POST', '/api/reviews', { productId: product.id, rating: 2, body: 'meh', images: [photo] }, otherToken)).json();
  assert.equal((await call('GET', '/api/admin/reviews', undefined, otherToken)).status, 403);
  const adminToken = signAdminToken();
  const all = await (await call('GET', '/api/admin/reviews', undefined, adminToken)).json();
  assert.ok(all.some((r) => r.id === created.id && r.productName));
  assert.equal((await call('DELETE', `/api/admin/reviews/${created.id}`, undefined, adminToken)).status, 200);
  assert.equal(db.getReview(created.id), null);
});

test('highlighted reviews: only admin can highlight; they appear in the public Community feed with photo, short name and product', async () => {
  const mk = await (await call('POST', '/api/reviews', { productId: product.id, rating: 5, body: 'Best tee ever', images: [photo] }, buyerToken)).json();
  // nothing highlighted yet -> empty feed (the storefront then keeps its placeholder cards)
  assert.deepEqual(await (await call('GET', '/api/reviews/featured')).json(), []);

  // customers cannot highlight, not even their own review
  assert.equal((await call('PATCH', `/api/admin/reviews/${mk.id}/feature`, { featured: true }, buyerToken)).status, 403);
  assert.equal((await call('PATCH', `/api/admin/reviews/${mk.id}/feature`, { featured: true })).status, 401);

  const adminToken = signAdminToken();
  const res = await call('PATCH', `/api/admin/reviews/${mk.id}/feature`, { featured: true }, adminToken);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).featured, true);

  const feed = await (await call('GET', '/api/reviews/featured')).json();
  assert.equal(feed.length, 1);
  assert.equal(feed[0].name, 'Priya S.');
  assert.equal(feed[0].productId, product.id);
  assert.equal(feed[0].productName, product.name);
  assert.match(feed[0].image, /^\/uploads\/reviews\//);
  const text = JSON.stringify(feed);
  assert.ok(!text.includes('priya@example.com') && !text.includes('userId'), 'no private data in the public feed');

  // it is flagged on the product page too, and floats to the top of that product's list
  const list = await (await call('GET', `/api/reviews/product/${product.id}`)).json();
  assert.equal(list.reviews[0].id, mk.id);
  assert.equal(list.reviews[0].featured, true);

  // un-highlight removes it from the feed
  await call('PATCH', `/api/admin/reviews/${mk.id}/feature`, { featured: false }, adminToken);
  assert.deepEqual(await (await call('GET', '/api/reviews/featured')).json(), []);
  assert.equal((await call('PATCH', '/api/admin/reviews/999999/feature', { featured: true }, adminToken)).status, 404);
});

test('a deleted review leaves the Community feed; one whose product is hidden is skipped', async () => {
  const adminToken = signAdminToken();
  const list = await (await call('GET', '/api/admin/reviews', undefined, adminToken)).json();
  const target = list.find((r) => r.userId === buyer.id);
  await call('PATCH', `/api/admin/reviews/${target.id}/feature`, { featured: true }, adminToken);
  assert.equal((await (await call('GET', '/api/reviews/featured')).json()).length, 1);

  await db.updateProduct(product.id, { active: false });
  assert.equal((await (await call('GET', '/api/reviews/featured')).json()).length, 0, 'hidden product -> its review is not shown');
  await db.updateProduct(product.id, { active: true });
  assert.equal((await (await call('GET', '/api/reviews/featured')).json()).length, 1);

  await call('DELETE', `/api/admin/reviews/${target.id}`, undefined, adminToken);
  assert.equal((await (await call('GET', '/api/reviews/featured')).json()).length, 0);
});

test('migration: a reviews table created before the highlight feature gets its new columns without losing data', async () => {
  const file = path.join(tmp, 'legacy.sqlite');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const old = new SQL.Database();
  old.run(`CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, user_id INTEGER NOT NULL, order_id TEXT NOT NULL,
    reviewer_name TEXT NOT NULL DEFAULT '', rating INTEGER NOT NULL, body TEXT NOT NULL DEFAULT '', images_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, UNIQUE (product_id, user_id));`);
  old.run(`INSERT INTO reviews (product_id,user_id,order_id,reviewer_name,rating,body,created_at) VALUES (1,1,'LWX','Old Timer',4,'kept','2026-01-01T00:00:00Z')`);
  fs.writeFileSync(file, Buffer.from(old.export()));
  // Run the real init() against that legacy file in a child process (the DB module is a singleton here).
  const { spawnSync } = require('node:child_process');
  const script = `
    process.env.LALLEWOOLS_DB_FILE=${JSON.stringify(file)}; process.env.LALLEWOOLS_CATALOG_FILE=${JSON.stringify(process.env.LALLEWOOLS_CATALOG_FILE)};
    process.env.LALLEWOOLS_NO_CATALOG_WATCH='1';
    const db=require(${JSON.stringify(path.join(__dirname, '..', 'server', 'db', 'sqlite'))});
    db.init().then(async()=>{ const r=db.getReview(1); await db.setReviewFeatured(1,true); console.log(JSON.stringify({body:r.body,featured:r.featured,after:db.getReview(1).featured})); process.exit(0); });`;
  const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim().split('\n').pop()), { body: 'kept', featured: false, after: true });
});
