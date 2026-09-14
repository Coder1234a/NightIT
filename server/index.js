require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { pool } = require("./db");

// GST on prepared food. Menu prices are shown excluding tax and it is added at
// checkout, which is how the mess already prices its board.
const TAX_PERCENT = Number(process.env.TAX_PERCENT || 5);
const taxOn = subtotal => Math.round(subtotal * TAX_PERCENT / 100);

const app = express();
app.use(cors());
app.use(express.json());

// Wraps a route so a thrown error becomes a clean 500 instead of a crash.
function route(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(req.method, req.path, err.message);
    res.status(500).json({ error: "server_error", detail: err.message });
  });
}

// The bare URL. Without this Express answers "Cannot GET /", which looks
// broken to anyone who opens the address by hand.
app.get("/", (_req, res) => {
  res.json({
    service: "nightit-api",
    description: "Night mess ordering and pickup for VIT hostels. An add-on to MessIT.",
    repo: "https://github.com/Coder1234a/NightIT",
    health: "/health",
    endpoints: [
      "GET  /blocks", "GET  /menu?block_id=1", "POST /orders",
      "POST /orders/:id/confirm", "GET  /orders/:id/status",
      "POST /orders/:id/ready", "POST /orders/:id/serve", "POST /redeem",
      "GET  /counter/:id/queue", "POST /stock", "POST /feedback",
      "GET  /admin/summary",
    ],
  });
});

app.get("/health", route(async (_req, res) => {
  const r = await pool.query("SELECT 1 AS ok");
  res.json({ ok: r.rows[0].ok === 1, service: "nightit-api" });
}));

// The public Razorpay key, so the frontend never hardcodes it.
app.get("/payments/config", (_req, res) => {
  const key = process.env.RAZORPAY_KEY_ID || null;
  res.json({ key_id: key, mode: (key || "").startsWith("rzp_test_") ? "test" : "live",
             configured: Boolean(key), tax_percent: TAX_PERCENT });
});

app.get("/blocks", route(async (_req, res) => {
  const r = await pool.query(
    `SELECT b.id, b.name, b.hostel_type, b.opens_at, b.closes_at, c.id AS counter_id
       FROM blocks b JOIN counters c ON c.block_id = b.id ORDER BY b.id`);
  res.json(r.rows);
}));

// Menu for one block: stock, cut-off, and how long one portion would take
// counting everyone already queued ahead of you at that counter.
app.get("/menu", route(async (req, res) => {
  const blockId = Number(req.query.block_id);
  if (!blockId) return res.status(400).json({ error: "block_id_required" });
  const r = await pool.query(
    `WITH ahead AS (
       SELECT counter_id, COUNT(*)::int AS n FROM orders
        WHERE status = 'paid' GROUP BY counter_id)
     SELECT m.id, m.name, m.price_paise, m.prep_minutes, m.cutoff_at, m.image_url,
            COALESCE(s.remaining,0) AS remaining, c.id AS counter_id,
            c.avg_service_seconds, b.closes_at,
            COALESCE(a.n,0) AS queue_ahead,
            m.prep_minutes * 60 + COALESCE(a.n,0) * c.avg_service_seconds AS eta_seconds,
            (COALESCE(s.remaining,0) > 0
             AND night_min(night_now()) >= night_min(b.opens_at)
             AND night_min(night_now()) <  night_min(m.cutoff_at)
             AND night_min(night_now()) <  night_min(b.closes_at)) AS available,
            CASE WHEN night_min(night_now()) <  night_min(b.opens_at)  THEN 'not_open_yet'
                 WHEN COALESCE(s.remaining,0) = 0                      THEN 'sold_out'
                 WHEN night_min(night_now()) >= night_min(b.closes_at) THEN 'block_closed'
                 WHEN night_min(night_now()) >= night_min(m.cutoff_at) THEN 'closed_for_tonight'
                 ELSE 'available' END AS state
       FROM menu_items m
       JOIN counters c ON c.id = m.counter_id
       JOIN blocks   b ON b.id = c.block_id
       LEFT JOIN stock s ON s.menu_item_id = m.id
       LEFT JOIN ahead a ON a.counter_id = c.id
      WHERE b.id = $1 ORDER BY m.id`, [blockId]);
  res.json(r.rows);
}));

