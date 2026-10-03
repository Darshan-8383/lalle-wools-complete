const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-rvimg-'));
process.env.LALLEWOOLS_UPLOAD_DIR = path.join(tmp, 'reviews');
const { saveImages, deleteImages, UPLOAD_DIR, MAX_IMAGES } = require('../server/services/reviewImages');

// Smallest byte sequences that carry each format's real signature.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32, 3)]);
const url = (buf, type = 'jpeg') => `data:image/${type};base64,${buf.toString('base64')}`;

test('accepts JPEG, PNG and WebP, stores them under random names with the right extension', () => {
  const out = saveImages([url(JPEG), url(PNG, 'png'), url(WEBP, 'webp')]);
  assert.equal(out.length, 3);
  assert.match(out[0], /^\/uploads\/reviews\/[a-f0-9]{24}\.jpg$/);
  assert.match(out[1], /\.png$/);
  assert.match(out[2], /\.webp$/);
  for (const u of out) assert.ok(fs.existsSync(path.join(UPLOAD_DIR, path.basename(u))));
});

test('the real file signature decides, not what the browser claims (an HTML/script payload labelled as jpeg is rejected)', () => {
  const evil = Buffer.from('<html><script>alert(1)</script></html>' + ' '.repeat(40));
  assert.throws(() => saveImages([url(evil, 'jpeg')]), /JPG, PNG or WebP/);
});

test('SVG is refused outright (it can carry scripts)', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
  assert.throws(() => saveImages([`data:image/svg+xml;base64,${svg.toString('base64')}`]), /JPG, PNG or WebP/);
});

test('rejects non-data-URL input, more than the maximum count, and oversize photos', () => {
  assert.throws(() => saveImages(['https://evil.example/x.jpg']), /JPG, PNG or WebP/);
  assert.throws(() => saveImages([42]), /Invalid image/);
  assert.throws(() => saveImages(Array(MAX_IMAGES + 1).fill(url(JPEG))), /up to 3/);
  const big = Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]);
  assert.throws(() => saveImages([url(big)]), /1\.5 MB/);
});

test('one bad photo means NOTHING is written (no orphan files from the valid ones)', () => {
  const before = fs.readdirSync(UPLOAD_DIR).length;
  assert.throws(() => saveImages([url(JPEG), url(Buffer.from('not an image at all, just text....'))]));
  assert.equal(fs.readdirSync(UPLOAD_DIR).length, before);
});

test('no photos is fine', () => {
  assert.deepEqual(saveImages(undefined), []);
  assert.deepEqual(saveImages([]), []);
});

test('deleteImages removes our files and ignores anything that is not one (path traversal safe)', () => {
  const [u] = saveImages([url(JPEG)]);
  const secret = path.join(tmp, 'secret.txt');
  fs.writeFileSync(secret, 'keep me');
  deleteImages([u, '/uploads/reviews/../../secret.txt', '../secret.txt', '/etc/passwd']);
  assert.ok(!fs.existsSync(path.join(UPLOAD_DIR, path.basename(u))));
  assert.ok(fs.existsSync(secret), 'files outside the upload folder must never be touched');
});
