/**
 * Normalises an Indian mobile number to its bare 10 digits.
 * Accepts "98765 43210", "+91 98765-43210", "919876543210", "09876543210".
 * Returns null if it isn't a valid Indian mobile number (must start 6-9).
 */
function normalizeIndianMobile(input) {
  let digits = String(input == null ? '' : input).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

/**
 * Normalises a WhatsApp number to wa.me format (country code + number, digits only).
 * A bare Indian mobile (10 digits, starts 6-9) gets 91 prepended; a leading 0 is dropped.
 * Returns null if the result isn't 11-15 digits.
 */
function normalizeWhatsappNumber(input) {
  let d = String(input == null ? '' : input).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) d = '91' + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

module.exports = { normalizeIndianMobile, normalizeWhatsappNumber };
