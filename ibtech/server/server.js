/* ==========================================================================
   IB-TECH backend — HTTP layer
   --------------------------------------------------------------------------
   This file only knows about HTTP: parsing requests, checking who's
   allowed to do what, and calling into db.js for anything that touches
   storage. See db.js for the SQLite schema and server/README.md for the
   endpoint list and a Node-version note (this needs a fairly recent Node
   for the built-in `node:sqlite` module).
   ========================================================================== */
"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { hashPassword, verifyPassword, unitPrice, genId } = require("./lib");

// ---- optional .env loader (no dependency — just reads KEY=VALUE lines) ----
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = (m[2] || "").trim();
  });
})();

const PORT = process.env.PORT || 3000;
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
// Must be on a domain you've verified in Resend, e.g. "IB-TECH <noreply@yourdomain.com>".
// Resend's shared "onboarding@resend.dev" sender only delivers to your own
// Resend account email, so it's fine for a first smoke test but not for
// real users — verify a domain before going live.
const RESEND_FROM = process.env.RESEND_FROM_EMAIL || "IB-TECH <onboarding@resend.dev>";
const { NETWORKS, DENOMS } = db;
const ROLES = { USER: "user", ADMIN: "admin", SUPERADMIN: "superadmin" };

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function isAdmin(user) { return !!user && user.role !== ROLES.USER; }
function isSuperAdmin(user) { return !!user && user.role === ROLES.SUPERADMIN; }

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, business: u.business, email: u.email, phone: u.phone,
    role: u.role, wallet: u.wallet, avatar: u.avatar || null, createdAt: u.created_at
  };
}

function getAuthUser(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const userId = db.userIdForSession(token);
  if (!userId) return null;
  return db.findUserById(userId);
}

// ---------------------------------------------------------------------------
// tiny HTTP plumbing (no Express) — a router table + JSON body parsing
// ---------------------------------------------------------------------------
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*", // demo only — restrict to your real origin in production
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(payload);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJSON(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString("utf8")); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Paystack calls — all server-side, using the secret key. Never send this
// key to the browser.
// ---------------------------------------------------------------------------
function paystackRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    if (!PAYSTACK_SECRET) return reject(new Error("PAYSTACK_SECRET_KEY is not configured on the server."));
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.paystack.co",
      path: urlPath,
      method,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let out = "";
      res.on("data", c => out += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Resend calls — sends the password-reset code by email. Falls back to
// returning the token directly in the API response when RESEND_API_KEY
// isn't set, so local/dev testing still works with zero setup.
// ---------------------------------------------------------------------------
function resendRequest(body) {
  return new Promise((resolve, reject) => {
    if (!RESEND_API_KEY) return reject(new Error("RESEND_API_KEY is not configured on the server."));
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: "api.resend.com",
      path: "/emails",
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    }, (res) => {
      let out = "";
      res.on("data", c => out += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(out) }); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendResetEmail(user, token) {
  const html = `
    <p>Hi ${user.name || "there"},</p>
    <p>Use this code to reset your IB-TECH password. It expires in 30 minutes.</p>
    <p style="font-size:22px;font-weight:700;letter-spacing:2px;">${token}</p>
    <p>Go back to the reset page and paste this code in if it isn't filled in already.</p>
    <p>If you didn't request this, you can ignore this email.</p>
  `;
  const r = await resendRequest({
    from: RESEND_FROM,
    to: [user.email],
    subject: "Your IB-TECH password reset code",
    html
  });
  if (r.status >= 400) {
    throw new Error(r.body?.message || "Resend rejected the email.");
  }
}

// ---------------------------------------------------------------------------
// route handlers
// ---------------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

// ---- auth ----
route("POST", "/api/auth/signup", async (req, res) => {
  const body = await readJSON(req);
  const { name, business, email, phone, password } = body;
  if (!name || !email || !password || password.length < 6) {
    return send(res, 400, { ok: false, error: "name, email and a password of at least 6 characters are required." });
  }
  if (db.findUserByEmail(email)) {
    return send(res, 409, { ok: false, error: "An account with that email already exists." });
  }
  const user = db.createUser({ name, business, email, phone, passwordHash: hashPassword(password) });
  const token = db.createSession(user.id);
  send(res, 201, { ok: true, token, user: publicUser(user) });
});

route("POST", "/api/auth/login", async (req, res) => {
  // `identifier` can be an email address or a phone number; `email` is kept
  // as a fallback so older clients that only ever sent { email } still work.
  const { identifier, email, password } = await readJSON(req);
  const login = (identifier || email || "").trim();
  const user = db.findUserByEmail(login) || db.findUserByPhone(login);
  if (!user || !verifyPassword(password || "", user.password_hash)) {
    return send(res, 401, { ok: false, error: "Incorrect email/phone or password." });
  }
  const token = db.createSession(user.id);
  send(res, 200, { ok: true, token, user: publicUser(user) });
});

route("POST", "/api/auth/logout", async (req, res) => {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) db.deleteSession(token);
  send(res, 200, { ok: true });
});

route("GET", "/api/me", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  send(res, 200, { ok: true, user: publicUser(user) });
});

// Profile photo — stored as a data URL directly on the user row so no file
// storage / static hosting is needed. Capped well under the DB's comfort
// zone for a TEXT column (a few hundred KB of base64 is plenty for an
// avatar-sized image once the client has resized it).
const MAX_AVATAR_CHARS = 900000; // ~650KB of image data once decoded
route("POST", "/api/me/avatar", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  const { image } = await readJSON(req);
  if (image !== null && (!image || !/^data:image\/(png|jpe?g|webp);base64,/.test(image))) {
    return send(res, 400, { ok: false, error: "Expected a base64 image data URL (png, jpg or webp)." });
  }
  if (image && image.length > MAX_AVATAR_CHARS) {
    return send(res, 413, { ok: false, error: "That image is too large — please use a smaller photo." });
  }
  const updated = db.setUserAvatar(user.id, image); // image === null clears it
  send(res, 200, { ok: true, avatar: updated.avatar });
});

