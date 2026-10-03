const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Point the DB layer at a throwaway file so tests never touch real store data.
const TEST_DB = path.join(__dirname, '.tmp-test.sqlite');
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
if (fs.existsSync(TEST_DB + '.tmp')) fs.unlinkSync(TEST_DB + '.tmp');
process.env.LALLEWOOLS_DB_FILE = TEST_DB;
// Same for the catalog file: write-through must not overwrite the real products.json.
const TEST_CATALOG = path.join(__dirname, '.tmp-test-products.json');
fs.copyFileSync(path.join(__dirname, '..', 'server', 'data', 'products.json'), TEST_CATALOG);
process.env.LALLEWOOLS_CATALOG_FILE = TEST_CATALOG;

const db = require('../server/db/sqlite');

test.before(async () => {
  await db.init();
});

test.after(() => {
  if (fs.existsSync(TEST_CATALOG)) fs.unlinkSync(TEST_CATALOG);
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_DB + '.tmp')) fs.unlinkSync(TEST_DB + '.tmp');
});

test('product catalog is seeded on first init', () => {
  const products = db.listProducts();
  assert.ok(products.length > 0, 'expected seeded products');
});

test('catalog sync is add-only: it never overwrites an existing product, even if the file changed', async () => {
  const catalog = require('../server/data/product-catalog').PRODUCTS;
  const target = catalog.find((p) => p.id === 1);
  assert.ok(target, 'expected catalog to include product 1');

  // Simulate an admin panel edit that now differs from the code file.
  const adminEditedName = 'Admin-Renamed Product (should survive a restart)';
  await db.updateProduct(1, { name: adminEditedName });

  // Simulate what happens on every server restart/redeploy.
  await db.syncProductsFromCatalog(catalog);

  const after = db.getProduct(1);
  assert.equal(after.name, adminEditedName, 'sync must never overwrite an admin edit with the code file\'s value');
});

test('catalog sync never deletes a product that was added outside the file (e.g. via the admin panel)', async () => {
  const catalog = require('../server/data/product-catalog').PRODUCTS;
  const adminAdded = await db.createProduct({ name: 'Admin Added Product', type: 'clothing', price: 500, stock: 5 });

  await db.syncProductsFromCatalog(catalog); // this product's id is not in the catalog file at all

  assert.ok(db.getProduct(adminAdded.id), 'a product created outside the catalog file must survive a sync/restart');
});

test('catalog sync does add a genuinely new id from the file', async () => {
  const catalog = require('../server/data/product-catalog').PRODUCTS;
  const brandNewId = Math.max(...catalog.map((p) => p.id)) + 500;
  assert.equal(db.getProduct(brandNewId), null);

  await db.syncProductsFromCatalog([...catalog, { id: brandNewId, sku: 'LW-TEST-999', type: 'clothing', name: 'Brand New From File', price: 100, stock: 1 }]);

  const added = db.getProduct(brandNewId);
  assert.ok(added, 'a new id present in the file should be inserted');
  assert.equal(added.name, 'Brand New From File');
});

test('creating a new product persists all fields', async () => {
  const created = await db.createProduct({
    name: 'Test New Tee', type: 'clothing', category: 'test', price: 799,
    emoji: '🧪', teeColor: '#111', designText: 'TEST', designColor: '#fff',
    sizes: ['S', 'M', 'L'], stock: 10, weightGrams: 280,
  });
  assert.ok(created.id);
  assert.equal(created.name, 'Test New Tee');
  assert.equal(created.price, 799);
  assert.deepEqual(created.sizes, ['S', 'M', 'L']);
  assert.ok(created.sku.startsWith('LW-'));

  const fetched = db.getProduct(created.id);
  assert.equal(fetched.name, 'Test New Tee');
});

test('deleting a product removes it, and reports false for an already-missing id', async () => {
  const created = await db.createProduct({ name: 'Temp Product', type: 'clothing', price: 500, stock: 5 });
  assert.ok(db.getProduct(created.id));

  const deleted = await db.deleteProduct(created.id);
  assert.equal(deleted, true);
  assert.equal(db.getProduct(created.id), null);

  const deletedAgain = await db.deleteProduct(created.id);
  assert.equal(deletedAgain, false);
});

test('editing a product with updateProduct (the admin panel path) changes every field, not just price/stock', async () => {
  const created = await db.createProduct({ name: 'Editable Tee', type: 'clothing', price: 1000, stock: 5 });
  const edited = await db.updateProduct(created.id, {
    name: 'Renamed Tee', price: 1200, category: 'streetwear', desc: 'New description',
    image: 'images/clothing/renamed.jpg', badge: 'hot',
  });
  assert.equal(edited.name, 'Renamed Tee');
  assert.equal(edited.price, 1200);
  assert.equal(edited.category, 'streetwear');
  assert.equal(edited.desc, 'New description');
  assert.equal(edited.image, 'images/clothing/renamed.jpg');
  assert.equal(edited.badge, 'hot');
});

