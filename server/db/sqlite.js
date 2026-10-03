/**
 * Database layer — SQLite (via sql.js)
 * --------------------------------------
 * This is a REAL relational database: proper tables, indexes, foreign keys,
 * and transactional stock decrement — not a hand-rolled JSON file.
 *
 * Why sql.js instead of better-sqlite3/node:sqlite?
 *   sql.js compiles SQLite to WebAssembly, so there is nothing to compile on
 *   install — it works identically on Windows/Mac/Linux with zero build
 *   tools. The trade-off: the whole database lives in memory and we persist
 *   it to disk after each write. For a single-process store doing up to
 *   tens of thousands of orders this is completely fine and is actually how
 *   plenty of small production services run SQLite. When you outgrow a
 *   single Node process (need horizontal scaling / multiple servers), swap
 *   this file for Postgres — every function below is written so routes/
 *   never touch SQL directly, so that swap doesn't ripple outward.
 *
 * Order rows store items/address/amounts/payment/shipment as JSON columns
 * (the same pattern as Postgres JSONB in real production apps) since that
 * data is always read/written as a whole per-order and never needs to be
 * queried column-by-column. Products, users and stock — the things that
 * genuinely need row-level integrity — are normal relational columns.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.LALLEWOOLS_DB_FILE || path.join(DATA_DIR, 'store.sqlite');

let SQL = null;
let db = null;

/** Tiny in-process mutex — serializes every write so stock decrement can never race. */
let queue = Promise.resolve();
function withLock(fn) {
  const result = queue.then(fn);
  queue = result.then(() => {}, () => {}); // never let one failure jam the queue
  return result;
}

function persist() {
  const data = db.export();
  const tmpFile = DB_FILE + '.tmp';
  fs.writeFileSync(tmpFile, Buffer.from(data));
  fs.renameSync(tmpFile, DB_FILE); // atomic on the same filesystem — no half-written DB file on crash
}

/**
 * Users can sign in two ways (email+password or Google), so password_hash is
 * optional — a Google-only account has none.
 * UNIQUE columns allow many NULLs in SQLite, so that is fine.
 */
const usersDDL = (table) => `
CREATE TABLE IF NOT EXISTS ${table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE,
  phone TEXT,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);`;

// Created after the users migration below, because they reference the newer columns.
// Only one account may own a given VERIFIED phone number; unverified numbers typed
// into a profile are just contact details and may repeat.
const USER_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_verified ON users(phone) WHERE phone_verified = 1;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  category TEXT,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  old_price REAL,
  emoji TEXT,
  badge TEXT,
  sticker TEXT,
  description TEXT,
  tee_color TEXT,
  design_text TEXT,
  design_color TEXT,
  image TEXT,
  size_label TEXT,
  sizes_json TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  weight_grams INTEGER DEFAULT 250,
  active INTEGER NOT NULL DEFAULT 1
);

