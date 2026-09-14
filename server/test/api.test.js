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

// Puts plenty of an item back on the shelf so a test is never starved.
async function restock(item, n = 200) { await api("POST", "/stock", { menu_item_id: item, remaining: n }); }

// Creates a paid cart and returns its code, queue number and counter.
async function paidCart(items = [{ menu_item_id: 1, qty: 1 }], mode = "upi", reg = "26BDE0124") {
  for (const i of items) await restock(i.menu_item_id);
  const o = await api("POST", "/orders", { reg_no: reg, items, mode });
  const c = await api("POST", `/orders/${o.body.order_id}/confirm`);
  return { id: o.body.order_id, code: c.body.code, counter: c.body.counter_id,
           queue_no: c.body.queue_no, amount: o.body.amount_paise, prep: o.body.prep_seconds };
}

before(async () => {
  reset();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
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
  test("two blocks with different closing times", async () => {
    const b = (await api("GET", "/blocks")).body;
    assert.equal(b.length, 2);
    assert.notEqual(b[0].closes_at, b[1].closes_at);
  });
});

describe("per-block configuration", () => {
  test("each block has its own menu", async () => {
    const m1 = (await api("GET", "/menu?block_id=1")).body.map(i => i.name).sort();
    const m2 = (await api("GET", "/menu?block_id=2")).body.map(i => i.name).sort();
    assert.notDeepEqual(m1, m2);
  });
  test("a sold-out item is marked unavailable", async () => {
    const fries = (await api("GET", "/menu?block_id=1")).body.find(i => i.name === "French fries");
    assert.equal(fries.available, false);
    assert.equal(fries.state, "sold_out");
  });
  test("an item past its cut-off closes itself", async () => {
    await pool.query("SET nightit.now = '23:55'");
    const r = await pool.query(
      "SELECT night_min(night_now()) >= night_min(cutoff_at) AS past FROM menu_items WHERE id = 6");
    assert.equal(r.rows[0].past, true);
    await pool.query("SET nightit.now = '23:00'");
  });
});

