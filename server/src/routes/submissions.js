const express = require("express");
const pool = require("../db");
const { authenticate } = require("../middleware/auth");
const { submissionQueue } = require("../queue");

const router = express.Router();

const LANGUAGES = ["python", "cpp"];
const MAX_CODE_BYTES = 100000;
const MAX_INT = 2147483647;

router.post("/", authenticate, async (req, res) => {
  const { problem_id, language, code } = req.body || {};

  if (!Number.isInteger(problem_id) || problem_id < 1 || problem_id > MAX_INT) {
    return res
      .status(400)
      .json({ error: "problem_id must be a positive integer" });
  }
  if (!LANGUAGES.includes(language)) {
    return res.status(400).json({ error: "language must be python or cpp" });
  }
  if (typeof code !== "string" || code.trim() === "") {
    return res.status(400).json({ error: "code is required" });
  }
  if (code.includes("\u0000")) {
    return res.status(400).json({ error: "code contains invalid characters" });
  }
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    return res.status(400).json({ error: "code is too large (max 100 KB)" });
  }

  let submission;
  try {
    const problem = await pool.query("SELECT 1 FROM problems WHERE id = $1", [
      problem_id,
    ]);
    if (problem.rows.length === 0) {
      return res.status(404).json({ error: "Problem not found" });
    }

    const result = await pool.query(
      `INSERT INTO submissions (user_id, problem_id, language, code)
       VALUES ($1, $2, $3, $4)
       RETURNING id, problem_id, language, status, created_at`,
      [req.user.id, problem_id, language, code],
    );
    submission = result.rows[0];
  } catch (err) {
    console.error("Create submission error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }

  try {
    await submissionQueue.add(
      "judge",
      { submissionId: submission.id },
      { jobId: `sub-${submission.id}` },
    );
  } catch (err) {
    console.error("Enqueue error:", err);
    await pool
      .query("DELETE FROM submissions WHERE id = $1", [submission.id])
      .catch(() => {});
    return res
      .status(503)
      .json({ error: "Judge queue unavailable, try again" });
  }

  return res.status(201).json({ submission });
});

module.exports = router;
