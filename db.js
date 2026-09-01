/* ==========================================================================
   IB-TECH — SQLite data layer
   --------------------------------------------------------------------------
   Uses Node's built-in `node:sqlite` (no npm install, but it needs a fairly
   recent Node — see the version note in server/README.md). This replaces
   the earlier db.json file: real ACID transactions, an index on stock
   lookups, and no risk of two requests corrupting the file by writing at
   the same moment.

   Every exported function here does ONE thing to the database — the intent
   is that server.js never writes raw SQL, and this file never knows about
   HTTP.
   ========================================================================== */
"use strict";
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");
const { genId, genPin, genSerial, hashPassword } = require("./lib");

const DB_FILE = path.join(__dirname, "ibtech.db");
const NETWORKS = ["MTN", "GLO", "AIRTEL", "9MOBILE"];
const DENOMS = [100, 200, 500, 1000, 1500];

const isNewDatabase = !fs.existsSync(DB_FILE);
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    business      TEXT,
    email         TEXT NOT NULL UNIQUE,
    phone         TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    wallet        REAL NOT NULL DEFAULT 0,
    avatar        TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pins (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    network  TEXT NOT NULL,
    denom    INTEGER NOT NULL,
    pin      TEXT NOT NULL,
    serial   TEXT NOT NULL,
    used     INTEGER NOT NULL DEFAULT 0,
    used_by  TEXT,
    used_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pins_available ON pins(network, denom, used);
  CREATE INDEX IF NOT EXISTS idx_pins_used_by ON pins(used_by);

  CREATE TABLE IF NOT EXISTS transactions (
    id        TEXT PRIMARY KEY,
    user_id   TEXT NOT NULL,
    type      TEXT NOT NULL,
    network   TEXT,
    denom     INTEGER,
    qty       INTEGER,
    amount    REAL,
    total     REAL,
    reference TEXT,
    status    TEXT,
    reason    TEXT,
    by_user   TEXT,
    via       TEXT,
    date      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
  CREATE INDEX IF NOT EXISTS idx_tx_reference ON transactions(reference);

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS processed_references (
    reference TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Migration for databases created before the "avatar" column existed —
// CREATE TABLE IF NOT EXISTS above only helps on a fresh DB_FILE.
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT"); } catch (e) { /* column already exists */ }

// Migration for databases created before dedicated virtual accounts existed.
try { db.exec("ALTER TABLE users ADD COLUMN paystack_customer_code TEXT"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN dva_status TEXT NOT NULL DEFAULT 'none'"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN dva_account_number TEXT"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN dva_bank_name TEXT"); } catch (e) { /* already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN dva_account_name TEXT"); } catch (e) { /* already exists */ }

if (isNewDatabase) seed();

function seed() {
  db.prepare(`
    INSERT INTO users (id, name, business, email, phone, password_hash, role, wallet, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'superadmin', 500000, ?)
  `).run("u_admin", "IB-TECH Admin", "IB-TECH Head Office", "admin@ibtech.com", "08000000000", hashPassword("admin123"), Date.now());

  const insertPin = db.prepare("INSERT INTO pins (network, denom, pin, serial) VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    NETWORKS.forEach(net => DENOMS.forEach(denom => {
      for (let i = 0; i < 40; i++) insertPin.run(net, denom, genPin(), genSerial());
    }));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(email) || null;
}
function findUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}
function findUserByPhone(phone) {
  if (!phone) return null;
  return db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) || null;
}
function createUser({ name, business, email, phone, passwordHash }) {
  const id = genId("u");
  const createdAt = Date.now();
  db.prepare(`
    INSERT INTO users (id, name, business, email, phone, password_hash, role, wallet, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'user', 0, ?)
  `).run(id, name, business || "—", email, phone || "", passwordHash, createdAt);
  return findUserById(id);
}
function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY created_at ASC").all();
}
// Positive delta credits, negative debits. Runs as one statement so two
// simultaneous requests can't both read the old balance and overwrite
// each other's update (the classic "lost update" bug with read-then-write).
function adjustWallet(userId, delta) {
  db.prepare("UPDATE users SET wallet = wallet + ? WHERE id = ?").run(delta, userId);
  return findUserById(userId);
}
function setUserRole(userId, role) {
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
  return findUserById(userId);
}
function setUserAvatar(userId, dataUrl) {
  db.prepare("UPDATE users SET avatar = ? WHERE id = ?").run(dataUrl, userId);
  return findUserById(userId);
}
function setUserPassword(userId, passwordHash) {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
  return findUserById(userId);
}
function countSuperAdmins(excludingId) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin' AND id != ?").get(excludingId).n;
}