${usersDDL('users')}

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscribers (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_id INTEGER,
  status TEXT NOT NULL,
  razorpay_order_id TEXT,
  items_json TEXT NOT NULL,
  address_json TEXT NOT NULL,
  amounts_json TEXT NOT NULL,
  payment_json TEXT NOT NULL,
  shipment_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_razorpay ON orders(razorpay_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Customer reviews (with optional photos). One review per customer per product; only buyers whose order
-- was delivered can write one (enforced in routes/reviews.js). Photos are files on disk, paths kept here.
-- featured = the admin highlighted it: it also appears in the storefront's Community section.
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  reviewer_name TEXT NOT NULL DEFAULT '',
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  images_json TEXT NOT NULL DEFAULT '[]',
  featured INTEGER NOT NULL DEFAULT 0,
  featured_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (product_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id, created_at);
`;

/**
 * Older databases have users(email NOT NULL, password_hash NOT NULL) and no
 * google_id / *_verified columns. SQLite can't relax NOT NULL in place, so we
 * rebuild the table once (the standard create-copy-drop-rename procedure).
 * Existing users and their ids are preserved, so orders keep pointing at them.
 */
function migrateUsersTable() {
  const info = db.exec('PRAGMA table_info(users)');
  const cols = info.length ? info[0].values.map((r) => ({ name: r[1], notnull: r[3] })) : [];
  const has = (n) => cols.some((c) => c.name === n);
  const emailCol = cols.find((c) => c.name === 'email');
  const needsRebuild = !has('google_id') || !has('phone_verified') || !has('email_verified') ||
    (emailCol && emailCol.notnull === 1);
  if (!needsRebuild) return;

  db.run('PRAGMA foreign_keys = OFF');
  db.run('BEGIN');
  try {
    db.run('DROP TABLE IF EXISTS users_new');
    db.run(usersDDL('users_new').replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE'));
    db.run(`INSERT INTO users_new (id, name, email, phone, password_hash, created_at)
            SELECT id, name, email, phone, password_hash, created_at FROM users`);
    db.run('DROP TABLE users');
    db.run('ALTER TABLE users_new RENAME TO users');
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

/** A reviews table created before the "highlight in Community" feature has no featured columns — add them in place. */
function migrateReviewsTable() {
  const info = db.exec('PRAGMA table_info(reviews)');
  const names = info.length ? info[0].values.map((r) => r[1]) : [];
  if (names.length && !names.includes('featured')) {
    db.run('ALTER TABLE reviews ADD COLUMN featured INTEGER NOT NULL DEFAULT 0');
    db.run('ALTER TABLE reviews ADD COLUMN featured_at TEXT');
  }
}

async function init() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  db.run('DROP TABLE IF EXISTS otp_codes'); // phone-OTP login was removed; clean up the old table
  db.run("DELETE FROM products WHERE type = 'poster'"); // posters were removed from the store; purge legacy rows
  migrateUsersTable();
  db.run(USER_INDEXES);
  migrateReviewsTable();
  persist();

  const { PRODUCTS } = require('../data/product-catalog');
  await syncProductsFromCatalog(PRODUCTS);
  applyLaunchOfferOnce();
  await syncCatalogChanges();
  startCatalogWatch();
  return db;
}

/**
 * ONE-TIME migration: launch offer pricing (price 749, was 1499, "launch offer" badge) on every
 * product that already exists in the database. Guarded by a settings flag so it runs exactly once —
 * any price you change in the admin panel afterwards is left alone on later restarts.
 */
function applyLaunchOfferOnce() {
  if (!db || getSetting('launch_offer_v1')) return;
  db.run("UPDATE products SET price = 749, old_price = 1499, badge = 'launch', sticker = '-50%' WHERE type != 'poster'");
  db.run("INSERT INTO settings (key, value) VALUES ('launch_offer_v1', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  persist();
  writeCatalogFile();
}

/**
 * Seed brand-new products from the catalog file on startup. Deliberately
 * ONE-WAY and ADD-ONLY:
 *   - A product already in the database (by id) is left completely alone,
 *     even if its fields differ from the file — the admin panel is the
 *     live source of truth once the store is running, and edits made there
 *     must survive a server restart/redeploy.
 *   - A product in the database but NOT in the file (e.g. added via the
 *     admin panel's "+ Add Product") is NEVER deleted here. Only the
 *     admin's own Delete button removes a product.
 *   - Only a product whose id doesn't exist in the database yet gets
 *     inserted, picking up whatever is in the catalog file at that id.
 * In short: this file only matters for the very first boot (or for adding
 * a new product by giving it a new id here) — after that, use /admin.
 */
function syncProductsFromCatalog(list) {
  return withLock(() => {
    if (!db) return [];
    const existing = queryAll('SELECT id FROM products');
    const existingIds = new Set(existing.map((p) => p.id));
    const newOnes = list.filter((p) => p.type !== 'poster' && !existingIds.has(p.id));
    if (newOnes.length) seedProducts(newOnes);
    persist();
    return queryAll('SELECT * FROM products');
  });
}

function seedProducts(list) {
  const stmt = db.prepare(`INSERT INTO products
    (id, sku, type, category, name, price, old_price, emoji, badge, sticker, description,
     tee_color, design_text, design_color, image, size_label, sizes_json, stock, weight_grams, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const p of list) {
    stmt.run([
      p.id, p.sku, p.type, p.category || null, p.name, p.price, p.oldPrice || null,
      p.emoji || null, p.badge || null, p.sticker || null, p.desc || null,
      p.teeColor || null, p.designText || null, p.designColor || null, p.image || null,
      p.size || null, p.sizes ? JSON.stringify(p.sizes) : null, p.stock ?? 0, p.weightGrams || 250,
      p.active === false ? 0 : 1,
    ]);
  }
  stmt.free();
  persist();
}

/* ─────────────────── Catalog file → database auto-update ───────────────────
 * Edit a product in server/data/products.json (price, badge, name, stock, image...) and the
 * database follows by itself — on every startup AND while the server is running (the file is
 * watched), so no manual DB step or restart is needed.
 *
 * How it stays safe: for every product we remember a fingerprint of the file's entry the last time
 * the file and database agreed (setting "catalog_hash_<id>"). A product is only updated from the
 * file when its entry in the file no longer matches that fingerprint, i.e. someone actually edited
 * it. Admin-panel edits write through to the file and refresh the fingerprint, so they are never
 * overwritten, and a stale file on ephemeral hosting can't clobber newer admin edits.
 */
const CATALOG_FIELDS = ['sku', 'type', 'category', 'name', 'price', 'oldPrice', 'emoji', 'badge', 'sticker', 'desc',
  'teeColor', 'designText', 'designColor', 'image', 'size', 'sizes', 'stock', 'weightGrams', 'active'];

function catalogEntryHash(p) {
  const norm = {};
  for (const k of CATALOG_FIELDS) {
    let v = p[k];
    if (v === undefined || v === '') v = null;
    if (k === 'active') v = p.active === false || p.active === 0 ? false : true;
    if (k === 'weightGrams') v = Number(v) || 250;
    if (k === 'price' || k === 'stock') v = Number(v) || 0;
    norm[k] = v;
  }
  return crypto.createHash('sha1').update(JSON.stringify(norm)).digest('hex');
}

function rememberCatalogHash(p) {
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['catalog_hash_' + p.id, catalogEntryHash(p)]);
}

