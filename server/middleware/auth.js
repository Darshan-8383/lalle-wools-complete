const jwt = require('jsonwebtoken');

function getSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set — add one to your .env (see .env.example)');
  }
  return process.env.JWT_SECRET;
}

function signCustomerToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: 'customer' }, getSecret(), { expiresIn: '7d' });
}

function readBearer(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

/** Attaches req.user if a valid customer token is present; never rejects. Use for optional-login routes. */
function optionalAuth(req, res, next) {
  const token = readBearer(req);
  if (token) {
    try {
      const payload = jwt.verify(token, getSecret());
      if (payload.role === 'customer') req.user = payload; // admin / invoice tokens are not customer sessions
    } catch (e) { /* ignore invalid/expired token, treat as guest */ }
  }
  next();
}

/** Rejects with 401 if there is no valid customer token. */
function requireAuth(req, res, next) {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ error: 'Please log in' });
  try {
    const payload = jwt.verify(token, getSecret());
    if (payload.role !== 'customer') return res.status(401).json({ error: 'Please log in' });
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Your session has expired, please log in again' });
  }
}

/** Short-lived link token so a plain <a href> can open one specific invoice without carrying a login header. */
function signInvoiceToken(orderId) {
  return jwt.sign({ purpose: 'invoice', orderId }, getSecret(), { expiresIn: '10m' });
}
function verifyInvoiceToken(token, orderId) {
  try {
    const p = jwt.verify(String(token || ''), getSecret());
    return p.purpose === 'invoice' && p.orderId === orderId;
  } catch (e) { return false; }
}

/** Emailed confirmation link token. Bound to the user AND the address, valid for 24 hours. */
function signEmailVerifyToken(user) {
  return jwt.sign({ purpose: 'verify-email', sub: user.id, email: user.email }, getSecret(), { expiresIn: '24h' });
}
function readEmailVerifyToken(token) {
  try {
    const p = jwt.verify(String(token || ''), getSecret());
    return p.purpose === 'verify-email' && p.sub && p.email ? p : null;
  } catch (e) { return null; }
}

const lastTen = (v) => String(v || '').replace(/\D/g, '').slice(-10);

/**
 * Who may see an order? Its owner (logged in), or a guest who knows both the order id AND the phone number
 * it was placed with (sent in the x-order-phone header, so it never lands in URLs or server logs).
 */
function canAccessOrder(req, order) {
  if (!order) return false;
  if (req.user && req.user.role === 'customer' && order.customerId && order.customerId === req.user.sub) return true;
  const given = lastTen(req.get('x-order-phone') || (req.body && req.body.phone));
  return given.length === 10 && given === lastTen(order.address && order.address.phone);
}

module.exports = { signCustomerToken, optionalAuth, requireAuth, getSecret, signInvoiceToken, verifyInvoiceToken, signEmailVerifyToken, readEmailVerifyToken, canAccessOrder, lastTen };
