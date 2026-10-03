const db = require('../db/sqlite');
const { verificationRequired } = require('../services/email');

/**
 * Use AFTER requireAuth. When email verification is required, only customers whose address is confirmed may continue.
 * Also rejects tokens whose account no longer exists.
 */
function requireVerifiedEmail(req, res, next) {
  const user = db.getUserById(req.user.sub);
  if (!user) return res.status(401).json({ error: 'Your session has expired, please log in again' });
  if (verificationRequired() && !user.emailVerified) {
    return res.status(403).json({
      error: 'Please confirm your email address before placing an order. We emailed you a link — check your inbox (and spam folder).',
      code: 'email_unverified',
    });
  }
  next();
}

module.exports = { requireVerifiedEmail };
