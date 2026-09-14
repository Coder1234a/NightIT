# NightIT

Night mess ordering, queueing and pickup for VIT Vellore hostels.
An add-on to MessIT. Built at **Hackulus '26** (SIAM VIT), 14–15 September 2026.

**Live API:** `https://nightit-api.onrender.com`

---

## The problem

Block entry closes at 9:00 PM for men and 8:30 PM for women. The night mess
opens at 10:30 PM. By the time food is being served every student is already
inside their own block and cannot walk to another one, so their block's counter
is the only counter they have.

You pay there and get two paper bills with the same number. The large one is
your only proof of purchase. Lose it and your money is gone; if somebody else
picks it up they can collect your order and nothing in the system would know.

**The paper decides who eats, not the person.** NightIT replaces it with a
six-digit code bound to a registration number, and a queue you can watch from
your room instead of from the corridor.

## What it does

| | |
|---|---|
| **Cart** | Order several things at once. The kitchen cooks a cart together, so the wait is the **slowest** item on it plus everyone queued ahead — not the sum of the items. |
| **Queue number** | Handed out per counter when you pay, the same number the staff work through. Your *position* counts down live as the carts ahead of you are served. |
| **Almost your turn** | When one or none are ahead, the phone buzzes and says start walking. |
| **Food is ready** | The counter taps Ready; the student's screen turns green with a sound and a notification. |
| **Pay your way** | UPI through Razorpay, or cash at the counter. Both end in the same place. |
| **Live menu** | Items grey out when stock hits zero, and close themselves at their cut-off time. |
| **Take away or eat in** | Chosen at order time. |
| **Prices excluding tax** | Every price is labelled `+tax`; the tax is added once at checkout, so the cart total and the amount the payment gateway charges are the same number. |
| **Three palettes** | Men's blocks, ladies' blocks and staff each get their own colour theme, so nobody has to wonder which side of the app they are on. |
| **Feedback and bug reports** | Open to men's and ladies' hostel users alike. |
| **Reopen your order** | A live strip follows you across every student page. Close the tab, clear the browser, borrow a friend's phone — type your registration number and the server hands the order back. |

Every block is different — menus, prices, counters, closing times, what runs
out. None of that is in the code. It is all rows in the database, so onboarding
a block means inserting rows, not shipping a release.

## Layout

```
.
├── render.yaml       Blueprint: API + database + static frontend
├── docs/
│   └── TEST_REPORT.md
├── server/           Node + Express + PostgreSQL
│   ├── index.js      19 routes
│   ├── db.js         pool, timezone and demo-clock wiring
│   ├── scripts/      migrate.js, gen_seed.py
│   ├── sql/          schema, functions, seed, indexes
│   └── test/         62 tests
└── client/           React + Vite
    ├── public/items/ where the menu photos go — see the README in there
    ├── src/lib/      api, Razorpay loader, sound and notifications
    └── src/screens/  Order · Ticket · Counter · Admin · Say · LiveOrder
```

## Pages

| Route | |
|---|---|
| `/` | the front door — pick men's hostel, ladies' hostel or staff |
| `/mens`, `/ladies` | ordering and feedback, showing only that side's blocks |
| `/order/:id` | one ticket: code, QR, queue number, live position |
| `/staff` | counter queue, scanning and the dashboard |

Real routes, not one static page — a ticket can be bookmarked, reloaded and
shared between the student's own devices.

## Running it

**Backend** — needs Node 20+ and a PostgreSQL database.

```bash
cd server
npm install
cp .env.example .env          # put your own DATABASE_URL in it
npm run migrate -- --seed
npm start                     # http://localhost:3000/health
npm test                      # 49 tests
```

**Frontend**

```bash
cd client
npm install
cp .env.example .env.local    # point VITE_API_URL at your API
npm run dev
```

## Deploying

Push to GitHub, then Render → **New → Blueprint** → pick the repo. `render.yaml`
creates the API, a free PostgreSQL database and the static frontend, and wires
`DATABASE_URL` and `VITE_API_URL` between them.

Then set three variables on **nightit-api** in the Render dashboard:

| Key | Value |
|---|---|
| `DEMO_TIME` | `23:00` while demoing; blank in real use |
| `TAX_PERCENT` | `5` if unset |
| `RAZORPAY_KEY_ID` | your `rzp_test_…` key |
| `RAZORPAY_KEY_SECRET` | the matching secret |

The free tier sleeps when idle, so the first request after a quiet period takes
about 30 seconds. **Open the URL once before any demo.**

## API

