/**
 * Generates a bcrypt hash for your admin password, to paste into .env as
 * ADMIN_PASSWORD_HASH (the app never stores your admin password in plain
 * text — only this hash).
 *
 * Usage:
 *   node scripts/hash-password.js "your-new-password"
 */
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js "your-password"');
  process.exit(1);
}

bcrypt.hash(password, 10).then((hash) => {
  console.log('\nAdd this line to your .env file:\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
});