// ---- password reset ----
// There's no email/SMS sending wired up in this project (see
// server/README.md), so — same spirit as the Paystack key being blank until
// you configure it — the reset link is handed straight back in the response
// instead of being emailed/texted. Swap this for a real mailer/SMS provider
// before using this in production; don't ship a token in an API response.
route("POST", "/api/auth/forgot", async (req, res) => {
  const { identifier } = await readJSON(req);
  const login = (identifier || "").trim();
  const user = db.findUserByEmail(login) || db.findUserByPhone(login);
  if (!user) {
    return send(res, 404, { ok: false, error: "No account matches that email or phone number." });
  }
  const token = db.createPasswordReset(user.id);

  // Email it if Resend is configured AND this account actually has an email
  // (phone-only accounts fall back to the on-page token — there's no SMS
  // provider wired up yet).
  if (RESEND_API_KEY && user.email) {
    try {
      await sendResetEmail(user, token);
      return send(res, 200, {
        ok: true,
        sent: true,
        expiresInMinutes: 30,
        note: `A reset code was emailed to ${user.email}.`
      });
    } catch (e) {
      // Don't silently fall through to exposing the token on a
      // misconfigured live server — surface the real problem instead.
      return send(res, 502, { ok: false, error: `Could not send the reset email: ${e.message}` });
    }
  }

  send(res, 200, {
    ok: true,
    token,
    expiresInMinutes: 30,
    note: "No email/SMS is configured — this token is returned directly instead of being sent to you."
  });
});

route("POST", "/api/auth/reset", async (req, res) => {
  const { token, password } = await readJSON(req);
  if (!password || password.length < 6) {
    return send(res, 400, { ok: false, error: "Enter a new password of at least 6 characters." });
  }
  const reset = db.findPasswordReset(token || "");
  if (!reset) {
    return send(res, 400, { ok: false, error: "That reset link is invalid or has expired — request a new one." });
  }
  db.setUserPassword(reset.user_id, hashPassword(password));
  db.deletePasswordReset(token);
  send(res, 200, { ok: true });
});

// ---- catalog ----
route("GET", "/api/stock", async (req, res) => {
  send(res, 200, { ok: true, networks: NETWORKS, denoms: DENOMS, stock: db.stockSnapshot() });
});

