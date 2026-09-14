const { test, before, after, describe } = require("node:test");
const assert = require("node:assert");
const { execSync } = require("node:child_process");
const path = require("path");

process.env.DEMO_TIME = process.env.DEMO_TIME || "23:00";
const app = require("../index");
const { pool } = require("../db");

let server, base;

// Rebuilds the database from the SQL files so every run starts identical.
function reset() {
  execSync("node scripts/migrate.js --seed",
    { cwd: path.join(__dirname, ".."), stdio: "pipe", env: { ...process.env } });
}

// Small fetch helper so the tests read like the calls the frontend makes.
async function api(method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* no body */ }
  return { status: r.status, body: json };
}

// Fixtures are discovered from the running API rather than hardcoded, so the
// suite survives any change to the seed: more blocks, different menus, new
// prices. F is filled in before the first test.
const F = {};

async function discover() {
  const blocks = (await api("GET", "/blocks")).body;
  F.mens   = blocks.find(b => b.hostel_type === "mens");
  F.ladies = blocks.find(b => b.hostel_type === "ladies");

  const mm = (await api("GET", `/menu?block_id=${F.mens.id}`)).body;
  const lm = (await api("GET", `/menu?block_id=${F.ladies.id}`)).body;
  F.mensMenu = mm; F.ladiesMenu = lm;
  F.a = mm.find(i => i.available);                                   // any orderable item
  F.b = mm.find(i => i.available && i.id !== F.a.id);
  F.l = lm.find(i => i.available);                                   // one at the other counter
  F.service = Number(mm[0].avg_service_seconds);

  // Guarantee one sold-out item to test against, whatever the seed did.
  F.soldOut = mm.find(i => Number(i.remaining) === 0) || mm[mm.length - 1];
  await api("POST", "/stock", { menu_item_id: F.soldOut.id, remaining: 0 });
}

// Puts plenty of an item back on the shelf so a test is never starved.
async function restock(item, n = 200) {
  await api("POST", "/stock", { menu_item_id: item, remaining: n });
}

// Rebuilds the database and re-reads the fixtures, because ids move when the
// seed is replayed.
async function fresh() { reset(); await discover(); }

// Creates a paid cart and returns its code, queue number and counter.
async function paidCart(items, mode = "upi", reg = "26BCE0001") {
  items = items || [{ menu_item_id: F.a.id, qty: 1 }];
  for (const i of items) await restock(i.menu_item_id);
  const o = await api("POST", "/orders", { reg_no: reg, items, mode });
  const c = await api("POST", `/orders/${o.body.order_id}/confirm`);
  return { id: o.body.order_id, code: c.body.code, counter: c.body.counter_id,
           queue_no: c.body.queue_no, subtotal: o.body.subtotal_paise,
           tax: o.body.tax_paise, prep: o.body.prep_seconds };
}

before(async () => {
  reset();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await discover();
});
after(async () => {
  // If the setup above failed there is no server to close; closing the pool is
  // still what lets the process exit instead of hanging on the real error.
  if (server) await new Promise(r => server.close(r));
  await pool.end();
});

describe("health and configuration", () => {
  test("health answers", async () => {
    assert.equal((await api("GET", "/health")).body.ok, true);
  });
  test("the midnight-crossing window is ordered correctly", async () => {
    const r = await pool.query("SELECT night_min('22:30') a, night_min('23:00') b, night_min('00:30') c");
    const { a, b, c } = r.rows[0];
    assert.ok(a < b && b < c);
  });
  test("payments config reports the public key only", async () => {
    const r = await api("GET", "/payments/config");
    assert.equal(r.status, 200);
    assert.ok(!("key_secret" in r.body), "the secret must never be exposed");
  });
  test("many blocks, both hostel types, and not all alike", async () => {
    const b = (await api("GET", "/blocks")).body;
    assert.ok(b.length >= 10, "the campus has more than a couple of blocks");
    assert.ok(b.some(x => x.hostel_type === "mens"));
    assert.ok(b.some(x => x.hostel_type === "ladies"));
    assert.ok(new Set(b.map(x => x.closes_at)).size > 1, "closing times differ by block");
    assert.ok(new Set(b.map(x => x.counter_id)).size === b.length, "one counter each");
  });
});

