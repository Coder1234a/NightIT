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
  execSync("node scripts/migrate.js --seed", {
    cwd: path.join(__dirname, ".."), stdio: "pipe",
    env: { ...process.env },
  });
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
  test("health endpoint answers", async () => {
    const r = await api("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });

  test("the midnight-crossing window is ordered correctly", async () => {
    const r = await pool.query(
      "SELECT night_min('22:30') a, night_min('23:00') b, night_min('00:30') c");
    const { a, b, c } = r.rows[0];
    assert.ok(a < b && b < c, "22:30 < 23:00 < 00:30 on the night scale");
  });

  test("two blocks exist with different closing times", async () => {
    const r = await api("GET", "/blocks");
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 2);
    const closes = r.body.map(b => b.closes_at);
    assert.notEqual(closes[0], closes[1], "blocks must be configured differently");
  });
});

describe("per-block configuration", () => {
  test("each block serves a different menu", async () => {
    const m1 = (await api("GET", "/menu?block_id=1")).body.map(i => i.name).sort();
    const m2 = (await api("GET", "/menu?block_id=2")).body.map(i => i.name).sort();
    assert.notDeepEqual(m1, m2, "menus must come from data, not code");
  });

  test("an out-of-stock item is reported as sold out and unavailable", async () => {
    const menu = (await api("GET", "/menu?block_id=1")).body;
    const fries = menu.find(i => i.name === "French fries");
    assert.equal(Number(fries.remaining), 0);
    assert.equal(fries.available, false);
    assert.equal(fries.state, "sold_out");
  });

  test("an item past its cut-off closes itself", async () => {
    await pool.query("SET nightit.now = '23:55'");
    const r = await pool.query(
      `SELECT m.name, night_min(night_now()) >= night_min(m.cutoff_at) AS past
         FROM menu_items m WHERE m.id = 6`);   // LH-2 dosa, cutoff 23:30
    assert.equal(r.rows[0].past, true);
    await pool.query("SET nightit.now = '23:00'");
  });

  test("every item reports a preparation estimate", async () => {
    const menu = (await api("GET", "/menu?block_id=1")).body;
    assert.ok(menu.every(i => Number(i.eta_minutes) > 0));
  });
});

