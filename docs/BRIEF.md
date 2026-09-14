# NightIT — what we built, how, and why

Hackulus '26 · SIAM VIT · 14–15 September 2026
Vidhi Garg 26BCE3103 · Ashutosh Pradhan 26BDE0113 · Anikeit Agarwal 26BDE0124 · Vedanshi Agrawal 26BDE0168

Live API: `https://nightit-api.onrender.com` · Repo: `github.com/Coder1234a/NightIT`

This is the long version, for anyone who wants the reasoning behind the six
slides. Read it before the review so nobody has to invent an answer on stage.

---

## 1. Why this problem, and not a delivery app

Three facts about the VIT night mess, put together, make a problem nobody has
solved on campus:

Block entry closes at **9:00 PM for men and 8:30 for women**. The night mess
opens at **10:30 PM**. Men cannot move between blocks at night. So by the time
food is being cooked, every student is already sealed inside their own
building, and **their block's counter is the only counter they have**.

That single constraint kills the obvious idea. This is not a delivery problem —
there is nowhere to deliver from and nobody allowed to walk. It is a **queue and
identity problem inside one building**, which is a much narrower and much more
solvable thing.

Then there is the paper. You pay at the counter and get two bills carrying the
same number. The small one goes to the kitchen; the large one is your proof.
Lose it and your money is gone. If somebody else picks it up, they collect your
food and nothing in the system knows.

**The insight the whole project hangs on: a paper bill is a bearer token.**
Whoever holds it can spend it. The paper decides who eats, not the person. Every
other complaint — theft, lost bills, arguments at the counter — follows from
that one property.

So NightIT replaces the bearer token with a **single-use code bound to a
registration number**, and replaces standing in the corridor with a queue you
can watch from your room.

## 2. What we actually built

A working system, deployed, not a mockup.

**Three separate experiences.** A front door asks who you are: men's hostel,
ladies' hostel, or mess staff. Each gets its own route, its own palette (warm
orange, violet, teal) and its own view of the data — a student sees only their
own side's blocks. The judges at Review 0 asked us to separate the
administrator and student pages; this is that, done properly rather than with
a hidden link.

**The ordering side.** Pick your block, build a cart, choose eat-in or take
away, pay by UPI through Razorpay or by cash at the counter. Prices are shown
excluding tax with a `+tax` label; tax is added once at checkout so the number
in the cart bar is the number the gateway charges.

**The pickup.** Paying returns a six-digit code and a queue token. The counter
scans the code or types it. It works exactly once.

**The queue.** Your token is the number the staff are working through, and your
*position* counts down live as the carts ahead of you are served. When one or
none are ahead, the phone buzzes and tells you to start walking. When the
counter marks your food ready, the screen turns green.

**Finding it again.** The obvious place to remember "which order am I waiting
for" is the browser — and that is exactly what breaks. A closed tab, a cleared
cache or a borrowed phone and the order is gone while the food is still being
cooked. So the browser is only the fast path: `GET /orders/active?reg_no=…`
asks the server, which is the only thing that actually knows, and a strip on
every student page hands the order back on any device.

**Every block is data, not code.** Menus, prices, counters, service speeds,
closing times, what has run out — none of it is hard-coded. Onboarding a new
block means inserting rows. 22 blocks, 22 counters, 220 menu rows, 31 items,
all with photographs.

## 3. How it works, technically

**Stack.** Node 22 and Express on Render, PostgreSQL 16 with `pgcrypto`,
React 18 with Vite as a Render static site, Razorpay in test mode. 19 API
routes. No animation library, no UI framework — the intro and the theming are
plain CSS and the Web Animations API.

**The pickup code — the part we are proudest of.** There is no OTP table. The
code lives on the order row, generated from `gen_random_bytes` rather than
`random()`, and only a SHA-256 hash is stored — the plain code is returned
exactly once, at payment.

Uniqueness is enforced by a **partial unique index** on
`(counter_id, otp_hash) WHERE status IN ('paid','ready')`. That phrasing is the
clever bit: a code only has to be unique among carts *still waiting at that
counter*. Serving an order frees its code again, so the six-digit space can
never fill up however many nights this runs, and nothing ever needs purging.

Redemption is a single conditional `UPDATE`. Two staff scanning the same code
at the same instant cannot both succeed — the database decides. There is a test
that fires both concurrently and asserts exactly one wins.

**The midnight window.** The mess serves 22:30 to 00:30, so the window crosses
midnight and times of day cannot be compared directly: 23:00 is *before* 00:15
on the same night, but 23:00 > 00:15 as a plain time. Our first version closed
every item all night. A `night_min()` function reorders the clock. Reverting it
fails fifteen tests. It bit us again later, in a test we wrote to check it.

