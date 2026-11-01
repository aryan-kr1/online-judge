const express = require("express");
const pool = require("../db");
const { authenticate, requireAdmin } = require("../middleware/auth");

const router = express.Router();

const MAX_INT = 2147483647;
const MAX_PROBLEMS = 26;
const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

// Computed with the database clock so every check uses the same time source.
const STATE_SQL = `CASE WHEN now() < c.starts_at THEN 'upcoming'
                        WHEN now() < c.ends_at THEN 'running'
                        ELSE 'ended' END`;

class BadRequest extends Error {}
class NotFound extends Error {}
class Conflict extends Error {}

function fail(res, err, what) {
  if (err instanceof BadRequest) {
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof NotFound) {
    return res.status(404).json({ error: err.message });
  }
  if (err instanceof Conflict) {
    return res.status(409).json({ error: err.message });
  }
  console.error(what, err);
  return res.status(500).json({ error: "Internal server error" });
}

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_INT ? n : null;
}

function isAdmin(req) {
  return Boolean(req.user && req.user.role === "admin");
}

// Needs an explicit timezone so "18:00" can never mean the server's local time.
function parseDate(value) {
  if (typeof value !== "string" || !HAS_OFFSET.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseProblemIds(value) {
  if (!Array.isArray(value) || value.length > MAX_PROBLEMS) return null;
  const ok = value.every((v) => Number.isInteger(v) && v >= 1 && v <= MAX_INT);
  if (!ok || new Set(value).size !== value.length) return null;
  return value;
}

function checkText(title, description) {
  if (typeof title !== "string" || title.trim() === "" || title.length > 200) {
    return "title is required (max 200 characters)";
  }
  if (typeof description !== "string" || description.length > 5000) {
    return "description must be text (max 5000 characters)";
  }
  if (title.includes("\u0000") || description.includes("\u0000")) {
    return "title and description contain invalid characters";
  }
  return null;
}

const DATE_ERROR =
  "starts_at and ends_at must be ISO timestamps with a timezone, like 2026-11-05T18:00:00+05:30";
const IDS_ERROR = `problem_ids must be an array of up to ${MAX_PROBLEMS} distinct problem ids`;

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Replaces the contest's problem list. Labels A, B, C... follow the array order.
async function setProblems(client, contestId, ids) {
  if (ids.length > 0) {
    const found = await client.query(
      "SELECT id FROM problems WHERE id = ANY($1::int[])",
      [ids],
    );
    if (found.rows.length !== ids.length) {
      throw new BadRequest("One or more problem_ids do not exist");
    }
  }
  await client.query("DELETE FROM contest_problems WHERE contest_id = $1", [
    contestId,
  ]);
  if (ids.length > 0) {
    await client.query(
      `INSERT INTO contest_problems (contest_id, problem_id, label, position)
       SELECT $1::int, t.pid, substr($3::text, t.ord::int, 1), t.ord::int - 1
       FROM unnest($2::int[]) WITH ORDINALITY AS t(pid, ord)`,
      [contestId, ids, LABELS],
    );
  }
}

async function loadContest(db, id) {
  const r = await db.query(
    `SELECT c.id, c.title, c.description, c.starts_at, c.ends_at,
            ${STATE_SQL} AS state, now() AS server_time
     FROM contests c WHERE c.id = $1`,
    [id],
  );
  return r.rows[0] || null;
}

async function loadProblems(db, id) {
  const r = await db.query(
    `SELECT cp.label, cp.position, p.id AS problem_id, p.slug, p.title, p.difficulty
     FROM contest_problems cp
     JOIN problems p ON p.id = cp.problem_id
     WHERE cp.contest_id = $1
     ORDER BY cp.position`,
    [id],
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Any logged-in user
// ---------------------------------------------------------------------------

router.get("/", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.title, c.starts_at, c.ends_at, ${STATE_SQL} AS state,
              (SELECT count(*)::int FROM contest_problems cp
               WHERE cp.contest_id = c.id) AS problem_count
       FROM contests c
       ORDER BY c.starts_at DESC, c.id DESC`,
    );
    return res.json({ contests: result.rows });
  } catch (err) {
    return fail(res, err, "List contests error:");
  }
});

router.get("/:id", authenticate, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: "Contest not found" });

  try {
    const contest = await loadContest(pool, id);
    if (!contest) return res.status(404).json({ error: "Contest not found" });

    // Problems stay hidden until the contest starts (admins can always see them).
    const problems =
      contest.state !== "upcoming" || isAdmin(req)
        ? await loadProblems(pool, id)
        : [];
    return res.json({ contest, problems });
  } catch (err) {
    return fail(res, err, "Get contest error:");
  }
});

// ---------------------------------------------------------------------------
// Admin only
// ---------------------------------------------------------------------------

router.post("/", authenticate, requireAdmin, async (req, res) => {
  const body = req.body || {};
  const title = body.title;
  const description = body.description === undefined ? "" : body.description;

  const textError = checkText(title, description);
  if (textError) return res.status(400).json({ error: textError });

  const startsAt = parseDate(body.starts_at);
  const endsAt = parseDate(body.ends_at);
  if (!startsAt || !endsAt) {
    return res.status(400).json({ error: DATE_ERROR });
  }
  if (endsAt <= startsAt) {
    return res.status(400).json({ error: "ends_at must be after starts_at" });
  }

  const problemIds =
    body.problem_ids === undefined ? [] : parseProblemIds(body.problem_ids);
  if (problemIds === null) {
    return res.status(400).json({ error: IDS_ERROR });
  }

  try {
    const id = await inTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO contests (title, description, starts_at, ends_at, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          title.trim(),
          description,
          startsAt.toISOString(),
          endsAt.toISOString(),
          req.user.id,
        ],
      );
      await setProblems(client, r.rows[0].id, problemIds);
      return r.rows[0].id;
    });
    return res.status(201).json({
      contest: await loadContest(pool, id),
      problems: await loadProblems(pool, id),
    });
  } catch (err) {
    return fail(res, err, "Create contest error:");
  }
});

// All fields optional. After the contest starts only title, description and
// ends_at can change; after it ends nothing can.
router.put("/:id", authenticate, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: "Contest not found" });
  const body = req.body || {};

  try {
    await inTransaction(async (client) => {
      const found = await client.query(
        `SELECT c.*, ${STATE_SQL} AS state
         FROM contests c WHERE c.id = $1 FOR UPDATE OF c`,
        [id],
      );
      if (found.rows.length === 0) throw new NotFound("Contest not found");
      const cur = found.rows[0];

      if (cur.state === "ended") {
        throw new Conflict("The contest has ended and cannot be changed");
      }
      if (cur.state === "running" && body.starts_at !== undefined) {
        throw new Conflict("starts_at cannot change after the contest started");
      }
      if (cur.state === "running" && body.problem_ids !== undefined) {
        throw new Conflict("Problems cannot change after the contest started");
      }

      const title = body.title !== undefined ? body.title : cur.title;
      const description =
        body.description !== undefined ? body.description : cur.description;
      const textError = checkText(title, description);
      if (textError) throw new BadRequest(textError);

      const startsAt =
        body.starts_at !== undefined
          ? parseDate(body.starts_at)
          : new Date(cur.starts_at);
      const endsAt =
        body.ends_at !== undefined
          ? parseDate(body.ends_at)
          : new Date(cur.ends_at);
      if (!startsAt || !endsAt) throw new BadRequest(DATE_ERROR);
      if (endsAt <= startsAt) {
        throw new BadRequest("ends_at must be after starts_at");
      }

      let problemIds = null;
      if (body.problem_ids !== undefined) {
        problemIds = parseProblemIds(body.problem_ids);
        if (problemIds === null) throw new BadRequest(IDS_ERROR);
      }

      await client.query(
        `UPDATE contests
         SET title = $1, description = $2, starts_at = $3, ends_at = $4
         WHERE id = $5`,
        [
          title.trim(),
          description,
          startsAt.toISOString(),
          endsAt.toISOString(),
          id,
        ],
      );
      if (problemIds) await setProblems(client, id, problemIds);
    });

    return res.json({
      contest: await loadContest(pool, id),
      problems: await loadProblems(pool, id),
    });
  } catch (err) {
    return fail(res, err, "Update contest error:");
  }
});

// Submissions made in the contest stay, but lose their contest_id.
router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: "Contest not found" });

  try {
    const r = await pool.query("DELETE FROM contests WHERE id = $1", [id]);
    if (r.rowCount === 0) {
      return res.status(404).json({ error: "Contest not found" });
    }
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err, "Delete contest error:");
  }
});

module.exports = router;
