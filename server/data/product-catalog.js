/**
 * LALLEWOOLS — Product Catalog (seed source)
 * ------------------------------------------------------
 * The product list now lives in products.json (same folder). That file is
 * kept in sync AUTOMATICALLY: every time you add/edit/delete a product (or
 * stock changes) in the admin panel, the server rewrites products.json.
 *
 * On boot, any product in products.json that is missing from the database is
 * inserted — so if the database file is ever wiped (ephemeral hosting,
 * redeploy), the store comes back with your latest admin edits instead of
 * old hardcoded prices — as long as products.json itself survives
 * (persistent disk, or commit the file via Admin → Products → Export).
 */
const fs = require('fs');
const path = require('path');

const CATALOG_FILE = process.env.LALLEWOOLS_CATALOG_FILE || path.join(__dirname, 'products.json');
const CLOTHING_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];

function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  } catch (e) {
    console.warn('[catalog] could not read', CATALOG_FILE, '-', e.message);
    return [];
  }
}

const PRODUCTS = loadCatalog();

module.exports = { PRODUCTS, CLOTHING_SIZES, CATALOG_FILE, loadCatalog };
