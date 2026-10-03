const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// Isolated database + catalog so this never touches real data.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-server-test-'));
process.env.LALLEWOOLS_DB_FILE = path.join(tmp, 'store.sqlite');
process.env.LALLEWOOLS_CATALOG_FILE = path.join(tmp, 'products.json');
fs.copyFileSync(path.join(__dirname, '..', 'server', 'data', 'products.json'), process.env.LALLEWOOLS_CATALOG_FILE);
process.env.JWT_SECRET = 'test-secret-' + 'x'.repeat(40);
process.env.NODE_ENV = 'test';
for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'SMTP_HOST']) delete process.env[k];

const db = require('../server/db/sqlite');
const { app } = require('../server/index');

let server, base;
test.before(async () => {
  await db.init();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

const post = (url, body, raw) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ?? JSON.stringify(body) });

test('health reports ok and exposes nothing about providers', async () => {
  const res = await fetch(base + '/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'uptime']);
});

test('unknown API route is a JSON 404; unknown page is an HTML 404 (not the storefront)', async () => {
  const api = await fetch(base + '/api/nope');
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type'), /json/);
  const page = await fetch(base + '/wp-login.php');
  assert.equal(page.status, 404);
  assert.match(await page.text(), /404/);
  assert.equal((await fetch(base + '/')).status, 200);
});

test('security headers: CSP allows Razorpay + Google but nothing arbitrary', async () => {
  const res = await fetch(base + '/');
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp.includes('https://checkout.razorpay.com'));
  assert.ok(csp.includes('https://accounts.google.com'));
  assert.ok(csp.includes("object-src 'none'"));
  assert.ok(!/script-src[^;]*\*/.test(csp), 'no wildcard script source');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('static caching: code revalidates, images are cached', async () => {
  assert.equal((await fetch(base + '/css/style.css')).headers.get('cache-control'), 'no-cache');
  assert.match((await fetch(base + '/images/logo.png')).headers.get('cache-control'), /max-age=604800/);
});

test('large text assets are gzip-compressed', async () => {
  const res = await fetch(base + '/js/script.js', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(res.headers.get('content-encoding'), 'gzip');
});

test('config advertises COD-only when no gateway keys are set', async () => {
  const cfg = await (await fetch(base + '/api/config')).json();
  assert.equal(cfg.onlinePayments, false);
});

test('newsletter: stores real subscribers, is idempotent, rejects junk', async () => {
  assert.equal((await post('/api/newsletter', { email: 'Fan@Example.com' })).status, 201);
  assert.equal((await post('/api/newsletter', { email: 'fan@example.com' })).status, 201); // duplicate → same answer
  assert.equal(db.listSubscribers().filter((s) => s.email === 'fan@example.com').length, 1);
  for (const bad of ['', 'nope', 'a@b', '=cmd|calc@x.com', 'x'.repeat(300) + '@a.com']) {
    assert.equal((await post('/api/newsletter', { email: bad })).status, 400, bad);
  }
});

test('malformed JSON gets a clean 400, not a stack trace', async () => {
  const res = await post('/api/newsletter', null, '{ not json');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Request body is not valid JSON');
});

test('production refuses to boot with a weak JWT_SECRET', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: 'short', PORT: '0' },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /JWT_SECRET/);
});
