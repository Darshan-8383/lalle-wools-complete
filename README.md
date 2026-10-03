# LALLEWOOLS — Full-Stack Storefront (v2: Real Store Edition)

Your original frontend is preserved pixel-for-pixel. This version replaces
the earlier JSON-file prototype with the real infrastructure a small D2C
store actually needs: a real database, admin panel, customer accounts,
transactional emails, GST invoices, refunds/cancellations, and production
hardening — while staying fully clickable with zero API keys in mock mode.

## What's new in this version

This directly addresses the 7 gaps from the previous version:

| # | Gap | What was built |
|---|---|---|
| 1 | JSON file "database" | Real SQLite database (`server/db/sqlite.js`) — proper tables, indexes, foreign keys |
| 2 | No stock decrement (overselling risk) | Atomic stock check-and-decrement inside a transaction-like lock; two people racing for the last unit → only one succeeds (covered by an automated test) |
| 3 | No admin panel | Full admin panel at `/admin` — orders, stats, ship/deliver/cancel, product price & stock editing |
| 4 | No order emails | Order confirmation, shipped, and cancellation emails via SMTP (any provider), mock-mode fallback logs to console |
| 5 | No auth/accounts | Admin login (JWT) + customer accounts (JWT) — log in with **Google** or email & password — with order history |
| 6 | No production hardening | Rate limiting, Helmet security headers, request logging, error handling, backup script |
| 7 | No invoices/GST/refunds/legal pages | PDF invoices with GST breakup, cancellation + Razorpay refund flow, 4 real legal pages |

Also included: a real automated test suite (`npm test`) — including a test
that actually races two concurrent orders for the last unit of stock to
prove the fix works, not just claim it does.

## Quick start

```bash
npm install
copy .env.example .env        # Windows (Command Prompt)
# or: cp .env.example .env    # Mac/Linux/PowerShell (Copy-Item .env.example .env)

node scripts/generate-jwt-secret.js     # paste the output into .env as JWT_SECRET
node scripts/hash-password.js "your-admin-password"   # paste into .env as ADMIN_PASSWORD_HASH

npm start
```

Open:
- **Storefront**: http://localhost:4000
- **Admin panel**: http://localhost:4000/admin (log in with `ADMIN_EMAIL` / the password you just hashed)

Everything works immediately in mock mode — real payments, shipping, and
email only activate once you add those specific keys to `.env` (see below).
Run `npm test` any time to verify the core logic (stock decrement, GST math)
is working correctly.

## Project structure

```
loolo-fullstack/
├── public/                     ← your original frontend, untouched visually
│   ├── index.html               (added: account modal, track-order modal, script tags)
│   ├── admin.html                new: admin panel (single file, no build step)
│   ├── legal/                    new: privacy, terms, shipping, refund policy pages
│   ├── css/style.css             untouched
│   └── js/
│       ├── script.js             checkout + account + tracking logic, calls the API
│       ├── reviews.js            product-page ratings & photo reviews + Community section
│       ├── api.js                fetch wrapper (adds auth token automatically)
│       └── admin.js              admin panel logic
├── server/
│   ├── index.js                  Express app: security headers, rate limiting, routes
│   ├── db/sqlite.js               ← the real database layer
│   ├── data/product-catalog.js    product data (edit prices/stock here)
│   ├── data/store.sqlite          auto-created on first run (your live data; not shipped in the zip)
│   ├── middleware/
│   │   ├── auth.js                customer JWT (optional + required variants)
│   │   ├── adminAuth.js           admin JWT
│   │   └── errorHandler.js        centralized error handling
│   ├── routes/
│   │   ├── products.js, orders.js, payment.js, shipping.js
│   │   ├── reviews.js             customer reviews + photos, Community feed
│   │   ├── auth.js                customer signup/login/order history
│   │   └── admin.js               admin login + order/product management
│   └── services/
│       ├── reviewImages.js        validates + stores review photos
│       ├── payment.js             Razorpay (+ mock fallback + refunds)
│       ├── shipping.js            Shiprocket (+ mock fallback)
│       ├── email.js               SMTP (+ mock fallback)
│       ├── tax.js                 GST calculation
│       └── invoice.js             PDF invoice generator
├── scripts/
│   ├── generate-jwt-secret.js
│   ├── hash-password.js
│   └── backup-db.js
├── tests/                        real automated tests (node --test)
├── package.json
└── .env.example
```