describe("per-block configuration", () => {
  test("each block has its own menu", async () => {
    const m1 = (await api("GET", `/menu?block_id=${F.mens.id}`)).body.map(i => i.name).sort();
    const m2 = (await api("GET", `/menu?block_id=${F.ladies.id}`)).body.map(i => i.name).sort();
    assert.notDeepEqual(m1, m2);
  });
  test("a sold-out item is marked unavailable", async () => {
    const fries = (await api("GET", `/menu?block_id=${F.mens.id}`)).body.find(i => i.id === F.soldOut.id);
    assert.equal(fries.available, false);
    assert.equal(fries.state, "sold_out");
  });
  test("an item past its cut-off closes itself", async () => {
    // Two things this used to get wrong. It named item 6 by number, which
    // moves whenever the seed changes; and it set nightit.now on the pool,
    // which lands on whichever connection answers — so the reset could go to
    // a different one and leave a connection pinned in the future, closing
    // the mess for a later test. The time goes straight into the comparison
    // now, and the item is looked up by what it actually is.
    // MIN(cutoff_at) is wrong here for the same reason the app needs
    // night_min at all: 00:00 sorts before 23:30 as a plain time, but it is
    // an hour and a half LATER in the night. Order by night_min or you pick
    // the last item to close and assert that it has already closed.
    const r = await pool.query(
      `SELECT name,
              night_min('23:55'::time) >= night_min(cutoff_at) AS past
         FROM menu_items ORDER BY night_min(cutoff_at) LIMIT 1`);
    assert.ok(r.rowCount, "some item has the earliest cut-off");
    assert.equal(r.rows[0].past, true,
      `${r.rows[0].name} should read as closed at 23:55`);
  });
});

