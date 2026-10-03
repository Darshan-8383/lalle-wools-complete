/**
 * Email Service
 * --------------
 * Works with any SMTP provider (Gmail, SendGrid, Amazon SES, Resend,
 * Zoho Mail, your host's SMTP, etc.) — just fill in the SMTP_* vars in
 * .env. Until then, this logs the email to the console instead of sending
 * it, so the rest of the app keeps working during development.
 *
 * Popular options for a real store:
 *   - Zoho Mail / Google Workspace: use your own domain's SMTP (cheap, simple)
 *   - Resend / SendGrid / Amazon SES: built for transactional email at scale,
 *     better deliverability, usually needs an API rather than SMTP for best
 *     results — if you pick one of these, swap the internals of sendEmail()
 *     for their SDK; nothing else in the app needs to change.
 */
const nodemailer = require('nodemailer');

const isConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendEmail({ to, subject, html, attachments }) {
  if (!to) return { skipped: true, reason: 'No email address on file' };
  if (!isConfigured()) {
    console.log(`\n[email:MOCK] Would send to ${to}\n  Subject: ${subject}\n  (Set SMTP_HOST/SMTP_USER/SMTP_PASS in .env to actually send this)\n`);
    return { mock: true };
  }
  const info = await getTransporter().sendMail({
    from: process.env.SMTP_FROM || `"LALLEWOOLS" <${process.env.SMTP_USER}>`,
    to, subject, html, attachments,
  });
  return { mock: false, messageId: info.messageId };
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(n) {
  return `₹${Number(n).toLocaleString('en-IN')}`;
}

function orderConfirmationEmail(order) {
  const itemRows = order.items.map(i =>
    `<tr><td style="padding:6px 8px">${esc(i.name)}${i.size !== 'NA' ? ` (${esc(i.size)})` : ''} × ${Number(i.qty) || 0}</td><td style="padding:6px 8px;text-align:right">${money(i.price * i.qty)}</td></tr>`
  ).join('');
  return {
    subject: `Your LALLEWOOLS order ${order.id} is confirmed 🎉`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Thanks for your order, ${esc(order.address.name)}!</h2>
        <p>Order <b>${esc(order.id)}</b> is confirmed${order.payment.method === 'cod' ? ' (Cash on Delivery)' : ' — payment received'}.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">${itemRows}</table>
        ${order.amounts.shippingFee ? `<p style="margin:0">Shipping: ${money(order.amounts.shippingFee)}</p>` : ''}
        ${order.amounts.codFee ? `<p style="margin:0">COD fee: ${money(order.amounts.codFee)}</p>` : ''}
        <p><b>Total: ${money(order.amounts.total)}</b></p>
        <p>Shipping to: ${esc(order.address.line1)}, ${esc(order.address.city)} - ${esc(order.address.pincode)}</p>
        <p style="color:#888;font-size:.85rem">We'll email you again once it ships with tracking details.</p>
      </div>`,
  };
}

function shippedEmail(order) {
  const awb = order.shipment && order.shipment.awbCode;
  return {
    subject: `Your LALLEWOOLS order ${order.id} has shipped 📦`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>It's on the way!</h2>
        <p>Order <b>${esc(order.id)}</b> has been handed to our courier${order.shipment?.courierName ? ` (${esc(order.shipment.courierName)})` : ''}.</p>
        ${awb ? `<p>Tracking / AWB number: <b>${esc(awb)}</b></p>` : ''}
        <p style="color:#888;font-size:.85rem">Thanks for shopping with LALLEWOOLS.</p>
      </div>`,
  };
}

function cancellationEmail(order) {
  return {
    subject: `Your LALLEWOOLS order ${order.id} has been cancelled`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Order cancelled</h2>
        <p>Order <b>${esc(order.id)}</b> has been cancelled${order.payment.status === 'refunded' ? ' and your payment has been refunded' : ''}.</p>
        <p style="color:#888;font-size:.85rem">If you didn't request this, please contact us right away.</p>
      </div>`,
  };
}

/**
 * Must customers confirm their email before placing an order?
 * Default: yes once real email sending is set up (SMTP_*), otherwise no — nobody could receive the link.
 * Override with REQUIRE_EMAIL_VERIFICATION=true|false in .env.
 */
function verificationRequired() {
  const v = String(process.env.REQUIRE_EMAIL_VERIFICATION || '').trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return isConfigured();
}

function verificationEmail({ name, url }) {
  const first = String(name || '').trim().split(' ')[0];
  return {
    subject: 'Confirm your email for LALLEWOOLS',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>${first ? `Hi ${esc(first)}, c` : 'C'}onfirm your email</h2>
        <p>Tap the button to confirm this address and finish setting up your LALLEWOOLS account.</p>
        <p style="margin:24px 0"><a href="${esc(url)}" style="background:#C8FF00;color:#000;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:700">Confirm my email</a></p>
        <p style="color:#888;font-size:.85rem">Or paste this link into your browser:<br>${esc(url)}</p>
        <p style="color:#888;font-size:.85rem">The link works for 24 hours. If you didn't create this account, you can ignore this email.</p>
      </div>`,
  };
}

module.exports = { isConfigured, verificationRequired, sendEmail, orderConfirmationEmail, shippedEmail, cancellationEmail, verificationEmail };