function updateRowFromCatalog(p) {
  db.run(
    `UPDATE products SET
       sku=?, type=?, category=?, name=?, price=?, old_price=?, emoji=?, badge=?, sticker=?,
       description=?, tee_color=?, design_text=?, design_color=?, image=?, size_label=?,
       sizes_json=?, stock=?, weight_grams=?, active=?
     WHERE id=?`,
    [
      p.sku, p.type || 'clothing', p.category || null, p.name, Number(p.price) || 0, p.oldPrice || null,
      p.emoji || null, p.badge || null, p.sticker || null, p.desc || null,
      p.teeColor || null, p.designText || null, p.designColor || null, p.image || null,
      p.size || null, p.sizes ? JSON.stringify(p.sizes) : null,
      Number(p.stock) || 0, Number(p.weightGrams) || 250, p.active === false ? 0 : 1,
      p.id,
    ]
  );
}

/** Reads products.json fresh from disk and applies any product that was edited there. Returns how many changed. */
function syncCatalogChanges() {
  return withLock(() => {
    if (!db) return { added: 0, updated: 0 };
    const { loadCatalog } = require('../data/product-catalog');
    const list = loadCatalog().filter((p) => p && p.id != null && p.type !== 'poster');
    if (!list.length) return { added: 0, updated: 0 };
    const existingIds = new Set(queryAll('SELECT id FROM products').map((r) => r.id));
    let added = 0, updated = 0;
    for (const p of list) {
      const stored = rawAll('SELECT value FROM settings WHERE key = ?', ['catalog_hash_' + p.id])[0];
      if (!existingIds.has(p.id)) {
        seedProducts([p]);
        rememberCatalogHash(p);
        added++;
      } else if (!stored) {
        rememberCatalogHash(p); // first run of this feature: just take a baseline, don't touch the live data
      } else if (stored.value !== catalogEntryHash(p)) {
        updateRowFromCatalog(p);
        rememberCatalogHash(p);
        updated++;
      }
    }
    if (added || updated) {
      persist();
      console.log(`[catalog] products.json changed — database updated automatically (${updated} updated, ${added} added)`);
    } else {
      persist();
    }
    return { added, updated };
  });
}

