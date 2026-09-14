-- NightIT schema. Frozen at 3:00 PM on 14 Sep 2026. Do not rename or drop columns after that.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS blocks (
  id           serial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  hostel_type  text NOT NULL CHECK (hostel_type IN ('mens','ladies')),
  opens_at     time NOT NULL DEFAULT '22:30',
  closes_at    time NOT NULL DEFAULT '00:30'
);

CREATE TABLE IF NOT EXISTS counters (
  id                   serial PRIMARY KEY,
  block_id             int NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  avg_service_seconds  int NOT NULL DEFAULT 90
);

CREATE TABLE IF NOT EXISTS menu_items (
  id           serial PRIMARY KEY,
  counter_id   int NOT NULL REFERENCES counters(id) ON DELETE CASCADE,
  name         text NOT NULL,
  price_paise  int  NOT NULL CHECK (price_paise > 0),
  prep_minutes int  NOT NULL DEFAULT 8,
  cutoff_at    time NOT NULL DEFAULT '00:15'
);

CREATE TABLE IF NOT EXISTS stock (
  menu_item_id int PRIMARY KEY REFERENCES menu_items(id) ON DELETE CASCADE,
  remaining    int NOT NULL DEFAULT 0 CHECK (remaining >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id           bigserial PRIMARY KEY,
  reg_no       text NOT NULL,
  counter_id   int  NOT NULL REFERENCES counters(id),
  menu_item_id int  NOT NULL REFERENCES menu_items(id),
  amount_paise int  NOT NULL,
  mode         text NOT NULL CHECK (mode IN ('upi','cash')),
  parcel       boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','paid','served','cancelled')),
  otp_hash     bytea,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  served_at    timestamptz
);

CREATE INDEX IF NOT EXISTS orders_counter_status ON orders (counter_id, status);
CREATE INDEX IF NOT EXISTS orders_created ON orders (created_at);

CREATE TABLE IF NOT EXISTS feedback (
  id         bigserial PRIMARY KEY,
  reg_no     text,
  block_id   int REFERENCES blocks(id),
  kind       text NOT NULL CHECK (kind IN ('feedback','bug')),
  rating     int CHECK (rating BETWEEN 1 AND 5),
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