## The database

`server/db/sqlite.js` uses **sql.js** — real SQLite compiled to WebAssembly.
Unlike `better-sqlite3` or `node:sqlite`, there is nothing to compile on
install, so `npm install` works identically on Windows, Mac, and Linux with
zero build tools. The trade-off: it's a single-file database
(`server/data/store.sqlite`), which is genuinely fine for a store doing up
to tens of thousands of orders on one server, but doesn't support running
multiple server instances against the same data. If you outgrow that,
swap this file for Postgres — every function it exports
(`createOrderWithStockDecrement`, `getOrder`, `updateOrder`, etc.) is
written so the routes never touch SQL directly, so the swap doesn't ripple
outward into the rest of the app.

**Back up the database** regularly — it's the one thing that isn't
reproducible from code:
```bash
npm run backup
```
This copies `server/data/store.sqlite` into `server/data/backups/` with a
timestamp, keeping the last 30. Schedule it (Windows Task Scheduler / cron)
to run daily, and copy the `backups/` folder off the server periodically —
a backup living on the same disk doesn't protect you if that disk fails.

## Admin panel

Go to `/admin`, log in with `ADMIN_EMAIL` and the password you hashed with
`scripts/hash-password.js`. From there you can:
- See total orders, revenue, and pending count
- Filter and inspect every order, including shipment/AWB info
- Orders are booked with Shiprocket automatically and stay **confirmed** until the
  courier actually picks the parcel up; then they flip to **shipped** by themselves.
  You can also enter a manually-booked AWB (marks shipped now), mark delivered, or
  cancel + auto-refund (this also cancels the order in Shiprocket)
- Open any order's PDF invoice
- Edit product price, stock, and active/inactive status

There is currently one admin account, configured via `.env`. If you need
multiple admin logins with different permissions later, that's a natural
next step — the current single-account model was chosen to keep setup to
two environment variables instead of a whole user-management flow.

## Customer accounts

Checkout requires an account (email + password with 8+ characters, or Google).

**Email verification.** New password sign-ups get an email with a confirmation
link (valid 24 hours). Until it is clicked they can browse and log in but cannot
place an order: checkout shows a "Confirm your email" box with a **Resend email**
button (one per minute), and the profile page shows a reminder. Google sign-ins
are already verified. Control it with `REQUIRE_EMAIL_VERIFICATION` in `.env`:
blank = required automatically once SMTP is configured (off before that, since
nobody could receive the link), `true`/`false` to force it. In production it also
needs `SITE_URL`, because the link is built from it. If someone signs up with an
address that was registered earlier but never confirmed or used, the new sign-up
takes it over, so a stranger can't lock the real owner out of their own email.
Accounts that already have orders, or are confirmed, are never taken over.
Existing customers from before this feature are asked to confirm at their next checkout.
Logged-in customers see their order history, track shipments, download
invoices and cancel orders from "My Orders". Login sessions last 7 days.

Order details contain names, phone numbers and addresses, so they are private:
an order can only be viewed (or its invoice opened) by its owner, or by someone
who enters the **Order ID together with the phone number used on the order**
in the footer's **Track Order** box. Invoice PDFs open through short-lived
(10-minute) links generated by the server; admins get the same from the panel.

## Payments — Razorpay