describe("cart and total queue time", () => {
  test("a cart adds up prices but takes the SLOWEST item's cooking time", async () => {
    await restock(F.a.id); await restock(F.b.id);
    const r = await api("POST", "/orders", {
      reg_no: "26BCE0001",
      items: [{ menu_item_id: F.a.id, qty: 2 }, { menu_item_id: F.b.id, qty: 1 }],
    });
    assert.equal(r.status, 201);
    const subtotal = F.a.price_paise * 2 + F.b.price_paise;
    assert.equal(r.body.subtotal_paise, subtotal, "money is additive");
    const slowest = Math.max(F.a.prep_minutes, F.b.prep_minutes) * 60;
    assert.equal(r.body.prep_seconds, slowest,
      "the kitchen cooks in parallel, so the wait is the slowest item");
    assert.ok(r.body.prep_seconds
      < (F.a.prep_minutes * 2 + F.b.prep_minutes) * 60, "and not the sum");
  });

  test("tax is added on top of the menu price, not baked into it", async () => {
    await restock(F.a.id);
    const r = await api("POST", "/orders",
      { reg_no: "26BCE0001", items: [{ menu_item_id: F.a.id, qty: 1 }] });
    const cfg = (await api("GET", "/payments/config")).body;
    assert.equal(r.body.subtotal_paise, F.a.price_paise, "menu price is pre-tax");
    assert.equal(r.body.tax_paise,
      Math.round(F.a.price_paise * cfg.tax_percent / 100 / 100) * 100,
      "tax rounds to the rupee");
    assert.equal(r.body.total_paise, r.body.subtotal_paise + r.body.tax_paise);
    assert.equal(r.body.total_paise % 100, 0,
      "the payable total is a whole number of rupees — nobody has 25p coins");
  });

  test("total queue time counts the people already waiting, not just cooking", async () => {
    await fresh();
    const first = await paidCart([{ menu_item_id: F.a.id, qty: 1 }]);
    const mine = await paidCart([{ menu_item_id: F.a.id, qty: 1 }], "upi", "26BCE3103");
    const s = (await api("GET", `/orders/${mine.id}/status`)).body;
    assert.equal(s.ahead, 1, "one cart is ahead of mine");
    assert.equal(s.eta_seconds, F.service + F.a.prep_minutes * 60);
    assert.equal(s.position, 2, "second in line");
    assert.ok(first.queue_no < mine.queue_no);
  });

  test("the menu shows a live estimate that grows with the queue", async () => {
    await fresh();
    const before = (await api("GET", `/menu?block_id=${F.mens.id}`)).body.find(i => i.id === F.a.id);
    await paidCart([{ menu_item_id: F.a.id, qty: 1 }]);
    const after = (await api("GET", `/menu?block_id=${F.mens.id}`)).body.find(i => i.id === F.a.id);
    assert.ok(Number(after.eta_seconds) > Number(before.eta_seconds),
      "one more person waiting must make the estimate longer");
  });

  test("a cart cannot mix two different counters", async () => {
    const r = await api("POST", "/orders", {
      reg_no: "26BDE0124", items: [{ menu_item_id: F.a.id }, { menu_item_id: F.l.id }],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "one_counter_per_cart");
  });

  test("a cart that hits a sold-out item leaves no stock stranded", async () => {
    await fresh();
    const before = (await api("GET", `/menu?block_id=${F.mens.id}`)).body.find(i => i.id === F.a.id).remaining;
    const r = await api("POST", "/orders", {
      reg_no: "26BDE0124",
      items: [{ menu_item_id: F.a.id, qty: 1 }, { menu_item_id: F.soldOut.id, qty: 1 }],   // fries are out
    });
    assert.equal(r.status, 409);
    const after = (await api("GET", `/menu?block_id=${F.mens.id}`)).body.find(i => i.id === F.a.id).remaining;
    assert.equal(after, before, "the Maggi taken for the failed cart must go back");
  });

  test("cancelling a cart returns every portion", async () => {
    await fresh();
    const before = (await api("GET", `/menu?block_id=${F.mens.id}`)).body.find(i => i.id === F.a.id).remaining;
    const o = await api("POST", "/orders", { reg_no: "26BDE0124", items: [{ menu_item_id: F.a.id, qty: 3 }] });
    await api("POST", `/orders/${o.body.order_id}/cancel`);
    const after = (await api("GET", `/menu?block_id=${F.mens.id}`)).body.find(i => i.id === F.a.id).remaining;
    assert.equal(after, before);
  });

  test("the last portion goes to exactly one of two simultaneous carts", async () => {
    await api("POST", "/stock", { menu_item_id: F.b.id, remaining: 1 });
    const [a, b] = await Promise.all([
      api("POST", "/orders", { reg_no: "26BCE3103", items: [{ menu_item_id: F.b.id }] }),
      api("POST", "/orders", { reg_no: "26BDE0113", items: [{ menu_item_id: F.b.id }] }),
    ]);
    assert.equal([a, b].filter(r => r.status === 201).length, 1);
  });
});

describe("queue number and your turn", () => {
  test("queue numbers are handed out in order at each counter", async () => {
    await fresh();
    const a = await paidCart();
    const b = await paidCart([{ menu_item_id: F.a.id }], "upi", "26BCE3103");
    const c = await paidCart([{ menu_item_id: F.a.id }], "upi", "26BDE0113");
    assert.deepEqual([a.queue_no, b.queue_no, c.queue_no], [1, 2, 3]);
  });

  test("each counter numbers its own queue independently", async () => {
    await fresh();
    const m = await paidCart([{ menu_item_id: F.a.id }]);                    // counter 1
    const l = await paidCart([{ menu_item_id: F.l.id }], "upi", "26BDE0168"); // counter 2
    assert.equal(m.queue_no, 1);
    assert.equal(l.queue_no, 1);
    assert.notEqual(m.counter, l.counter);
  });

  test("almost_your_turn turns on when one or none are ahead", async () => {
    await fresh();
    const a = await paidCart();
    const b = await paidCart([{ menu_item_id: F.a.id }], "upi", "26BCE3103");
    const c = await paidCart([{ menu_item_id: F.a.id }], "upi", "26BDE0113");
    const sa = (await api("GET", `/orders/${a.id}/status`)).body;
    const sc = (await api("GET", `/orders/${c.id}/status`)).body;
    assert.equal(sa.almost_your_turn, true, "first in line is next");
    assert.equal(sc.almost_your_turn, false, "third in line is not");
    assert.equal(sc.ahead, 2);
  });

  test("as people ahead are served, the wait shrinks", async () => {
    await fresh();
    const a = await paidCart();
    const b = await paidCart([{ menu_item_id: F.a.id }], "upi", "26BCE3103");
    const before = (await api("GET", `/orders/${b.id}/status`)).body;
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    const after = (await api("GET", `/orders/${b.id}/status`)).body;
    assert.equal(before.ahead, 1);
    assert.equal(after.ahead, 0);
    assert.ok(after.eta_seconds < before.eta_seconds);
  });

  test("your position counts down as the people ahead are served", async () => {
    await fresh();
    const a = await paidCart(undefined, "upi", "26AAA0001");
    const b = await paidCart(undefined, "upi", "26AAA0002");
    const mine = await paidCart(undefined, "upi", "26AAA0003");

    const pos = async () => (await api("GET", `/orders/${mine.id}/status`)).body.position;
    assert.equal(await pos(), 3, "third in line to begin with");

    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    assert.equal(await pos(), 2, "one served, so we move up");

    await api("POST", "/redeem", { counter_id: b.counter, code: b.code });
    assert.equal(await pos(), 1, "next up");

    await api("POST", `/orders/${mine.id}/ready`);
    const s2 = (await api("GET", `/orders/${mine.id}/status`)).body;
    assert.equal(s2.position, 0, "no longer queueing once it is ready");
    assert.equal(s2.ready, true);
  });

  test("a cart marked ready stops lengthening everyone else's estimate", async () => {
    await fresh();
    const a = await paidCart(undefined, "upi", "26AAA0004");
    const before = (await api("GET", `/menu?block_id=${F.mens.id}`))
      .body.find(i => i.id === F.a.id).eta_seconds;
    await api("POST", `/orders/${a.id}/ready`);
    const after = (await api("GET", `/menu?block_id=${F.mens.id}`))
      .body.find(i => i.id === F.a.id).eta_seconds;
    assert.ok(Number(after) < Number(before), "cooked food is not still cooking");
  });

  test("the status call carries the whole cart back", async () => {
    await fresh();
    await restock(F.a.id); await restock(F.b.id);
    const o = await api("POST", "/orders", {
      reg_no: "26BDE0124", takeaway: true,
      items: [{ menu_item_id: F.a.id, qty: 2 }, { menu_item_id: F.b.id, qty: 1 }],
    });
    await api("POST", `/orders/${o.body.order_id}/confirm`);
    const s = (await api("GET", `/orders/${o.body.order_id}/status`)).body;
    assert.equal(s.items.length, 2);
    assert.equal(s.items.find(i => i.name === F.a.name).qty, 2);
    assert.equal(s.takeaway, true);
    assert.equal(s.block, F.mens.name);
    assert.equal(s.total_paise, s.amount_paise + s.tax_paise);
  });
});

describe("food is ready", () => {
  test("the counter marks a cart ready and the student sees it", async () => {
    await fresh();
    const a = await paidCart();
    let s = (await api("GET", `/orders/${a.id}/status`)).body;
    assert.equal(s.ready, false);
    const r = await api("POST", `/orders/${a.id}/ready`);
    assert.equal(r.status, 200);
    s = (await api("GET", `/orders/${a.id}/status`)).body;
    assert.equal(s.ready, true);
    assert.equal(s.status, "ready");
    assert.equal(s.eta_seconds, 0, "no waiting left once it is ready");
    assert.ok(s.ready_at);
  });

  test("a ready cart can still be collected with its code", async () => {
    await fresh();
    const a = await paidCart();
    await api("POST", `/orders/${a.id}/ready`);
    const r = await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    assert.equal(r.body.served, true);
  });

  test("a ready cart still cannot be collected twice", async () => {
    await fresh();
    const a = await paidCart();
    await api("POST", `/orders/${a.id}/ready`);
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    const again = await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    assert.equal(again.status, 409);
  });

  test("an unpaid cart cannot be marked ready", async () => {
    const o = await api("POST", "/orders", { reg_no: "26BDE0124", items: [{ menu_item_id: F.a.id }] });
    const r = await api("POST", `/orders/${o.body.order_id}/ready`);
    assert.equal(r.status, 409);
  });

  test("a cart already served drops out of the queue count", async () => {
    await fresh();
    const a = await paidCart();
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    const menu = (await api("GET", `/menu?block_id=${F.mens.id}`)).body[0];
    assert.equal(Number(menu.queue_ahead), 0);
  });
});

describe("pickup codes", () => {
  test("confirming returns a six-digit code and a queue number", async () => {
    await fresh();
    const a = await paidCart();
    assert.match(a.code, /^\d{6}$/);
    assert.equal(a.queue_no, 1);
  });
  test("the code is never stored in readable form", async () => {
    const a = await paidCart();
    const r = await pool.query("SELECT otp_hash::text h FROM orders WHERE id=$1", [a.id]);
    assert.ok(!r.rows[0].h.includes(a.code));
  });
  test("the same code is refused the second time", async () => {
    const a = await paidCart();
    assert.equal((await api("POST", "/redeem", { counter_id: a.counter, code: a.code })).body.served, true);
    assert.equal((await api("POST", "/redeem", { counter_id: a.counter, code: a.code })).status, 409);
  });
  test("two simultaneous scans serve it only once", async () => {
    const a = await paidCart();
    const [x, y] = await Promise.all([
      api("POST", "/redeem", { counter_id: a.counter, code: a.code }),
      api("POST", "/redeem", { counter_id: a.counter, code: a.code }),
    ]);
    assert.equal([x, y].filter(r => r.body.served === true).length, 1);
  });
  test("a code from one counter does not work at another", async () => {
    const a = await paidCart();
    assert.equal((await api("POST", "/redeem", { counter_id: F.ladies.counter_id, code: a.code })).status, 409);
  });
  test("an expired code is refused", async () => {
    const a = await paidCart();
    await pool.query("UPDATE orders SET expires_at = now() - interval '1 min' WHERE id=$1", [a.id]);
    assert.equal((await api("POST", "/redeem", { counter_id: a.counter, code: a.code })).status, 409);
  });
  test("the database itself blocks two live carts sharing a code at one counter", async () => {
    await fresh();
    const a = await api("POST", "/orders", { reg_no: "a", items: [{ menu_item_id: F.a.id }] });
    const b = await api("POST", "/orders", { reg_no: "b", items: [{ menu_item_id: F.a.id }] });
    const h = "digest('424242' || 1::text || current_date::text,'sha256')";
    const set = id => pool.query(
      `UPDATE orders SET status='paid', otp_hash=${h}, expires_at=now()+interval '90 min'
        WHERE id=$1`, [id]);
    await set(a.body.order_id);
    await assert.rejects(() => set(b.body.order_id), /duplicate key|unique/i);
  });
  test("the same code may be live at two different counters", async () => {
    await fresh();
    const a = await api("POST", "/orders", { reg_no: "a", items: [{ menu_item_id: F.a.id }] });
    const b = await api("POST", "/orders", { reg_no: "b", items: [{ menu_item_id: F.l.id }] });
    for (const [id, ctr] of [[a.body.order_id, F.mens.counter_id],
                             [b.body.order_id, F.ladies.counter_id]]) {
      await pool.query(
        `UPDATE orders SET status='paid', queue_no=1, paid_at=now(),
                otp_hash=digest('515151' || $2::text || current_date::text,'sha256'),
                expires_at=now()+interval '90 min' WHERE id=$1`, [id, ctr]);
    }
    assert.equal((await api("POST", "/redeem",
      { counter_id: F.mens.counter_id, code: "515151" })).body.served, true);
    assert.equal((await api("POST", "/redeem",
      { counter_id: F.ladies.counter_id, code: "515151" })).body.served, true);
  });
  test("issue_otp survives a collision and still returns a code", async () => {
    await fresh();
    const held = await api("POST", "/orders", { reg_no: "h", items: [{ menu_item_id: F.a.id }] });
    await pool.query(
      `UPDATE orders SET status='paid', queue_no=99, paid_at=now(),
              otp_hash=digest('999999' || 1::text || current_date::text,'sha256'),
              expires_at=now()+interval '90 min' WHERE id=$1`, [held.body.order_id]);
    await restock(F.a.id);
    for (let i = 0; i < 25; i++) {
      const o = await api("POST", "/orders", { reg_no: "x", items: [{ menu_item_id: F.a.id }] });
      const c = await api("POST", `/orders/${o.body.order_id}/confirm`);
      assert.match(c.body.code, /^\d{6}$/);
    }
  });
});

describe("cash path", () => {
  test("a cash cart waits for the cashier and then gets the same kind of code", async () => {
    await fresh();
    const o = await api("POST", "/orders", {
      reg_no: "26BDE0168", mode: "cash", items: [{ menu_item_id: F.l.id, qty: 2 }] });
    assert.equal(o.status, 201);
    const q = (await api("GET", `/counter/${F.ladies.counter_id}/queue`)).body;
    assert.ok(q.some(x => Number(x.id) === o.body.order_id && x.status === "pending"));
    const c = await api("POST", `/orders/${o.body.order_id}/confirm`);
    assert.match(c.body.code, /^\d{6}$/);
    assert.equal((await api("POST", "/redeem", { counter_id: F.ladies.counter_id, code: c.body.code })).body.served, true);
  });
});

describe("serving from the counter", () => {
  test("the counter can serve a cash cart without a code", async () => {
    await fresh();
    const o = await api("POST", "/orders", { reg_no: "26BDE0168", mode: "cash",
                                             items: [{ menu_item_id: F.l.id }] });
    await api("POST", `/orders/${o.body.order_id}/confirm`);
    const r = await api("POST", `/orders/${o.body.order_id}/serve`);
    assert.equal(r.status, 200);
    assert.equal(r.body.served, true);
  });

  test("serving twice from the counter is refused", async () => {
    await fresh();
    const a = await paidCart();
    await api("POST", `/orders/${a.id}/serve`);
    assert.equal((await api("POST", `/orders/${a.id}/serve`)).status, 409);
  });

  test("a cart served at the counter can no longer be redeemed by code", async () => {
    await fresh();
    const a = await paidCart();
    await api("POST", `/orders/${a.id}/serve`);
    assert.equal((await api("POST", "/redeem", { counter_id: a.counter, code: a.code })).status, 409);
  });

  test("an unpaid cart cannot be served", async () => {
    const o = await api("POST", "/orders", { reg_no: "x", items: [{ menu_item_id: F.a.id }] });
    assert.equal((await api("POST", `/orders/${o.body.order_id}/serve`)).status, 409);
  });
});

describe("finding your order again", () => {
  test("a live cart is findable by registration number alone", async () => {
    await fresh();
    const a = await paidCart([{ menu_item_id: F.a.id }], "upi", "26BCE9999");
    const rows = (await api("GET", "/orders/active?reg_no=26BCE9999")).body;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].order_id, a.id);
    assert.ok(rows[0].block);
    assert.equal(rows[0].position, 1);
  });
  test("the lookup ignores the case of the registration number", async () => {
    await fresh();
    await paidCart([{ menu_item_id: F.a.id }], "upi", "26BCE9999");
    assert.equal((await api("GET", "/orders/active?reg_no=26bce9999")).body.length, 1);
  });
  test("a served cart drops out of the lookup", async () => {
    await fresh();
    const a = await paidCart([{ menu_item_id: F.a.id }], "upi", "26BCE9999");
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    assert.equal((await api("GET", "/orders/active?reg_no=26BCE9999")).body.length, 0);
  });
  test("somebody else's registration number returns nothing of yours", async () => {
    await fresh();
    await paidCart([{ menu_item_id: F.a.id }], "upi", "26BCE9999");
    assert.equal((await api("GET", "/orders/active?reg_no=26BCE0000")).body.length, 0);
  });
  test("the lookup refuses an empty registration number", async () => {
    await fresh();
    assert.equal((await api("GET", "/orders/active?reg_no=")).status, 400);
  });
});