**Timezone.** Render runs on UTC, so the database thought 23:00 IST was 17:30
and closed everything. The pool now pins every connection to `Asia/Kolkata`.

**Cart arithmetic.** A kitchen cooks a cart together, so the wait is the
**slowest** item plus everyone queued ahead — not the sum of the items. Two
Maggi and a coffee is six minutes, not fourteen. (LCM, which was suggested at
one point, is worse than either: LCM(6,4) is 12, longer than the slowest dish.)

**Money.** Prices are whole rupees and tax rounds to the whole rupee, on the
server and in the cart bar alike. Coins below 50 paise stopped being legal
tender in 2011, so a bill reading ₹162.75 is one no counter can settle.

## 4. How we know it works

**62 backend tests**, covering concurrency (two carts fighting over the last
portion; two simultaneous scans), the midnight window, tax, queue positions,
the pickup-code guarantee and input validation. The suite discovers its own
fixtures from the API rather than hard-coding seed IDs, so growing from 2 blocks
to 22 broke nothing.

**Mutation testing** — deliberately breaking the code to prove the tests bite:

| Break | Result |
|---|---|
| make the cart wait additive again | 2 tests fail |
| drop the partial unique index | 1 test fails |
| let `ready` accept an unpaid cart | 1 test fails |
| weaken redeem to allow re-serving | 2 tests fail |
| restore the naive midnight comparison | 15 tests fail |

**A full browser run** through all three roles on every build: intro, door,
menu, cart, payment, ticket, hard reload, staff queue, ready, scan, second scan
refused, dashboard, reduced motion, and 320px width.

**Contrast measured, not eyeballed.** Every role and theme combination is
checked against WCAG AA; the worst is 4.85:1.

## 5. Bugs worth admitting to

Say these out loud if asked. They are better evidence of engineering than a
clean story would be.

**`CREATE UNIQUE INDEX IF NOT EXISTS` silently does nothing** when a non-unique
index of that name already exists. No error — and the single-use guarantee was
quietly switched off. We only found it by deliberately breaking the code and
noticing a test that *failed to fail*. The index now drops first and lives in
its own file that runs after the seed.

**Our own uniqueness test did not test uniqueness.** Issuing 25 random six-digit
codes and checking they differ passes whether or not the index exists — the odds
of a natural collision are tiny. Replaced with three deterministic tests
including a forced collision.

**An order was only findable from the phone that placed it.** Fixed by making
the server the source of truth (section 2).

**A hundred lines of `!important` fighting one missing variable.** The live
order strip was unreadable in dark mode, and got patched role-by-role with
escalating overrides. The real cause was a CSS variable with no default and no
dark value. Fixing it at the root deleted all hundred lines: the file went from
35 `!important` declarations to 2.

**The uploaded art could not ship as sent.** The icon sheet carried visible
Vecteezy watermarks; the food sheet contained a real Nestlé Maggi retail packet.
The three door icons are drawn as inline SVG instead, and the Maggi packet was
dropped.

## 6. Known limits — say these before a judge finds them

- The Razorpay webhook signature is not verified; confirmation is trusted from
  the client. Fine for a test-mode demo, not for production.
- Authentication is a typed registration number. Binding to the existing
  biometric hostel entry system is the intended next step.
- No rate limit on redeem attempts yet.
- The hash salt is the counter plus the date, both guessable. This stops casual
  database browsing; it is not password-grade.
- Cash carts are handed over against the queue number rather than a code,
  because the student already paid in person. Still a one-way transition.
- Menu names, prices and photos are plausible placeholders, not published mess
  data.

## 7. Running the demo

1. Set `DEMO_TIME=23:00` on **nightit-api** so the mess reads as open at any
   hour. Blank it for real use.
2. **Open the API URL once before you present.** Render's free tier sleeps and
   the first request after a quiet period takes about 30 seconds.
3. Clear the night's orders so you start from an empty queue:
   `POST /admin/reset` with the `x-reset-token` header.
4. Use a **private window**. The intro plays once per session; in your normal
   tab you will have already seen it and will think it is broken.
5. Have two windows ready: a student on one, `/staff` on the other.

**The run:** front door → a hostel → add two items (point out the wait is the
slowest dish, not the sum) → pay → the code and token appear → switch to staff
→ mark ready, the student screen turns green → scan the code, SERVED → scan it
again, ALREADY USED.

That last beat is the whole pitch in two seconds.
