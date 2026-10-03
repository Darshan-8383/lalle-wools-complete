const test = require('node:test');
const assert = require('node:assert/strict');
const { computeOrderTax, gstRateFor } = require('../server/services/tax');

test('gstRateFor: apparel under ₹1000 is 5%', () => {
  assert.equal(gstRateFor({ sku: 'LW-CL-003', price: 999 }), 0.05);
});

test('gstRateFor: apparel over ₹1000 is 12%', () => {
  assert.equal(gstRateFor({ sku: 'LW-CL-001', price: 1299 }), 0.12);
});

test('gstRateFor: non-apparel SKUs default to 12%', () => {
  assert.equal(gstRateFor({ sku: 'LW-XX-101', price: 599 }), 0.12);
});

test('computeOrderTax: splits a tax-inclusive line total correctly', () => {
  const { lines, totalTaxableValue, totalGST } = computeOrderTax([
    { sku: 'LW-CL-003', name: 'Core Logo Drop', price: 999, qty: 2 }, // 5% bracket
  ]);
  const line = lines[0];
  // lineTotal = 1998, at 5% GST: base = 1998 / 1.05
  assert.equal(line.lineTotal, 1998);
  assert.equal(line.taxRate, 0.05);
  // base + gst should reconstruct the original line total (within rounding)
  assert.ok(Math.abs(line.taxableValue + line.gstAmount - line.lineTotal) < 0.02);
  assert.ok(Math.abs(totalTaxableValue + totalGST - 1998) < 0.02);
});

test('computeOrderTax: totals across multiple lines add up', () => {
  const { totalTaxableValue, totalGST } = computeOrderTax([
    { sku: 'LW-CL-001', name: 'Naruto Tee', price: 1299, qty: 1 }, // 12%
    { sku: 'LW-XX-101', name: 'Other', price: 599, qty: 1 }, // 12%
  ]);
  const grandTotal = 1299 + 599;
  assert.ok(Math.abs(totalTaxableValue + totalGST - grandTotal) < 0.05);
});
