-- Two blocks configured deliberately differently, to show that per-block
-- behaviour is data and not code.
TRUNCATE feedback, order_items, orders, stock, menu_items, counters, blocks
  RESTART IDENTITY CASCADE;

INSERT INTO blocks (name, hostel_type, opens_at, closes_at) VALUES
  ('M-Block','mens','22:30','00:30'),
  ('LH-2','ladies','22:30','00:00');

INSERT INTO counters (block_id, name, avg_service_seconds) VALUES
  (1,'M-Block Night Counter',95),
  (2,'LH-2 Night Counter',75);

INSERT INTO menu_items (counter_id, name, price_paise, prep_minutes, cutoff_at) VALUES
  (1,'Maggi',4000,6,'00:15'),
  (1,'French fries',6000,9,'00:00'),
  (1,'Veg fried rice',9000,14,'23:45'),
  (1,'Cold coffee',5000,4,'00:20'),
  (2,'Maggi',4000,6,'23:50'),
  (2,'Masala dosa',7000,11,'23:30'),
  (2,'Paneer roll',8000,10,'23:45'),
  (2,'Lemon tea',2500,3,'23:55');

INSERT INTO stock (menu_item_id, remaining) VALUES
  (1,40),(2,0),(3,15),(4,25),(5,30),(6,12),(7,18),(8,50);
