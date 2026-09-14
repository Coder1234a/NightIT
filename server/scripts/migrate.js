require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("../db");

// True when the database has no blocks yet, so a first deploy can seed itself
// without a later deploy ever wiping real orders.
async function isEmpty() {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM blocks");
  return r.rows[0].n === 0;
}

// Runs every .sql file in sql/ in name order. Safe to run again and again.
(async () => {
  const dir = path.join(__dirname, "..", "sql");
  // RESEED is the escape hatch for a deploy whose database already has rows.
  // --seed-if-empty deliberately skips the seed once blocks exist, so adding
  // blocks or menu items to the seed file would otherwise never reach a live
  // database. Set RESEED=1 in the dashboard, deploy, then delete the variable.
  const reseed = /^(1|true|yes)$/i.test(process.env.RESEED || "");
  const always = process.argv.includes("--seed") || reseed;
  const ifEmpty = process.argv.includes("--seed-if-empty");
  if (reseed) console.log("RESEED is set — rebuilding blocks, menus and stock "
                        + "from the seed file. Every order will be erased.");

  for (const f of fs.readdirSync(dir).sort()) {
    if (f.includes("seed")) {
      const wanted = always || (ifEmpty && await isEmpty());
      if (!wanted) { console.log(`skipping ${f} (database already has data)`); continue; }
    }
    process.stdout.write(`running ${f} ... `);
    await pool.query(fs.readFileSync(path.join(dir, f), "utf8"));
    console.log("ok");
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
