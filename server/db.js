const { Pool } = require("pg");

// One connection pool for the whole process. Render needs SSL; local does not.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "");

// Render runs in UTC, so without this the database thinks 23:00 IST is 17:30
// and every night item reads as closed. Pin the connection to India time.
// DEMO_TIME additionally freezes the clock, so an off-hours demo (the 6 AM
// judging slot) still shows an open mess. Leave DEMO_TIME unset in real use.
const settings = [`-c timezone=${process.env.TZ || "Asia/Kolkata"}`];
if (process.env.DEMO_TIME) settings.push(`-c nightit.now=${process.env.DEMO_TIME}`);
const options = settings.join(" ");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  options,
  max: 8,
});

module.exports = { pool };
