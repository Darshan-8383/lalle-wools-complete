/**
 * Creates small, fast WebP versions of every product image.
 *
 *   npm run optimize-images
 *
 * For each  every .jpg/.jpeg/.png under public/images  it writes
 *   name.w480.webp   (product cards on phones)
 *   name.w800.webp   (product page on phones, cards on desktop)
 *   name.w1200.webp  (product page on desktop / zoom)
 * next to the original. Your originals are NEVER modified or deleted — they stay as the
 * fallback and as your high-resolution masters. The storefront automatically uses the
 * .webp versions when they exist and falls back to the original when they don't, so a
 * newly added image still works before you run this; it is just slower until you do.
 *
 * Re-running is safe and fast: files that are already up to date are skipped.
 * Run it whenever you add or replace images (then redeploy the public/images folder).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', 'public', 'images');
const WIDTHS = [480, 800, 1200];
const QUALITY = 78;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(jpe?g|png)$/i.test(entry.name)) yield full;
  }
}

(async () => {
  let made = 0, skipped = 0, before = 0, after = 0;
  for (const file of walk(ROOT)) {
    const base = file.replace(/\.[^.]+$/, '');
    const srcStat = fs.statSync(file);
    before += srcStat.size;
    const meta = await sharp(file).metadata();
    for (const w of WIDTHS) {
      const out = `${base}.w${w}.webp`;
      if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= srcStat.mtimeMs) { skipped++; after += fs.statSync(out).size; continue; }
      // Never enlarge: a 600px-wide source just produces a 600px file for each tier.
      await sharp(file)
        .rotate() // honour EXIF orientation from phone cameras
        .resize({ width: Math.min(w, meta.width || w), withoutEnlargement: true })
        .webp({ quality: QUALITY, effort: 5 })
        .toFile(out);
      made++;
      after += fs.statSync(out).size;
    }
  }
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  console.log(`✅ ${made} image(s) written, ${skipped} already up to date.`);
  console.log(`   Originals: ${mb(before)}  →  all three WebP tiers combined: ${mb(after)}`);
})().catch((err) => { console.error('❌ Image optimization failed:', err.message); process.exit(1); });
