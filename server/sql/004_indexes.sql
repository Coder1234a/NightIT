-- Built last so a re-run always lands on clean data.
--
-- The whole scalability guarantee is the WHERE clause. A code must only be
-- unique among orders still waiting at one counter, so serving an order frees
-- its code again and the six-digit space never fills up. Nothing is purged.
--
-- Note: CREATE UNIQUE INDEX IF NOT EXISTS is silently a no-op when a
-- non-unique index of the same name already exists, which would leave the
-- guarantee switched off. Always drop first.
DROP INDEX IF EXISTS orders_active_otp;
CREATE UNIQUE INDEX orders_active_otp
  ON orders (counter_id, otp_hash) WHERE status = 'paid';
