const pool = require("./index");

async function main() {
  try {
    const now = await pool.query("SELECT NOW()");
    console.log("Connected. Server time:", now.rows[0].now);

    const tables = await pool.query(
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'",
    );
    console.log("Tables in public schema:", tables.rows[0].count);
  } catch (err) {
    console.error("Connection test failed:", err.message);
  } finally {
    await pool.end();
  }
}

main();
