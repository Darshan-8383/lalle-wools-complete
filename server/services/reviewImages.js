/**
 * Review photos
 * -------------
 * The storefront shrinks every photo in the browser (max ~1200px JPEG) and sends it as a base64 data URL.
 * Nothing the browser says is trusted here: we decode it, check the real file signature (magic bytes) rather
 * than the claimed type, enforce size/count limits, and save it under a random name we choose ourselves.
 * Only JPEG / PNG / WebP are accepted — never SVG (it can carry scripts).
 *
 * Files live next to the database (server/data/uploads/reviews), i.e. on the same Docker volume, so they
 * survive redeploys exactly like orders do.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOAD_DIR = process.env.LALLEWOOLS_UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads', 'reviews');
const PUBLIC_PREFIX = '/uploads/reviews/';
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // after the browser's compression a photo is ~100-300 KB, so this is generous
const FILE_RE = /^[a-f0-9]{24}\.(jpg|png|webp)$/;

function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function decodeDataUrl(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('Invalid image'), { status: 400 });
  const comma = value.indexOf(',');
  if (!value.startsWith('data:image/') || comma < 0 || !value.slice(0, comma).endsWith(';base64')) {
    throw Object.assign(new Error('Photos must be JPG, PNG or WebP images'), { status: 400 });
  }
  const b64 = value.slice(comma + 1);
  // Cheap upper bound before decoding, so a huge string is rejected without allocating for it.
  if (b64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) throw Object.assign(new Error('Each photo must be under 1.5 MB'), { status: 413 });
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('Each photo must be under 1.5 MB'), { status: 413 });
  return buf;
}

/** Validates ALL images first, and only then writes them, so a bad third photo never leaves two orphan files behind. */
function saveImages(dataUrls) {
  if (dataUrls === undefined || dataUrls === null) return [];
  if (!Array.isArray(dataUrls)) throw Object.assign(new Error('Invalid photos'), { status: 400 });
  if (dataUrls.length > MAX_IMAGES) throw Object.assign(new Error(`You can add up to ${MAX_IMAGES} photos`), { status: 400 });

  const decoded = dataUrls.map((d) => {
    const buf = decodeDataUrl(d);
    const ext = sniff(buf);
    if (!ext) throw Object.assign(new Error('Photos must be JPG, PNG or WebP images'), { status: 400 });
    return { buf, ext };
  });

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const urls = [];
  try {
    for (const { buf, ext } of decoded) {
      const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf, { flag: 'wx' });
      urls.push(PUBLIC_PREFIX + name);
    }
  } catch (e) {
    deleteImages(urls);
    throw e;
  }
  return urls;
}

/** Removes photo files by their public URL. Only ever touches files whose names match what saveImages generates. */
function deleteImages(urls) {
  for (const url of urls || []) {
    const name = String(url).startsWith(PUBLIC_PREFIX) ? String(url).slice(PUBLIC_PREFIX.length) : '';
    if (!FILE_RE.test(name)) continue;
    try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); } catch (e) { /* already gone */ }
  }
}

module.exports = { saveImages, deleteImages, UPLOAD_DIR, PUBLIC_PREFIX, MAX_IMAGES, MAX_IMAGE_BYTES };
