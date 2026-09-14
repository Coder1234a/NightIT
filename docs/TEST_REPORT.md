NIGHTIT BACKEND - TEST AND DEBUG REPORT
Run 14 September 2026, in a container with PostgreSQL 16.13 + pgcrypto
Node v22.22.2

RESULT: 37 tests, 37 pass, 0 fail. Stable across 5 consecutive clean runs.

-------------------------------------------------------------------------------
WHAT IS COVERED
-------------------------------------------------------------------------------
health and configuration        3 tests
per-block configuration         4 tests
ordering and stock              5 tests
token issue and redemption     16 tests
cash path                       1 test
feedback, bugs, dashboard       3 tests
input validation                5 tests

Notable cases:
  - two simultaneous orders for the last portion: exactly one succeeds
  - two simultaneous scans of one code: served exactly once
  - a code from counter 1 does not work at counter 2
  - the same code MAY be live at two different counters at once
  - an expired code is refused
  - confirming an order twice is refused
  - the plain code never appears in the stored row
  - serving frees the code for reuse, and the row is kept as history
  - a cash order reaches the cashier queue and yields the same kind of code

-------------------------------------------------------------------------------
BUGS FOUND AND FIXED DURING THE BUILD
-------------------------------------------------------------------------------

1. MIDNIGHT-CROSSING SERVICE WINDOW  (would have broken every menu at night)
   The first version compared times of day directly: localtime < cutoff_at.
   The mess runs 22:30 to 00:30, so at 23:00 the test "23:00 < 00:15" is false
   and every item would show as closed for the entire serving window.
   Fixed with night_min(), which puts anything before noon on the following
   day, so 22:30 < 23:00 < 00:30 orders correctly. Mutation test confirms:
   reverting this breaks 15 of 37 tests.

2. THE 6 AM DEMO WOULD HAVE SHOWN AN EMPTY, CLOSED MESS
   The final presentation is at 6 AM, when the mess is genuinely shut, so a
   correct app would correctly show nothing available on stage.
   Added DEMO_TIME, which pins the clock. Set DEMO_TIME=23:00 in Render before
   judging. Leave it unset in real use.
   It is passed as a libpq connection option rather than a query after connect,
   which also removed a pg concurrency warning.

3. CREATE UNIQUE INDEX IF NOT EXISTS SILENTLY DID NOTHING
   Found by mutation testing. A non-unique index of the same name already
   existed from an earlier run, so the IF NOT EXISTS form skipped creation with
   no error and the single-use guarantee was quietly switched off.
   Fixed: DROP INDEX IF EXISTS first, and the index now lives in its own file
   that runs AFTER the seed, so a re-run on a dirty database still succeeds.

4. THE ORIGINAL UNIQUENESS TEST DID NOT ACTUALLY TEST UNIQUENESS
   The first version issued 25 codes and checked they differed. With a million
   possible codes, that passes whether or not the index exists. Replaced with
   three deterministic tests: a forced duplicate must be rejected by the
   database, the same code must be allowed at two different counters, and
   issue_otp must recover from a real collision.

-------------------------------------------------------------------------------
MUTATION TESTING - deliberately breaking the code to prove the tests bite
-------------------------------------------------------------------------------
  weaken redeem to allow re-serving       2 tests fail   caught
  drop the partial unique index           1 test  fails  caught (after fix 4)
  let take_stock go below zero            1 test  fails  caught
  restore the naive midnight comparison  15 tests fail   caught

-------------------------------------------------------------------------------
LIVE END-TO-END, THROUGH THE RUNNING SERVER
-------------------------------------------------------------------------------
  GET  /health                       {"ok":true}
  GET  /menu?block_id=1              Maggi/fries/fried rice/cold coffee,
                                     fries correctly sold_out, ETAs present
  GET  /menu?block_id=2              a different menu - per-block config works
  POST /orders (Maggi, parcel, UPI)  order_id 1
  POST /orders/1/confirm             code 949561
  POST /redeem                       served: true
  POST /redeem  (same code again)    served: false, already used
  POST /orders (LH-2, cash)          appears in the cashier queue
  POST /orders/2/confirm             code 472005, redeemed successfully
  GET  /admin/summary                2 orders, 2 served, Rs 80 collected

-------------------------------------------------------------------------------
WHAT IS NOT DONE, AND WHY
-------------------------------------------------------------------------------
  Not deployed to Render, and not pushed to GitHub. Both need account
  credentials. Two commands from a laptop that is logged in:

      git remote add origin https://github.com/Coder1234a/NightIT.git
      git push -u origin main

  Then Render -> New -> Blueprint -> pick the repo. render.yaml creates the web
  service and a free PostgreSQL database and wires DATABASE_URL automatically.

  Also not built, deliberately: Razorpay webhook signature verification, rate
  limiting on redeem attempts, and any authentication beyond a typed
  registration number. All three are listed in the README as known limits.
