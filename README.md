# IB-TECH backend (reference implementation)

A real server for the IB-TECH portal — no framework, and the only
dependency is Node itself. It replaces the browser's `localStorage` with
real SQLite storage, issues real login sessions, and (once you add a
Paystack secret key) handles real wallet funding, refunds, and payouts.

**Storage: SQLite**, via Node's built-in `node:sqlite` module — so there's
still nothing to `npm install`. Every write that matters (drawing pins for
a print, adjusting a wallet) runs inside a real database transaction, so
two requests landing at the same instant can't corrupt each other's data
or oversell stock. This was tested directly: 50 simultaneous print
requests against 47 available pins correctly succeeded exactly 47 times,
failed exactly 3 times, and left stock at precisely 0 — never negative,
never double-counted.

This is still a **reference implementation**, not a full production
deployment: it's a single SQLite file on one machine's disk, and session
tokens live in that same file. That's genuinely fine for a small-to-medium
operation — SQLite handles far more load than people expect — but if you
outgrow a single server, that's the point to move to Postgres/MySQL and a
proper session store (Redis, or signed JWTs). The request/response shape
won't need to change either way.

## Node version note

`node:sqlite` is a fairly new addition. This was built and tested against
**Node v22.22**. If you're on an older Node 22.x (22.5–22.11), you may need
to run it as `node --experimental-sqlite server.js`. Node 18/20 don't have
this module at all — upgrade first (`node --version` to check).

## Quick start

```bash
cd server
cp .env.example .env      # then edit .env if you have a Paystack secret key
node server.js
```

No `npm install` needed. You should see:
```
IB-TECH backend listening on http://localhost:3000
Storage: SQLite (server/ibtech.db)
No PAYSTACK_SECRET_KEY set — wallet/payout routes will return a clear error until you add one.
```

`server/ibtech.db` is created automatically on first run, seeded with one
super admin account:
- **admin@ibtech.com** / **admin123**

Delete `ibtech.db` (and the `-wal`/`-shm` files next to it, if present) any
time to reset back to that seed.

## Code layout

- `lib.js` — pure helpers (password hashing, ID/pin generation, pricing). No I/O.
- `db.js` — every SQL statement lives here. Exposes plain functions like `db.drawPins(...)`; nothing outside this file writes SQL.
- `server.js` — HTTP only: routing, auth checks, request/response shaping, and the Paystack calls.

## Try it with curl

```bash
# Sign up a reseller
curl -s -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Ibrahim Kankia","business":"Kankia Recharge Stores","email":"demo@ibtech.com","phone":"08011112222","password":"demo1234"}'
# -> { "ok": true, "token": "tok_...", "user": {...} }

# Log in as the super admin
curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@ibtech.com","password":"admin123"}'
# -> save the returned token as ADMIN_TOKEN

# Grant a user admin access (super admin only)
curl -s -X POST http://localhost:3000/api/admin/access \
  -H "Authorization: Bearer ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"u_...","role":"admin"}'

# Credit a wallet manually (ledger only, no real money)
curl -s -X POST http://localhost:3000/api/admin/credit \
  -H "Authorization: Bearer ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"u_...","amount":5000}'

# Print a batch of cards as that user
curl -s -X POST http://localhost:3000/api/print \
  -H "Authorization: Bearer USER_TOKEN" -H "Content-Type: application/json" \
  -d '{"network":"MTN","denom":500,"qty":2}'
```

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/api/auth/signup` | — | Create a reseller account |
| POST | `/api/auth/login` | — | Get a session token |
| POST | `/api/auth/logout` | token | Invalidate the token |
| GET | `/api/me` | token | Current user |
| GET | `/api/stock` | — | Stock counts per network/denomination |
| POST | `/api/print` | token | Debit wallet, atomically draw pins, log a transaction |
| GET | `/api/transactions` | token | Own transactions (`?all=1` for admins) |
| POST | `/api/wallet/initiate` | token | Start a real Paystack payment |
| POST | `/api/wallet/verify` | token | Confirm a payment and credit the wallet |
| POST | `/api/paystack/webhook` | signature | Source-of-truth events from Paystack |
| POST | `/api/admin/stock` | admin | Add e-pins to stock |
| GET | `/api/admin/users` | admin | List all users |
| POST | `/api/admin/credit` | admin | Ledger-only wallet top-up |
| POST | `/api/admin/refund` | admin | Ledger-only refund back into a wallet |
| POST | `/api/admin/access` | **super admin** | Grant or revoke admin access |
| POST | `/api/admin/payout` | **super admin** | Send real money to a bank account (Paystack Transfer) |
| GET | `/api/admin/banks` | **super admin** | List banks, for a payout form's dropdown |

The front end (`js/api.js`, one folder up) already speaks this exact
contract — the dashboards work against this server as-is.

## Payouts need a live/test Paystack balance

`/api/admin/payout` calls Paystack's real Transfer API. In **test mode**
transfers always report success without moving real money — useful for
building the flow. In **live mode** it needs an actual balance in your
Paystack account and a verified recipient bank account. Rely on the
`/api/paystack/webhook` events (`transfer.success` / `transfer.failed`)
for the final word on whether a payout went through — the initial API
response only means the request was accepted, not that money has moved.

## Deploying

Any host that runs a persistent Node process works — this is a plain
`http.createServer`, not tied to any platform's serverless model (SQLite
needs a writable, persistent disk, which rules out most serverless
functions anyway). Reasonable starting points: a small VPS (systemd
service or `pm2 start server.js`), Railway, Render, or Fly.io. Whichever
you pick:

1. Set `PAYSTACK_SECRET_KEY` as an environment variable (not a committed `.env` file).
2. Back up `ibtech.db` regularly — it's the entire database.
3. Point `js/api.js`'s `CONFIG.apiBase` (or the `window.IBT_API_BASE` global) at the deployed URL instead of `http://localhost:3000`.
4. Serve the static front-end files from any static host (Netlify, Vercel, GitHub Pages, or the same VPS) — CORS is already open (`Access-Control-Allow-Origin: *`), so it doesn't need to share an origin with the backend. Tighten that header to your real domain once you're live.
