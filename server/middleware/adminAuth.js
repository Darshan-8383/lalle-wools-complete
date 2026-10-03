const jwt = require('jsonwebtoken');
const { getSecret } = require('./auth');

function signAdminToken() {
  return jwt.sign({ role: 'admin' }, getSecret(), { expiresIn: '12h' });
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return res.status(401).json({ error: 'Admin login required' });
  try {
    const payload = jwt.verify(token, getSecret());
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Admin session expired, please log in again' });
  }
}

module.exports = { signAdminToken, requireAdmin };
