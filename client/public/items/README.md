# Menu photos

One file per menu item, named after the item in lower case with hyphens.
`Cheese Maggi` is `cheese-maggi.jpg`. The name comes from `image_url` on the
menu row, which `server/scripts/gen_seed.py` derives from the item name — so
if you rename an item in the seed, rename the file too.

## Every item has one

All 31 items in the catalogue have a picture: 0 without.
Items that had no photo were taken out of the catalogue rather than shown as a
coloured tile beside photographed ones — a half-illustrated menu reads worse
than a smaller one.

The illustrations are squared to 400x400 on the app's own paper colour, so a
thumbnail has no white box around it on a cream card. All under 20 KB.

## The fallback still exists

If a file goes missing the row falls back to a coloured tile rather than
breaking. That is a safety net, not a design — keep the set complete.

## Adding an item back

Two steps, both needed:

1. Put the picture here. Square, 400x400 or larger, JPEG, under 80 KB, on a
   `#fff9f4` background rather than white.
2. Add the item to `CATALOGUE` in `server/scripts/gen_seed.py`, re-run that
   script, and reseed.

Real photographs of your own block's counter will beat stock art every time.
If somebody is going down there, shoot them square and close.

## One that is deliberately absent

The sheet we were sent included a picture of a Nestle Maggi retail packet, with
the real wordmark and pack design. That is somebody's trademark, so it is not
in here. `maggi.jpg` is a bowl of noodles.
