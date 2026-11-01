const express = require("express");
const pool = require("../db");
const { authenticate, requireAdmin } = require("../middleware/auth");

const router = express.Router();

const SLUG_RE = /^[a-z0-9-]+$/;
const DIFFICULTIES = ["easy", "medium", "hard"];
const MAX_INT = 2147483647;

// A problem is hidden from non-admins while any contest containing it has not
// started yet. Uses the alias "p" for the problems table.
const NOT_IN_UPCOMING_CONTEST = `NOT EXISTS (
  SELECT 1 FROM contest_problems cp
  JOIN contests c ON c.id = cp.contest_id
  WHERE cp.problem_id = p.id AND c.starts_at > now()
)`;

function parseId(value) {
  if (!/^\d+$/.test(value)) return null;
  const n = parseInt(value, 10);
  return n <= MAX_INT ? n : null;
}

// Validates only the fields that are present (or all required ones on create).
// Returns { error } or { values } containing whitelisted columns only.
function validateProblemFields(body, isCreate) {
  const values = {};

  if (isCreate || body.slug !== undefined) {
    const slug = typeof body.slug === "string" ? body.slug.trim() : "";
    if (!slug || slug.length > 100 || !SLUG_RE.test(slug)) {
      return {
        error:
          "slug must be lowercase letters, digits and hyphens (max 100 chars)",
      };
    }
    values.slug = slug;
  }

  if (isCreate || body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) {
      return { error: "title is required (max 200 chars)" };
    }
    values.title = title;
  }

  if (isCreate || body.statement !== undefined) {
    const statement =
      typeof body.statement === "string" ? body.statement.trim() : "";
    if (!statement) {
      return { error: "statement is required" };
    }
    values.statement = statement;
  }

  if (body.difficulty !== undefined) {
    if (!DIFFICULTIES.includes(body.difficulty)) {
      return { error: "difficulty must be easy, medium or hard" };
    }
    values.difficulty = body.difficulty;
  }

  if (body.time_limit_ms !== undefined) {
    const t = body.time_limit_ms;
    if (!Number.isInteger(t) || t < 100 || t > 10000) {
      return { error: "time_limit_ms must be an integer from 100 to 10000" };
    }
    values.time_limit_ms = t;
  }

  if (body.memory_limit_mb !== undefined) {
    const m = body.memory_limit_mb;
    if (!Number.isInteger(m) || m < 16 || m > 1024) {
      return { error: "memory_limit_mb must be an integer from 16 to 1024" };
    }
    values.memory_limit_mb = m;
  }

  for (const field of ["reference_solution", "test_generator"]) {
    if (body[field] !== undefined) {
      if (body[field] !== null && typeof body[field] !== "string") {
        return { error: `${field} must be a string or null` };
      }
      values[field] = body[field];
    }
  }

  return { values };
}

// ---------- Logged-in users ----------