// ---------------------------------------------------------------------------
// dedicated virtual accounts (Paystack) — a permanent bank account number
// per user, so they can fund their wallet by transfer at any time.
// ---------------------------------------------------------------------------
function setCustomerCode(userId, customerCode) {
  db.prepare("UPDATE users SET paystack_customer_code = ? WHERE id = ?").run(customerCode, userId);
  return findUserById(userId);
}
function setDvaPending(userId) {
  db.prepare("UPDATE users SET dva_status = 'pending' WHERE id = ?").run(userId);
  return findUserById(userId);
}
function setDvaActive(userId, { accountNumber, bankName, accountName }) {
  db.prepare(`
    UPDATE users SET dva_status = 'active', dva_account_number = ?, dva_bank_name = ?, dva_account_name = ?
    WHERE id = ?
  `).run(accountNumber, bankName, accountName, userId);
  return findUserById(userId);
}
function setDvaFailed(userId) {
  db.prepare("UPDATE users SET dva_status = 'failed' WHERE id = ?").run(userId);
  return findUserById(userId);
}
function findUserByCustomerCode(customerCode) {
  return db.prepare("SELECT * FROM users WHERE paystack_customer_code = ?").get(customerCode) || null;
}

// ---------------------------------------------------------------------------
// stock / pins
// ---------------------------------------------------------------------------
function stockCount(network, denom) {
  return db.prepare("SELECT COUNT(*) AS n FROM pins WHERE network = ? AND denom = ? AND used = 0").get(network, denom).n;
}
function stockSnapshot() {
  const out = {};
  NETWORKS.forEach(n => { out[n] = {}; DENOMS.forEach(d => out[n][d] = stockCount(n, d)); });
  return out;
}
function addPins(network, denom, qty) {
  const insert = db.prepare("INSERT INTO pins (network, denom, pin, serial) VALUES (?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (let i = 0; i < qty; i++) insert.run(network, denom, genPin(), genSerial());
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return stockCount(network, denom);
}
// Atomically claims `qty` unused pins for a transaction, or claims nothing
// at all if there aren't enough — never hands out half a batch.
function drawPins(network, denom, qty, txId) {
  db.exec("BEGIN");
  try {
    const rows = db.prepare("SELECT id, pin, serial FROM pins WHERE network = ? AND denom = ? AND used = 0 LIMIT ?").all(network, denom, qty);
    if (rows.length < qty) { db.exec("ROLLBACK"); return null; }
    const claim = db.prepare("UPDATE pins SET used = 1, used_by = ?, used_at = ? WHERE id = ?");
    const now = Date.now();
    rows.forEach(r => claim.run(txId, now, r.id));
    db.exec("COMMIT");
    return rows.map(r => ({ pin: r.pin, serial: r.serial }));
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function cardsForTransaction(txId) {
  return db.prepare("SELECT pin, serial FROM pins WHERE used_by = ?").all(txId);
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
function createSession(userId) {
  const token = genId("tok");
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(token, userId, Date.now());
  return token;
}
function userIdForSession(token) {
  const row = db.prepare("SELECT user_id FROM sessions WHERE token = ?").get(token);
  return row ? row.user_id : null;
}
function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// ---------------------------------------------------------------------------
// password resets
// ---------------------------------------------------------------------------
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
function createPasswordReset(userId) {
  const token = genId("reset");
  db.prepare("INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)")
    .run(token, userId, Date.now() + RESET_TTL_MS);
  return token;
}
// Returns the user_id for a still-valid token, or null if it's missing/expired.
function findPasswordReset(token) {
  const row = db.prepare("SELECT * FROM password_resets WHERE token = ?").get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) { deletePasswordReset(token); return null; }
  return row;
}
function deletePasswordReset(token) {
  db.prepare("DELETE FROM password_resets WHERE token = ?").run(token);
}

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------
function insertTransaction(tx) {
  db.prepare(`
    INSERT INTO transactions (id, user_id, type, network, denom, qty, amount, total, reference, status, reason, by_user, via, date)
    VALUES (@id, @userId, @type, @network, @denom, @qty, @amount, @total, @reference, @status, @reason, @byUser, @via, @date)
  `).run({
    id: tx.id, userId: tx.userId, type: tx.type,
    network: tx.network ?? null, denom: tx.denom ?? null, qty: tx.qty ?? null,
    amount: tx.amount ?? null, total: tx.total ?? null, reference: tx.reference ?? null,
    status: tx.status ?? null, reason: tx.reason ?? null, byUser: tx.byUser ?? null,
    via: tx.via ?? null, date: tx.date
  });
  return tx.id;
}
function transactionsForUser(userId) {
  const rows = db.prepare("SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC").all(userId);
  return rows.map(hydrateTransaction);
}
function allTransactions() {
  const rows = db.prepare("SELECT * FROM transactions ORDER BY date DESC").all();
  return rows.map(hydrateTransaction);
}
function hydrateTransaction(row) {
  const out = {
    id: row.id, userId: row.user_id, type: row.type,
    network: row.network, denom: row.denom, qty: row.qty,
    amount: row.amount, total: row.total, reference: row.reference,
    status: row.status, reason: row.reason, byUser: row.by_user,
    via: row.via, date: row.date
  };
  if (row.type === "print") out.cards = cardsForTransaction(row.id);
  return out;
}
function findPendingPayout(reference) {
  return db.prepare("SELECT * FROM transactions WHERE type = 'payout' AND reference = ? AND status = 'pending'").get(reference) || null;
}
function setTransactionStatus(id, status) {
  db.prepare("UPDATE transactions SET status = ? WHERE id = ?").run(status, id);
}
// Deletes a transaction record (history entry only — it does not restore
// wallet balance or un-claim any pins that were printed under it).
// Pass ownerId to scope the delete to that user's own rows (regular users);
// pass null to delete any transaction regardless of owner (admins).
function deleteTransaction(id, ownerId) {
  const result = ownerId
    ? db.prepare("DELETE FROM transactions WHERE id = ? AND user_id = ?").run(id, ownerId)
    : db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// idempotency guard for Paystack references
// ---------------------------------------------------------------------------
function isReferenceProcessed(reference) {
  return !!db.prepare("SELECT 1 FROM processed_references WHERE reference = ?").get(reference);
}
function markReferenceProcessed(reference) {
  db.prepare("INSERT OR IGNORE INTO processed_references (reference) VALUES (?)").run(reference);
}

module.exports = {
  NETWORKS, DENOMS,
  findUserByEmail, findUserByPhone, findUserById, createUser, listUsers, adjustWallet, setUserRole, countSuperAdmins,
  setUserAvatar, setUserPassword,
  stockCount, stockSnapshot, addPins, drawPins, cardsForTransaction,
  createSession, userIdForSession, deleteSession,
  createPasswordReset, findPasswordReset, deletePasswordReset,
  insertTransaction, transactionsForUser, allTransactions, findPendingPayout, setTransactionStatus, deleteTransaction,
  isReferenceProcessed, markReferenceProcessed,
  setCustomerCode, setDvaPending, setDvaActive, setDvaFailed, findUserByCustomerCode
};
