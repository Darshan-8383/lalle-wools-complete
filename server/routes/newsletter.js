const express = require('express');
const db = require('../db/sqlite');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();

// A leading = + - @ would be treated as a formula if the CSV export is opened in Excel, so such addresses are rejected.
const EMAIL_RE = /^[^\s@=+\-][^\s@]*@[^\s@]+\.[^\s@]+$/;

// POST /api/newsletter  { email }
router.post('/', asyncRoute(async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  await db.addSubscriber(email);
  // Same answer whether or not the address was already on the list (no way to probe who is subscribed).
  res.status(201).json({ success: true });
}));

module.exports = router;
