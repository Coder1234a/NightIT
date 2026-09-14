# NightIT — test and debug report

Run 14–15 September 2026 against PostgreSQL 16.13 with `pgcrypto`, Node v22.

**61 backend tests, 61 passing.** Plus a full three-role browser run of the
merged frontend against a live backend.

## Coverage

| Area | Tests |
|---|---|
| health and configuration | 4 |
| per-block configuration | 3 |
| cart, tax and total queue time | 11 |
| queue number and your turn | 7 |
| food is ready | 5 |
| pickup codes | 9 |
| cash path | 1 |
| serving from the counter | 4 |
| counter queue view | 2 |
| feedback, bugs, dashboard | 4 |
| input validation | 5 |
| finding your order again | 5 |

Notable cases: two simultaneous carts fighting over the last portion (exactly
one wins); two simultaneous scans of one code (served exactly once); a cart
that hits a sold-out item leaving no stock stranded; the same code live at two
different counters at once; a code refused after the cart was served at the
counter instead of scanned; a cart taking the *slowest* item's cooking time
rather than the sum; tax added on top of the menu price rather than baked into
it; a queue position that counts down as the people ahead are served; and a
cart marked ready no longer lengthening anyone else's estimate.

The suite discovers its own fixtures from `/blocks` and `/menu` instead of
hardcoding seed IDs, so growing the seed from 2 blocks to 14 does not break a
single test.

## Bugs found and fixed

**1. The pickup code was lost between payment and the ticket screen.** The app
asked `/orders/:id/status` for the code, but the code is deliberately never
stored in readable form, so it came back empty and the ticket showed nothing.
The code now travels back from `confirm` and is passed straight through.

**2. Cash carts could not be handed over at all.** A cash student has no code
on their phone, and nothing in the API let staff complete the order. Added
`POST /orders/:id/serve` — a one-way transition, so a cart still cannot be
handed over twice. Four tests cover it.

**3. The serving window crosses midnight.** Comparing times of day directly
made 23:00 look *later* than 00:15, so every item read as closed all night.
Fixed with `night_min()`. Reverting it fails 15 tests.

**4. Render runs on UTC**, so the database thought 23:00 IST was 17:30 and
closed everything. The pool now pins its connection to `Asia/Kolkata`.

**5. `CREATE UNIQUE INDEX IF NOT EXISTS` silently did nothing** because a
non-unique index of the same name already existed — no error, and the
single-use guarantee was switched off. Found by mutation testing. The index now
drops first and lives in its own file that runs after the seed.

**6. The original uniqueness test did not test uniqueness.** Issuing 25 codes
and checking they differ passes whether or not the index exists. Replaced with
three deterministic tests including a forced collision.

**7. The cart's wait was the sum of its items.** A kitchen cooks a cart
together, so two Maggi and a coffee is six minutes, not fourteen. Changed to
the maximum item time plus the queue ahead. (LCM, which was suggested, is
worse than either: LCM(6, 4) is 12 — longer than the slowest item.)

**8. Ready food kept inflating everyone else's estimate.** The "how many are
ahead of you" CTE counted carts already cooked and waiting to be collected.
Now it counts only `status = 'paid'`.

**9. Migrations only created, never upgraded.** A deploy onto an existing
database died with `column "queue_no" does not exist`, and later with
`function return_stock(unknown) is not unique` because `CREATE OR REPLACE`
had left the old overload behind. `001_schema.sql` now carries guarded
`ALTER … IF NOT EXISTS` blocks and a queue-number backfill; `002_functions.sql`
drops each function before redefining it.

**11. An order was only findable from the phone that placed it.** The resume
banner read `localStorage`, so a closed tab or a cleared cache lost a cart that
was still being cooked. Replaced with `GET /orders/active?reg_no=…` — the
server is the only thing that actually knows — and a strip on every student
page rather than only the front door. Five tests cover the lookup, including
that a served cart drops out of it and that somebody else's number returns
nothing of yours.

**12. The price floated inside the item name** and collided with it on any item
whose name wrapped to two lines. The row is now three real columns, and a
missing photo renders a coloured tile instead of the browser's broken-image
glyph.

**13. The front door's title and subtitle ran together on one line** — two
spans in a flex row with no column wrapper.

**10. `node_modules` slipped past `.gitignore`.** The pattern ended in a slash,
which only matches real directories — a symlinked `node_modules` was staged for
commit. Slash removed.

## Mutation testing

Deliberately breaking the code to prove the tests bite:

| Change | Result |
|---|---|
| ETA ignores the queue, counts only cooking | 2 tests fail |
| `ready` accepts an unpaid cart | 1 test fails |
| queue numbers not scoped per counter | 1 test fails |
| cart failure does not roll back stock | the suite hangs on a leaked transaction — itself proof the rollback matters |
| weaken redeem to allow re-serving | 2 tests fail |
| drop the partial unique index | 1 test fails |
| restore the naive midnight comparison | 15 tests fail |
| make the cart wait additive again | 2 tests fail |
| bake tax into the price instead of adding it | 3 tests fail |
| count ready carts as still ahead of you | 1 test fails |

## Browser run

Driven with a real Chromium against a live API, all three roles:

```
door          Men's hostel · Ladies' hostel · Mess staff   body role ""
/ladies       role "ladies" · 6 ladies' blocks, no men's blocks listed
              registration number empty, placeholder "Your registration number"
              modes  Eat in · Take away
              menu   Cheese Maggi ₹55 +tax · thumbnail slot present
items         7 min item + 15 min item in one cart
cart bar      ₹173 | incl. ₹8 tax · ready in about 15 min      <- max, not 22
ticket        /order/1 · code 899818 · token 1 · QR rendered
              You are next · People ahead of you 0 · cart ready in 15 min
              Cheese Maggi ₹55 · Paneer fried rice ₹110 · Subtotal ₹165
              Tax ₹8 · Paid ₹173
reload        /order/1 survives a hard reload, token still 1
/staff        role "staff" · 14 counters · queue row shows the cart
after Ready   student header "Ready" · "Collect it now", no reload
scan 1        SERVED
scan 2        ALREADY USED
dashboard     1 order · 1 served · 0 waiting · ₹165 collected · chart drawn
resume        door shows "You are 1 in line · A-Block · token 1" for an
              unserved cart; Open returns to /order/:id with the palette intact
```

Each role paints its own palette from `body[data-role]`: warm orange for the
men's blocks, violet for the ladies' blocks, teal for staff.

No JavaScript errors. The only console noise is Google Fonts being blocked by
the test container's proxy and the deliberate 409 from the second scan.

## Not done, deliberately

Razorpay webhook signature verification, rate limiting on redeem attempts, and
any authentication beyond a typed registration number. All three are listed as
known limits in the README rather than hidden.