describe("cart and total queue time", () => {
  test("a cart with several items sums price and preparation time", async () => {
    await restock(1); await restock(4);
    const r = await api("POST", "/orders", {
      reg_no: "26BDE0124",
      items: [{ menu_item_id: 1, qty: 2 }, { menu_item_id: 4, qty: 1 }],
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.amount_paise, 4000 * 2 + 5000);          // 2 Maggi + 1 coffee
    assert.equal(r.body.prep_seconds, 6 * 60 * 2 + 4 * 60);      // 12 min + 4 min
  });

  test("total queue time counts the people already waiting, not just cooking", async () => {
    reset();
    const first = await paidCart([{ menu_item_id: 1, qty: 1 }]);
    const mine = await paidCart([{ menu_item_id: 1, qty: 1 }], "upi", "26BCE3103");
    const s = (await api("GET", `/orders/${mine.id}/status`)).body;
    assert.equal(s.ahead, 1, "one cart is ahead of mine");
    // 1 ahead x 95s service + my own 6 min of cooking
    assert.equal(s.eta_seconds, 1 * 95 + 6 * 60);
    assert.ok(first.queue_no < mine.queue_no);
  });

  test("the menu shows a live estimate that grows with the queue", async () => {
    reset();
    const before = (await api("GET", "/menu?block_id=1")).body.find(i => i.id === 1);
    await paidCart([{ menu_item_id: 1, qty: 1 }]);
    const after = (await api("GET", "/menu?block_id=1")).body.find(i => i.id === 1);
    assert.ok(Number(after.eta_seconds) > Number(before.eta_seconds),
      "one more person waiting must make the estimate longer");
  });

  test("a cart cannot mix two different counters", async () => {
    const r = await api("POST", "/orders", {
      reg_no: "26BDE0124", items: [{ menu_item_id: 1 }, { menu_item_id: 5 }],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "one_counter_per_cart");
  });

  test("a cart that hits a sold-out item leaves no stock stranded", async () => {
    reset();
    const before = (await api("GET", "/menu?block_id=1")).body.find(i => i.id === 1).remaining;
    const r = await api("POST", "/orders", {
      reg_no: "26BDE0124",
      items: [{ menu_item_id: 1, qty: 1 }, { menu_item_id: 2, qty: 1 }],   // fries are out
    });
    assert.equal(r.status, 409);
    const after = (await api("GET", "/menu?block_id=1")).body.find(i => i.id === 1).remaining;
    assert.equal(after, before, "the Maggi taken for the failed cart must go back");
  });

  test("cancelling a cart returns every portion", async () => {
    reset();
    const before = (await api("GET", "/menu?block_id=1")).body.find(i => i.id === 1).remaining;
    const o = await api("POST", "/orders", { reg_no: "26BDE0124", items: [{ menu_item_id: 1, qty: 3 }] });
    await api("POST", `/orders/${o.body.order_id}/cancel`);
    const after = (await api("GET", "/menu?block_id=1")).body.find(i => i.id === 1).remaining;
    assert.equal(after, before);
  });

  test("the last portion goes to exactly one of two simultaneous carts", async () => {
    await api("POST", "/stock", { menu_item_id: 3, remaining: 1 });
    const [a, b] = await Promise.all([
      api("POST", "/orders", { reg_no: "26BCE3103", items: [{ menu_item_id: 3 }] }),
      api("POST", "/orders", { reg_no: "26BDE0113", items: [{ menu_item_id: 3 }] }),
    ]);
    assert.equal([a, b].filter(r => r.status === 201).length, 1);
  });
});

describe("queue number and your turn", () => {
  test("queue numbers are handed out in order at each counter", async () => {
    reset();
    const a = await paidCart();
    const b = await paidCart([{ menu_item_id: 1 }], "upi", "26BCE3103");
    const c = await paidCart([{ menu_item_id: 1 }], "upi", "26BDE0113");
    assert.deepEqual([a.queue_no, b.queue_no, c.queue_no], [1, 2, 3]);
  });

  test("each counter numbers its own queue independently", async () => {
    reset();
    const m = await paidCart([{ menu_item_id: 1 }]);                    // counter 1
    const l = await paidCart([{ menu_item_id: 5 }], "upi", "26BDE0168"); // counter 2
    assert.equal(m.queue_no, 1);
    assert.equal(l.queue_no, 1);
    assert.notEqual(m.counter, l.counter);
  });

  test("almost_your_turn turns on when one or none are ahead", async () => {
    reset();
    const a = await paidCart();
    const b = await paidCart([{ menu_item_id: 1 }], "upi", "26BCE3103");
    const c = await paidCart([{ menu_item_id: 1 }], "upi", "26BDE0113");
    const sa = (await api("GET", `/orders/${a.id}/status`)).body;
    const sc = (await api("GET", `/orders/${c.id}/status`)).body;
    assert.equal(sa.almost_your_turn, true, "first in line is next");
    assert.equal(sc.almost_your_turn, false, "third in line is not");
    assert.equal(sc.ahead, 2);
  });

  test("as people ahead are served, the wait shrinks", async () => {
    reset();
    const a = await paidCart();
    const b = await paidCart([{ menu_item_id: 1 }], "upi", "26BCE3103");
    const before = (await api("GET", `/orders/${b.id}/status`)).body;
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    const after = (await api("GET", `/orders/${b.id}/status`)).body;
    assert.equal(before.ahead, 1);
    assert.equal(after.ahead, 0);
    assert.ok(after.eta_seconds < before.eta_seconds);
  });

  test("the status call carries the whole cart back", async () => {
    reset();
    await restock(1); await restock(4);
    const o = await api("POST", "/orders", {
      reg_no: "26BDE0124", parcel: true,
      items: [{ menu_item_id: 1, qty: 2 }, { menu_item_id: 4, qty: 1 }],
    });
    await api("POST", `/orders/${o.body.order_id}/confirm`);
    const s = (await api("GET", `/orders/${o.body.order_id}/status`)).body;
    assert.equal(s.items.length, 2);
    assert.equal(s.items.find(i => i.name === "Maggi").qty, 2);
    assert.equal(s.parcel, true);
    assert.equal(s.block, "M-Block");
  });
});

describe("food is ready", () => {
  test("the counter marks a cart ready and the student sees it", async () => {
    reset();
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
    reset();
    const a = await paidCart();
    await api("POST", `/orders/${a.id}/ready`);
    const r = await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    assert.equal(r.body.served, true);
  });

  test("a ready cart still cannot be collected twice", async () => {
    reset();
    const a = await paidCart();
    await api("POST", `/orders/${a.id}/ready`);
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    const again = await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    assert.equal(again.status, 409);
  });

  test("an unpaid cart cannot be marked ready", async () => {
    const o = await api("POST", "/orders", { reg_no: "26BDE0124", items: [{ menu_item_id: 1 }] });
    const r = await api("POST", `/orders/${o.body.order_id}/ready`);
    assert.equal(r.status, 409);
  });

  test("a cart already served drops out of the queue count", async () => {
    reset();
    const a = await paidCart();
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    const menu = (await api("GET", "/menu?block_id=1")).body[0];
    assert.equal(Number(menu.queue_ahead), 0);
  });
});

describe("pickup codes", () => {
  test("confirming returns a six-digit code and a queue number", async () => {
    reset();
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
    assert.equal((await api("POST", "/redeem", { counter_id: 2, code: a.code })).status, 409);
  });
  test("an expired code is refused", async () => {
    const a = await paidCart();
    await pool.query("UPDATE orders SET expires_at = now() - interval '1 min' WHERE id=$1", [a.id]);
    assert.equal((await api("POST", "/redeem", { counter_id: a.counter, code: a.code })).status, 409);
  });
  test("the database itself blocks two live carts sharing a code at one counter", async () => {
    reset();
    const a = await api("POST", "/orders", { reg_no: "a", items: [{ menu_item_id: 1 }] });
    const b = await api("POST", "/orders", { reg_no: "b", items: [{ menu_item_id: 1 }] });
    const h = "digest('424242' || 1::text || current_date::text,'sha256')";
    const set = id => pool.query(
      `UPDATE orders SET status='paid', otp_hash=${h}, expires_at=now()+interval '90 min'
        WHERE id=$1`, [id]);
    await set(a.body.order_id);
    await assert.rejects(() => set(b.body.order_id), /duplicate key|unique/i);
  });
  test("the same code may be live at two different counters", async () => {
    reset();
    const a = await api("POST", "/orders", { reg_no: "a", items: [{ menu_item_id: 1 }] });
    const b = await api("POST", "/orders", { reg_no: "b", items: [{ menu_item_id: 5 }] });
    for (const [id, ctr] of [[a.body.order_id, 1], [b.body.order_id, 2]]) {
      await pool.query(
        `UPDATE orders SET status='paid', queue_no=1, paid_at=now(),
                otp_hash=digest('515151' || $2::text || current_date::text,'sha256'),
                expires_at=now()+interval '90 min' WHERE id=$1`, [id, ctr]);
    }
    assert.equal((await api("POST", "/redeem", { counter_id: 1, code: "515151" })).body.served, true);
    assert.equal((await api("POST", "/redeem", { counter_id: 2, code: "515151" })).body.served, true);
  });
  test("issue_otp survives a collision and still returns a code", async () => {
    reset();
    const held = await api("POST", "/orders", { reg_no: "h", items: [{ menu_item_id: 1 }] });
    await pool.query(
      `UPDATE orders SET status='paid', queue_no=99, paid_at=now(),
              otp_hash=digest('999999' || 1::text || current_date::text,'sha256'),
              expires_at=now()+interval '90 min' WHERE id=$1`, [held.body.order_id]);
    await restock(1);
    for (let i = 0; i < 25; i++) {
      const o = await api("POST", "/orders", { reg_no: "x", items: [{ menu_item_id: 1 }] });
      const c = await api("POST", `/orders/${o.body.order_id}/confirm`);
      assert.match(c.body.code, /^\d{6}$/);
    }
  });
});

describe("cash path", () => {
  test("a cash cart waits for the cashier and then gets the same kind of code", async () => {
    reset();
    const o = await api("POST", "/orders", {
      reg_no: "26BDE0168", mode: "cash", items: [{ menu_item_id: 5, qty: 2 }] });
    assert.equal(o.status, 201);
    const q = (await api("GET", "/counter/2/queue")).body;
    assert.ok(q.some(x => Number(x.id) === o.body.order_id && x.status === "pending"));
    const c = await api("POST", `/orders/${o.body.order_id}/confirm`);
    assert.match(c.body.code, /^\d{6}$/);
    assert.equal((await api("POST", "/redeem", { counter_id: 2, code: c.body.code })).body.served, true);
  });
});

describe("serving from the counter", () => {
  test("the counter can serve a cash cart without a code", async () => {
    reset();
    const o = await api("POST", "/orders", { reg_no: "26BDE0168", mode: "cash",
                                             items: [{ menu_item_id: 5 }] });
    await api("POST", `/orders/${o.body.order_id}/confirm`);
    const r = await api("POST", `/orders/${o.body.order_id}/serve`);
    assert.equal(r.status, 200);
    assert.equal(r.body.served, true);
  });

  test("serving twice from the counter is refused", async () => {
    reset();
    const a = await paidCart();
    await api("POST", `/orders/${a.id}/serve`);
    assert.equal((await api("POST", `/orders/${a.id}/serve`)).status, 409);
  });

  test("a cart served at the counter can no longer be redeemed by code", async () => {
    reset();
    const a = await paidCart();
    await api("POST", `/orders/${a.id}/serve`);
    assert.equal((await api("POST", "/redeem", { counter_id: a.counter, code: a.code })).status, 409);
  });

  test("an unpaid cart cannot be served", async () => {
    const o = await api("POST", "/orders", { reg_no: "x", items: [{ menu_item_id: 1 }] });
    assert.equal((await api("POST", `/orders/${o.body.order_id}/serve`)).status, 409);
  });
});

describe("counter queue view", () => {
  test("the counter sees waiting carts in queue order with their items", async () => {
    reset();
    await paidCart([{ menu_item_id: 1, qty: 2 }]);
    await paidCart([{ menu_item_id: 4 }], "upi", "26BCE3103");
    const q = (await api("GET", "/counter/1/queue")).body;
    assert.equal(q.length, 2);
    assert.ok(q[0].items.includes("Maggi x2"));
    assert.ok(Number(q[0].queue_no) < Number(q[1].queue_no));
  });
  test("a served cart leaves the counter queue", async () => {
    reset();
    const a = await paidCart();
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    assert.equal((await api("GET", "/counter/1/queue")).body.length, 0);
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
    reset();
    const a = await paidCart();
    await paidCart([{ menu_item_id: 1 }], "upi", "26BCE3103");
    await api("POST", "/redeem", { counter_id: a.counter, code: a.code });
    const s = (await api("GET", "/admin/summary")).body;
    assert.equal(Number(s.orders_tonight), 2);
    assert.equal(Number(s.meals_served), 1);
    assert.equal(Number(s.waiting_now), 1);
    assert.ok(Number(s.collections_paise) > 0);
    assert.ok(s.demand.length > 0);
  });
  test("the dashboard can be filtered by hostel type", async () => {
    reset();
    await paidCart([{ menu_item_id: 1 }]);
    const mens = (await api("GET", "/admin/summary?hostel_type=mens")).body;
    const ladies = (await api("GET", "/admin/summary?hostel_type=ladies")).body;
    assert.equal(Number(mens.orders_tonight), 1);
    assert.equal(Number(ladies.orders_tonight), 0);
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
      { reg_no: "x", items: [{ menu_item_id: 1 }], mode: "crypto" })).status, 400);
  });
  test("redeem needs six digits", async () => {
    assert.equal((await api("POST", "/redeem", { counter_id: 1, code: "12" })).status, 400);
  });
  test("an unknown order is not found", async () => {
    assert.equal((await api("GET", "/orders/999999/status")).status, 404);
    assert.equal((await api("POST", "/orders/999999/confirm")).status, 404);
  });
});
