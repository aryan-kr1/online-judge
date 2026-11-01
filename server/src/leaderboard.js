"use strict";

// ICPC-style contest leaderboard.
// Postgres is the source of truth. Redis holds a cached copy:
//   oj:lb:<id>          sorted set, member = user id, score = rank score
//   oj:lb:<id>:detail   hash, user id -> JSON (username and per-problem cells)
//   oj:lb:<id>:ready    marker that the cache has been built
// This file requires nothing from the server or worker, so both can use it.

const PENALTY_MINUTES = 20;
const SCORE_SCALE = 10000000; // score = solved * SCALE - penalty
const MAX_ROWS = 500;
const NOT_FINAL = new Set(["Queued", "Running"]);
const COUNTS_AS_WRONG = new Set([
  "Wrong Answer",
  "Time Limit Exceeded",
  "Memory Limit Exceeded",
  "Runtime Error",
]);

function scoreOf(st) {
  return st.solved * SCORE_SCALE - st.penalty;
}

// Turns a time-ordered list of submissions into one standing per user.
function buildStandings(contest, rows) {
  const byUser = new Map();

  for (const r of rows) {
    if (NOT_FINAL.has(r.status)) continue;
    const label = contest.labelByProblem.get(r.problem_id);
    if (!label) continue;

    let st = byUser.get(r.user_id);
    if (!st) {
      st = {
        userId: r.user_id,
        username: r.username,
        solved: 0,
        penalty: 0,
        problems: {},
      };
      byUser.set(r.user_id, st);
    }

    let cell = st.problems[label];
    if (!cell) {
      cell = { solved: false, attempts: 0, minutes: null };
      st.problems[label] = cell;
    }
    if (cell.solved) continue; // attempts after the first Accepted are ignored

    if (r.status === "Accepted") {
      cell.solved = true;
      cell.minutes = Math.max(
        0,
        Math.floor((new Date(r.created_at) - contest.startsAt) / 60000),
      );
      st.solved += 1;
      st.penalty += cell.minutes + PENALTY_MINUTES * cell.attempts;
    } else if (COUNTS_AS_WRONG.has(r.status)) {
      cell.attempts += 1;
    }
  }

  return byUser;
}

async function runMulti(multi) {
  const results = await multi.exec();
  for (const [err] of results || []) {
    if (err) throw err;
  }
}

function createLeaderboard({ pool, redis }) {
  const keysFor = (id) => ({
    zset: `oj:lb:${id}`,
    detail: `oj:lb:${id}:detail`,
    ready: `oj:lb:${id}:ready`,
  });

  async function loadContest(contestId) {
    const c = await pool.query(
      "SELECT id, starts_at, ends_at FROM contests WHERE id = $1",
      [contestId],
    );
    if (c.rows.length === 0) return null;
    const p = await pool.query(
      "SELECT problem_id, label FROM contest_problems WHERE contest_id = $1",
      [contestId],
    );
    return {
      id: c.rows[0].id,
      startsAt: new Date(c.rows[0].starts_at),
      endsAt: new Date(c.rows[0].ends_at),
      labelByProblem: new Map(p.rows.map((r) => [r.problem_id, r.label])),
    };
  }

  // Contest submissions in time order. Admins never count. Only submissions
  // made while the contest was running count.
  async function loadSubmissions(contest, userId) {
    const params = [
      contest.id,
      contest.startsAt.toISOString(),
      contest.endsAt.toISOString(),
    ];
    let userFilter = "";
    if (userId !== undefined) {
      params.push(userId);
      userFilter = "AND s.user_id = $4";
    }
    const r = await pool.query(
      `SELECT s.user_id, u.username, s.problem_id, s.status, s.created_at
       FROM submissions s
       JOIN users u ON u.id = s.user_id
       WHERE s.contest_id = $1
         AND u.role <> 'admin'
         AND s.created_at >= $2::timestamptz
         AND s.created_at < $3::timestamptz
         ${userFilter}
       ORDER BY s.created_at, s.id`,
      params,
    );
    return r.rows;
  }

  // Rebuilds the whole cached board from Postgres.
  async function rebuild(contestId) {
    const k = keysFor(contestId);
    const contest = await loadContest(contestId);
    if (!contest) {
      await redis.del(k.zset, k.detail, k.ready);
      return;
    }

    const standings = buildStandings(contest, await loadSubmissions(contest));
    const multi = redis.multi().del(k.zset, k.detail);
    for (const st of standings.values()) {
      multi.zadd(k.zset, scoreOf(st), String(st.userId));
      multi.hset(k.detail, String(st.userId), JSON.stringify(st));
    }
    multi.set(k.ready, "1");
    await runMulti(multi);
  }

  // Called by the worker after a final verdict. Recomputes just that user.
  async function updateForSubmission(submissionId) {
    const sub = await pool.query(
      "SELECT user_id, contest_id FROM submissions WHERE id = $1",
      [submissionId],
    );
    const row = sub.rows[0];
    if (!row || row.contest_id == null) return;

    const k = keysFor(row.contest_id);
    if (!(await redis.exists(k.ready))) {
      await rebuild(row.contest_id);
      return;
    }

    const contest = await loadContest(row.contest_id);
    if (!contest) return;
    const rows = await loadSubmissions(contest, row.user_id);
    const st = buildStandings(contest, rows).get(row.user_id);
    if (!st) return;

    await runMulti(
      redis
        .multi()
        .zadd(k.zset, scoreOf(st), String(st.userId))
        .hset(k.detail, String(st.userId), JSON.stringify(st)),
    );
  }

  // Ranked rows for the API. Builds the cache first if Redis has nothing.
  async function read(contestId) {
    const k = keysFor(contestId);
    if (!(await redis.exists(k.ready))) await rebuild(contestId);

    const flat = await redis.zrevrange(k.zset, 0, MAX_ROWS - 1, "WITHSCORES");
    const ids = [];
    const scores = [];
    for (let i = 0; i < flat.length; i += 2) {
      ids.push(flat[i]);
      scores.push(Number(flat[i + 1]));
    }
    if (ids.length === 0) return [];

    const details = await redis.hmget(k.detail, ...ids);
    const rows = [];
    let rank = 0;
    let prev = null;
    ids.forEach((id, i) => {
      if (!details[i]) return;
      if (scores[i] !== prev) {
        rank = i + 1;
        prev = scores[i];
      }
      const st = JSON.parse(details[i]);
      rows.push({
        rank,
        user_id: st.userId,
        username: st.username,
        solved: st.solved,
        penalty: st.penalty,
        problems: st.problems,
      });
    });
    return rows;
  }

  return { updateForSubmission, rebuild, read };
}

module.exports = { createLeaderboard };