**There is no fake/simulated payment.** Until you add Razorpay keys, the
"Pay Online" option is hidden at checkout and only Cash on Delivery works
(the server also rejects online orders, so it can't be bypassed via the API).
Adding the keys below turns online payment on automatically.
```
RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxx
```
New in this version: **refunds**. Cancelling a paid order (by the customer
before shipping, or by an admin at any pre-delivery stage) automatically
calls Razorpay's refund API and updates the order status — no manual refund
processing needed. Get your keys at https://dashboard.razorpay.com/app/keys.

## Reviews with photos (Myntra-style) + Community highlights

**On every product page** (under the product details): average rating, a 5→1 star breakdown, a strip of
customer photos (tap to open a swipeable viewer), "All / With photos" filter, and the review list — each with
a rating badge, text, photos, first-name + initial, and a "Verified buyer" tag. Highlighted reviews are badged
**⭐ Community pick** and listed first.

- **Who can review:** only a logged-in customer whose order for that product is **delivered** (Shiprocket's delivery scan sets this automatically, or use *Mark Delivered* in the admin panel). One review per customer per product; customers can delete their own.
- **Photos:** up to **3** per review. The browser shrinks each to ≤1200px JPEG before upload, which also strips EXIF/location data. The server re-checks everything: real file signature (JPEG/PNG/WebP only — never SVG), max 1.5 MB each, random file names, and rate-limiting on posting.
- **Where photos live:** `server/data/uploads/reviews/` — the same folder/volume as the database, so Docker redeploys keep them. **Include this folder in your own backups** (the automatic backup covers the database only).
- **Privacy:** public pages show "Priya S." only — never an email or phone number.

**Community section (homepage):** in **Admin → Reviews**, press **☆ Highlight** on any review. Highlighted reviews
appear in the storefront's Community section (photo, stars, quote, name and product; tapping one opens that
product's page). The **newest 8** highlighted reviews are shown. Until you highlight at least one, the section keeps
its original placeholder cards. Delete or un-highlight at any time — deleting a review also removes its photos.

API: `GET /api/reviews/product/:id`, `GET /api/reviews/featured`, `GET /api/reviews/eligibility/:productId`,
`POST /api/reviews`, `DELETE /api/reviews/:id`; admin: `GET /api/admin/reviews`,
`PATCH /api/admin/reviews/:id/feature {featured}`, `DELETE /api/admin/reviews/:id`.

## Orders are only confirmed once they are paid

An **online** order is *not* a real order until Razorpay has confirmed the payment. Until then:

- It stays `pending` / `awaiting_payment`. The customer sees **"Awaiting payment"**, never "Order placed"; the success screen, confirmation email and courier booking only happen after the server verifies the payment signature (or the Razorpay webhook confirms it).
- If the customer **closes the payment window**, the order is released immediately (`POST /api/orders/:id/abandon`): stock goes back on the shelf, nothing is emailed, and their bag is untouched so they can retry. A *failed* attempt does not release it — Razorpay keeps its window open for another try.
- If the customer is charged but the browser never reports back, the order is **not** released; the webhook confirms it (or the late-payment refund fires if it had already expired).
- Unpaid orders can't be invoiced, can't be shipped or delivered from the admin panel, and don't count toward the dashboard's order/revenue numbers. Abandoned never-paid orders are hidden from "My Orders"; anything still unpaid after 30 minutes is cancelled automatically (housekeeping).
- **Cash on Delivery** orders are confirmed immediately, as before.

## PIN code → city auto-fill

Typing a 6-digit PIN at checkout fills in the city and state using India
Post's free public API (`api.postalpincode.in`), proxied and cached by
`GET /api/shipping/pincode/:pin`. If the API is down or the PIN is unknown,
the customer just types city/state manually — checkout is never blocked.

## Shipment tracking

- `GET /api/shipping/track/:orderId` returns one normalized shape
  (`stage`, `stageLabel`, `courierName`, `trackingUrl`, `etd`, `checkpoints[]`)
  regardless of courier.
- With Shiprocket configured, scans are live. An order is only shown as **Shipped**
  after the courier's pickup scan (booking / AWB / scheduled pickup still show
  "Order confirmed"). Status moves forward automatically (picked up → shipped,
  delivered → delivered) via a 15-minute background poll, whenever someone opens the
  order, and instantly if you add the optional webhook below.
- For manually-booked shipments (admin enters an AWB), there are no courier
  scans to fetch, so customers see your own events plus the AWB and the
  tracking link you entered in the admin panel — nothing is invented.
- Customers see this in **My Orders → order**, in **Track Order** (guest), and
  via a *Track Order* button on the order-success screen.

## Shipping — Shiprocket

Sign up at https://www.shiprocket.in, add your
pickup address, and put your credentials in `.env`. See the comments at the
top of `server/services/shipping.js` for the full walkthrough.

Optional instant updates: in Shiprocket → Settings → API → Webhooks add
`https://YOURSITE/api/shipping/webhook` and use the same token you set as
`SHIPROCKET_WEBHOOK_TOKEN` in `.env` (sent as the `x-api-key` header).

## Email

Any SMTP provider works — Gmail (with an App Password), Zoho Mail, Amazon
SES, SendGrid, Resend, your own host, etc.:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password
```
Until these are set, emails just print to the server console — so you can
verify the content and timing of every email (order confirmed, shipped,
cancelled) without needing real SMTP credentials during development.

**Not included**: SMS notifications. If you want order SMS alerts, the
cleanest option is Twilio or MSG91 — you'd add a `server/services/sms.js`
file following the exact same pattern as `email.js` (a `sendSms()` function
with a mock fallback), and call it from the same places `email.js` is
called in `routes/orders.js`, `routes/payment.js`, and `routes/admin.js`.

## Invoices & GST

Every order gets a real PDF invoice (`GET /api/orders/:id/invoice`), linked
from the confirmation email, the customer's order history, and the admin
panel. It shows a GST breakup per line item — 5% for apparel priced ≤₹1000,
12% above that (per current Indian textile GST slabs); anything else is
12% flat.

**Important**: these rates and the invoice format are reasonable defaults
to get you launched, not tax advice. Confirm your exact HSN codes and
applicable rates with a CA before relying on this for GST filing. Once
you're GST-registered, add your GSTIN to `.env` as `BUSINESS_GSTIN` and it
will appear on every invoice automatically.

## Cancellations & refunds

- **Customers** can cancel their own order (logged in, via "My Orders", or
  as a guest by providing the phone number on the order) any time before
  it ships.
- **Admins** can cancel any order up until it's delivered.
- Either way: stock is automatically restored, and if the order was already
  paid online, a Razorpay refund is automatically issued. A cancellation
  email goes out either way.

See `public/legal/refund-policy.html` for the customer-facing policy — fill
in your actual return window before launch.

## Legal pages

Four real pages are included and linked from the footer:
- `legal/privacy-policy.html`
- `legal/terms.html`
- `legal/shipping-policy.html`
- `legal/refund-policy.html`

These are launch-ready templates, not legal advice — replace the bracketed
placeholders with your real business details and have them reviewed by a
lawyer, especially the return-window details in the refund policy. (Note:
Razorpay's own merchant approval process typically expects to see pages
like these live on your site, so this also helps that process.)

## Customer login (Google · email)

The login box offers a **Continue with Google** button with email & password below it. Both produce the same session token, so checkout, order
history and everything else behave identically.

**Set up (Google is optional — the button appears once it's configured):**

| Method | What to put in `.env` | Notes |
|---|---|---|
| Google | `GOOGLE_CLIENT_ID` | Create a *Web application* OAuth client; add your site and `http://localhost:4000` as authorised JavaScript origins. No client secret needed. |

**How accounts are matched**

- Google login matches on Google's stable user id, then on the verified email, then creates an account.
- If a Google sign-in matches an account that was registered with email + password (email ownership never verified), that old password is cleared so nobody who pre-registered someone else's address can keep access. The owner can set a new password in Profile.
- Google-only accounts have no password; they can add one from Profile.

**Upgrading an existing database:** nothing to do — on first start the `users` table is migrated automatically (existing customers and their orders are kept).

## Production hardening

What the server does for you when `NODE_ENV=production`:

- **Refuses to boot unsafely**: a missing/short/placeholder `JWT_SECRET` (< 32 chars) stops the
  server with a clear message instead of running with weak sessions.
- **Content-Security-Policy**: locked to your own origin plus exactly Razorpay, Google sign-in
  and Google Fonts. Anything else (a script injected by an attacker, say) is blocked by the browser.
- **CORS off by default**: the storefront is served by the same server, so no other website needs
  API access. Set `CLIENT_ORIGIN=https://other-site.com` only if you really host a separate frontend.
- **Rate limiting**: 120 req/min browsing, 20/15 min for login, 15/min for orders, 10/hour for
  newsletter sign-ups. `TRUST_PROXY` (default 1) makes this see real visitor IPs behind nginx/Render.
- **Compression + caching**: gzip for text; images cached for a week; HTML/CSS/JS revalidated each
  load so a deploy is never half-visible.
- **Small request bodies** (100 KB) and a **JSON-only error handler** that hides internals from the public.
- **Health check**: `GET /api/health` → `{ok:true}` (503 if the database is unreachable). Point your
  uptime monitor / load balancer at it. It deliberately reveals nothing about your configuration.
- **Graceful shutdown**: on SIGTERM/SIGINT the server finishes in-flight requests (an order being
  placed) before exiting, so redeploys don't drop orders.
- **Automatic daily backups** of the database to `server/data/backups/` (newest 14 kept).
- **`robots.txt` + `sitemap.xml`** generated for you (set `SITE_URL` to your domain). Admin and API are excluded.
- **Real 404 page** for unknown URLs, and JSON 404s under `/api`.
- **Tests**: `npm test` — 40+ tests: database/stock races, tax, Google auth, shipping/payment
  safety, and HTTP-level tests of the hardened server (headers, health, 404s, compression, newsletter).

## Mobile experience (Myntra-style)

On phones (≤768px) `public/css/mobile.css` takes over; desktop styling stays in `style.css`:

- Compact header with a permanent search bar, **bottom tab bar** (Home · Tees · Wishlist ·
  Account) whose active tab follows your scroll, safe-area padding for notched iPhones.
- Banner-style swipeable hero, circular category shortcuts, horizontally-scrolling *Trending*,
  sticky filter chips and a tight **2-column grid** (brand → name → price → ~~MRP~~ → % OFF).
- **Product page, Bag, Search and Checkout are full-screen pages** with sticky bottom action bars
  ("Add to bag / Go to bag", "Place order", "Continue to payment"). Size must be chosen first, with a PIN
  delivery check on the product page.
- Myntra-sized type (14px body, 12–13px on cards) with 16px form fields so iOS never zooms on focus.
- Light and dark themes both pass a contrast audit (the brand lime is never used as text on white;
  `--accent-text` swaps to a readable olive in light mode).

## Images (important for speed)

The original photos were 2–4 MB each. Run this once after adding or replacing any product image:

```
npm run optimize-images
```

It writes `name.w480.webp / .w800.webp / .w1200.webp` next to each original (originals are never touched).
The storefront serves the right size per screen and falls back to the original if a WebP doesn't exist.
Card images go from ~2.5 MB to ~25 KB. `npm run icons` regenerates the home-screen icons from `images/logo.png`.

## Newsletter

The "Join the fam" box now really saves addresses (table `subscribers`). Download them as CSV from
`/api/admin/subscribers?format=csv` (send your admin token), or read the `subscribers` table directly.

## What's still genuinely out of scope

Being direct about what this doesn't cover, so there are no surprises:

- **Horizontal scaling**: this is a single-process app with a single SQLite
  file. It comfortably handles a real small-to-mid store, but if you need
  multiple server instances behind a load balancer, migrate to Postgres
  first (see "The database" above).
- **SMS notifications**: scaffolded conceptually in this README, not built
  — see the "Email" section above for how to add it.
- **Multi-admin / role-based permissions**: one admin account for now.
- **Automated integration/HTTP tests**: `tests/` covers the core business
  logic (database layer, tax math) directly; it doesn't spin up the HTTP
  server and hit real endpoints. Adding that (e.g. with `supertest`) is a
  reasonable next step once you're extending the API further.
- **PCI compliance**: not something this app needs to handle directly —
  Razorpay's Checkout modal collects card details on their own secure page,
  so raw card numbers never touch this server. That's why the payment
  integration uses their hosted Checkout rather than a custom card form.

## Why admin price edits must persist (read this if prices "revert")

Admin edits are saved to the SQLite file (`server/data/store.sqlite`) **and**
mirrored into `server/data/products.json` after every change. If the host has
an ephemeral disk (Render/Railway free tiers, Vercel, Heroku…), both files are
reset on every redeploy/restart and the store comes back with whatever is in
the repo. To keep edits you must do ONE of:

1. Mount a persistent disk and point `LALLEWOOLS_DB_FILE` and
   `LALLEWOOLS_CATALOG_FILE` at it (e.g. `/data/store.sqlite`, `/data/products.json`), or
2. After editing prices, click **Admin → Products → Export products.json**,
   replace `server/data/products.json` in your repo, commit and redeploy, or
3. Use a VPS (disk is persistent), or migrate to a hosted Postgres.

Vercel/serverless cannot run this app's file-based database reliably — use a
VPS, Render with a disk, or Railway with a volume.

## Deploying

### Pre-launch checklist

1. `npm run generate-jwt-secret` → paste into `JWT_SECRET`.
2. `npm run hash-password -- "your-password"` → `ADMIN_PASSWORD_HASH` (and set `ADMIN_EMAIL`).
3. `NODE_ENV=production`, `SITE_URL=https://yourdomain.com`, and remove `CLIENT_ORIGIN` (or set your domain).
4. Razorpay **live** keys + webhook secret (otherwise only Cash on Delivery is offered — by design).
5. SMTP details (otherwise customers get no order emails).
6. Optional: `SOCIAL_INSTAGRAM` etc. and `BUSINESS_EMAIL` fill the footer; blank = not shown. `ADMIN_WHATSAPP` (country code + number, digits only, e.g. `919876543210`) turns on the **Custom Tee** section, which opens a WhatsApp chat with that number; blank = section hidden. The number can also be changed any time in the admin panel (**Settings** tab), which overrides `.env`.
7. `npm run optimize-images`, then deploy `public/images/` with the rest.
8. Fill in the real business address/GSTIN, and have the pages in `public/legal/` reviewed for your business.
9. Place a real ₹1 test order and a test cancellation/refund before announcing.
10. Point an uptime monitor at `/api/health`, and copy `server/data/backups/` off the machine regularly.

### Docker (recommended)

```
cp .env.example .env      # fill it in
docker compose up -d --build
```

The database lives in the `lallewools-data` volume, so it survives rebuilds. Put nginx / Caddy /
Cloudflare in front for HTTPS (the app itself doesn't handle certificates).

### Render / Railway / Fly.io

Build `npm install`, start `npm start`, set the `.env` values as environment variables. **Attach a
persistent disk mounted at `server/data`** — without one, the database is wiped on every redeploy.

### A VPS

`git clone`, `npm ci --omit=dev`, run under `pm2` or `systemd`, nginx in front for HTTPS.

### Honest limits

Single process + single SQLite file: fine for a real small-to-mid store, not for multiple instances
behind a load balancer (migrate to Postgres first).
