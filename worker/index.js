require("dotenv").config();
const fs = require("fs/promises");
const path = require("path");
const { Worker } = require("bullmq");
const IORedis = require("ioredis");
const { Pool } = require("pg");
const { prepare } = require("../sandbox-lab/runner");
const { createLeaderboard } = require("../server/src/leaderboard");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
const leaderboard = createLeaderboard({ pool, redis: connection });

const TMP_BASE = path.join(__dirname, ".tmp-judge");
const EXT = { python: "py", cpp: "cpp" };

function normalize(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

function clean(text, max) {
  return (text || "").replace(/\u0000/g, "").slice(0, max);
}

async function saveVerdict(id, status, timeMs, message) {
  await pool.query(
    "UPDATE submissions SET status = $1, time_ms = $2, error_message = $3 WHERE id = $4",
    [status, timeMs, message, id],
  );
}

// Never throws: a leaderboard problem must not fail (and re-judge) the job.
async function refreshLeaderboard(submissionId) {
  try {
    await leaderboard.updateForSubmission(submissionId);
  } catch (err) {
    console.error(
      `Leaderboard update failed for submission ${submissionId}:`,
      err.message,
    );
  }
}

async function judge(job) {
  const { submissionId } = job.data;

  const subResult = await pool.query(
    `SELECT s.id, s.language, s.code, s.problem_id, p.time_limit_ms, p.memory_limit_mb
     FROM submissions s JOIN problems p ON p.id = s.problem_id
     WHERE s.id = $1`,
    [submissionId],
  );
  const sub = subResult.rows[0];
  if (!sub) return { skipped: true };

  const testsResult = await pool.query(
    "SELECT input, expected_output FROM test_cases WHERE problem_id = $1 ORDER BY position, id",
    [sub.problem_id],
  );
  const tests = testsResult.rows;
  if (tests.length === 0) {
    throw new Error("problem has no test cases");
  }

  await pool.query("UPDATE submissions SET status = 'Running' WHERE id = $1", [
    sub.id,
  ]);
  await job.updateProgress({ status: "Running", test: 0, total: tests.length });

  await fs.mkdir(TMP_BASE, { recursive: true });
  const dir = await fs.mkdtemp(path.join(TMP_BASE, "job-"));
  let prepared = null;

  try {
    await fs.chmod(dir, 0o755);
    const codePath = path.join(dir, `solution.${EXT[sub.language]}`);
    const inputPath = path.join(dir, "input.txt");
    await fs.writeFile(codePath, sub.code);
    await fs.chmod(codePath, 0o644);

    // Compile once per submission (C++); Python has nothing to compile.
    const prep = await prepare({ language: sub.language, codePath });

    if (prep.failure) {
      if (prep.failure.status === "Internal Error") {
        throw new Error(`sandbox failure: ${prep.failure.reason}`);
      }
      const message = clean(prep.failure.stderr, 2000);
      await saveVerdict(sub.id, prep.failure.status, 0, message);
      await refreshLeaderboard(sub.id);
      return { status: prep.failure.status, timeMs: 0 };
    }
    prepared = prep.prepared;

    let maxTime = 0;

    for (let i = 0; i < tests.length; i++) {
      await fs.writeFile(inputPath, tests[i].input);

      const result = await prepared.run({
        inputPath,
        timeLimitMs: sub.time_limit_ms,
        memoryMb: sub.memory_limit_mb,
      });

      if (result.status === "Internal Error") {
        throw new Error(`sandbox failure: ${result.reason}`);
      }

      maxTime = Math.max(maxTime, result.timeMs || 0);

      let verdict = null;
      let message = null;

      if (result.status === "OK") {
        if (normalize(result.stdout) !== normalize(tests[i].expected_output)) {
          verdict = "Wrong Answer";
          message = `Failed on test ${i + 1}`;
        }
      } else {
        verdict = result.status;
        message = clean(
          `Test ${i + 1}: ${result.reason || ""}\n${result.stderr || ""}`,
          2000,
        );
      }

      if (verdict) {
        await saveVerdict(sub.id, verdict, maxTime, message);
        await refreshLeaderboard(sub.id);
        return { status: verdict, timeMs: maxTime, failedTest: i + 1 };
      }

      await job.updateProgress({
        status: "Running",
        test: i + 1,
        total: tests.length,
      });
    }

    await saveVerdict(sub.id, "Accepted", maxTime, null);
    await refreshLeaderboard(sub.id);
    return { status: "Accepted", timeMs: maxTime };
  } finally {
    if (prepared) prepared.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const worker = new Worker("submissions", judge, {
  connection,
  concurrency: 1,
});

worker.on("completed", (job, result) => {
  console.log(`Job ${job.id} done:`, JSON.stringify(result));
});

worker.on("failed", async (job, err) => {
  console.error(
    `Job ${job && job.id} failed (attempt ${job && job.attemptsMade}):`,
    err.message,
  );
  if (job && job.attemptsMade >= (job.opts.attempts || 1)) {
    try {
      await saveVerdict(
        job.data.submissionId,
        "Internal Error",
        null,
        clean(err.message, 500),
      );
    } catch (e) {
      console.error("Could not save Internal Error:", e);
    }
  }
});

worker.on("error", (err) => console.error("Worker error:", err));

async function shutdown() {
  console.log("Shutting down worker...");
  await worker.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Worker started, waiting for jobs...");