// Creates a cart. Every portion is taken off the shelf inside one transaction,
// so two people cannot both claim the last plate and a half-filled cart never
// leaves stock stranded.
app.post("/orders", route(async (req, res) => {
  const { reg_no, items, mode = "upi", takeaway = false } = req.body || {};
  if (!reg_no || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "reg_no_and_items_required" });
  if (!["upi", "cash"].includes(mode)) return res.status(400).json({ error: "bad_mode" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let total = 0, prep = 0, counterId = null;
    const lines = [];

    for (const line of items) {
      const id = Number(line.menu_item_id);
      const qty = Math.max(1, Number(line.qty || 1));
      const it = await client.query(
        `SELECT m.price_paise, m.prep_minutes, m.counter_id,
                (night_min(night_now()) >= night_min(b.opens_at)
                 AND night_min(night_now()) < night_min(m.cutoff_at)
                 AND night_min(night_now()) < night_min(b.closes_at)) AS open_now
           FROM menu_items m JOIN counters c ON c.id = m.counter_id
           JOIN blocks b ON b.id = c.block_id WHERE m.id = $1`, [id]);
      if (!it.rowCount) throw Object.assign(new Error("no_such_item"), { http: 404 });

      const row = it.rows[0];
      if (!row.open_now) throw Object.assign(new Error("closed_for_tonight"), { http: 409 });
      if (counterId && counterId !== row.counter_id)
        throw Object.assign(new Error("one_counter_per_cart"), { http: 400 });
      counterId = row.counter_id;

      const took = await client.query("SELECT take_stock($1,$2) AS ok", [id, qty]);
      if (!took.rows[0].ok) throw Object.assign(new Error("sold_out"), { http: 409 });

      total += row.price_paise * qty;
      // The kitchen cooks a cart together, so the wait is the slowest item on
      // it, not the sum of them. Two Maggi and a coffee is six minutes.
      prep = Math.max(prep, row.prep_minutes * 60);
      lines.push({ id, qty, price: row.price_paise });
    }

    const tax = taxOn(total);
    const o = await client.query(
      `INSERT INTO orders (reg_no, counter_id, amount_paise, tax_paise, mode, takeaway, prep_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [reg_no, counterId, total, tax, mode, !!takeaway, prep]);
    const orderId = Number(o.rows[0].id);

    for (const l of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, menu_item_id, qty, unit_price_paise)
         VALUES ($1,$2,$3,$4)`, [orderId, l.id, l.qty, l.price]);
    }

    await client.query("COMMIT");
    res.status(201).json({
      order_id: orderId, counter_id: counterId, mode, status: "pending",
      subtotal_paise: total, tax_paise: tax, total_paise: total + tax,
      tax_percent: TAX_PERCENT, prep_seconds: prep,
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (e.http) return res.status(e.http).json({ error: e.message });
    throw e;
  } finally {
    client.release();
  }
}));

// Confirms payment and issues the pickup code plus a queue number.
app.post("/orders/:id/confirm", route(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await pool.query("SELECT status FROM orders WHERE id = $1", [id]);
  if (!cur.rowCount) return res.status(404).json({ error: "no_such_order" });
  if (cur.rows[0].status !== "pending")
    return res.status(409).json({ error: "not_pending", status: cur.rows[0].status });

  const r = await pool.query("SELECT issue_otp($1) AS code", [id]);
  const info = await pool.query(
    "SELECT expires_at, counter_id, queue_no FROM orders WHERE id = $1", [id]);
  res.json({ order_id: id, code: r.rows[0].code, ...info.rows[0] });
}));

app.post("/orders/:id/cancel", route(async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query(
    "UPDATE orders SET status='cancelled' WHERE id=$1 AND status='pending' RETURNING id", [id]);
  if (!r.rowCount) return res.status(409).json({ error: "not_pending" });
  await pool.query("SELECT return_stock($1)", [id]);
  res.json({ ok: true });
}));

// Every cart of yours that is still alive tonight, found by registration
// number. This is what lets a student who closed the tab, cleared the browser
// or picked up a different phone get back to their order — the server knows,
// so nothing depends on the handset that placed it.
app.get("/orders/active", route(async (req, res) => {
  const reg = String(req.query.reg_no || "").trim();
  if (!reg) return res.status(400).json({ error: "reg_no_required" });
  const r = await pool.query(
    `SELECT o.id, o.status, o.queue_no, b.name AS block, b.hostel_type,
            o.amount_paise + o.tax_paise AS total_paise,
            (SELECT COUNT(*)::int FROM orders x
              WHERE x.counter_id = o.counter_id AND x.status = 'paid'
                AND x.queue_no < o.queue_no) AS ahead
       FROM orders o JOIN counters c ON c.id = o.counter_id
       JOIN blocks b ON b.id = c.block_id
      WHERE upper(o.reg_no) = upper($1) AND o.status IN ('paid','ready')
      ORDER BY o.id DESC LIMIT 5`, [reg]);
  res.json(r.rows.map(o => ({
    order_id: Number(o.id), status: o.status, queue_no: o.queue_no,
    block: o.block, hostel_type: o.hostel_type, total_paise: o.total_paise,
    position: o.status === "paid" ? o.ahead + 1 : 0, ready: o.status === "ready",
  })));
}));

