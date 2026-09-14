const { Pool } = require("pg");

// One connection pool for the whole process. Render needs SSL; local does not.
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "");

// DEMO_TIME pins the app's clock so a 6 AM presentation still shows an open
// mess. It is set as a connection option, which arrives with the handshake and
// cannot race against the first query. Leave it unset in real use.
const options = process.env.DEMO_TIME
  ? `-c nightit.now=${process.env.DEMO_TIME}`
  : undefined;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  options,
  max: 8,
});

module.exports = { pool };