let catalogWatching = false;
function startCatalogWatch() {
  if (catalogWatching || process.env.LALLEWOOLS_NO_CATALOG_WATCH === '1') return;
  try {
    const { CATALOG_FILE } = require('../data/product-catalog');
    fs.watchFile(CATALOG_FILE, { interval: 2000 }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs) return;
      syncCatalogChanges().catch((e) => console.warn('[catalog] auto-sync failed:', e.message));
    }).unref();
    catalogWatching = true;
  } catch (e) {
    console.warn('[catalog] could not watch products.json:', e.message);
  }
}

/* ─────────────────── Catalog file write-through ───────────────────
 * After every product/stock change, mirror the live products table into
 * products.json so the "code" copy always matches what the admin panel shows.
 */
function writeCatalogFile() {
  try {
    const { CATALOG_FILE } = require('../data/product-catalog');
    const list = queryAll('SELECT * FROM products ORDER BY id');
    const clean = list.map((p) => JSON.parse(JSON.stringify(p))); // drop undefined
    const tmp = CATALOG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n');
    fs.renameSync(tmp, CATALOG_FILE);
    // The file now equals the database: remember that, so our own write is never mistaken for a manual edit.
    for (const row of clean) rememberCatalogHash(row);
  } catch (e) {
    console.warn('[catalog] could not write products.json (read-only or ephemeral filesystem?):', e.message);
  }
}

/* ─────────────────────────── Products ─────────────────────────── */

function rowToProduct(cols, vals) {
  const o = {};
  cols.forEach((c, i) => (o[c] = vals[i]));
  return {
    id: o.id,
    sku: o.sku,
    type: o.type,
    category: o.category,
    name: o.name,
    price: o.price,
    oldPrice: o.old_price,
    emoji: o.emoji,
    badge: o.badge,
    sticker: o.sticker,
    desc: o.description,
    teeColor: o.tee_color,
    designText: o.design_text,
    designColor: o.design_color,
    image: o.image,
    size: o.size_label,
    sizes: o.sizes_json ? JSON.parse(o.sizes_json) : undefined,
    stock: o.stock,
    weightGrams: o.weight_grams,
    active: !!o.active,
  };
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  const cols = stmt.getColumnNames();
  while (stmt.step()) rows.push(rowToProduct(cols, stmt.get()));
  stmt.free();
  return rows;
}

function listProducts({ type, category, includeInactive = false } = {}) {
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (!includeInactive) sql += ' AND active = 1';
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  return queryAll(sql, params);
}

function getProduct(id) {
  const rows = queryAll('SELECT * FROM products WHERE id = ?', [id]);
  return rows[0] || null;
}

