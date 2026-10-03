/* ═══════════════════════════════════════
   LALLEWOOLS — api.js
   Thin fetch wrapper around the backend REST API.
   Same-origin by default (works once server/index.js serves this file);
   override window.LALLEWOOLS_API_BASE before this script loads if the
   frontend and backend are deployed separately.
═══════════════════════════════════════ */
'use strict';

const API_BASE = window.LALLEWOOLS_API_BASE || '/api';

function getCustomerToken() {
  return localStorage.getItem('lallewools_customer_token') || null;
}

async function apiRequest(path, options = {}) {
  const token = getCustomerToken();
  const { guestPhone, ...fetchOptions } = options; // guestPhone: lets a logged-out visitor prove an order is theirs
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(guestPhone ? { 'x-order-phone': guestPhone } : {}),
    },
    cache: 'no-store',
    ...fetchOptions,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    if (data && data.retryAfter) err.retryAfter = data.retryAfter;
    if (data && data.code) err.code = data.code;
    throw err;
  }
  return data;
}

const Api = {
  getProducts: () => apiRequest('/products'),
  getProduct: (id) => apiRequest(`/products/${id}`),

  createOrder: (payload) =>
    apiRequest('/orders', { method: 'POST', body: JSON.stringify(payload) }),
  getOrder: (id, guestPhone) => apiRequest(`/orders/${id}`, { guestPhone }),
  invoiceLink: (id, guestPhone) => apiRequest(`/orders/${id}/invoice-link`, { method: 'POST', guestPhone }),
  // The customer closed the payment window without paying: release the unconfirmed order (and its reserved stock) now.
  abandonOrder: (id) => apiRequest(`/orders/${id}/abandon`, { method: 'POST' }),

  createPaymentOrder: (orderId) =>
    apiRequest('/payment/create-order', { method: 'POST', body: JSON.stringify({ orderId }) }),
  verifyPayment: (payload) =>
    apiRequest('/payment/verify', { method: 'POST', body: JSON.stringify(payload) }),

  getReviews: (productId) => apiRequest(`/reviews/product/${productId}`),
  reviewEligibility: (productId) => apiRequest(`/reviews/eligibility/${productId}`),
  postReview: (payload) => apiRequest('/reviews', { method: 'POST', body: JSON.stringify(payload) }),
  deleteReview: (id) => apiRequest(`/reviews/${id}`, { method: 'DELETE' }),
  getFeaturedReviews: () => apiRequest('/reviews/featured'),

  getConfig: () => apiRequest('/config'),
  subscribe: (email) => apiRequest('/newsletter', { method: 'POST', body: JSON.stringify({ email }) }),
  lookupPincode: (pincode) => apiRequest(`/shipping/pincode/${encodeURIComponent(pincode)}`),
  checkPincode: (pincode, amount, weightKg) =>
    apiRequest('/shipping/check-pincode', {
      method: 'POST',
      body: JSON.stringify({ pincode, amount, weightKg }),
    }),
  trackOrder: (orderId, guestPhone) => apiRequest(`/shipping/track/${orderId}`, { guestPhone }),

  signup: (payload) => apiRequest('/auth/signup', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload) => apiRequest('/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  googleLogin: (credential) => apiRequest('/auth/google', { method: 'POST', body: JSON.stringify({ credential }) }),
  me: () => apiRequest('/auth/me'),
  resendVerification: () => apiRequest('/auth/resend-verification', { method: 'POST' }),
  updateProfile: (payload) => apiRequest('/auth/me', { method: 'PATCH', body: JSON.stringify(payload) }),
  changePassword: (payload) => apiRequest('/auth/password', { method: 'PATCH', body: JSON.stringify(payload) }),
  myOrders: () => apiRequest('/auth/orders'),
  cancelOrder: (orderId, phone) =>
    apiRequest(`/orders/${orderId}/cancel`, { method: 'POST', body: JSON.stringify(phone ? { phone } : {}) }),
};
