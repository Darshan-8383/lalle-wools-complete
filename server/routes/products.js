const express = require('express');
const db = require('../db/sqlite');
const { asyncRoute } = require('../middleware/errorHandler');

const router = express.Router();

// Prices/stock change from the admin panel — never let browsers/CDNs cache them.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// GET /api/products  — optional ?type=clothing & ?category=xyz
router.get('/', asyncRoute(async (req, res) => {
  const list = db.listProducts({ type: req.query.type, category: req.query.category });
  res.json(list);
}));

// GET /api/products/:id
router.get('/:id', asyncRoute(async (req, res) => {
  const product = db.getProduct(req.params.id);
  if (!product || !product.active) return res.status(404).json({ error: 'Product not found' });
  res.json(product);
}));

module.exports = router;
