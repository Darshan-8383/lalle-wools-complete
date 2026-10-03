const test = require('node:test');
const assert = require('node:assert');
const { normalizeWhatsappNumber } = require('../server/services/phone');

test('normalizeWhatsappNumber: formats to wa.me digits', () => {
  assert.strictEqual(normalizeWhatsappNumber('+91 98765 43210'), '919876543210');
  assert.strictEqual(normalizeWhatsappNumber('9876543210'), '919876543210');
  assert.strictEqual(normalizeWhatsappNumber('09876543210'), '919876543210');
  assert.strictEqual(normalizeWhatsappNumber('14155550123'), '14155550123');
});

test('normalizeWhatsappNumber: rejects invalid input', () => {
  assert.strictEqual(normalizeWhatsappNumber(''), null);
  assert.strictEqual(normalizeWhatsappNumber(null), null);
  assert.strictEqual(normalizeWhatsappNumber('12345'), null);
  assert.strictEqual(normalizeWhatsappNumber('1234567890123456'), null);
});
