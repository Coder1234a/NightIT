# NightIT — API

Backend for NightIT, the night mess ordering and pickup system for VIT hostels.
An add-on to MessIT.

## Run it locally

```bash
cd server
npm install
cp .env.example .env          # put your own DATABASE_URL in it
npm run migrate -- --seed     # creates the tables and two example blocks
npm start                     # http://localhost:3000/health
```

## Run the tests

```bash
npm test
```

37 tests. They rebuild the database from `sql/` first, so a run always starts
from the same state. `DEMO_TIME` defaults to `23:00` inside the tests so the
night mess is open while they run.

## Deploy to Render

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → pick this repo. `render.yaml` creates both the
   web service and a free PostgreSQL database and wires `DATABASE_URL` for you.
3. Wait for the first deploy, then open `/health`.

Nothing secret is in this repo. `DATABASE_URL` comes from Render, and the
Razorpay keys belong in the Render dashboard as environment variables.

The free tier sleeps when idle, so the first request after a quiet period takes
about 30 seconds. **Open the URL once before any demo.**

## DEMO_TIME

The mess is only open 22:30–00:30, so at 6 AM every item would correctly show
as closed. Setting `DEMO_TIME=23:00` pins the app's clock so a morning
presentation still shows a working, open mess. Leave it unset in real use.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET  | `/health` | Liveness check |
| GET  | `/blocks` | Every block and its counter |
| GET  | `/menu?block_id=1` | Menu with stock, cut-off, state and an ETA |
| POST | `/orders` | `{reg_no, menu_item_id, mode, parcel}` → creates a pending order and takes a portion off the shelf |
| POST | `/orders/:id/confirm` | Marks it paid and returns the six-digit code |
| POST | `/orders/:id/cancel` | Cancels an unpaid order, returns the portion |
| POST | `/redeem` | `{counter_id, code}` → serves it once, refuses every time after |
| GET  | `/counter/:id/pending-cash` | Cash orders waiting for the cashier |
| POST | `/stock` | `{menu_item_id, remaining}` — staff stock control |
| POST | `/feedback` | `{reg_no, block_id, kind, rating, message}`, kind is `feedback` or `bug` |
| GET  | `/feedback?kind=bug` | Newest first |
| GET  | `/admin/summary?hostel_type=mens` | Four tiles plus demand in 10-minute slots |

## How the pickup code works

The code lives on the order row. There is no OTP table, so nothing accumulates
and nothing ever needs purging.

* Randomness comes from `pgcrypto`'s `gen_random_bytes`, not `random()`.
* Only a SHA-256 hash is stored. The plain code is returned once.
* A partial unique index — `(counter_id, otp_hash) WHERE status = 'paid'` —
  means a code only has to be unique among orders still waiting at that
  counter. Serving an order frees its code, so the six-digit space never fills.
* Redemption is one conditional `UPDATE`, so two simultaneous scans can only
  serve the order once. There is a test for exactly that.

### Two things to know before changing this

* `CREATE UNIQUE INDEX IF NOT EXISTS` silently does nothing if a non-unique
  index of the same name already exists, which would switch the guarantee off
  without any error. `sql/004_indexes.sql` drops first, and runs after the seed
  so a re-run on a dirty database still succeeds.
* The serving window crosses midnight, so times of day cannot be compared
  directly — 23:00 is *before* 00:15 on the same night. `night_min()` puts
  everything on one scale. Use it for any new time comparison.

### Known limits, state them if a reviewer asks

* The hash salt is the counter plus the date, both guessable, so this stops
  casual database browsing but is not password-grade.
* There is no rate limit on redeem attempts yet. That is the next thing to add.
* The Razorpay webhook signature is not verified; confirmation is trusted from
  the client. Fine for a test-mode demo, not for production.
