/**
 * Invoice PDF generator (pdfkit — pure JS, no native deps).
 * Streams a GST-compliant-shaped invoice directly to the HTTP response.
 */
const PDFDocument = require('pdfkit');
const { computeOrderTax } = require('./tax');

function money(n) {
  return `Rs. ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Writes the invoice PDF for `order` directly to `res` (an Express response). */
function streamInvoice(order, res) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="invoice-${order.id}.pdf"`);
  doc.pipe(res);

  const business = {
    name: process.env.BUSINESS_NAME || 'LALLEWOOLS',
    address: process.env.BUSINESS_ADDRESS || 'Bengaluru, Karnataka, India',
    gstin: process.env.BUSINESS_GSTIN || null,
    email: process.env.BUSINESS_EMAIL || 'support@lallewools.com',
  };

  // Header
  doc.fontSize(20).text(business.name, { continued: false });
  doc.fontSize(9).fillColor('#555').text(business.address);
  if (business.gstin) doc.text(`GSTIN: ${business.gstin}`);
  doc.text(`Email: ${business.email}`);
  doc.moveDown(1);

  doc.fillColor('#000').fontSize(14).text('TAX INVOICE', { align: 'right' });
  doc.fontSize(10).fillColor('#333')
    .text(`Invoice / Order #: ${order.id}`, { align: 'right' })
    .text(`Date: ${new Date(order.createdAt).toLocaleDateString('en-IN')}`, { align: 'right' })
    .text(`Payment: ${order.payment.method.toUpperCase()} — ${order.payment.status}`, { align: 'right' });
  doc.moveDown(1);

  // Bill to
  doc.fillColor('#000').fontSize(11).text('Bill To:', { underline: true });
  doc.fontSize(10).fillColor('#333')
    .text(order.address.name)
    .text(order.address.line1)
    .text(order.address.line2 || '')
    .text(`${order.address.city}, ${order.address.state} - ${order.address.pincode}`)
    .text(`Phone: ${order.address.phone}`);
  doc.moveDown(1);

  // Line items table with GST breakup
  const { lines, totalTaxableValue, totalGST } = computeOrderTax(order.items);
  const tableTop = doc.y + 10;
  const col = { name: 50, qty: 260, taxable: 310, rate: 380, gst: 430, total: 500 };
  doc.fontSize(9).fillColor('#000');
  doc.text('Item', col.name, tableTop);
  doc.text('Qty', col.qty, tableTop);
  doc.text('Taxable', col.taxable, tableTop);
  doc.text('GST%', col.rate, tableTop);
  doc.text('GST Amt', col.gst, tableTop);
  doc.text('Total', col.total, tableTop);
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).strokeColor('#ccc').stroke();

  let y = tableTop + 20;
  doc.fillColor('#333');
  lines.forEach((l) => {
    const label = `${l.name}${l.size && l.size !== 'NA' ? ` (${l.size})` : ''}`;
    doc.fontSize(9).text(label, col.name, y, { width: 200 });
    doc.text(String(l.qty), col.qty, y);
    doc.text(l.taxableValue.toFixed(2), col.taxable, y);
    doc.text(`${(l.taxRate * 100).toFixed(0)}%`, col.rate, y);
    doc.text(l.gstAmount.toFixed(2), col.gst, y);
    doc.text(l.lineTotal.toFixed(2), col.total, y);
    y += 20;
  });

  doc.moveTo(50, y + 4).lineTo(545, y + 4).strokeColor('#ccc').stroke();
  y += 14;
  doc.fontSize(9).text(`Taxable Value: ${money(totalTaxableValue)}`, 350, y); y += 14;
  doc.text(`Total GST: ${money(totalGST)}`, 350, y); y += 14;
  if (order.amounts.shippingFee) { doc.text(`Shipping: ${money(order.amounts.shippingFee)}`, 350, y); y += 14; }
  if (order.amounts.codFee) { doc.text(`COD Fee: ${money(order.amounts.codFee)}`, 350, y); y += 14; }
  doc.fontSize(11).fillColor('#000').text(`Grand Total: ${money(order.amounts.total)}`, 350, y, { underline: true });

  doc.moveDown(4);
  doc.fontSize(8).fillColor('#888').text(
    'This is a system-generated invoice. GST rates are indicative — please verify HSN codes and applicable rates with your tax advisor.',
    50, doc.y, { width: 495 }
  );

  doc.end();
}

module.exports = { streamInvoice };
