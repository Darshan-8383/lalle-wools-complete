const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/sqlite');
const { signCustomerToken, requireAuth, signEmailVerifyToken, readEmailVerifyToken } = require('../middleware/auth');
const email = require('../services/email');
const { asyncRoute } = require('../middleware/errorHandler');
const { normalizeIndianMobile } = require('../services/phone');
const { verifyGoogleIdToken } = require('../services/google');

const router = express.Router();

function publicUser(user) {
  return {
    id: user.id, name: user.name, email: user.email, phone: user.phone,
    emailVerified: Boolean(user.emailVerified),
    hasPassword: Boolean(user.passwordHash),
    hasGoogle: Boolean(user.googleId),
  };
}

function sessionFor(user, extra = {}) {
  return { token: signCustomerToken(user), user: publicUser(user), ...extra };
}

/** Where the emailed link points. SITE_URL when set (always, in production) so a forged Host header can't redirect the token. */
function siteBase(req) {
  return (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

const RESEND_COOLDOWN_MS = 60 * 1000;
const lastSent = new Map(); // userId -> time of the last verification email (stops inbox flooding)

/** Email the confirmation link. Never throws: a mail hiccup must not break signup. Returns true if attempted. */
async function sendVerification(user, req) {
  if (!user || !user.email || user.emailVerified) return false;
  lastSent.set(user.id, Date.now());
  const url = `${siteBase(req)}/api/auth/verify-email?token=${encodeURIComponent(signEmailVerifyToken(user))}`;
  const { subject, html } = email.verificationEmail({ name: user.name, url });
  try { await email.sendEmail({ to: user.email, subject, html }); }
  catch (e) { console.error('[email] verification email failed:', e.message); }
  if (!email.isConfigured()) console.log(`[email:MOCK] Verification link for ${user.email}: ${url}`);
  return true;
}

// POST /api/auth/signup  { name, email, password, phone }
router.post('/signup', asyncRoute(async (req, res) => {
  const { name, email, password, phone } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password are required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  // The phone typed here is just a contact number.
  // If this address was registered earlier by password but never confirmed or used, whoever did that may not own it.
  // Let the new sign-up take it over (they must now confirm it), otherwise the real owner would be locked out.
  const existing = db.findUserByEmail(email);
  if (existing && !existing.emailVerified && !existing.googleId) db.deleteUnverifiedEmptyUser(existing.id);
  const user = await db.createUser({ name, email, phone, passwordHash });
  await sendVerification(user, req);
  res.status(201).json(sessionFor(user, { verificationEmailSent: true }));
}));

// POST /api/auth/login  { email, password }
router.post('/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.findUserByEmail(String(email || ''));
  // Accounts created via Google have no password, so they can't use this route.
  // Same message either way so this endpoint can't be used to discover which emails exist.
  if (!user || !user.passwordHash) return res.status(401).json({ error: 'Incorrect email or password' });
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password' });
  res.json(sessionFor(user));
}));

// POST /api/auth/google  { credential }  — the ID token from Google's sign-in button
router.post('/google', asyncRoute(async (req, res) => {
  const profile = await verifyGoogleIdToken(req.body && req.body.credential, {
    clientId: process.env.GOOGLE_CLIENT_ID,
  });

  // 1) Returning Google user
  let user = db.findUserByGoogleId(profile.sub);

  // 2) Same email already has an account → link it (Google has verified the address)
  if (!user) {
    const byEmail = db.findUserByEmail(profile.email);
    if (byEmail) {
      // Password sign-ups never prove they own the email. If someone registered this
      // address first with a password they chose, drop that password now that the real
      // owner has proven ownership via Google — otherwise it would be a backdoor.
      // (They can set a new one from Profile.)
      user = await db.linkGoogleAccount(byEmail.id, profile.sub, {
        clearPassword: !byEmail.emailVerified && Boolean(byEmail.passwordHash),
      });
    }
  }

  // 3) Brand-new customer
  if (!user) {
    user = await db.createUser({
      name: profile.name || profile.email.split('@')[0],
      email: profile.email, googleId: profile.sub, emailVerified: true,
    });
    return res.status(201).json(sessionFor(user, { isNewUser: true }));
  }
  res.json(sessionFor(user));
}));

// GET /api/auth/verify-email?token=...  — the link in the email. Always ends on the storefront with a result flag.
router.get('/verify-email', asyncRoute(async (req, res) => {
  const payload = readEmailVerifyToken(req.query.token);
  const user = payload && db.getUserById(payload.sub);
  if (!user || user.email !== String(payload.email).toLowerCase()) return res.redirect(302, '/?email_verified=0');
  if (!user.emailVerified) await db.markEmailVerified(user.id, user.email);
  res.redirect(302, '/?email_verified=1');
}));

// POST /api/auth/resend-verification — logged-in customer asks for a fresh link
router.post('/resend-verification', requireAuth, asyncRoute(async (req, res) => {
  const user = db.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.emailVerified) return res.json({ alreadyVerified: true });
  const wait = RESEND_COOLDOWN_MS - (Date.now() - (lastSent.get(user.id) || 0));
  if (wait > 0) return res.status(429).json({ error: `Please wait ${Math.ceil(wait / 1000)} seconds before asking for another email.`, retryAfter: Math.ceil(wait / 1000) });
  await sendVerification(user, req);
  res.json({ sent: true });
}));

// GET /api/auth/me
router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const user = db.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  res.json({ user: publicUser(user) });
}));

// PATCH /api/auth/me  { name?, phone? } — update own profile
router.patch('/me', requireAuth, asyncRoute(async (req, res) => {
  const { name, phone } = req.body || {};
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ error: 'Name cannot be empty' });
  }
  const existing = db.getUserById(req.user.sub);
  if (!existing) return res.status(404).json({ error: 'Account not found' });

  let nextPhone;
  if (phone !== undefined) {
    nextPhone = phone ? normalizeIndianMobile(phone) : '';
    if (phone && !nextPhone) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit phone number' });
    }
  }
  const updated = await db.updateUser(req.user.sub, {
    name: name !== undefined ? String(name).trim() : undefined,
    phone: nextPhone,
  });
  res.json({ user: publicUser(updated) });
}));

// PATCH /api/auth/password  { currentPassword?, newPassword }
// Accounts that signed in with Google have no password yet, so they may set one without a current one.
router.patch('/password', requireAuth, asyncRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword) return res.status(400).json({ error: 'Please enter a new password' });
  if (String(newPassword).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const user = db.getUserById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  if (user.passwordHash) {
    if (!currentPassword) return res.status(400).json({ error: 'Current and new password are both required' });
    const ok = await bcrypt.compare(String(currentPassword), user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
  } else if (!user.email) {
    return res.status(400).json({ error: 'Add an email address to your account before setting a password.' });
  }
  const newHash = await bcrypt.hash(newPassword, 10);
  await db.updateUserPassword(user.id, newHash);
  res.json({ success: true });
}));

// GET /api/auth/orders — this account's order history
router.get('/orders', requireAuth, asyncRoute(async (req, res) => {
  // Online orders that were abandoned/expired before payment were never really placed — keep them out of the history.
  // (Unpaid ones still within their payment window stay visible, clearly labelled "awaiting payment".)
  res.json(db.listOrdersByCustomer(req.user.sub).filter((o) => !(o.status === 'cancelled' && db.isNeverPaid(o))));
}));

module.exports = router;