// ---- printing ----
route("POST", "/api/print", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  const { network, denom, qty } = await readJSON(req);
  const q = Math.max(1, Number(qty) || 1);
  const d = Number(denom);
  if (!NETWORKS.includes(network) || !DENOMS.includes(d)) {
    return send(res, 400, { ok: false, error: "Unknown network or denomination." });
  }
  const cost = unitPrice(d) * q;
  const fresh = db.findUserById(user.id);
  if (fresh.wallet < cost) {
    return send(res, 402, { ok: false, error: `Insufficient wallet balance. Needs ₦${cost}, wallet holds ₦${fresh.wallet}.` });
  }
  const txId = genId("tx");
  const drawn = db.drawPins(network, d, q, txId);
  if (!drawn) {
    return send(res, 409, { ok: false, error: `Only ${db.stockCount(network, d)} ${network} ₦${d} pin(s) left in stock.` });
  }
  const updated = db.adjustWallet(user.id, -cost);
  db.insertTransaction({ id: txId, userId: user.id, type: "print", network, denom: d, qty: q, total: cost, date: Date.now() });
  send(res, 200, { ok: true, tx: { id: txId, network, denom: d, qty: q, cards: drawn, total: cost, date: Date.now() }, wallet: updated.wallet });
});

route("GET", "/api/transactions", async (req, res, query) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  if (query.all === "1" && isAdmin(user)) return send(res, 200, { ok: true, transactions: db.allTransactions() });
  send(res, 200, { ok: true, transactions: db.transactionsForUser(user.id) });
});

// Removes a row from history only — it does not reverse a wallet debit/credit
// or return printed pins to stock, it just clears the record from view.
route("POST", "/api/transactions/delete", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  const { id } = await readJSON(req);
  if (!id) return send(res, 400, { ok: false, error: "Missing transaction id." });
  const deleted = db.deleteTransaction(id, isAdmin(user) ? null : user.id);
  if (!deleted) return send(res, 404, { ok: false, error: "Transaction not found." });
  send(res, 200, { ok: true });
});

