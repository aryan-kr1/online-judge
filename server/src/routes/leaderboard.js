const express = require("express");
const pool = require("../db");
const { authenticate, requireAdmin } = require("../middleware/auth");
const { connection } = require("../queue");
const { createLeaderboard } = require("../leaderboard");

const router = express.Router();
const leaderboard = createLeaderboard({ pool, redis: connection });

const MAX_INT = 2147483647;

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_INT ? n : null;
}

// Rows are empty before the contest starts (admins can always look).
router.get("/:id/leaderboard", authenticate, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: "Contest not found" });

  try {
    const c = await pool.query(
      `SELECT c.id, c.title, c.starts_at, c.ends_at,
              CASE WHEN now() < c.starts_at THEN 'upcoming'
                   WHEN now() < c.ends_at THEN 'running'
                   ELSE 'ended' END AS state,
              now() AS server_time
       FROM contests c WHERE c.id = $1`,
      [id],
    );
    if (c.rows.length === 0) {
      return res.status(404).json({ error: "Contest not found" });
    }
    const contest = c.rows[0];

    let problems = [];
    let rows = [];
    if (contest.state !== "upcoming" || req.user.role === "admin") {
      const p = await pool.query(
        `SELECT label, problem_id FROM contest_problems
         WHERE contest_id = $1 ORDER BY position`,
        [id],
      );
      problems = p.rows;
      rows = await leaderboard.read(id);
    }
    return res.json({ contest, problems, rows });
  } catch (err) {
    console.error("Leaderboard error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Rebuilds the cached board from Postgres (for fixing a wiped or wrong cache).
router.post(
  "/:id/leaderboard/rebuild",
  authenticate,
  requireAdmin,
  async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: "Contest not found" });

    try {
      const c = await pool.query("SELECT 1 FROM contests WHERE id = $1", [id]);
      if (c.rows.length === 0) {
        return res.status(404).json({ error: "Contest not found" });
      }
      await leaderboard.rebuild(id);
      return res.json({ ok: true });
    } catch (err) {
      console.error("Leaderboard rebuild error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

module.exports = router;