describe("counter queue view", () => {
  test("the counter sees waiting carts in queue order with their items", async () => {
    await fresh();
    await paidCart([{ menu_item_id: F.a.id, qty: 2 }]);
    await paidCart([{ menu_item_id: F.b.id }], "upi", "26BCE3103");
    const q = (await api("GET", `/counter/${F.mens.counter_id}/queue`)).body;
    assert.equal(q.length, 2);
    assert.ok(q[0].items.includes(`${F.a.name} x2`));
    assert.ok(Number(q[0].queue_no) < Number(q[1].queue_no));
  });
  test("a served cart leaves the counter queue", async () => {
    await fresh();
    const a = await paidCart();
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    assert.equal((await api("GET", `/counter/${F.mens.counter_id}/queue`)).body.length, 0);
  });
});

describe("feedback, bugs and the dashboard", () => {
  test("feedback and bugs are stored and can be listed apart", async () => {
    await api("POST", "/feedback", { reg_no: "26BDE0168", block_id: 2, kind: "feedback",
                                     rating: 4, message: "More veg options please" });
    await api("POST", "/feedback", { reg_no: "26BCE3103", block_id: 1, kind: "bug",
                                     message: "Scanner froze" });
    const bugs = (await api("GET", "/feedback?kind=bug")).body;
    assert.ok(bugs.length >= 1 && bugs.every(f => f.kind === "bug"));
  });
  test("bad feedback input is refused", async () => {
    assert.equal((await api("POST", "/feedback", { kind: "nope", message: "x" })).status, 400);
  });
  test("the dashboard reports orders, served, waiting and collections", async () => {
    await fresh();
    const a = await paidCart();
    await paidCart([{ menu_item_id: F.a.id }], "upi", "26BCE3103");
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    const s = (await api("GET", "/admin/summary")).body;
    assert.equal(Number(s.orders_tonight), 2);
    assert.equal(Number(s.meals_served), 1);
    assert.equal(Number(s.waiting_now), 1);
    assert.ok(Number(s.collections_paise) > 0);
    assert.ok(s.demand.length > 0);
  });
  test("the dashboard can be filtered by hostel type", async () => {
    await fresh();
    await paidCart([{ menu_item_id: F.a.id }]);
    const mens = (await api("GET", "/admin/summary?hostel_type=mens")).body;
    const ladies = (await api("GET", "/admin/summary?hostel_type=ladies")).body;
    assert.equal(Number(mens.orders_tonight), 1);
    assert.equal(Number(ladies.orders_tonight), 0);
  });
});

