const express = require('express');
const db = require('../db/sqlite');
const { optionalAuth, requireAuth } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { saveImages, deleteImages } = require('../services/reviewImages');

const router = express.Router();
const MAX_BODY = 1000;
const COMMUNITY_LIMIT = 8; // how many highlighted reviews the homepage Community section shows

// Reviews change as customers post them — don't let browsers cache the lists.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

/** "Priya Sharma" -> "Priya S." — the public sees a first name only; never an email or phone. */
function publicName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Verified buyer';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

function toPublic(r, viewerId) {
  return {
    id: r.id, rating: r.rating, body: r.body, images: r.images, createdAt: r.createdAt,
    name: publicName(r.reviewerName), verified: true, featured: r.featured, mine: Boolean(viewerId) && r.userId === viewerId,
  };
}

// GET /api/reviews/featured — the admin-highlighted reviews for the Community section (public)
router.get('/featured', asyncRoute(async (req, res) => {
  const out = [];
  for (const r of db.listFeaturedReviews(COMMUNITY_LIMIT * 2)) {
    const product = db.getProduct(r.productId);
    if (!product || !product.active) continue; // its product was removed or hidden
    out.push({
      id: r.id, rating: r.rating, body: r.body, image: r.images[0] || null, photoCount: r.images.length,
      name: publicName(r.reviewerName), createdAt: r.createdAt, productId: product.id, productName: product.name,
    });
    if (out.length >= COMMUNITY_LIMIT) break;
  }
  res.json(out);
}));

// GET /api/reviews/product/:id — public list + rating summary
router.get('/product/:id', optionalAuth, asyncRoute(async (req, res) => {
  const product = db.getProduct(req.params.id);
  if (!product || !product.active) return res.status(404).json({ error: 'Product not found' });
  const viewerId = req.user ? req.user.sub : null;
  res.json({
    summary: db.getReviewSummary(product.id),
    reviews: db.listReviewsForProduct(product.id).map((r) => toPublic(r, viewerId)),
  });
}));

// GET /api/reviews/eligibility/:productId — can the logged-in customer review this product right now?
router.get('/eligibility/:productId', optionalAuth, asyncRoute(async (req, res) => {
  if (!req.user) return res.json({ canReview: false, reason: 'login' });
  if (db.getUserReviewForProduct(req.user.sub, req.params.productId)) return res.json({ canReview: false, reason: 'already_reviewed' });
  const order = db.findReviewableOrder(req.user.sub, req.params.productId);
  res.json(order ? { canReview: true } : { canReview: false, reason: 'not_delivered' });
}));

// POST /api/reviews  { productId, rating, body, images: [dataUrl, ...] }
router.post('/', requireAuth, asyncRoute(async (req, res) => {
  const { productId, rating, body, images } = req.body || {};
  const product = db.getProduct(productId);
  if (!product) throw Object.assign(new Error('Product not found'), { status: 404 });

  const stars = Number(rating);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw Object.assign(new Error('Please choose a rating from 1 to 5 stars'), { status: 400 });
  const text = String(body == null ? '' : body).trim();
  if (text.length > MAX_BODY) throw Object.assign(new Error(`Please keep your review under ${MAX_BODY} characters`), { status: 400 });

  const userId = req.user.sub;
  if (db.getUserReviewForProduct(userId, product.id)) throw Object.assign(new Error('You have already reviewed this product'), { status: 409 });
  const order = db.findReviewableOrder(userId, product.id);
  if (!order) throw Object.assign(new Error('You can review a product once your order for it has been delivered'), { status: 403 });

  const user = db.getUserById(userId);
  const urls = saveImages(images);
  try {
    const review = await db.createReview({
      productId: product.id, userId, orderId: order.id,
      reviewerName: (user && user.name) || order.address.name, rating: stars, body: text, images: urls,
    });
    res.status(201).json(toPublic(review, userId));
  } catch (e) {
    deleteImages(urls); // don't leave photos behind for a review that was never saved
    throw e;
  }
}));

// DELETE /api/reviews/:id — customers can remove their own review
router.delete('/:id', requireAuth, asyncRoute(async (req, res) => {
  const existing = db.getReview(req.params.id);
  if (!existing || existing.userId !== req.user.sub) return res.status(404).json({ error: 'Review not found' });
  const removed = await db.deleteReview(existing.id);
  if (removed) deleteImages(removed.images);
  res.json({ deleted: true });
}));

module.exports = router;
