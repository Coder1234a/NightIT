-- Built last so a re-run always lands on clean data.
--
-- The scalability guarantee is the WHERE clause: a pickup code only has to be
-- unique among carts still waiting at one counter. Serving a cart frees its
-- code, so the six-digit space never fills up and nothing is ever purged.
--
-- CREATE UNIQUE INDEX IF NOT EXISTS is silently a no-op when a non-unique
-- index of the same name exists, which would switch the guarantee off without
-- an error. Always drop first.
DROP INDEX IF EXISTS orders_active_otp;
CREATE UNIQUE INDEX orders_active_otp
  ON orders (counter_id, otp_hash) WHERE status IN ('paid','ready');

CREATE INDEX IF NOT EXISTS orders_counter_status ON orders (counter_id, status);
CREATE INDEX IF NOT EXISTS orders_queue ON orders (counter_id, queue_no);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items (order_id);