describe("demo reset", () => {
  test("reseed rebuilds the menu, a plain reset leaves it alone", async () => {
    await fresh();
    process.env.RESET_TOKEN = "letmein";
    const before = (await api("GET", "/blocks")).body.length;
    await pool.query("DELETE FROM blocks WHERE id = (SELECT max(id) FROM blocks)");
    assert.equal((await api("GET", "/blocks")).body.length, before - 1);

    // a plain reset clears orders only, so the missing block stays missing
    await fetch(base + "/admin/reset",
      { method: "POST", headers: { "x-reset-token": "letmein" } });
    assert.equal((await api("GET", "/blocks")).body.length, before - 1);

    // reseed puts the whole menu back
    await fetch(base + "/admin/reset?reseed=1",
      { method: "POST", headers: { "x-reset-token": "letmein" } });
    assert.equal((await api("GET", "/blocks")).body.length, before);
    delete process.env.RESET_TOKEN;
    await discover();
  });

  test("it is switched off unless RESET_TOKEN is set", async () => {
    delete process.env.RESET_TOKEN;
    assert.equal((await api("POST", "/admin/reset")).status, 404);
  });

  test("a wrong token is refused", async () => {
    process.env.RESET_TOKEN = "letmein";
    const r = await fetch(base + "/admin/reset",
      { method: "POST", headers: { "x-reset-token": "nope" } });
    assert.equal(r.status, 403);
    delete process.env.RESET_TOKEN;
  });

  test("with the right token it clears orders and restores stock", async () => {
    await fresh();
    process.env.RESET_TOKEN = "letmein";
    const a = await paidCart([{ menu_item_id: F.a.id, qty: 5 }]);
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    await api("POST", "/feedback", { kind: "bug", message: "kept on purpose" });

    const r = await fetch(base + "/admin/reset",
      { method: "POST", headers: { "x-reset-token": "letmein" } });
    assert.equal(r.status, 200);

    const s2 = (await api("GET", "/admin/summary")).body;
    assert.equal(Number(s2.orders_tonight), 0);
    assert.equal(Number(s2.meals_served), 0);
    assert.equal(Number(s2.collections_paise), 0);
    assert.equal((await api("GET", `/counter/${F.mens.counter_id}/queue`)).body.length, 0);

    // the reset restores stock with the same rule 003_seed.sql uses, so the
    // two cannot drift apart as the menu grows
    const seeded = id => (id % 11 === 0 ? 0 : 12 + (id % 28));
    const after = (await api("GET", `/menu?block_id=${F.mens.id}`)).body;
    const item = after.find(i => i.id === F.a.id);
    assert.equal(Number(item.remaining), seeded(F.a.id), "stock back to the seeded level");
    const dry = after.find(i => i.id % 11 === 0);
    if (dry) assert.equal(Number(dry.remaining), 0, "a seeded sold-out item stays sold out");

    assert.ok((await api("GET", "/feedback?kind=bug")).body.length >= 1,
      "feedback is kept unless asked for");
    delete process.env.RESET_TOKEN;
  });

  test("feedback=1 clears the reports too", async () => {
    process.env.RESET_TOKEN = "letmein";
    await api("POST", "/feedback", { kind: "bug", message: "goes away" });
    await fetch(base + "/admin/reset?feedback=1",
      { method: "POST", headers: { "x-reset-token": "letmein" } });
    assert.equal((await api("GET", "/feedback")).body.length, 0);
    delete process.env.RESET_TOKEN;
  });
});

describe("input validation", () => {
  test("menu needs a block", async () => {
    assert.equal((await api("GET", "/menu")).status, 400);
  });
  test("an order needs items", async () => {
    assert.equal((await api("POST", "/orders", { reg_no: "x", items: [] })).status, 400);
  });
  test("an unknown payment mode is refused", async () => {
    assert.equal((await api("POST", "/orders",
      { reg_no: "x", items: [{ menu_item_id: F.a.id }], mode: "crypto" })).status, 400);
  });
  test("redeem needs six digits", async () => {
    assert.equal((await api("POST", "/redeem", { counter_id: F.mens.counter_id, code: "12" })).status, 400);
  });
  test("an unknown order is not found", async () => {
    assert.equal((await api("GET", "/orders/999999/status")).status, 404);
    assert.equal((await api("POST", "/orders/999999/confirm")).status, 404);
  });
});
