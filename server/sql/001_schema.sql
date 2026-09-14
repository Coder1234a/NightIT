-- NightIT schema.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS blocks (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  hostel_type text NOT NULL CHECK (hostel_type IN ('mens','ladies')),
  opens_at time NOT NULL DEFAULT '22:30',
  closes_at time NOT NULL DEFAULT '00:30'
);

CREATE TABLE IF NOT EXISTS counters (
  id serial PRIMARY KEY,
  block_id int NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  name text NOT NULL,
  avg_service_seconds int NOT NULL DEFAULT 90
);

CREATE TABLE IF NOT EXISTS menu_items (
  id serial PRIMARY KEY,
  counter_id int NOT NULL REFERENCES counters(id) ON DELETE CASCADE,
  name text NOT NULL,
  price_paise int NOT NULL CHECK (price_paise > 0),
  prep_minutes int NOT NULL DEFAULT 8,
  cutoff_at time NOT NULL DEFAULT '00:15'
);

CREATE TABLE IF NOT EXISTS stock (
  menu_item_id int PRIMARY KEY REFERENCES menu_items(id) ON DELETE CASCADE,
  remaining int NOT NULL DEFAULT 0 CHECK (remaining >= 0)
);

-- One order is one cart. It can hold several items.
CREATE TABLE IF NOT EXISTS orders (
  id bigserial PRIMARY KEY,
  reg_no text NOT NULL,
  counter_id int NOT NULL REFERENCES counters(id),
  amount_paise int NOT NULL DEFAULT 0,
  mode text NOT NULL CHECK (mode IN ('upi','cash')),
  parcel boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','ready','served','cancelled')),
  queue_no int,
  prep_seconds int NOT NULL DEFAULT 0,
  otp_hash bytea,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz
);

CREATE TABLE IF NOT EXISTS order_items (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id int NOT NULL REFERENCES menu_items(id),
  qty int NOT NULL CHECK (qty > 0),
  unit_price_paise int NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id bigserial PRIMARY KEY,
  reg_no text,
  block_id int REFERENCES blocks(id),
  kind text NOT NULL CHECK (kind IN ('feedback','bug')),
  rating int CHECK (rating BETWEEN 1 AND 5),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Upgrade for a database created by an earlier version.
--
-- CREATE TABLE IF NOT EXISTS leaves an existing table exactly as it was, so a
-- database that already held the single-item version of `orders` would keep
-- the old columns and be missing the new ones. Everything below is written to
-- be a no-op on a fresh database and a repair on an old one, and it is safe to
-- run any number of times.
-- ---------------------------------------------------------------------------

ALTER TABLE orders ADD COLUMN IF NOT EXISTS queue_no     int;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS prep_seconds int NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at      timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ready_at     timestamptz;
ALTER TABLE orders ALTER COLUMN amount_paise SET DEFAULT 0;

-- A cart's contents live in order_items now, so the single item column on the
-- order itself is gone. Move anything an old row still holds across first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'orders' AND column_name = 'menu_item_id') THEN
    INSERT INTO order_items (order_id, menu_item_id, qty, unit_price_paise)
    SELECT o.id, o.menu_item_id, 1, o.amount_paise
      FROM orders o
     WHERE o.menu_item_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id);
    ALTER TABLE orders DROP COLUMN menu_item_id;
  END IF;
END $$;

-- 'ready' is a new status, so the old CHECK constraint would reject it.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD  CONSTRAINT orders_status_check
  CHECK (status IN ('pending','paid','ready','served','cancelled'));

-- Carts that were already paid before this upgrade have no queue number, which
-- would leave them unnumbered on the counter screen and invisible to the
-- "how many are ahead of me" count. Give them one, continuing from whatever
-- each counter has already issued.
WITH base AS (
  SELECT counter_id, COALESCE(MAX(queue_no), 0) AS m FROM orders GROUP BY counter_id
), numbered AS (
  SELECT o.id,
         b.m + row_number() OVER (PARTITION BY o.counter_id ORDER BY o.created_at, o.id) AS n
    FROM orders o JOIN base b ON b.counter_id = o.counter_id
   WHERE o.queue_no IS NULL AND o.status IN ('paid','ready')
)
UPDATE orders o SET queue_no = numbered.n, paid_at = COALESCE(o.paid_at, o.created_at)
  FROM numbered WHERE o.id = numbered.id;
