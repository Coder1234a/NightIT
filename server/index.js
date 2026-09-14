require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { pool } = require("./db");

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

app.get("/health", route(async (_req, res) => {
  const r = await pool.query("SELECT 1 AS ok");
  res.json({ ok: r.rows[0].ok === 1, service: "nightit-api" });
}));

// Lists every block so the student can pick where they are.
app.get("/blocks", route(async (_req, res) => {
  const r = await pool.query(
    `SELECT b.id, b.name, b.hostel_type, b.opens_at, b.closes_at, c.id AS counter_id
       FROM blocks b JOIN counters c ON c.block_id = b.id
      ORDER BY b.id`);
  res.json(r.rows);
}));

// The menu for one block, with stock, cut-off and a preparation estimate.
// An item is orderable only if stock remains, its cut-off has not passed and
// the block has not closed for the night.
app.get("/menu", route(async (req, res) => {
  const blockId = Number(req.query.block_id);
  if (!blockId) return res.status(400).json({ error: "block_id_required" });
  const r = await pool.query(
    `SELECT m.id, m.name, m.price_paise, m.prep_minutes, m.cutoff_at,
            COALESCE(s.remaining, 0) AS remaining,
            c.id AS counter_id, c.avg_service_seconds, b.closes_at,
            (COALESCE(s.remaining,0) > 0
             AND night_min(night_now()) >= night_min(b.opens_at)
             AND night_min(night_now()) <  night_min(m.cutoff_at)
             AND night_min(night_now()) <  night_min(b.closes_at)) AS available,
            CASE WHEN night_min(night_now()) <  night_min(b.opens_at)  THEN 'not_open_yet'
                 WHEN COALESCE(s.remaining,0) = 0                      THEN 'sold_out'
                 WHEN night_min(night_now()) >= night_min(b.closes_at) THEN 'block_closed'
                 WHEN night_min(night_now()) >= night_min(m.cutoff_at) THEN 'closed_for_tonight'
                 ELSE 'available' END AS state,
            m.prep_minutes + (
              SELECT COUNT(*) FROM orders o
               WHERE o.counter_id = c.id AND o.status = 'paid'
            ) * c.avg_service_seconds / 60 AS eta_minutes
       FROM menu_items m
       JOIN counters c ON c.id = m.counter_id
       JOIN blocks   b ON b.id = c.block_id
       LEFT JOIN stock s ON s.menu_item_id = m.id
      WHERE b.id = $1
      ORDER BY m.id`, [blockId]);
  res.json(r.rows);
}));

// Creates a pending order and takes one portion off the shelf straight away,
// so two people cannot both claim the last plate.
app.post("/orders", route(async (req, res) => {
  const { reg_no, menu_item_id, mode = "upi", parcel = false } = req.body || {};
  if (!reg_no || !menu_item_id) return res.status(400).json({ error: "reg_no_and_item_required" });
  if (!["upi", "cash"].includes(mode)) return res.status(400).json({ error: "bad_mode" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const it = await client.query(
      `SELECT m.id, m.price_paise, m.counter_id,
              (night_min(night_now()) >= night_min(b.opens_at)
               AND night_min(night_now()) < night_min(m.cutoff_at)
               AND night_min(night_now()) < night_min(b.closes_at)) AS open_now
         FROM menu_items m JOIN counters c ON c.id = m.counter_id
         JOIN blocks b ON b.id = c.block_id WHERE m.id = $1`, [menu_item_id]);
    if (!it.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "no_such_item" }); }
    if (!it.rows[0].open_now) { await client.query("ROLLBACK"); return res.status(409).json({ error: "closed_for_tonight" }); }

    const took = await client.query("SELECT take_stock($1) AS ok", [menu_item_id]);
    if (!took.rows[0].ok) { await client.query("ROLLBACK"); return res.status(409).json({ error: "sold_out" }); }

    const o = await client.query(
      `INSERT INTO orders (reg_no, counter_id, menu_item_id, amount_paise, mode, parcel)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, amount_paise, status`,
      [reg_no, it.rows[0].counter_id, menu_item_id, it.rows[0].price_paise, mode, !!parcel]);
    await client.query("COMMIT");
    res.status(201).json({ order_id: Number(o.rows[0].id), amount_paise: o.rows[0].amount_paise,
                           mode, status: "pending" });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}));

// Confirms payment and issues the pickup code. UPI arrives here from Razorpay,
// cash arrives here when the cashier taps confirm. Both get the same code.
app.post("/orders/:id/confirm", route(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await pool.query("SELECT status FROM orders WHERE id = $1", [id]);
  if (!cur.rowCount) return res.status(404).json({ error: "no_such_order" });
  if (cur.rows[0].status !== "pending") return res.status(409).json({ error: "not_pending", status: cur.rows[0].status });

  const r = await pool.query("SELECT issue_otp($1) AS code", [id]);
  const info = await pool.query("SELECT expires_at, counter_id FROM orders WHERE id = $1", [id]);
  res.json({ order_id: id, code: r.rows[0].code,
             counter_id: info.rows[0].counter_id, expires_at: info.rows[0].expires_at });
}));

