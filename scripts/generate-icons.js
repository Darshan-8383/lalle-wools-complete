/** Builds the home-screen / favicon PNGs from public/images/logo.png. Run: node scripts/generate-icons.js */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const LOGO = path.join(__dirname, '..', 'public', 'images', 'logo.png');
const BG = '#0A0A0A';

async function icon(size, name, padRatio = 0.2) {
  const inner = Math.round(size * (1 - padRatio * 2));
  const logo = await sharp(LOGO).resize({ width: inner, height: inner, fit: 'inside' }).toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: logo, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT, name));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await icon(512, 'icon-512.png');
  await icon(192, 'icon-192.png');
  await icon(180, 'apple-touch-icon.png', 0.16);
  await icon(48, 'favicon-48.png', 0.08);
  await icon(512, 'icon-maskable-512.png', 0.3); // extra padding: Android crops maskable icons to a circle/squircle
  console.log('✅ Icons written to public/icons/');
})().catch((e) => { console.error(e); process.exit(1); });