// Live status of one cart: how many are ahead, how long that is, and whether
// the food is ready. The phone polls this, so it carries everything at once.
app.get("/orders/:id/status", route(async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query(
    `SELECT o.id, o.status, o.queue_no, o.takeaway, o.amount_paise, o.tax_paise, o.prep_seconds,
            o.expires_at, o.ready_at, c.avg_service_seconds, b.name AS block,
            (SELECT COUNT(*)::int FROM orders x
              WHERE x.counter_id = o.counter_id AND x.status = 'paid'
                AND x.queue_no < o.queue_no) AS ahead,
            (SELECT COALESCE(json_agg(json_build_object(
                      'name', m.name, 'qty', oi.qty, 'price_paise', oi.unit_price_paise)), '[]')
               FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id
              WHERE oi.order_id = o.id) AS items
       FROM orders o JOIN counters c ON c.id = o.counter_id
       JOIN blocks b ON b.id = c.block_id WHERE o.id = $1`, [id]);
  if (!r.rowCount) return res.status(404).json({ error: "no_such_order" });

  const o = r.rows[0];
  const ahead = o.status === "paid" ? o.ahead : 0;
  const eta = o.status === "ready" || o.status === "served"
    ? 0 : ahead * o.avg_service_seconds + o.prep_seconds;
  res.json({
    order_id: Number(o.id), status: o.status, queue_no: o.queue_no, block: o.block,
    // queue_no is the ticket you were handed; position is where you are in the
    // line right now, and it counts down as the people ahead are served.
    position: o.status === "paid" ? o.ahead + 1 : 0,
    items: o.items, amount_paise: o.amount_paise, tax_paise: o.tax_paise,
    total_paise: o.amount_paise + o.tax_paise, takeaway: o.takeaway,
    ahead, eta_seconds: eta,
    ready: o.status === "ready", served: o.status === "served",
    almost_your_turn: o.status === "paid" && ahead <= 1,
    ready_at: o.ready_at, expires_at: o.expires_at,
  });
}));

// The counter marks a cart ready. This is what turns the student's screen green.
app.post("/orders/:id/ready", route(async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query(
    "UPDATE orders SET status='ready', ready_at=now() WHERE id=$1 AND status='paid' RETURNING queue_no",
    [id]);
  if (!r.rowCount) return res.status(409).json({ error: "not_paid" });
  res.json({ ok: true, queue_no: r.rows[0].queue_no });
}));

// The counter serves a cart directly. Used for cash, where the student paid in
// person and there is no code on their phone. Same one-way transition as a
// scan, so a cart can still only be handed over once.
app.post("/orders/:id/serve", route(async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query(
    `UPDATE orders SET status='served', served_at=now()
      WHERE id=$1 AND status IN ('paid','ready') RETURNING queue_no`, [id]);
  if (!r.rowCount) return res.status(409).json({ error: "not_collectable" });
  res.json({ served: true, queue_no: r.rows[0].queue_no });
}));

// Everything the counter screen shows: who is waiting, in order.
app.get("/counter/:id/queue", route(async (req, res) => {
  const r = await pool.query(
    `SELECT o.id, o.queue_no, o.reg_no, o.status, o.mode, o.takeaway,
            o.amount_paise, o.tax_paise,
            (SELECT string_agg(m.name || CASE WHEN oi.qty > 1 THEN ' x' || oi.qty ELSE '' END, ', ')
               FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id
              WHERE oi.order_id = o.id) AS items
       FROM orders o
      WHERE o.counter_id = $1 AND o.status IN ('pending','paid','ready')
      ORDER BY (o.status = 'pending') DESC, o.queue_no NULLS LAST`, [Number(req.params.id)]);
  res.json(r.rows);
}));

app.post("/redeem", route(async (req, res) => {
  const counter_id = Number(req.body?.counter_id);
  const code = String(req.body?.code || "").trim();
  if (!counter_id || !/^\d{6}$/.test(code))
    return res.status(400).json({ error: "counter_and_6_digit_code_required" });

  const r = await pool.query("SELECT redeem_otp($1,$2) AS id", [counter_id, code]);
  const id = r.rows[0].id;
  if (!id) return res.status(409).json({ served: false, reason: "invalid_expired_or_already_used" });

  const d = await pool.query(
    `SELECT o.id, o.reg_no, o.takeaway, o.queue_no,
            (SELECT string_agg(m.name || CASE WHEN oi.qty > 1 THEN ' x' || oi.qty ELSE '' END, ', ')
               FROM order_items oi JOIN menu_items m ON m.id = oi.menu_item_id
              WHERE oi.order_id = o.id) AS items
       FROM orders o WHERE o.id = $1`, [id]);
  res.json({ served: true, order: d.rows[0] });
}));

