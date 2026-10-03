const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { normalizeIndianMobile } = require('../server/services/phone');
const { verifyGoogleIdToken } = require('../server/services/google');

/* ───────────── phone normalisation ───────────── */
test('normalizeIndianMobile accepts common formats and rejects bad numbers', () => {
  for (const ok of ['9876543210', '98765 43210', '+91 98765-43210', '919876543210', '09876543210']) {
    assert.equal(normalizeIndianMobile(ok), '9876543210', ok);
  }
  for (const bad of ['', null, undefined, '12345', '5876543210', '98765432100', 'abcdefghij', '+1 415 555 2671']) {
    assert.equal(normalizeIndianMobile(bad), null, String(bad));
  }
});

/* ───────────── Google ID-token verification ───────────── */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUB_PEM = publicKey.export({ type: 'spki', format: 'pem' });
const CLIENT_ID = 'my-client-id.apps.googleusercontent.com';
const NOW = 1_800_000_000_000;

function makeToken(claims = {}, { key = privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const nowS = Math.floor(NOW / 1000);
  const payload = {
    iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1234567890',
    email: 'Shopper@Example.com', email_verified: true, name: 'Test Shopper',
    iat: nowS - 10, exp: nowS + 3600, ...claims,
  };
  const body = `${b64({ alg, kid, typ: 'JWT' })}.${b64(payload)}`;
  const sig = crypto.createSign('RSA-SHA256').update(body).sign(key).toString('base64url');
  return `${body}.${sig}`;
}
const opts = { clientId: CLIENT_ID, getCerts: async () => ({ k1: PUB_PEM }), nowMs: NOW };

test('Google: a valid token yields a normalised profile', async () => {
  const p = await verifyGoogleIdToken(makeToken(), opts);
  assert.equal(p.sub, '1234567890');
  assert.equal(p.email, 'shopper@example.com');
  assert.equal(p.name, 'Test Shopper');
});

test('Google: rejects forged signature, wrong audience, wrong issuer, expired, unverified email, bad alg', async () => {
  const cases = {
    'forged signature': makeToken({}, { key: otherKey }),
    'wrong audience': makeToken({ aud: 'someone-elses-app' }),
    'wrong issuer': makeToken({ iss: 'https://evil.example.com' }),
    'expired': makeToken({ exp: Math.floor(NOW / 1000) - 3600 }),
    'unverified email': makeToken({ email_verified: false }),
    'no email': makeToken({ email: undefined }),
    'unknown key id': makeToken({}, { kid: 'nope' }),
    'alg none/HS256': makeToken({}, { alg: 'HS256' }),
  };
  for (const [label, token] of Object.entries(cases)) {
    await assert.rejects(() => verifyGoogleIdToken(token, opts), (e) => e.status === 401, label);
  }
  await assert.rejects(() => verifyGoogleIdToken('not.a.jwt', opts), (e) => e.status === 401);
  await assert.rejects(() => verifyGoogleIdToken('', opts), (e) => e.status === 401);
});

test('Google: reports a clear 503 when no client id is configured', async () => {
  await assert.rejects(() => verifyGoogleIdToken(makeToken(), { ...opts, clientId: '' }), (e) => e.status === 503);
});

test('Google: refetches certs once when the key id is unknown (key rotation)', async () => {
  let calls = 0;
  const getCerts = async (force) => { calls++; return force ? { k1: PUB_PEM } : {}; };
  const p = await verifyGoogleIdToken(makeToken(), { ...opts, getCerts });
  assert.equal(p.sub, '1234567890');
  assert.equal(calls, 2);
});