function updateProduct(id, patch) {
  return withLock(() => {
    const existing = getProduct(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    db.run(
      `UPDATE products SET
         sku=?, type=?, category=?, name=?, price=?, old_price=?, emoji=?, badge=?, sticker=?,
         description=?, tee_color=?, design_text=?, design_color=?, image=?, size_label=?,
         sizes_json=?, stock=?, weight_grams=?, active=?
       WHERE id=?`,
      [
        merged.sku, merged.type, merged.category || null, merged.name, merged.price, merged.oldPrice || null,
        merged.emoji || null, merged.badge || null, merged.sticker || null, merged.desc || null,
        merged.teeColor || null, merged.designText || null, merged.designColor || null, merged.image || null,
        merged.size || null, merged.sizes ? JSON.stringify(merged.sizes) : null,
        merged.stock, merged.weightGrams || 250, merged.active ? 1 : 0,
        id,
      ]
    );
    persist();
    writeCatalogFile();
    return getProduct(id);
  });
}

/** Create a brand-new product. Auto-generates id + sku if not supplied. */
function createProduct(p) {
  return withLock(() => {
    const maxIdRow = db.exec('SELECT COALESCE(MAX(id), 0) AS m FROM products')[0];
    const nextId = maxIdRow.values[0][0] + 1;
    const id = p.id || nextId;
    const sku = p.sku || `LW-${(p.type || 'gen').slice(0, 2).toUpperCase()}-${id}`;

    db.run(
      `INSERT INTO products
        (id, sku, type, category, name, price, old_price, emoji, badge, sticker, description,
         tee_color, design_text, design_color, image, size_label, sizes_json, stock, weight_grams, active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, sku, p.type || 'clothing', p.category || null, p.name, Number(p.price) || 0, p.oldPrice || null,
        p.emoji || null, p.badge || null, p.sticker || null, p.desc || null,
        p.teeColor || null, p.designText || null, p.designColor || null, p.image || null,
        p.size || null, p.sizes ? JSON.stringify(p.sizes) : null,
        Number(p.stock) || 0, Number(p.weightGrams) || 250, p.active === false ? 0 : 1,
      ]
    );
    persist();
    writeCatalogFile();
    return getProduct(id);
  });
}

/** Hard-delete a product. Safe: order records store a self-contained item
 *  snapshot (name/price/sku at the time of purchase), so past orders keep
 *  displaying correctly even after the product row itself is gone. */
function deleteProduct(id) {
  return withLock(() => {
    const existing = getProduct(id);
    if (!existing) return false;
    db.run('DELETE FROM products WHERE id=?', [id]);
    persist();
    writeCatalogFile();
    return true;
  });
}

/* ─────────────────────────── Orders ─────────────────────────── */

function genOrderId() {
  // Non-sequential on purpose (timestamp + random) so order IDs can't be
  // enumerated/guessed by incrementing — matters once invoice/tracking
  // lookups are keyed off this ID.
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return 'LW' + Date.now().toString(36).toUpperCase() + rand;
}

function rowToOrder(cols, vals) {
  const o = {};
  cols.forEach((c, i) => (o[c] = vals[i]));
  return {
    id: o.id,
    customerId: o.customer_id,
    status: o.status,
    items: JSON.parse(o.items_json),
    address: JSON.parse(o.address_json),
    amounts: JSON.parse(o.amounts_json),
    payment: JSON.parse(o.payment_json),
    shipment: o.shipment_json ? JSON.parse(o.shipment_json) : null,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

function queryOrders(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  const cols = stmt.getColumnNames();
  while (stmt.step()) rows.push(rowToOrder(cols, stmt.get()));
  stmt.free();
  return rows;
}

/**
 * Creates an order AND decrements stock atomically. If any item doesn't
 * have enough stock, the whole thing is rejected and NOTHING is written —
 * this is the fix for the "two people buy the last unit" race condition.
 * Because it runs inside withLock(), no two orders can decrement stock at
 * the same instant even under concurrent requests.
 */
function createOrderWithStockDecrement({ items, address, amounts, payment, customerId, shipment }) {
  return withLock(() => {
    // 1. Validate stock for every line against the live DB values.
    for (const line of items) {
      const product = getProduct(line.id);
      if (!product || !product.active) throw new Error(`Product ${line.id} is not available`);
      if (product.stock < line.qty) {
        throw new Error(`"${product.name}" only has ${product.stock} left in stock`);
      }
    }
    // 2. Decrement stock for every line.
    for (const line of items) {
      db.run('UPDATE products SET stock = stock - ? WHERE id = ?', [line.qty, line.id]);
    }
    // 3. Insert the order.
    const id = genOrderId();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO orders (id, customer_id, status, razorpay_order_id, items_json, address_json, amounts_json, payment_json, shipment_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, customerId || null, 'pending', null, JSON.stringify(items), JSON.stringify(address),
       JSON.stringify(amounts), JSON.stringify(payment), shipment ? JSON.stringify(shipment) : null, now, now]
    );
    persist();
    writeCatalogFile();
    return queryOrders('SELECT * FROM orders WHERE id = ?', [id])[0];
  });
}

function getOrder(id) {
  return queryOrders('SELECT * FROM orders WHERE id = ?', [id])[0] || null;
}

function findOrderByRazorpayOrderId(rpOrderId) {
  return queryOrders('SELECT * FROM orders WHERE razorpay_order_id = ?', [rpOrderId])[0] || null;
}

function updateOrder(id, patch) {
  return withLock(() => {
    const existing = getOrder(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    const razorpayOrderId = merged.payment && merged.payment.razorpayOrderId ? merged.payment.razorpayOrderId : null;
    db.run(
      `UPDATE orders SET status=?, razorpay_order_id=?, items_json=?, address_json=?, amounts_json=?, payment_json=?, shipment_json=?, updated_at=? WHERE id=?`,
      [merged.status, razorpayOrderId, JSON.stringify(merged.items), JSON.stringify(merged.address),
       JSON.stringify(merged.amounts), JSON.stringify(merged.payment),
       merged.shipment ? JSON.stringify(merged.shipment) : null, merged.updatedAt, id]
    );
    persist();
    return getOrder(id);
  });
}

/** Used when an order is cancelled — puts the stock back. */
function restoreStock(items) {
  return withLock(() => {
    for (const line of items) {
      db.run('UPDATE products SET stock = stock + ? WHERE id = ?', [line.qty, line.id]);
    }
    persist();
    writeCatalogFile();
  });
}

function listOrdersByCustomer(customerId) {
  return queryOrders('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC', [customerId]);
}

function listAllOrders({ status, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM orders WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return queryOrders(sql, params);
}

/** SQL fragment: an order only "counts" once it is a real order — COD, or an online order that has been paid. */
const COUNTS_AS_ORDER = `(json_extract(payment_json, '$.method') = 'cod' OR json_extract(payment_json, '$.status') = 'paid')`;

function orderStats() {
  const totalRow = db.exec(`SELECT COUNT(*) c, COALESCE(SUM(json_extract(amounts_json, '$.total')),0) rev FROM orders WHERE status != 'cancelled' AND ${COUNTS_AS_ORDER}`)[0];
  const pendingRow = db.exec(`SELECT COUNT(*) c FROM orders WHERE status IN ('pending','confirmed') AND ${COUNTS_AS_ORDER}`)[0];
  return {
    totalOrders: totalRow.values[0][0],
    totalRevenue: totalRow.values[0][1],
    pendingOrders: pendingRow.values[0][0],
  };
}

/** True once an order is a real order: COD, or an online order whose payment was captured. */
function isPaymentSettled(order) {
  return order.payment.method === 'cod' || order.payment.status === 'paid';
}

/** An online order that was started but never paid (abandoned, expired or still waiting). It was never really "placed". */
function isNeverPaid(order) {
  return order.payment.method !== 'cod' && !order.payment.paidAt && !order.payment.gatewayPaymentId;
}

/* ─────────────────────────── Users ─────────────────────────── */

function rowToUser(cols, vals) {
  const o = {};
  cols.forEach((c, i) => (o[c] = vals[i]));
  return {
    id: o.id, name: o.name, email: o.email, phone: o.phone,
    passwordHash: o.password_hash, googleId: o.google_id,
    emailVerified: o.email_verified === 1,
    createdAt: o.created_at,
  };
}

function queryUser(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  const cols = stmt.getColumnNames();
  if (stmt.step()) row = rowToUser(cols, stmt.get());
  stmt.free();
  return row;
}

function findUserByEmail(email) {
  return queryUser('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase()]);
}
function getUserById(id) {
  return queryUser('SELECT * FROM users WHERE id = ?', [id]);
}
function findUserByGoogleId(googleId) {
  return queryUser('SELECT * FROM users WHERE google_id = ?', [String(googleId)]);
}

function createUser({ name, email, phone, passwordHash, googleId, emailVerified }) {
  return withLock(() => {
    const now = new Date().toISOString();
    try {
      db.run(
        `INSERT INTO users (name, email, phone, password_hash, google_id, phone_verified, email_verified, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          name || '', email ? String(email).toLowerCase() : null, phone || null, passwordHash || null,
          googleId || null, 0, emailVerified ? 1 : 0, now,
        ]
      );
    } catch (e) {
      const msg = String(e.message);
      if (msg.includes('UNIQUE')) {
        if (msg.includes('users.email')) throw new Error('An account with this email already exists');
        if (msg.includes('users.phone')) throw new Error('An account with this mobile number already exists');
        throw new Error('An account with these details already exists');
      }
      throw e;
    }
    const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    persist();
    return getUserById(id);
  });
}

