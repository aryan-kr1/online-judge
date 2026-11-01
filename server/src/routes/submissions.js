const express = require("express");
const pool = require("../db");
const { authenticate } = require("../middleware/auth");
const { submissionQueue } = require("../queue");

const router = express.Router();

const LANGUAGES = ["python", "cpp"];
const MAX_CODE_BYTES = 100000;
const MAX_INT = 2147483647;
const HISTORY_LIMIT = 50;
const MAX_PENDING = 5;

router.post("/", authenticate, async (req, res) => {
  const { problem_id, language, code } = req.body || {};
  const contestId =
    req.body && req.body.contest_id !== undefined ? req.body.contest_id : null;

  if (!Number.isInteger(problem_id) || problem_id < 1 || problem_id > MAX_INT) {
    return res
      .status(400)
      .json({ error: "problem_id must be a positive integer" });
  }
  if (
    contestId !== null &&
    (!Number.isInteger(contestId) || contestId < 1 || contestId > MAX_INT)
  ) {
    return res
      .status(400)
      .json({ error: "contest_id must be a positive integer" });
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

    if (contestId !== null) {
      // Contest submission: the contest must be running and own this problem.
      const contest = await pool.query(
        `SELECT (now() >= starts_at AND now() < ends_at) AS running
         FROM contests WHERE id = $1`,
        [contestId],
      );
      if (contest.rows.length === 0) {
        return res.status(404).json({ error: "Contest not found" });
      }
      if (!contest.rows[0].running) {
        return res.status(403).json({ error: "This contest is not running" });
      }
      const member = await pool.query(
        "SELECT 1 FROM contest_problems WHERE contest_id = $1 AND problem_id = $2",
        [contestId, problem_id],
      );
      if (member.rows.length === 0) {
        return res
          .status(400)
          .json({ error: "This problem is not part of that contest" });
      }
    } else if (req.user.role !== "admin") {
      // Practice submission: not allowed while a contest with this problem is
      // upcoming or running.
      const locked = await pool.query(
        `SELECT 1 FROM contest_problems cp
         JOIN contests c ON c.id = cp.contest_id
         WHERE cp.problem_id = $1 AND c.ends_at > now()
         LIMIT 1`,
        [problem_id],
      );
      if (locked.rows.length > 0) {
        return res.status(403).json({
          error: "This problem belongs to a contest that has not ended yet",
        });
      }
    }

    // Cap on unfinished submissions per user (recent ones only, so a crashed
    // worker cannot block someone forever).
    const pending = await pool.query(
      `SELECT count(*)::int AS n FROM submissions
       WHERE user_id = $1 AND status IN ('Queued', 'Running')
         AND created_at > now() - interval '10 minutes'`,
      [req.user.id],
    );
    if (pending.rows[0].n >= MAX_PENDING) {
      return res.status(429).json({
        error: `Too many submissions waiting (max ${MAX_PENDING}). Wait for some to finish.`,
      });
    }

    const result = await pool.query(
      `INSERT INTO submissions (user_id, problem_id, contest_id, language, code)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, problem_id, contest_id, language, status, created_at`,
      [req.user.id, problem_id, contestId, language, code],
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

// My submissions, newest first. Optional filter: ?problem_id=N
router.get("/", authenticate, async (req, res) => {
  const params = [req.user.id];
  let filter = "";

  if (req.query.problem_id !== undefined) {
    const raw = String(req.query.problem_id);
    const problemId = Number(raw);
    if (!/^\d+$/.test(raw) || problemId < 1 || problemId > MAX_INT) {
      return res
        .status(400)
        .json({ error: "problem_id must be a positive integer" });
    }
    params.push(problemId);
    filter = "AND s.problem_id = $2";
  }

  try {
    const result = await pool.query(
      `SELECT s.id, s.problem_id, s.contest_id, p.slug AS problem_slug,
              p.title AS problem_title, s.language, s.status, s.time_ms, s.created_at
       FROM submissions s
       JOIN problems p ON p.id = s.problem_id
       WHERE s.user_id = $1 ${filter}
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT ${HISTORY_LIMIT}`,
      params,
    );
    return res.json({ submissions: result.rows });
  } catch (err) {
    console.error("List submissions error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// One of my submissions, including the code. Only the owner can read it.
router.get("/:id", authenticate, async (req, res) => {
  if (!/^\d+$/.test(req.params.id) || Number(req.params.id) > MAX_INT) {
    return res.status(404).json({ error: "Submission not found" });
  }
  const id = Number(req.params.id);

  try {
    const result = await pool.query(
      `SELECT s.id, s.problem_id, s.contest_id, p.slug AS problem_slug,
              p.title AS problem_title, s.language, s.code, s.status, s.time_ms,
              s.error_message, s.created_at
       FROM submissions s
       JOIN problems p ON p.id = s.problem_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [id, req.user.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Submission not found" });
    }
    return res.json({ submission: result.rows[0] });
  } catch (err) {
    console.error("Get submission error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