// Cancels an unpaid order and puts the portion back on the shelf.
app.post("/orders/:id/cancel", route(async (req, res) => {
  const id = Number(req.params.id);
  const r = await pool.query(
    `UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending'
     RETURNING menu_item_id`, [id]);
  if (!r.rowCount) return res.status(409).json({ error: "not_pending" });
  await pool.query("SELECT return_stock($1)", [r.rows[0].menu_item_id]);
  res.json({ ok: true });
}));

// The counter scans or types the code. A code works exactly once.
app.post("/redeem", route(async (req, res) => {
  const counter_id = Number(req.body?.counter_id);
  const code = String(req.body?.code || "").trim();
  if (!counter_id || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "counter_and_6_digit_code_required" });

  const r = await pool.query("SELECT redeem_otp($1,$2) AS id", [counter_id, code]);
  const id = r.rows[0].id;
  if (!id) return res.status(409).json({ served: false, reason: "invalid_expired_or_already_used" });

  const d = await pool.query(
    `SELECT o.id, o.reg_no, o.parcel, m.name AS item
       FROM orders o JOIN menu_items m ON m.id = o.menu_item_id WHERE o.id = $1`, [id]);
  res.json({ served: true, order: d.rows[0] });
}));

// Cash orders waiting for a cashier to confirm them.
app.get("/counter/:id/pending-cash", route(async (req, res) => {
  const r = await pool.query(
    `SELECT o.id, o.reg_no, o.amount_paise, m.name AS item, o.created_at
       FROM orders o JOIN menu_items m ON m.id = o.menu_item_id
      WHERE o.counter_id = $1 AND o.status = 'pending' AND o.mode = 'cash'
      ORDER BY o.created_at`, [Number(req.params.id)]);
  res.json(r.rows);
}));

// Lets staff set an item's remaining count, including straight to zero.
app.post("/stock", route(async (req, res) => {
  const { menu_item_id, remaining } = req.body || {};
  if (!menu_item_id || remaining === undefined) return res.status(400).json({ error: "item_and_remaining_required" });
  if (Number(remaining) < 0) return res.status(400).json({ error: "remaining_negative" });
  await pool.query(
    `INSERT INTO stock (menu_item_id, remaining) VALUES ($1,$2)
     ON CONFLICT (menu_item_id) DO UPDATE SET remaining = EXCLUDED.remaining`,
    [menu_item_id, Number(remaining)]);
  res.json({ ok: true });
}));

// Feedback and bug reports, from both hostels, into the same table.
app.post("/feedback", route(async (req, res) => {
  const { reg_no, block_id, kind, rating, message } = req.body || {};
  if (!["feedback", "bug"].includes(kind)) return res.status(400).json({ error: "kind_must_be_feedback_or_bug" });
  if (!message) return res.status(400).json({ error: "message_required" });
  const r = await pool.query(
    `INSERT INTO feedback (reg_no, block_id, kind, rating, message)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [reg_no || null, block_id || null, kind, rating || null, message]);
  res.status(201).json({ id: Number(r.rows[0].id) });
}));

app.get("/feedback", route(async (req, res) => {
  const kind = req.query.kind;
  const r = await pool.query(
    `SELECT f.*, b.name AS block FROM feedback f LEFT JOIN blocks b ON b.id = f.block_id
      WHERE ($1::text IS NULL OR f.kind = $1) ORDER BY f.created_at DESC LIMIT 100`,
    [kind || null]);
  res.json(r.rows);
}));

// The four dashboard numbers plus demand in ten-minute buckets.
app.get("/admin/summary", route(async (req, res) => {
  const type = req.query.hostel_type || null;
  const args = [type];
  const totals = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE o.status <> 'cancelled')            AS orders_tonight,
            COUNT(*) FILTER (WHERE o.status = 'served')                AS meals_served,
            COALESCE(SUM(o.amount_paise) FILTER (WHERE o.status IN ('paid','served')),0) AS collections_paise
       FROM orders o JOIN counters c ON c.id = o.counter_id
       JOIN blocks b ON b.id = c.block_id
      WHERE ($1::text IS NULL OR b.hostel_type = $1)`, args);
  const buckets = await pool.query(
    `SELECT to_char(date_trunc('hour', o.created_at)
              + floor(extract(minute FROM o.created_at)/10) * interval '10 min', 'HH24:MI') AS slot,
            COUNT(*) AS orders
       FROM orders o JOIN counters c ON c.id = o.counter_id
       JOIN blocks b ON b.id = c.block_id
      WHERE ($1::text IS NULL OR b.hostel_type = $1)
      GROUP BY 1 ORDER BY 1`, args);
  res.json({ ...totals.rows[0], demand: buckets.rows });
}));

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`nightit-api listening on ${port}`));
}
module.exports = app;
