/**
 * Verifies a "Sign in with Google" ID token (the JWT the Google button hands
 * the browser) using Node's built-in crypto — no extra dependency.
 *
 * What we check, in line with Google's own guidance:
 *   - RS256 signature against Google's published certificates (cached,
 *     refreshed when Google rotates keys)
 *   - audience == OUR client id (stops tokens minted for someone else's app)
 *   - issuer is Google, token not expired, email present AND verified
 */
const crypto = require('crypto');

const CERTS_URL = 'https://www.googleapis.com/oauth2/v1/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_S = 60;

let certCache = { certs: null, expiresAt: 0 };

async function fetchGoogleCerts(force = false) {
  if (!force && certCache.certs && Date.now() < certCache.expiresAt) return certCache.certs;
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Google certs request failed (${res.status})`);
  const certs = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  const ttlMs = Math.min(maxAge ? Number(maxAge[1]) * 1000 : 3600000, 24 * 3600000);
  certCache = { certs, expiresAt: Date.now() + ttlMs };
  return certs;
}

function fail(detail) {
  if (detail) console.warn('[google-auth] rejected token:', detail);
  return Object.assign(new Error('Google sign-in failed. Please try again.'), { status: 401 });
}

const decodePart = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

async function verifyGoogleIdToken(idToken, { clientId, getCerts = fetchGoogleCerts, nowMs = Date.now() } = {}) {
  if (!clientId) throw Object.assign(new Error('Google login is not set up yet.'), { status: 503 });
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw fail('malformed token');

  let header, payload;
  try { header = decodePart(parts[0]); payload = decodePart(parts[1]); } catch (e) { throw fail('undecodable token'); }
  if (header.alg !== 'RS256' || !header.kid) throw fail('unexpected alg/kid');

  let certs = await getCerts();
  if (!certs[header.kid]) certs = await getCerts(true); // keys may have rotated since we cached
  const pem = certs[header.kid];
  if (!pem) throw fail('unknown signing key');

  const signatureOk = crypto.createVerify('RSA-SHA256')
    .update(`${parts[0]}.${parts[1]}`)
    .verify(pem, Buffer.from(parts[2], 'base64url'));
  if (!signatureOk) throw fail('bad signature');

  const nowS = Math.floor(nowMs / 1000);
  if (payload.aud !== clientId) throw fail('wrong audience');
  if (!ISSUERS.has(payload.iss)) throw fail('wrong issuer');
  if (!payload.exp || payload.exp + CLOCK_SKEW_S < nowS) throw fail('expired');
  if (payload.iat && payload.iat - CLOCK_SKEW_S > nowS) throw fail('issued in the future');
  if (!payload.sub || !payload.email) throw fail('missing sub/email');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw fail('email not verified');

  return {
    sub: String(payload.sub),
    email: String(payload.email).toLowerCase(),
    name: payload.name ? String(payload.name).trim() : '',
    picture: payload.picture || null,
  };
}

module.exports = { verifyGoogleIdToken };
