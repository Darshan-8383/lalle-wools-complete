/**
 * Tax (GST) helper
 * -----------------
 * Indian D2C stores conventionally display prices INCLUSIVE of GST (like
 * all retail MRPs), so the checkout total does NOT change — this just
 * reverse-calculates how much of that price is tax, for showing a proper
 * GST breakup on the invoice (a legal requirement for GST-registered
 * sellers) and for your own accounting.
 *
 * Apparel: 5% GST if unit price <= ₹1000, else 12% (per Indian textile GST
 * slabs). Anything else: 12% flat. These are reasonable defaults — confirm
 * exact HSN codes/rates with a CA before relying on this for tax filing.
 */
function gstRateFor(item) {
  if (item.sku && item.sku.startsWith('LW-CL-')) {
    return item.price <= 1000 ? 0.05 : 0.12;
  }
  return 0.12;
}

/** Reverse-calculates the GST portion of a tax-inclusive line total. */
function splitGST(lineTotal, rate) {
  const base = lineTotal / (1 + rate);
  const gst = lineTotal - base;
  return { base: round2(base), gst: round2(gst), rate };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Returns a per-line GST breakup array plus totals, for invoices and admin reporting. */
function computeOrderTax(items) {
  const lines = items.map((i) => {
    const lineTotal = i.price * i.qty;
    const rate = gstRateFor(i);
    const { base, gst } = splitGST(lineTotal, rate);
    return { ...i, lineTotal, taxRate: rate, taxableValue: base, gstAmount: gst };
  });
  const totalTaxableValue = round2(lines.reduce((s, l) => s + l.taxableValue, 0));
  const totalGST = round2(lines.reduce((s, l) => s + l.gstAmount, 0));
  return { lines, totalTaxableValue, totalGST };
}

module.exports = { computeOrderTax, gstRateFor };