router.get("/", authenticate, async (req, res) => {
  const isAdmin = req.user.role === "admin";

  try {
    const result = await pool.query(
      `SELECT p.id, p.slug, p.title, p.difficulty
       FROM problems p
       ${isAdmin ? "" : `WHERE ${NOT_IN_UPCOMING_CONTEST}`}
       ORDER BY p.created_at DESC, p.id DESC`,
    );
    return res.json({ problems: result.rows });
  } catch (err) {
    console.error("List problems error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:slug", authenticate, async (req, res) => {
  const isAdmin = req.user.role === "admin";

  try {
    const problemResult = await pool.query(
      `SELECT p.id, p.slug, p.title, p.statement, p.difficulty,
              p.time_limit_ms, p.memory_limit_mb
       FROM problems p
       WHERE p.slug = $1
       ${isAdmin ? "" : `AND ${NOT_IN_UPCOMING_CONTEST}`}`,
      [req.params.slug],
    );
    const problem = problemResult.rows[0];
    if (!problem) {
      return res.status(404).json({ error: "Problem not found" });
    }

    const samples = await pool.query(
      `SELECT id, input, expected_output, position
       FROM test_cases
       WHERE problem_id = $1 AND is_sample = true
       ORDER BY position, id`,
      [problem.id],
    );

    return res.json({
      problem: { ...problem, sample_test_cases: samples.rows },
    });
  } catch (err) {
    console.error("Get problem error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- Admin ----------

router.post("/", authenticate, requireAdmin, async (req, res) => {
  const { error, values } = validateProblemFields(req.body, true);
  if (error) return res.status(400).json({ error });

  const columns = [...Object.keys(values), "created_by"];
  const params = [...Object.values(values), req.user.id];
  const placeholders = params.map((_, i) => `$${i + 1}`);

  try {
    const result = await pool.query(
      `INSERT INTO problems (${columns.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING id, slug, title, statement, difficulty, time_limit_ms, memory_limit_mb`,
      params,
    );
    return res.status(201).json({ problem: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Slug already taken" });
    }
    console.error("Create problem error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", authenticate, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid problem id" });

  const { error, values } = validateProblemFields(req.body, false);
  if (error) return res.status(400).json({ error });

  const keys = Object.keys(values);
  if (keys.length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(", ");
  const params = [...Object.values(values), id];

  try {
    const result = await pool.query(
      `UPDATE problems SET ${setClause}
       WHERE id = $${params.length}
       RETURNING id, slug, title, statement, difficulty, time_limit_ms, memory_limit_mb`,
      params,
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Problem not found" });
    }
    return res.json({ problem: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Slug already taken" });
    }
    console.error("Update problem error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid problem id" });

  try {
    const result = await pool.query(
      "DELETE FROM problems WHERE id = $1 RETURNING id",
      [id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Problem not found" });
    }
    return res.json({ deleted: id });
  } catch (err) {
    console.error("Delete problem error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id/test-cases", authenticate, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid problem id" });

  try {
    const exists = await pool.query("SELECT 1 FROM problems WHERE id = $1", [
      id,
    ]);
    if (exists.rows.length === 0) {
      return res.status(404).json({ error: "Problem not found" });
    }

    const result = await pool.query(
      `SELECT id, input, expected_output, is_sample, position
       FROM test_cases WHERE problem_id = $1 ORDER BY position, id`,
      [id],
    );
    return res.json({ test_cases: result.rows });
  } catch (err) {
    console.error("List test cases error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/test-cases", authenticate, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "Invalid problem id" });

  const { input, expected_output } = req.body;
  const isSample =
    req.body.is_sample === undefined ? false : req.body.is_sample;
  const position = req.body.position === undefined ? 0 : req.body.position;

  if (typeof input !== "string" || typeof expected_output !== "string") {
    return res
      .status(400)
      .json({ error: "input and expected_output must be strings" });
  }
  if (typeof isSample !== "boolean") {
    return res.status(400).json({ error: "is_sample must be true or false" });
  }
  if (!Number.isInteger(position) || position < 0 || position > MAX_INT) {
    return res
      .status(400)
      .json({ error: "position must be a non-negative integer" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO test_cases (problem_id, input, expected_output, is_sample, position)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, problem_id, input, expected_output, is_sample, position`,
      [id, input, expected_output, isSample, position],
    );
    return res.status(201).json({ test_case: result.rows[0] });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(404).json({ error: "Problem not found" });
    }
    console.error("Create test case error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.delete(
  "/:id/test-cases/:testId",
  authenticate,
  requireAdmin,
  async (req, res) => {
    const id = parseId(req.params.id);
    const testId = parseId(req.params.testId);
    if (id === null || testId === null) {
      return res.status(400).json({ error: "Invalid id" });
    }

    try {
      const result = await pool.query(
        "DELETE FROM test_cases WHERE id = $1 AND problem_id = $2 RETURNING id",
        [testId, id],
      );
      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ error: "Test case not found for this problem" });
      }
      return res.json({ deleted: testId });
    } catch (err) {
      console.error("Delete test case error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

module.exports = router;