test('creating an order decrements stock', async () => {
  const product = db.listProducts()[0];
  const startingStock = product.stock;

  const order = await db.createOrderWithStockDecrement({
    items: [{ id: product.id, sku: product.sku, name: product.name, price: product.price, size: 'M', qty: 2, weightGrams: 300 }],
    address: { name: 'Test User', phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
    amounts: { subtotal: product.price * 2, codFee: 0, total: product.price * 2, currency: 'INR' },
    payment: { method: 'cod', status: 'cod_pending' },
    customerId: null,
  });

  assert.ok(order.id.startsWith('LW'));
  const after = db.getProduct(product.id);
  assert.equal(after.stock, startingStock - 2);
});

test('ordering more than available stock is rejected and writes nothing', async () => {
  const product = db.listProducts()[0];
  const hugeQty = product.stock + 9999;

  await assert.rejects(
    () => db.createOrderWithStockDecrement({
      items: [{ id: product.id, sku: product.sku, name: product.name, price: product.price, size: 'M', qty: hugeQty, weightGrams: 300 }],
      address: { name: 'Test User', phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
      amounts: { subtotal: product.price * hugeQty, codFee: 0, total: product.price * hugeQty, currency: 'INR' },
      payment: { method: 'cod', status: 'cod_pending' },
      customerId: null,
    }),
    /only has \d+ left in stock/
  );

  // Confirm stock was NOT touched by the rejected attempt.
  const after = db.getProduct(product.id);
  assert.equal(after.stock, product.stock);
});

test('cancelling an order restores stock', async () => {
  const product = db.listProducts()[1];
  const startingStock = product.stock;

  const order = await db.createOrderWithStockDecrement({
    items: [{ id: product.id, sku: product.sku, name: product.name, price: product.price, size: 'M', qty: 3, weightGrams: 300 }],
    address: { name: 'Test User', phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
    amounts: { subtotal: product.price * 3, codFee: 0, total: product.price * 3, currency: 'INR' },
    payment: { method: 'cod', status: 'cod_pending' },
    customerId: null,
  });
  assert.equal(db.getProduct(product.id).stock, startingStock - 3);

  await db.restoreStock(order.items);
  assert.equal(db.getProduct(product.id).stock, startingStock);
});

test('two concurrent orders for the last unit — only one succeeds', async () => {
  const product = db.listProducts()[2];
  // Force stock down to exactly 1 unit for this test.
  await db.updateProduct(product.id, { stock: 1 });

  const attempt = () =>
    db.createOrderWithStockDecrement({
      items: [{ id: product.id, sku: product.sku, name: product.name, price: product.price, size: 'M', qty: 1, weightGrams: 300 }],
      address: { name: 'Racer', phone: '9876543210', line1: 'A', city: 'B', pincode: '560001', state: 'KA' },
      amounts: { subtotal: product.price, codFee: 0, total: product.price, currency: 'INR' },
      payment: { method: 'cod', status: 'cod_pending' },
      customerId: null,
    });

  const results = await Promise.allSettled([attempt(), attempt()]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, 'exactly one of the two concurrent orders should succeed');
  assert.equal(rejected.length, 1, 'the other should be rejected for insufficient stock');
  assert.equal(db.getProduct(product.id).stock, 0);
});

test('admin edits are written through to the catalog file (survives a wiped database)', async () => {
  await db.updateProduct(1, { price: 4321 });
  const onDisk = JSON.parse(fs.readFileSync(TEST_CATALOG, 'utf8'));
  assert.equal(onDisk.find((p) => p.id === 1).price, 4321);
});

test('editing products.json updates the database automatically (and leaves untouched products alone)', async () => {
  // Baseline: make sure the file and DB agree and fingerprints exist.
  await db.syncCatalogChanges();
  const before2 = db.getProduct(2);

  // Simulate someone editing the catalog file by hand: change product 1's price + badge.
  const file = JSON.parse(fs.readFileSync(TEST_CATALOG, 'utf8'));
  const entry = file.find((p) => p.id === 1);
  entry.price = 555;
  entry.badge = 'hot';
  fs.writeFileSync(TEST_CATALOG, JSON.stringify(file, null, 2));

  const result = await db.syncCatalogChanges();
  assert.equal(result.updated, 1, 'exactly the edited product should be updated');
  assert.equal(db.getProduct(1).price, 555);
  assert.equal(db.getProduct(1).badge, 'hot');
  assert.deepEqual(db.getProduct(2), before2, 'products not edited in the file must be left alone');

  // Running again with no further edits changes nothing.
  assert.equal((await db.syncCatalogChanges()).updated, 0);
});

test('an admin-panel edit is not overwritten by the auto-sync', async () => {
  await db.updateProduct(1, { price: 612 }); // writes through to the file and refreshes the fingerprint
  const result = await db.syncCatalogChanges();
  assert.equal(result.updated, 0);
  assert.equal(db.getProduct(1).price, 612);
});