/** Update a customer's own profile fields (name, phone). Email/password have their own dedicated flows. */
function updateUser(id, { name, phone }) {
  return withLock(() => {
    const existing = getUserById(id);
    if (!existing) return null;
    const nextPhone = phone !== undefined ? (phone || null) : existing.phone;
    db.run('UPDATE users SET name=?, phone=? WHERE id=?', [
      name !== undefined ? name : existing.name,
      nextPhone,
      id,
    ]);
    persist();
    return getUserById(id);
  });
}

/** Set a new password hash directly (used after verifying the current password in the route). */
function updateUserPassword(id, passwordHash) {
  return withLock(() => {
    db.run('UPDATE users SET password_hash=? WHERE id=?', [passwordHash, id]);
    persist();
    return true;
  });
}

/**
 * Attach a Google identity to an existing account (matched by its verified email).
 * clearPassword: used when the account's email was never verified — whoever
 * registered it by password may not own that address, so that password stops
 * working once the real owner proves ownership through Google.
 */
function linkGoogleAccount(id, googleId, { clearPassword = false } = {}) {
  return withLock(() => {
    db.run(
      `UPDATE users SET google_id=?, email_verified=1,
         password_hash = CASE WHEN ? = 1 THEN NULL ELSE password_hash END
       WHERE id=?`,
      [String(googleId), clearPassword ? 1 : 0, id]
    );
    persist();
    return getUserById(id);
  });
}

