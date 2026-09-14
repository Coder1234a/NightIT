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
  const always = process.argv.includes("--seed");
  const ifEmpty = process.argv.includes("--seed-if-empty");

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
