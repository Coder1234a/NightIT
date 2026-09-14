# NightIT — test and debug report

Run 14 September 2026 against PostgreSQL 16.13 with `pgcrypto`, Node v22.

**49 backend tests, 49 passing.** Plus a full browser run of the merged
frontend against a live backend.

## Coverage

| Area | Tests |
|---|---|
| health and configuration | 4 |
| per-block configuration | 3 |
| cart and total queue time | 7 |
| queue number and your turn | 5 |
| food is ready | 5 |
| pickup codes | 9 |
| cash path | 1 |
| serving from the counter | 4 |
| counter queue view | 2 |
| feedback, bugs, dashboard | 4 |
| input validation | 5 |

Notable cases: two simultaneous carts fighting over the last portion (exactly
one wins); two simultaneous scans of one code (served exactly once); a cart
that hits a sold-out item leaving no stock stranded; the same code live at two
different counters at once; a code refused after the cart was served at the
counter instead of scanned.

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

## Browser run

Driven with a real Chromium against a live API:

```
cart          ₹130 | whole cart ready in about 16 min
ticket        code 137948 | queue number 1 | QR rendered
              People ahead of you: 0 · Whole cart ready in: 16 min
              Maggi x2 ₹80 · Cold coffee ₹50 · Total ₹130
              "almost your turn" state active
counter       queue row "Maggi x2, Cold coffee" · no 1
after Ready   header "Ready" · "Collect it now" · green card, no reload
scan 1        SERVED
scan 2        ALREADY USED
admin         1 order · 1 served · 0 waiting · ₹130 collected · chart drawn
say           feedback submitted and confirmed
```

No JavaScript errors. The only console noise is Google Fonts being blocked in
the test container and a favicon 404, both fixed or harmless.

## Not done, deliberately

Razorpay webhook signature verification, rate limiting on redeem attempts, and
any authentication beyond a typed registration number. All three are listed as
known limits in the README rather than hidden.