// ---- wallet funding (real money, via Paystack) ----
route("POST", "/api/wallet/initiate", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  const { amount } = await readJSON(req);
  const naira = Number(amount);
  if (!naira || naira <= 0) return send(res, 400, { ok: false, error: "Enter a valid amount." });
  try {
    const reference = genId("pay");
    const r = await paystackRequest("POST", "/transaction/initialize", {
      email: user.email,
      amount: Math.round(naira * 100), // kobo
      reference
    });
    if (r.status >= 400 || !r.body.status) return send(res, 502, { ok: false, error: r.body.message || "Paystack rejected the request." });
    send(res, 200, { ok: true, authorization_url: r.body.data.authorization_url, reference });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

route("POST", "/api/wallet/verify", async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return send(res, 401, { ok: false, error: "Not logged in." });
  const { reference } = await readJSON(req);
  if (!reference) return send(res, 400, { ok: false, error: "Missing reference." });
  if (db.isReferenceProcessed(reference)) {
    return send(res, 200, { ok: true, alreadyProcessed: true, wallet: db.findUserById(user.id).wallet });
  }
  try {
    const r = await paystackRequest("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
    if (r.status >= 400 || r.body.data?.status !== "success") {
      return send(res, 402, { ok: false, error: "Payment was not successful." });
    }
    const naira = r.body.data.amount / 100;
    const updated = db.adjustWallet(user.id, naira);
    db.markReferenceProcessed(reference);
    db.insertTransaction({ id: genId("tx"), userId: user.id, type: "wallet-fund", amount: naira, reference, date: Date.now() });
    send(res, 200, { ok: true, credited: naira, wallet: updated.wallet });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// Paystack calls this directly — it's the source of truth, independent of
// whether the customer's browser stayed open long enough to call /verify.
route("POST", "/api/paystack/webhook", async (req, res) => {
  const raw = await readRawBody(req);
  const signature = req.headers["x-paystack-signature"];
  if (!PAYSTACK_SECRET) return send(res, 500, { ok: false, error: "Webhook secret not configured." });
  const expected = crypto.createHmac("sha512", PAYSTACK_SECRET).update(raw).digest("hex");
  if (expected !== signature) return send(res, 401, { ok: false, error: "Invalid signature." });

  const event = JSON.parse(raw.toString("utf8"));
  if (event.event === "charge.success") {
    const { reference, amount, customer } = event.data;
    if (!db.isReferenceProcessed(reference)) {
      const user = db.findUserByEmail(customer.email);
      if (user) {
        db.adjustWallet(user.id, amount / 100);
        db.markReferenceProcessed(reference);
        db.insertTransaction({ id: genId("tx"), userId: user.id, type: "wallet-fund", amount: amount / 100, reference, date: Date.now(), via: "webhook" });
      }
    }
  }
  if (event.event === "transfer.failed" || event.event === "transfer.reversed") {
    // A payout we already debited from the wallet didn't go through — refund it.
    const { reference, amount } = event.data;
    const tx = db.findPendingPayout(reference);
    if (tx) {
      db.setTransactionStatus(tx.id, "failed");
      db.adjustWallet(tx.user_id, amount / 100);
    }
  }
  if (event.event === "transfer.success") {
    const tx = db.findPendingPayout(event.data.reference);
    if (tx) db.setTransactionStatus(tx.id, "success");
  }
  send(res, 200, { ok: true });
});

// ---- admin: stock ----
route("POST", "/api/admin/stock", async (req, res) => {
  const user = getAuthUser(req);
  if (!isAdmin(user)) return send(res, 403, { ok: false, error: "Admin access required." });
  const { network, denom, qty } = await readJSON(req);
  const d = Number(denom);
  const q = Math.max(1, Number(qty) || 1);
  if (!NETWORKS.includes(network) || !DENOMS.includes(d)) {
    return send(res, 400, { ok: false, error: "Unknown network or denomination." });
  }
  const newCount = db.addPins(network, d, q);
  send(res, 200, { ok: true, stock: newCount });
});

// ---- admin: users ----
route("GET", "/api/admin/users", async (req, res) => {
  const user = getAuthUser(req);
  if (!isAdmin(user)) return send(res, 403, { ok: false, error: "Admin access required." });
  send(res, 200, { ok: true, users: db.listUsers().map(publicUser) });
});

// Ledger-only wallet credit — no real money moves. Use for manual top-ups.
route("POST", "/api/admin/credit", async (req, res) => {
  const admin = getAuthUser(req);
  if (!isAdmin(admin)) return send(res, 403, { ok: false, error: "Admin access required." });
  const { userId, amount } = await readJSON(req);
  const target = db.findUserById(userId);
  if (!target) return send(res, 404, { ok: false, error: "User not found." });
  const amt = Number(amount);
  if (!amt || amt <= 0) return send(res, 400, { ok: false, error: "Enter a valid amount." });
  const updated = db.adjustWallet(target.id, amt);
  db.insertTransaction({ id: genId("tx"), userId: target.id, type: "admin-credit", amount: amt, byUser: admin.id, date: Date.now() });
  send(res, 200, { ok: true, wallet: updated.wallet });
});

// Ledger-only refund — same mechanics as credit, tagged separately so it's
// distinguishable in reports from a manual top-up.
route("POST", "/api/admin/refund", async (req, res) => {
  const admin = getAuthUser(req);
  if (!isAdmin(admin)) return send(res, 403, { ok: false, error: "Admin access required." });
  const { userId, amount, reason } = await readJSON(req);
  const target = db.findUserById(userId);
  if (!target) return send(res, 404, { ok: false, error: "User not found." });
  const amt = Number(amount);
  if (!amt || amt <= 0) return send(res, 400, { ok: false, error: "Enter a valid amount." });
  const updated = db.adjustWallet(target.id, amt);
  db.insertTransaction({ id: genId("tx"), userId: target.id, type: "refund", amount: amt, reason: reason || "", byUser: admin.id, date: Date.now() });
  send(res, 200, { ok: true, wallet: updated.wallet });
});

// ---- super admin: access control ----
route("POST", "/api/admin/access", async (req, res) => {
  const actor = getAuthUser(req);
  if (!isSuperAdmin(actor)) return send(res, 403, { ok: false, error: "Only the super admin can change access levels." });
  const { userId, role } = await readJSON(req);
  const target = db.findUserById(userId);
  if (!target) return send(res, 404, { ok: false, error: "User not found." });
  if (target.id === actor.id) return send(res, 400, { ok: false, error: "You can't change your own access level." });
  if (!Object.values(ROLES).includes(role)) return send(res, 400, { ok: false, error: "Unknown role." });
  if (target.role === ROLES.SUPERADMIN && role !== ROLES.SUPERADMIN) {
    if (db.countSuperAdmins(target.id) === 0) return send(res, 400, { ok: false, error: "At least one super admin must remain." });
  }
  const updated = db.setUserRole(target.id, role);
  send(res, 200, { ok: true, user: publicUser(updated) });
});

// ---- super admin: real payouts (money leaving the platform) ----
route("POST", "/api/admin/payout", async (req, res) => {
  const actor = getAuthUser(req);
  if (!isSuperAdmin(actor)) return send(res, 403, { ok: false, error: "Only the super admin can send payouts." });
  const { userId, amount, accountNumber, bankCode, accountName } = await readJSON(req);
  const target = db.findUserById(userId);
  if (!target) return send(res, 404, { ok: false, error: "User not found." });
  const amt = Number(amount);
  if (!amt || amt <= 0) return send(res, 400, { ok: false, error: "Enter a valid amount." });
  if (target.wallet < amt) return send(res, 402, { ok: false, error: "User's wallet balance is lower than the payout amount." });
  if (!accountNumber || !bankCode) return send(res, 400, { ok: false, error: "accountNumber and bankCode are required." });

  try {
    const recipient = await paystackRequest("POST", "/transferrecipient", {
      type: "nuban", name: accountName || target.name,
      account_number: accountNumber, bank_code: bankCode, currency: "NGN"
    });
    if (recipient.status >= 400 || !recipient.body.status) {
      return send(res, 502, { ok: false, error: recipient.body.message || "Could not create transfer recipient." });
    }
    const reference = genId("payout");
    const transfer = await paystackRequest("POST", "/transfer", {
      source: "balance", amount: Math.round(amt * 100),
      recipient: recipient.body.data.recipient_code,
      reason: `IB-TECH payout to ${target.name}`, reference
    });
    if (transfer.status >= 400 || !transfer.body.status) {
      return send(res, 502, { ok: false, error: transfer.body.message || "Paystack rejected the transfer." });
    }
    // Debit immediately so the same balance can't be paid out twice while
    // the transfer is still processing; the webhook reverses this if
    // Paystack later reports the transfer failed.
    const updated = db.adjustWallet(target.id, -amt);
    db.insertTransaction({ id: genId("tx"), userId: target.id, type: "payout", amount: amt, reference, status: "pending", byUser: actor.id, date: Date.now() });
    send(res, 200, { ok: true, reference, wallet: updated.wallet, paystackStatus: transfer.body.data.status });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// Optional helper for building a bank picker in the admin UI.
route("GET", "/api/admin/banks", async (req, res) => {
  const user = getAuthUser(req);
  if (!isSuperAdmin(user)) return send(res, 403, { ok: false, error: "Only the super admin can view this." });
  try {
    const r = await paystackRequest("GET", "/bank?currency=NGN");
    send(res, 200, { ok: true, banks: r.body.data || [] });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const [pathname, qs] = req.url.split("?");
  const query = Object.fromEntries(new URLSearchParams(qs || ""));
  const match = routes.find(r => r.method === req.method && r.pattern === pathname);
  if (!match) return send(res, 404, { ok: false, error: "No such route." });

  try {
    await match.handler(req, res, query);
  } catch (e) {
    console.error(e);
    send(res, 500, { ok: false, error: "Internal server error." });
  }
});

server.listen(PORT, () => {
  console.log(`IB-TECH backend listening on http://localhost:${PORT}`);
  console.log("Storage: SQLite (server/ibtech.db)");
  console.log(PAYSTACK_SECRET ? "Paystack secret key detected — real payments enabled." : "No PAYSTACK_SECRET_KEY set — wallet/payout routes will return a clear error until you add one.");
});