app.post("/stock", route(async (req, res) => {
  const { menu_item_id, remaining } = req.body || {};
  if (!menu_item_id || remaining === undefined)
    return res.status(400).json({ error: "item_and_remaining_required" });
  if (Number(remaining) < 0) return res.status(400).json({ error: "remaining_negative" });
  await pool.query(
    `INSERT INTO stock (menu_item_id, remaining) VALUES ($1,$2)
     ON CONFLICT (menu_item_id) DO UPDATE SET remaining = EXCLUDED.remaining`,
    [menu_item_id, Number(remaining)]);
  res.json({ ok: true });
}));

app.post("/feedback", route(async (req, res) => {
  const { reg_no, block_id, kind, rating, message } = req.body || {};
  if (!["feedback", "bug"].includes(kind))
    return res.status(400).json({ error: "kind_must_be_feedback_or_bug" });
  if (!message) return res.status(400).json({ error: "message_required" });
  const r = await pool.query(
    `INSERT INTO feedback (reg_no, block_id, kind, rating, message)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [reg_no || null, block_id || null, kind, rating || null, message]);
  res.status(201).json({ id: Number(r.rows[0].id) });
}));

app.get("/feedback", route(async (req, res) => {
  const r = await pool.query(
    `SELECT f.*, b.name AS block FROM feedback f LEFT JOIN blocks b ON b.id = f.block_id
      WHERE ($1::text IS NULL OR f.kind = $1) ORDER BY f.created_at DESC LIMIT 100`,
    [req.query.kind || null]);
  res.json(r.rows);
}));

app.get("/admin/summary", route(async (req, res) => {
  const args = [req.query.hostel_type || null];
  const totals = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE o.status <> 'cancelled') AS orders_tonight,
            COUNT(*) FILTER (WHERE o.status = 'served')     AS meals_served,
            COUNT(*) FILTER (WHERE o.status IN ('paid','ready')) AS waiting_now,
            COALESCE(SUM(o.amount_paise) FILTER (WHERE o.status IN ('paid','ready','served')),0)
              AS collections_paise
       FROM orders o JOIN counters c ON c.id = o.counter_id
       JOIN blocks b ON b.id = c.block_id
      WHERE ($1::text IS NULL OR b.hostel_type = $1)`, args);
  const buckets = await pool.query(
    `SELECT to_char(date_trunc('hour', o.created_at)
              + floor(extract(minute FROM o.created_at)/10) * interval '10 min','HH24:MI') AS slot,
            COUNT(*) AS orders
       FROM orders o JOIN counters c ON c.id = o.counter_id
       JOIN blocks b ON b.id = c.block_id
      WHERE ($1::text IS NULL OR b.hostel_type = $1)
      GROUP BY 1 ORDER BY 1`, args);
  res.json({ ...totals.rows[0], demand: buckets.rows });
}));

// Wipes tonight's orders and puts every portion back on the shelf, so a demo
// starts from a clean queue. Disabled unless RESET_TOKEN is set, and the
// caller must send that exact token, so nobody can empty the mess by accident.
app.post("/admin/reset", route(async (req, res) => {
  const expected = process.env.RESET_TOKEN;
  if (!expected) return res.status(404).json({ error: "reset_disabled" });
  if (req.get("x-reset-token") !== expected)
    return res.status(403).json({ error: "bad_token" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE order_items, orders RESTART IDENTITY CASCADE");
    if (req.query.feedback === "1") await client.query("TRUNCATE feedback RESTART IDENTITY");
    // Restore the seeded stock levels without touching blocks or menus.
    await client.query(`
      UPDATE stock s SET remaining = v.n
        FROM (VALUES (1,40),(2,0),(3,15),(4,25),(5,30),(6,12),(7,18),(8,50))
             AS v(item, n)
       WHERE s.menu_item_id = v.item`);
    await client.query("COMMIT");
    res.json({ ok: true, cleared: "orders", stock: "restored",
               feedback: req.query.feedback === "1" ? "cleared" : "kept" });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

const port = process.env.PORT || 3000;
if (require.main === module) app.listen(port, () => console.log(`nightit-api on ${port}`));
module.exports = app;