describe("ordering and stock", () => {
  test("placing an order takes one portion off the shelf", async () => {
    const before = (await api("GET", "/menu?block_id=1")).body.find(i => i.id === 1);
    const r = await api("POST", "/orders", { reg_no: "26BDE0124", menu_item_id: 1 });
    assert.equal(r.status, 201);
    const after = (await api("GET", "/menu?block_id=1")).body.find(i => i.id === 1);
    assert.equal(Number(after.remaining), Number(before.remaining) - 1);
  });

  test("a sold-out item cannot be ordered", async () => {
    const r = await api("POST", "/orders", { reg_no: "26BDE0124", menu_item_id: 2 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "sold_out");
  });

  test("cancelling an unpaid order puts the portion back", async () => {
    const before = (await api("GET", "/menu?block_id=1")).body.find(i => i.id === 4);
    const o = await api("POST", "/orders", { reg_no: "26BDE0168", menu_item_id: 4 });
    await api("POST", `/orders/${o.body.order_id}/cancel`);
    const after = (await api("GET", "/menu?block_id=1")).body.find(i => i.id === 4);
    assert.equal(Number(after.remaining), Number(before.remaining));
  });

  test("the last portion goes to exactly one of two simultaneous orders", async () => {
    await api("POST", "/stock", { menu_item_id: 3, remaining: 1 });
    const [a, b] = await Promise.all([
      api("POST", "/orders", { reg_no: "26BCE3103", menu_item_id: 3 }),
      api("POST", "/orders", { reg_no: "26BDE0113", menu_item_id: 3 }),
    ]);
    const created = [a, b].filter(r => r.status === 201).length;
    assert.equal(created, 1, "exactly one order may claim the last plate");
  });

  test("parcel is recorded on the order", async () => {
    const o = await api("POST", "/orders", { reg_no: "26BDE0124", menu_item_id: 1, parcel: true });
    const r = await pool.query("SELECT parcel FROM orders WHERE id = $1", [o.body.order_id]);
    assert.equal(r.rows[0].parcel, true);
  });
});

describe("token issue and redemption", () => {
  // Puts plenty of an item back on the shelf so a test is never starved.
  async function restock(item = 1, n = 200) {
    await api("POST", "/stock", { menu_item_id: item, remaining: n });
  }

  async function paidOrder(item = 1, mode = "upi") {
    await restock(item);
    const o = await api("POST", "/orders", { reg_no: "26BDE0124", menu_item_id: item, mode });
    const c = await api("POST", `/orders/${o.body.order_id}/confirm`);
    return { id: o.body.order_id, code: c.body.code, counter: c.body.counter_id };
  }

  test("confirming a paid order returns a six-digit code", async () => {
    const { code } = await paidOrder();
    assert.match(code, /^\d{6}$/);
  });

  test("the code is never stored in readable form", async () => {
    const { id, code } = await paidOrder();
    const r = await pool.query("SELECT otp_hash::text AS h FROM orders WHERE id = $1", [id]);
    assert.ok(!r.rows[0].h.includes(code), "the plain code must not appear in the row");
  });

  test("a valid code serves the order", async () => {
    const { code, counter } = await paidOrder();
    const r = await api("POST", "/redeem", { counter_id: counter, code });
    assert.equal(r.status, 200);
    assert.equal(r.body.served, true);
  });

  test("the same code is rejected the second time", async () => {
    const { code, counter } = await paidOrder();
    const first = await api("POST", "/redeem", { counter_id: counter, code });
    const second = await api("POST", "/redeem", { counter_id: counter, code });
    assert.equal(first.body.served, true);
    assert.equal(second.status, 409);
    assert.equal(second.body.served, false);
  });

  test("two simultaneous scans of one code serve it only once", async () => {
    const { code, counter } = await paidOrder();
    const [a, b] = await Promise.all([
      api("POST", "/redeem", { counter_id: counter, code }),
      api("POST", "/redeem", { counter_id: counter, code }),
    ]);
    const served = [a, b].filter(r => r.body.served === true).length;
    assert.equal(served, 1, "a race must not serve the same order twice");
  });

  test("a code from one counter does not work at another", async () => {
    const { code } = await paidOrder(1);           // counter 1
    const r = await api("POST", "/redeem", { counter_id: 2, code });
    assert.equal(r.status, 409);
  });

  test("an unconfirmed order cannot be redeemed", async () => {
    const o = await api("POST", "/orders", { reg_no: "26BDE0124", menu_item_id: 1 });
    const r = await pool.query("SELECT otp_hash FROM orders WHERE id = $1", [o.body.order_id]);
    assert.equal(r.rows[0].otp_hash, null);
  });

  test("confirming twice is refused", async () => {
    const o = await api("POST", "/orders", { reg_no: "26BDE0124", menu_item_id: 1 });
    await api("POST", `/orders/${o.body.order_id}/confirm`);
    const again = await api("POST", `/orders/${o.body.order_id}/confirm`);
    assert.equal(again.status, 409);
  });

  test("an expired code is refused", async () => {
    const { id, code, counter } = await paidOrder();
    await pool.query("UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    const r = await api("POST", "/redeem", { counter_id: counter, code });
    assert.equal(r.status, 409);
  });

  test("a wrong code is refused", async () => {
    const r = await api("POST", "/redeem", { counter_id: 1, code: "000000" });
    assert.equal(r.status, 409);
  });

  test("codes are unique among live orders at a counter", async () => {
    const codes = new Set();
    for (let i = 0; i < 25; i++) {
      const o = await api("POST", "/orders", { reg_no: "26BDE0124", menu_item_id: 1 });
      if (o.status !== 201) break;
      const c = await api("POST", `/orders/${o.body.order_id}/confirm`);
      assert.equal(codes.has(c.body.code), false, "duplicate live code at one counter");
      codes.add(c.body.code);
    }
    assert.ok(codes.size >= 20);
  });


  test("the database itself refuses two live orders sharing a code at one counter", async () => {
    await restock(1);
    const a = await api("POST", "/orders", { reg_no: "26BDE0124", menu_item_id: 1 });
    const b = await api("POST", "/orders", { reg_no: "26BDE0113", menu_item_id: 1 });
    const hash = "digest('424242' || 1::text || current_date::text,'sha256')";
    await pool.query(
      `UPDATE orders SET status='paid', otp_hash=${hash},
              expires_at = now() + interval '90 min' WHERE id = $1`, [a.body.order_id]);
    await assert.rejects(
      () => pool.query(
        `UPDATE orders SET status='paid', otp_hash=${hash},
                expires_at = now() + interval '90 min' WHERE id = $1`, [b.body.order_id]),
      /duplicate key|unique/i,
      "the partial unique index must block a colliding live code");
  });

  test("the same code may be live at two different counters at once", async () => {
    await restock(1); await restock(5);
    const a = await api("POST", "/orders", { reg_no: "26BDE0124", menu_item_id: 1 });   // counter 1
    const b = await api("POST", "/orders", { reg_no: "26BDE0168", menu_item_id: 5 });   // counter 2
    for (const [id, counter] of [[a.body.order_id, 1], [b.body.order_id, 2]]) {
      await pool.query(
        `UPDATE orders SET status='paid',
                otp_hash = digest('515151' || $2::text || current_date::text,'sha256'),
                expires_at = now() + interval '90 min' WHERE id = $1`, [id, counter]);
    }
    const r1 = await api("POST", "/redeem", { counter_id: 1, code: "515151" });
    const r2 = await api("POST", "/redeem", { counter_id: 2, code: "515151" });
    assert.equal(r1.body.served, true);
    assert.equal(r2.body.served, true, "codes are scoped per counter, not globally");
  });

  test("issue_otp survives a collision and still returns a code", async () => {
    await restock(1);
    // Occupy one exact code at counter 1, then confirm 30 fresh orders. Any
    // draw that lands on the taken code must be retried, not returned.
    const held = await api("POST", "/orders", { reg_no: "26BDE0124", menu_item_id: 1 });
    await pool.query(
      `UPDATE orders SET status='paid',
              otp_hash = digest('999999' || 1::text || current_date::text,'sha256'),
              expires_at = now() + interval '90 min' WHERE id = $1`, [held.body.order_id]);
    for (let i = 0; i < 30; i++) {
      const o = await api("POST", "/orders", { reg_no: "26BDE0124", menu_item_id: 1 });
      if (o.status !== 201) break;
      const c = await api("POST", `/orders/${o.body.order_id}/confirm`);
      assert.equal(c.status, 200);
      assert.match(c.body.code, /^\d{6}$/);
    }
  });

  test("serving an order frees its code for reuse, with nothing purged", async () => {
    await restock(1);
    const before = (await pool.query("SELECT COUNT(*)::int n FROM orders")).rows[0].n;
    const { code, counter, id } = await paidOrder();
    await api("POST", "/redeem", { counter_id: counter, code });
    // The served row is still there. Nothing was deleted.
    const still = await pool.query("SELECT status FROM orders WHERE id = $1", [id]);
    assert.equal(still.rows[0].status, "served");
    const after = (await pool.query("SELECT COUNT(*)::int n FROM orders")).rows[0].n;
    assert.ok(after > before, "rows accumulate as history, not as garbage");
    // And the freed code can be issued again to a new order at that counter.
    await restock(1);
    const o = await api("POST", "/orders", { reg_no: "26BDE0113", menu_item_id: 1 });
    await pool.query(
      `UPDATE orders SET status='paid',
              otp_hash = digest($2 || $3::text || current_date::text,'sha256'),
              expires_at = now() + interval '90 min' WHERE id = $1`,
      [o.body.order_id, code, counter]);
    const r = await api("POST", "/redeem", { counter_id: counter, code });
    assert.equal(r.body.served, true, "a served code may be reissued");
  });
});

describe("cash path", () => {
  test("a cash order appears in the counter queue and gets the same kind of code", async () => {
    const o = await api("POST", "/orders", { reg_no: "26BDE0168", menu_item_id: 5, mode: "cash" });
    assert.equal(o.status, 201);
    const q = await api("GET", "/counter/2/pending-cash");
    assert.ok(q.body.some(x => Number(x.id) === o.body.order_id), "cashier can see it waiting");
    const c = await api("POST", `/orders/${o.body.order_id}/confirm`);
    assert.match(c.body.code, /^\d{6}$/);
    const r = await api("POST", "/redeem", { counter_id: 2, code: c.body.code });
    assert.equal(r.body.served, true);
  });
});

describe("feedback, bugs and the dashboard", () => {
  test("feedback and bug reports are stored and listed separately", async () => {
    await api("POST", "/feedback", { reg_no: "26BDE0168", block_id: 2, kind: "feedback",
                                     rating: 4, message: "Please add more veg options" });
    await api("POST", "/feedback", { reg_no: "26BCE3103", block_id: 1, kind: "bug",
                                     message: "Scanner froze after the third scan" });
    const bugs = (await api("GET", "/feedback?kind=bug")).body;
    assert.ok(bugs.length >= 1);
    assert.ok(bugs.every(f => f.kind === "bug"));
  });

  test("bad feedback input is refused", async () => {
    const r = await api("POST", "/feedback", { kind: "nonsense", message: "x" });
    assert.equal(r.status, 400);
  });

  test("the dashboard reports orders, meals served and collections", async () => {
    const s = (await api("GET", "/admin/summary")).body;
    assert.ok(Number(s.orders_tonight) > 0);
    assert.ok(Number(s.meals_served) > 0);
    assert.ok(Number(s.collections_paise) > 0);
    assert.ok(Array.isArray(s.demand) && s.demand.length > 0);
  });

  test("the dashboard can be filtered to one hostel type", async () => {
    const mens = (await api("GET", "/admin/summary?hostel_type=mens")).body;
    const ladies = (await api("GET", "/admin/summary?hostel_type=ladies")).body;
    assert.notEqual(Number(mens.orders_tonight), Number(ladies.orders_tonight));
  });
});

describe("input validation", () => {
  test("menu needs a block", async () => {
    assert.equal((await api("GET", "/menu")).status, 400);
  });
  test("orders need a registration number and an item", async () => {
    assert.equal((await api("POST", "/orders", { reg_no: "x" })).status, 400);
  });
  test("an unknown payment mode is refused", async () => {
    assert.equal((await api("POST", "/orders", { reg_no: "x", menu_item_id: 1, mode: "crypto" })).status, 400);
  });
  test("redeem needs six digits", async () => {
    assert.equal((await api("POST", "/redeem", { counter_id: 1, code: "12" })).status, 400);
  });
  test("an unknown order returns not found", async () => {
    assert.equal((await api("POST", "/orders/999999/confirm")).status, 404);
  });
});
