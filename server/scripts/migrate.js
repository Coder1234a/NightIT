require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("../db");

// Runs every .sql file in sql/ in name order. Safe to re-run.
(async () => {
  const dir = path.join(__dirname, "..", "sql");
  const withSeed = process.argv.includes("--seed");
  for (const f of fs.readdirSync(dir).sort()) {
    if (f.includes("seed") && !withSeed) continue;
    process.stdout.write(`running ${f} ... `);
    await pool.query(fs.readFileSync(path.join(dir, f), "utf8"));
    console.log("ok");
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