| Method | Path | |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/payments/config` | the public Razorpay key, never the secret |
| GET | `/blocks` | blocks and their counters |
| GET | `/menu?block_id=1` | stock, cut-off, state, live wait estimate |
| POST | `/orders` | `{reg_no, items:[{menu_item_id, qty}], mode, takeaway}` — one cart |
| POST | `/orders/:id/confirm` | payment done → pickup code + queue number |
| POST | `/orders/:id/cancel` | unpaid cart, portions go back |
| GET | `/orders/:id/status` | status, queue number, how many ahead, wait, ready |
| GET | `/orders/active?reg_no=…` | every live cart under that registration number |
| POST | `/orders/:id/ready` | counter: food is ready |
| POST | `/orders/:id/serve` | counter: handed over (used for cash) |
| POST | `/redeem` | `{counter_id, code}` — serves once, refuses after |
| GET | `/counter/:id/queue` | the live queue for one counter |
| POST | `/stock` | staff stock control |
| POST/GET | `/feedback` | feedback and bug reports |
| GET | `/admin/summary` | four figures plus demand in 10-minute slots |
| POST | `/admin/reset` | clears the night's orders; `?reseed=1` also rebuilds the menu; 404 unless `RESET_TOKEN` is set |
| GET | `/` | service index |

## How the pickup code works

The code lives on the order row. There is no OTP table, so nothing accumulates
and nothing ever needs purging.

- Randomness from `pgcrypto`'s `gen_random_bytes`, not `random()`.
- Only a SHA-256 hash is stored. The plain code is returned exactly once.
- A **partial** unique index — `(counter_id, otp_hash) WHERE status IN
  ('paid','ready')` — means a code only has to be unique among carts *still
  waiting at that counter*. Serving one frees its code, so the six-digit space
  never fills up however many nights this runs.
- Redemption is one conditional `UPDATE`, so two simultaneous scans can only
  serve the cart once. There is a test for exactly that.

## Three traps for anyone changing this

**`CREATE UNIQUE INDEX IF NOT EXISTS` silently does nothing** when a non-unique
index of that name already exists — no error, and the single-use guarantee is
quietly off. `004_indexes.sql` drops first and runs after the seed.

**The serving window crosses midnight**, so times of day cannot be compared
directly: 23:00 is *before* 00:15 on the same night. Use `night_min()` for any
new time comparison.

**Render runs on UTC.** The pool pins its connection to `Asia/Kolkata`, or the
database would think 23:00 IST is 17:30 and close everything.

## Finding your order again

The obvious place to keep "which order am I waiting for" is the browser, and
that is exactly what breaks: a closed tab, a cleared cache or a borrowed phone
and the order is gone, even though the food is still being cooked.

So the browser is only the fast path. `GET /orders/active?reg_no=…` asks the
server, which is the only thing that actually knows, and the student gets their
queue number back on any device. The strip that shows it is on every student
page, not just the front door.

## The blocks

Men's: A B C D K L M N P Q R T. Ladies': A B C D E F G H J S.

Both hostels have an A block, so `blocks.name` is not unique on its own — the
table is keyed on `(name, hostel_type)`, and the counter name carries the side
so the staff dropdown stays unambiguous.

`server/scripts/gen_seed.py` writes `sql/003_seed.sql`: 22 blocks, 22 counters
and 220 menu rows drawn from a 43-item catalogue. Edit the generator, re-run
it, and commit both. Hand-writing 220 rows is how typos get in.

## Changing the menu on a live database

`--seed-if-empty` in the build command seeds exactly once, on the very first
deploy, and never again — otherwise every deploy would erase the night's real
orders. The cost is that adding blocks or menu items to the seed file does
*not* reach a database that already has rows. Two ways to push it through:

- **Without a deploy** — `POST /admin/reset?reseed=1` with the `x-reset-token`
  header. Rebuilds blocks, counters, menus and stock from `003_seed.sql`.
- **With a deploy** — set `RESEED=1` on **nightit-api**, let it build, then
  delete the variable again.

Both erase every order, which is exactly what you want before a demo and
exactly what you do not want during one.

## Menu photos

`client/public/items/` is empty on purpose. Each menu row carries an
`image_url` such as `/items/cheese-maggi.jpg`; drop a file of that name in and
it appears. Anything missing falls back to a coloured tile, so the app never
breaks over a photo. The README in that folder lists all 22 slugs and the size
to shoot them at.

## Known limits

- The hash salt is the counter plus the date, both guessable — this stops
  casual database browsing, it is not password-grade.
- No rate limit on redeem attempts yet.
- The Razorpay webhook signature is not verified; confirmation is trusted from
  the client. Fine for a test-mode demo, not for production.
- Authentication is a typed registration number. Binding to the existing
  biometric hostel entry system is the intended next step.
- Cash carts are handed over against the queue number rather than a code,
  because the student paid in person. Still a single one-way transition.

## Team

| | | |
|---|---|---|
| Vidhi Garg | 26BCE3103 | Frontend and demo |
| Ashutosh Pradhan | 26BDE0113 | Payments and admin |
| Anikeit Agarwal | 26BDE0124 | Backend and data |
| Vedanshi Agrawal | 26BDE0168 | Research and pitch |

The interface design system, the QR and scanner work are Vidhi's. The Razorpay
loader and the dashboard are Ashutosh's. Both were built against mock data and
are wired to the live API here.

## License

MIT — see [LICENSE](LICENSE).
