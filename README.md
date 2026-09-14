# NightIT

Night mess ordering and pickup for VIT Vellore hostels. An add-on to MessIT.

Built at **Hackulus '26** (SIAM VIT), 14–15 September 2026.

---

## The problem

Hostel block entry closes at 9:00 PM for men and 8:30 PM for women. The night
mess opens at 10:30 PM. By the time food is being served, every student is
already inside their own block and cannot walk to another one, so their block's
counter is the only counter they have.

You pay at that counter and get two paper bills carrying the same number. The
large one is your only proof of purchase. Lose it and you get nothing back.
If someone else picks it up, they can collect your order and nothing in the
system would know.

**The paper decides who eats, not the person.** NightIT replaces it with a
six-digit code bound to a registration number — one that cannot be dropped,
handed over, or picked up by a stranger.

## What it does

| | |
|---|---|
| **Pay your way** | UPI in the app, or cash at the counter. A cash order becomes a real code the moment the cashier confirms it. |
| **Live menu** | Items grey out the moment stock hits zero. |
| **Items close themselves** | Every item has a cut-off time and marks itself unavailable when it passes. |
| **Preparation estimate** | Shown before the order is placed. |
| **Parcel or eat in** | Chosen at order time. |
| **Token pickup** | QR plus a six-digit code. No queue, nothing shouted across the room. |
| **Feedback and bug reports** | Available to men's and ladies' hostel users alike. |

Every block is different — menus, prices, counters, closing times, what runs
out. None of that is in the code. It is all rows in the database, so onboarding
a new block means inserting rows, not shipping a release.

## Repository layout

```
.
├── render.yaml          Render Blueprint — must stay at the root
├── docs/
│   └── TEST_REPORT.md   Test results and the bugs found while building
└── server/              The API
    ├── index.js         Express app, 11 endpoints
    ├── db.js            PostgreSQL connection pool
    ├── scripts/
    │   └── migrate.js   Runs everything in sql/ in order
    ├── sql/
    │   ├── 001_schema.sql      six tables
    │   ├── 002_functions.sql   OTP issue and redeem, stock, night_min
    │   ├── 003_seed.sql        two example blocks, deliberately different
    │   └── 004_indexes.sql     the partial unique index — runs last
    └── test/
        └── api.test.js  37 tests
```

The frontend (`client/`, React + Vite on Vercel) is being built in parallel and
lands in this repo separately.

## Running it locally

You need Node 20 or newer and a PostgreSQL database.

```bash
cd server
npm install
cp .env.example .env          # put your own DATABASE_URL in it
npm run migrate -- --seed     # creates the tables and two example blocks
npm start                     # http://localhost:3000/health
```

## Running the tests

```bash
cd server
npm test
```

37 tests. They rebuild the database from `sql/` before running, so every run
starts from the same state. `DEMO_TIME` defaults to `23:00` inside the tests so
the night mess is open while they run.

## Deploying to Render

1. Push this repository to GitHub.
2. Render → **New → Blueprint** → pick the repo. `render.yaml` creates the web
   service and a free PostgreSQL database and connects them.
3. Wait for the first deploy, then open `/health`.
4. **Seed the database once**, by hand — see below.

### Seeding, and why it is not automatic

`sql/003_seed.sql` starts with `TRUNCATE`. If seeding ran on every deploy, every
push would erase the night's real orders. So the build only runs migrations.

To seed once, open the Render database's **External Connection String** and run:

```bash
cd server
DATABASE_URL="<external connection string>" npm run migrate -- --seed
```

### Before the demo

The free tier sleeps when idle, so the first request after a quiet period takes
about 30 seconds. **Open the URL once before any demo.**

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Liveness check |
| GET | `/blocks` | Every block and its counter |
| GET | `/menu?block_id=1` | Menu with stock, cut-off, state and an ETA |
| POST | `/orders` | `{reg_no, menu_item_id, mode, parcel}` → creates a pending order and takes a portion off the shelf |
| POST | `/orders/:id/confirm` | Marks it paid and returns the six-digit code |
| POST | `/orders/:id/cancel` | Cancels an unpaid order, returns the portion |
| POST | `/redeem` | `{counter_id, code}` → serves it once, refuses every time after |
| GET | `/counter/:id/pending-cash` | Cash orders waiting for the cashier |
| POST | `/stock` | `{menu_item_id, remaining}` — staff stock control |
| POST | `/feedback` | `{reg_no, block_id, kind, rating, message}` — kind is `feedback` or `bug` |
| GET | `/feedback?kind=bug` | Newest first |
| GET | `/admin/summary?hostel_type=mens` | Four dashboard figures plus demand in 10-minute slots |

## How the pickup code works

The code lives on the order row. There is no OTP table, so nothing accumulates
and nothing ever needs purging.

- Randomness comes from `pgcrypto`'s `gen_random_bytes`, not `random()`, which
  is seeded and predictable.
- Only a SHA-256 hash is stored. The plain code is returned exactly once.
- A **partial** unique index — `(counter_id, otp_hash) WHERE status = 'paid'` —
  means a code only has to be unique among orders *still waiting at that
  counter*. Serving an order frees its code, so the six-digit space never fills
  up however many nights this runs.
- Redemption is one conditional `UPDATE`, so two simultaneous scans can only
  serve the order once. There is a test for exactly that.

### Two traps for anyone changing this

**`CREATE UNIQUE INDEX IF NOT EXISTS` silently does nothing** if a non-unique
index of the same name already exists — no error, and the single-use guarantee
is quietly switched off. `004_indexes.sql` drops first, and runs after the seed
so a re-run on a dirty database still succeeds.

**The serving window crosses midnight**, so times of day cannot be compared
directly: 23:00 is *before* 00:15 on the same night, but `23:00 > 00:15` as a
plain time. `night_min()` puts everything on one continuous scale. Use it for
any new time comparison.

## Known limits

Stated openly rather than hidden:

- The hash salt is the counter plus the date, both guessable, so hashing stops
  casual database browsing but is not password-grade.
- There is no rate limit on redeem attempts yet.
- The Razorpay webhook signature is not verified; confirmation is trusted from
  the client. Fine for a test-mode demo, not for production.
- Authentication is a typed registration number. Binding to the existing
  biometric hostel entry system is the intended next step.

## Secrets

Nothing secret belongs in this repository. `DATABASE_URL` comes from Render and
the Razorpay keys live in the Render dashboard as environment variables.
`.env` is gitignored — keep it that way.

## Team

| | | |
|---|---|---|
| Vidhi Garg | 26BCE3103 | Frontend and demo |
| Ashutosh Pradhan | 26BDE0113 | Payments and admin |
| Anikeit Agarwal | 26BDE0124 | Backend and data |
| Vedanshi Agrawal | 26BDE0168 | Research and pitch |

## License

MIT — see [LICENSE](LICENSE).
