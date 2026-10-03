/**
 * Generates a strong random secret for JWT_SECRET in .env.
 * Usage: node scripts/generate-jwt-secret.js
 */
const crypto = require('crypto');
console.log('\nAdd this line to your .env file:\n');
console.log(`JWT_SECRET=${crypto.randomBytes(48).toString('hex')}\n`);