/** Mark an address as confirmed. Matching on the email too means a link for an old address can't verify a changed one. */
function markEmailVerified(id, email) {
  return withLock(() => {
    db.run('UPDATE users SET email_verified=1 WHERE id=? AND email=?', [id, String(email).toLowerCase()]);
    persist();
    return getUserById(id);
  });
}

/**
 * Remove a never-verified, never-used password account so the address can be registered again.
 * Without this, anyone could sign up with somebody else's email and lock the real owner out.
 * Refuses (returns false) if the account is verified, has Google linked, or has any orders.
 */
function deleteUnverifiedEmptyUser(id) {
  return withLock(() => {
    const u = getUserById(id);
    if (!u || u.emailVerified || u.googleId) return false;
    const stmt = db.prepare('SELECT COUNT(*) FROM orders WHERE customer_id = ?');
    stmt.bind([id]);
    stmt.step();
    const orderCount = stmt.get()[0];
    stmt.free();
    if (orderCount > 0) return false;
    db.run('DELETE FROM users WHERE id=?', [id]);
    persist();
    return true;
  });
}

/** Generic row reader: plain objects keyed by column name (queryAll above is product-specific). */
function rawAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  const cols = stmt.getColumnNames();
  while (stmt.step()) {
    const vals = stmt.get();
    const row = {};
    cols.forEach((c, i) => { row[c] = vals[i]; });
    rows.push(row);
  }
  stmt.free();
  return rows;
}

/* ─────────────────── Newsletter subscribers ─────────────────── */
/** Idempotent: subscribing the same address twice is a silent success. Returns true if it was new. */
function addSubscriber(email) {
  return withLock(() => {
    const addr = String(email).trim().toLowerCase();
    const existing = rawAll('SELECT email FROM subscribers WHERE email = ?', [addr]);
    if (existing.length) return false;
    db.run('INSERT INTO subscribers (email, created_at) VALUES (?,?)', [addr, new Date().toISOString()]);
    persist();
    return true;
  });
}
function listSubscribers() {
  return rawAll('SELECT email, created_at AS createdAt FROM subscribers ORDER BY created_at DESC');
}

/* ─────────────────── Store settings (admin-editable key/value) ─────────────────── */
function getSetting(key) {
  const rows = rawAll('SELECT value FROM settings WHERE key = ?', [key]);
  return rows.length ? rows[0].value : null;
}
/** Pass null/'' to remove the setting. */
function setSetting(key, value) {
  return withLock(() => {
    if (value == null || value === '') db.run('DELETE FROM settings WHERE key = ?', [key]);
    else db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
    persist();
  });
}

/** Cheap liveness probe for /api/health — proves the in-memory DB is open and answering. */
function ping() {
  return Boolean(db) && rawAll('SELECT 1 AS ok')[0].ok === 1;
}

/* ─────────────────────────── Reviews ─────────────────────────── */

function rowToReview(r) {
  return {
    id: r.id, productId: r.product_id, userId: r.user_id, orderId: r.order_id,
    reviewerName: r.reviewer_name, rating: r.rating, body: r.body,
    images: JSON.parse(r.images_json || '[]'), featured: !!r.featured, featuredAt: r.featured_at || null,
    createdAt: r.created_at,
  };
}

/** The delivered order that lets this customer review this product, or null. */
function findReviewableOrder(userId, productId) {
  const pid = Number(productId);
  return listOrdersByCustomer(userId).find((o) => o.status === 'delivered' && o.items.some((i) => Number(i.id) === pid)) || null;
}

