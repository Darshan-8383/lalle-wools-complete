require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

const db = require('./db/sqlite');
const { normalizeWhatsappNumber } = require('./services/phone');
const productsRoute = require('./routes/products');
const { router: ordersRoute } = require('./routes/orders');
const paymentRoute = require('./routes/payment');
const shippingRoute = require('./routes/shipping');
const authRoute = require('./routes/auth');
const newsletterRoute = require('./routes/newsletter');
const adminRoute = require('./routes/admin');
const reviewsRoute = require('./routes/reviews');
const { UPLOAD_DIR } = require('./services/reviewImages');
const paymentService = require('./services/payment');
const emailService = require('./services/email');
const shippingService = require('./services/shipping');
const { errorHandler } = require('./middleware/errorHandler');
const { startAutoBackup } = require('./services/backup');
const { startHousekeeping } = require('./services/housekeeping');
const { startTrackingSync } = require('./services/tracking');

const app = express();
const PORT = process.env.PORT || 4000;
const isProd = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Refuse to boot a production server that is misconfigured in ways that are dangerous rather than merely incomplete. */
function validateEnv() {
  const problems = [];
  const secret = process.env.JWT_SECRET || '';
  if (isProd && secret.length < 32) problems.push('JWT_SECRET must be set to a random string of at least 32 characters (run: npm run generate-jwt-secret).');
  if (isProd && /change.?me|secret|password/i.test(secret)) problems.push('JWT_SECRET looks like a placeholder — generate a real one.');
  if (isProd && emailService.verificationRequired() && !process.env.SITE_URL) problems.push('SITE_URL must be set (e.g. https://lallewools.com) — email-verification links are built from it.');
  if (problems.length) {
    console.error('\n❌ Refusing to start in production:\n  - ' + problems.join('\n  - ') + '\n');
    process.exit(1);
  }
}
validateEnv();

// Running behind a reverse proxy (nginx, Render, Railway, Cloudflare...) means req.ip would be the
// proxy's address for everyone, so rate limiting would throttle ALL visitors together. Default: trust
// one proxy hop. If this server is exposed directly to the internet, set TRUST_PROXY=0 in .env.
const trustProxy = process.env.TRUST_PROXY === undefined ? 1 : (Number.isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY));
app.set('trust proxy', trustProxy);

// Content-Security-Policy: only what the storefront really needs (Razorpay checkout, Google sign-in, Google Fonts).
// 'unsafe-inline' is allowed for style attributes and inline event handlers (onclick=...) used throughout the pages.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://checkout.razorpay.com', 'https://accounts.google.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com', 'https://accounts.google.com'],
      frameSrc: ['https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://accounts.google.com'],
      formAction: ["'self'", 'https://api.razorpay.com'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      ...(isProd ? { upgradeInsecureRequests: [] } : {}), // would break plain-http localhost testing
    },
  },
  // Google sign-in and Razorpay both open popups that talk back to this page.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));
app.use(compression());

// The storefront is served from this same server, so CORS is only needed if a *different* site calls the API.
// Production default: CORS off. Set CLIENT_ORIGIN=https://other-site.com (comma-separate several) to allow one.
const corsOrigins = (process.env.CLIENT_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);
if (corsOrigins.includes('*')) {
  if (isProd) console.warn('⚠️  CLIENT_ORIGIN=* lets ANY website call your API from a browser. Remove it (same-origin needs no CORS) or set your real domain.');
  app.use(cors({ origin: '*' }));
} else if (corsOrigins.length) {
  app.use(cors({ origin: corsOrigins }));
} else if (!isProd) {
  app.use(cors({ origin: '*' }));
}
app.use(morgan(isProd ? 'combined' : 'dev', { skip: (req) => req.path === '/api/health' }));

// The Razorpay webhook needs the *raw* request body to verify its signature,
// so it gets its own express.raw() before the global json() parser touches it.
app.use('/api/payment/webhook', express.raw({ type: '*/*', limit: '256kb' }));
// Review photos arrive as base64 inside the JSON body (up to 3 photos, already shrunk by the browser), so
// ONLY this route gets a bigger body limit; everything else stays at 100kb. Registered first so it parses
// the body before the small global parser can reject it.
app.use('/api/reviews', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '100kb' }));

// Rate limiting: generous for browsing, tighter for the endpoints that are
// actually worth abusing (creating orders, brute-forcing login).
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, please try again later.' } });
const orderLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many orders placed too quickly, please slow down.' } });

const reviewLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, skip: (req) => req.method !== 'POST', message: { error: 'Too many reviews from this connection, please try again later.' } });
const newsletterLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many sign-ups from this connection, please try again later.' } });

app.use('/api/', generalLimiter);
app.use('/api/newsletter', newsletterLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/google', authLimiter);
app.use('/api/auth/resend-verification', authLimiter);
app.use('/api/admin/login', authLimiter);
app.use('/api/orders', orderLimiter);
app.use('/api/reviews', reviewLimiter);

app.use('/api/products', productsRoute);
app.use('/api/orders', ordersRoute);
app.use('/api/payment', paymentRoute);
app.use('/api/shipping', shippingRoute);
app.use('/api/auth', authRoute);
app.use('/api/newsletter', newsletterRoute);
app.use('/api/admin', adminRoute);
app.use('/api/reviews', reviewsRoute);

// Lets the storefront know what it can offer (e.g. hide online payment when no gateway is configured).
app.get('/api/config', (req, res) => {
  res.json({
    onlinePayments: paymentService.isConfigured(),
    emailVerificationRequired: emailService.verificationRequired(),
    codFee: require('./routes/orders').COD_FEE,
    shippingFee: require('./routes/orders').SHIPPING_FEE,
    googleClientId: process.env.GOOGLE_CLIENT_ID || null, // public by design — it's embedded in every Google button
    supportEmail: process.env.BUSINESS_EMAIL || null,
    // Digits only, country code included (wa.me format). Blank/invalid => Custom Tee section stays hidden.
    // Admin-panel value wins; ADMIN_WHATSAPP in .env is the fallback.
    adminWhatsapp: normalizeWhatsappNumber(db.getSetting('admin_whatsapp')) || normalizeWhatsappNumber(process.env.ADMIN_WHATSAPP),
    social: {
      instagram: process.env.SOCIAL_INSTAGRAM || null,
      twitter: process.env.SOCIAL_TWITTER || null,
      youtube: process.env.SOCIAL_YOUTUBE || null,
      discord: process.env.SOCIAL_DISCORD || null,
    },
  });
});

// Liveness/readiness probe for uptime monitors and Docker. Deliberately says nothing about which providers are configured.
app.get('/api/health', (req, res) => {
  let dbOk = false;
  try { dbOk = db.ping(); } catch (e) { /* reported below */ }
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, uptime: Math.round(process.uptime()) });
});

