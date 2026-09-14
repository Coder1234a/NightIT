-- The night window crosses midnight, so plain time comparison is wrong:
-- 23:00 is BEFORE 00:15 on the same night. These put every time on one scale.
CREATE OR REPLACE FUNCTION night_min(t time)
RETURNS int AS $$
  SELECT (extract(epoch FROM t)/60)::int
       + CASE WHEN t < time '12:00' THEN 1440 ELSE 0 END;
$$ LANGUAGE sql IMMUTABLE;

-- The clock the app runs on. A demo can pin it with SET nightit.now = '23:00'.
CREATE OR REPLACE FUNCTION night_now()
RETURNS time AS $$
  SELECT COALESCE(NULLIF(current_setting('nightit.now', true), '')::time, localtime);
$$ LANGUAGE sql STABLE;

-- Takes one portion off the shelf only if a portion is actually there.
CREATE OR REPLACE FUNCTION take_stock(p_item int, p_qty int DEFAULT 1)
RETURNS boolean AS $$
DECLARE n int;
BEGIN
  UPDATE stock SET remaining = remaining - p_qty
   WHERE menu_item_id = p_item AND remaining >= p_qty;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$ LANGUAGE plpgsql;

-- Puts portions back when a cart is cancelled.
CREATE OR REPLACE FUNCTION return_stock(p_order bigint)
RETURNS void AS $$
  UPDATE stock s SET remaining = s.remaining + oi.qty
    FROM order_items oi
   WHERE oi.order_id = p_order AND oi.menu_item_id = s.menu_item_id;
$$ LANGUAGE sql;

-- Marks a cart paid, gives it the next queue number at its counter, and
-- returns a random six-digit pickup code. Only the hash of the code is kept,
-- so the code itself exists in one place: the student's screen.
CREATE OR REPLACE FUNCTION issue_otp(p_order bigint, p_minutes int DEFAULT 90)
RETURNS text AS $$
DECLARE
  b bytea; code text; v_counter int; v_queue int; updated int;
BEGIN
  SELECT counter_id INTO v_counter FROM orders WHERE id = p_order;
  IF v_counter IS NULL THEN RAISE EXCEPTION 'order % not found', p_order; END IF;

  SELECT COALESCE(MAX(queue_no), 0) + 1 INTO v_queue
    FROM orders
   WHERE counter_id = v_counter AND paid_at::date = current_date;

  FOR attempt IN 1..8 LOOP
    b := gen_random_bytes(4);
    code := lpad(((get_byte(b,0)::bigint * 16777216 + get_byte(b,1) * 65536
                 + get_byte(b,2) * 256 + get_byte(b,3)) % 1000000)::text, 6, '0');
    BEGIN
      UPDATE orders
         SET status = 'paid', queue_no = v_queue, paid_at = now(),
             otp_hash = digest(code || v_counter::text || current_date::text, 'sha256'),
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

-- Serves a cart only if the code matches, it is unserved and not expired.
-- A cart that the counter has already marked ready may also be served.
CREATE OR REPLACE FUNCTION redeem_otp(p_counter int, p_code text)
RETURNS bigint AS $$
  UPDATE orders SET status = 'served', served_at = now()
   WHERE counter_id = p_counter AND status IN ('paid','ready') AND expires_at > now()
     AND otp_hash = digest(p_code || p_counter::text || current_date::text, 'sha256')
  RETURNING id;
$$ LANGUAGE sql;
