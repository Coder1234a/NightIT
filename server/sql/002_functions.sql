-- The night mess window crosses midnight, so times of day cannot be compared
-- directly: 23:00 is "before" 00:15 on the same night, but 23:00 > 00:15 as a
-- plain time. These two helpers put every time on one continuous scale where
-- anything before noon counts as the following day.
CREATE OR REPLACE FUNCTION night_min(t time)
RETURNS int AS $$
  SELECT (extract(epoch FROM t)/60)::int
       + CASE WHEN t < time '12:00' THEN 1440 ELSE 0 END;
$$ LANGUAGE sql IMMUTABLE;

-- The clock the app runs on. Normally the real one; a demo can pin it with
-- SET nightit.now = '23:00' so a 6 AM presentation still shows an open mess.
CREATE OR REPLACE FUNCTION night_now()
RETURNS time AS $$
  SELECT COALESCE(NULLIF(current_setting('nightit.now', true), '')::time, localtime);
$$ LANGUAGE sql STABLE;

-- Draws a random six-digit code for one order and stores only its hash.
-- The code is returned once and never kept in readable form.
CREATE OR REPLACE FUNCTION issue_otp(p_order bigint, p_minutes int DEFAULT 90)
RETURNS text AS $$
DECLARE
  b bytea; code text; v_counter int; updated int;
BEGIN
  SELECT counter_id INTO v_counter FROM orders WHERE id = p_order;
  IF v_counter IS NULL THEN RAISE EXCEPTION 'order % not found', p_order; END IF;

  FOR attempt IN 1..8 LOOP
    b := gen_random_bytes(4);
    code := lpad(((get_byte(b,0)::bigint * 16777216
                 + get_byte(b,1) * 65536
                 + get_byte(b,2) * 256
                 + get_byte(b,3)) % 1000000)::text, 6, '0');
    BEGIN
      UPDATE orders
         SET status     = 'paid',
             otp_hash   = digest(code || v_counter::text || current_date::text, 'sha256'),
             expires_at = now() + make_interval(mins => p_minutes)
       WHERE id = p_order AND status = 'pending';
      GET DIAGNOSTICS updated = ROW_COUNT;
      IF updated = 0 THEN RAISE EXCEPTION 'order % is not pending', p_order; END IF;
      RETURN code;
    EXCEPTION WHEN unique_violation THEN
      NULL;  -- that code is already live at this counter, draw another
    END;
  END LOOP;
  RAISE EXCEPTION 'could not allocate a free code at counter %', v_counter;
END $$ LANGUAGE plpgsql;

-- Serves an order only if the code matches, it is unserved and not expired.
CREATE OR REPLACE FUNCTION redeem_otp(p_counter int, p_code text)
RETURNS bigint AS $$
  UPDATE orders SET status = 'served', served_at = now()
   WHERE counter_id = p_counter AND status = 'paid' AND expires_at > now()
     AND otp_hash = digest(p_code || p_counter::text || current_date::text, 'sha256')
  RETURNING id;
$$ LANGUAGE sql;

-- Takes one portion off the shelf, but only if a portion is actually there.
CREATE OR REPLACE FUNCTION take_stock(p_item int)
RETURNS boolean AS $$
DECLARE n int;
BEGIN
  UPDATE stock SET remaining = remaining - 1
   WHERE menu_item_id = p_item AND remaining > 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$ LANGUAGE plpgsql;

-- Puts a portion back when an order is cancelled.
CREATE OR REPLACE FUNCTION return_stock(p_item int)
RETURNS void AS $$
  UPDATE stock SET remaining = remaining + 1 WHERE menu_item_id = p_item;
$$ LANGUAGE sql;