function getUserReviewForProduct(userId, productId) {
  const r = rawAll('SELECT * FROM reviews WHERE user_id = ? AND product_id = ?', [userId, Number(productId)])[0];
  return r ? rowToReview(r) : null;
}

function createReview({ productId, userId, orderId, reviewerName, rating, body, images }) {
  return withLock(() => {
    if (getUserReviewForProduct(userId, productId)) throw Object.assign(new Error('You have already reviewed this product'), { status: 409 });
    db.run(
      `INSERT INTO reviews (product_id, user_id, order_id, reviewer_name, rating, body, images_json, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [Number(productId), userId, orderId, reviewerName || '', rating, body || '', JSON.stringify(images || []), new Date().toISOString()]
    );
    const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    persist();
    return rowToReview(rawAll('SELECT * FROM reviews WHERE id = ?', [id])[0]);
  });
}

function getReview(id) {
  const r = rawAll('SELECT * FROM reviews WHERE id = ?', [Number(id)])[0];
  return r ? rowToReview(r) : null;
}

/** Newest first, but highlighted reviews float to the top so shoppers see the best ones first. */
function listReviewsForProduct(productId, { limit = 100, offset = 0 } = {}) {
  return rawAll('SELECT * FROM reviews WHERE product_id = ? ORDER BY featured DESC, created_at DESC, id DESC LIMIT ? OFFSET ?', [Number(productId), limit, offset]).map(rowToReview);
}

function getReviewSummary(productId) {
  const row = rawAll('SELECT COUNT(*) AS c, AVG(rating) AS a FROM reviews WHERE product_id = ?', [Number(productId)])[0];
  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rawAll('SELECT rating, COUNT(*) AS c FROM reviews WHERE product_id = ? GROUP BY rating', [Number(productId)])) breakdown[r.rating] = r.c;
  return { count: row.c, average: row.c ? Math.round(row.a * 10) / 10 : 0, breakdown };
}

function listAllReviews({ limit = 100, offset = 0 } = {}) {
  return rawAll('SELECT * FROM reviews ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?', [limit, offset]).map(rowToReview);
}

/** The reviews the admin highlighted, most recently highlighted first — these are shown in the Community section. */
function listFeaturedReviews(limit = 8) {
  return rawAll('SELECT * FROM reviews WHERE featured = 1 ORDER BY featured_at DESC, id DESC LIMIT ?', [limit]).map(rowToReview);
}

/** Highlight / un-highlight a review. Returns the updated review, or null if it doesn't exist. */
function setReviewFeatured(id, featured) {
  return withLock(() => {
    if (!getReview(id)) return null;
    db.run('UPDATE reviews SET featured = ?, featured_at = ? WHERE id = ?', [featured ? 1 : 0, featured ? new Date().toISOString() : null, Number(id)]);
    persist();
    return getReview(id);
  });
}

/** Returns the deleted review (so the caller can remove its photo files), or null if it didn't exist. */
function deleteReview(id) {
  return withLock(() => {
    const existing = getReview(id);
    if (!existing) return null;
    db.run('DELETE FROM reviews WHERE id = ?', [Number(id)]);
    persist();
    return existing;
  });
}

module.exports = {
  init, ping, DB_FILE,
  // newsletter
  addSubscriber, listSubscribers,
  // settings
  getSetting, setSetting,
  // products
  listProducts, getProduct, updateProduct, createProduct, deleteProduct,
  syncProductsFromCatalog, syncCatalogChanges, seedProducts, writeCatalogFile,
  // orders
  createOrderWithStockDecrement, getOrder, updateOrder, restoreStock,
  listOrdersByCustomer, listAllOrders, findOrderByRazorpayOrderId, orderStats, isPaymentSettled, isNeverPaid,
  // reviews
  findReviewableOrder, getUserReviewForProduct, createReview, getReview, listReviewsForProduct, getReviewSummary,
  listAllReviews, listFeaturedReviews, setReviewFeatured, deleteReview,
  // users
  createUser, findUserByEmail, findUserByGoogleId, getUserById,
  updateUser, updateUserPassword, linkGoogleAccount, markEmailVerified, deleteUnverifiedEmptyUser,
};