// Unknown API routes get JSON, not the HTML page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// robots.txt + sitemap.xml. Set SITE_URL=https://yourdomain.com in .env so the sitemap carries your real address.
const siteUrl = (req) => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${siteUrl(req)}/sitemap.xml\n`);
});
app.get('/sitemap.xml', (req, res) => {
  const base = siteUrl(req);
  const pages = ['/', '/legal/shipping-policy.html', '/legal/refund-policy.html', '/legal/privacy-policy.html', '/legal/terms.html'];
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    pages.concat(db.listProducts().map((p) => `/?product=${p.id}`)).map((p) => `  <url><loc>${base}${p}</loc></url>`).join('\n') + '\n</urlset>\n'
  );
});

// The storefront page carries your real address in its canonical/social-preview tags, filled in per request.
const fs = require('fs');
const INDEX_TEMPLATE = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const escAttr = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Prefer the 1200px WebP of a product photo for link previews when it exists.
function previewImagePath(img) {
  if (!img) return null;
  const big = img.replace(/\.[a-z]+$/i, '.w1200.webp');
  return fs.existsSync(path.join(PUBLIC_DIR, big)) ? big : img;
}
app.get(['/', '/index.html'], (req, res) => {
  const base = siteUrl(req);
  let html = INDEX_TEMPLATE.replace(/__SITE_URL__/g, base);

  // Shared product link (/?product=ID): fill the page + social-preview tags (WhatsApp, Instagram, etc.) for that product.
  const pid = parseInt(req.query.product, 10);
  const p = Number.isFinite(pid) ? db.getProduct(pid) : null;
  if (p && p.active) {
    const url = `${base}/?product=${p.id}`;
    const title = `${p.name} — ₹${p.price} | LALLEWOOLS`;
    const desc = p.desc || 'Oversized streetwear tees and fan art for your culture.';
    const img = previewImagePath(p.image);
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`)
      .replace(/(<meta name="description" content=")[^"]*(")/, `$1${escAttr(desc)}$2`)
      .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${escAttr(url)}$2`)
      .replace(/(<meta property="og:type" content=")[^"]*(")/, '$1product$2')
      .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escAttr(title)}$2`)
      .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${escAttr(desc)}$2`)
      .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${escAttr(url)}$2`);
    if (img) html = html.replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${escAttr(`${base}/${img}`)}$2`);
  }
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});

// Customer review photos. Served from the data volume (not /public), long-cached because names are random and never reused.
app.use('/uploads/reviews', express.static(UPLOAD_DIR, {
  fallthrough: false, index: false, dotfiles: 'deny', maxAge: '30d', immutable: true,
  setHeaders(res) { res.setHeader('Content-Security-Policy', "default-src 'none'"); },
}));

// Serve the storefront + the admin panel as static files.
// HTML/CSS/JS are revalidated on every load (cheap 304s via ETag) so a deploy is never half-visible;
// images are the heavy part, so they are cached for a week.
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  setHeaders(res, file) {
    if (/\.(png|jpe?g|webp|avif|svg|ico|woff2?)$/i.test(file)) res.setHeader('Cache-Control', 'public, max-age=604800');
    else res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get('/admin', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(PUBLIC_DIR, 'admin.html')); });
// The storefront is a single page driven by #anchors, so only "/" is a real page; anything else is a 404.
app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

// Must be last: catches every thrown/rejected error from the routes above.
app.use(errorHandler);

async function start() {
  await db.init();
  if (!process.env.JWT_SECRET) {
    console.warn('\n⚠️  JWT_SECRET is not set in .env — customer/admin login will not work until you add one.');
    console.warn('   Generate one with: node scripts/generate-jwt-secret.js\n');
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn('ℹ️  GOOGLE_CLIENT_ID not set — the "Continue with Google" button is hidden until you add one (see .env.example).');
  }
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD_HASH) {
    console.warn('⚠️  ADMIN_EMAIL / ADMIN_PASSWORD_HASH not set — the admin panel login will not work yet.');
    console.warn('   Generate a password hash with: node scripts/hash-password.js "your-password"\n');
  }
  if (isProd) {
    // These run fine without keys, but a real shop should know it is not fully live.
    if (!shippingService.isConfigured()) console.warn('⚠️  PRODUCTION without Shiprocket keys: shipments are simulated (fake AWBs). Fine for COD-by-hand fulfilment, not for real courier booking.');
    if (!process.env.SMTP_HOST) console.warn('⚠️  PRODUCTION without SMTP: customers will NOT receive order emails.');
  }

  const server = app.listen(PORT, () => {
    console.log(`\n🛍  LALLEWOOLS server running on port ${PORT} (${isProd ? 'production' : 'development'})`);
    console.log(`   Storefront:         http://localhost:${PORT}`);
    console.log(`   Admin panel:        http://localhost:${PORT}/admin`);
    console.log(`   Payment gateway:    ${paymentService.isConfigured() ? 'RAZORPAY (live keys found)' : 'OFF — online payment hidden, COD only (set RAZORPAY_KEY_ID/SECRET in .env to enable)'}`);
    console.log(`   Shipping provider:  ${shippingService.isConfigured() ? 'SHIPROCKET (live keys found)' : 'MOCK MODE — set SHIPROCKET_EMAIL/PASSWORD in .env to go live'}`);
    console.log(`   Email service:      ${process.env.SMTP_HOST ? 'SMTP (live)' : 'MOCK MODE — set SMTP_HOST/USER/PASS in .env to send real emails'}\n`);
  });

  if (isProd) startAutoBackup(db.DB_FILE);
  startHousekeeping();
  startTrackingSync();

  // Graceful shutdown: stop taking new requests, let in-flight ones (an order being placed...) finish, then exit.
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} received — shutting down gracefully…`);
    server.close(() => { console.log('Closed. Bye.'); process.exit(0); });
    setTimeout(() => { console.error('Forced exit after 10s'); process.exit(1); }, 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

// A stray rejected promise should be logged loudly, not silently ignored; a truly uncaught exception leaves
// the process in an unknown state, so log it and exit — Docker/pm2/systemd will restart a clean process.
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => { console.error('[uncaughtException]', err); process.exit(1); });

if (require.main === module) {
  start().catch((err) => {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
