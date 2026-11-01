"use strict";

const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PY_IMAGE = "python:3.12-slim";
const CPP_IMAGE = "gcc:14";

const MAX_STDOUT_BYTES = 1024 * 1024; // 1 MB
const MAX_STDERR_BYTES = 64 * 1024; // 64 KB
// Docker needs time to start the container, and that time is included in the
// wall-clock timer. This grace keeps fast programs from failing the limit.
const STARTUP_GRACE_MS = 1000;

const COMPILE_LIMIT_MS = 10000;
const COMPILE_MEMORY_MB = 512;
const MAX_COMPILE_MESSAGE = 2000;

// Temp folders for C++ runs. Kept inside the project so Docker can mount them.
const WORK_ROOT = path.join(__dirname, ".tmp-runs");

function newName() {
  return "oj-run-" + crypto.randomBytes(6).toString("hex");
}

function removeContainer(name) {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}

// Lockdown flags shared by every container.
function baseFlags({ name, memoryMb, cpus, tmpfs }) {
  return [
    "run",
    "-i",
    "--name",
    name,
    "--network",
    "none",
    "--memory",
    `${memoryMb}m`,
    "--memory-swap",
    `${memoryMb}m`,
    "--cpus",
    String(cpus),
    "--pids-limit",
    "64",
    "--read-only",
    "--tmpfs",
    tmpfs,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "65534:65534",
  ];
}

// Runs one container and reports what happened. Knows nothing about languages.
function dockerRun({ name, args, inputPath, timeoutMs, maxStdout, maxStderr }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let finished = false;

    const killContainer = () => {
      spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killContainer();
    }, timeoutMs);

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      if (outputExceeded) return;
      outBytes += chunk.length;
      if (outBytes > maxStdout) {
        outputExceeded = true;
        killContainer();
        return;
      }
      outChunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      if (errBytes >= maxStderr) return;
      errBytes += chunk.length;
      errChunks.push(chunk);
    });

    // The program may exit without reading its input; ignore the broken pipe.
    child.stdin.on("error", () => {});
    if (inputPath) {
      fs.createReadStream(inputPath)
        .on("error", () => child.stdin.end())
        .pipe(child.stdin);
    } else {
      child.stdin.end();
    }

    child.on("error", (e) => {
      finish({
        startError: e.message,
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        outputExceeded: false,
        oomKilled: false,
        timeMs: Date.now() - started,
      });
    });

    child.on("close", (code) => {
      const timeMs = Date.now() - started;

      let oomKilled = false;
      if (!timedOut && !outputExceeded) {
        const r = spawnSync(
          "docker",
          ["inspect", "-f", "{{.State.OOMKilled}}", name],
          { encoding: "utf8" },
        );
        oomKilled = r.status === 0 && r.stdout.trim() === "true";
      }
      removeContainer(name);

      finish({
        startError: null,
        code,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8").slice(0, maxStderr),
        timedOut,
        outputExceeded,
        oomKilled,
        timeMs,
      });
    });
  });
}

function internalError(r, reason) {
  return {
    status: "Internal Error",
    reason: reason || r.startError || "docker failed to start the container",
    exitCode: r.code,
    timeMs: r.timeMs,
    stdout: "",
    stderr: "",
  };
}

// Turns a finished run container into a verdict.
function verdictFromRun(r) {
  if (r.startError) return internalError(r);

  let status;
  let reason = "";
  if (r.timedOut) {
    status = "Time Limit Exceeded";
  } else if (r.outputExceeded) {
    status = "Runtime Error";
    reason = "output limit exceeded";
  } else if (r.oomKilled) {
    status = "Memory Limit Exceeded";
  } else if (r.code === 125) {
    return internalError(r);
  } else if (r.code !== 0) {
    status = "Runtime Error";
    const signal = r.code > 128 ? ` (signal ${r.code - 128})` : "";
    reason = `exit code ${r.code}${signal}`;
  } else {
    status = "OK"; // ran fine; comparing with expected output is the worker's job
  }

  return {
    status,
    reason,
    exitCode: r.code,
    timeMs: r.timeMs,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

// ---------------------------------------------------------------------------
// Python: nothing to compile, so "prepared" just remembers the file path.
// ---------------------------------------------------------------------------

function preparePython(codePath) {
  const codeAbs = path.resolve(codePath);

  const run = async ({ inputPath, timeLimitMs, memoryMb }) => {
    const name = newName();
    const args = [
      ...baseFlags({
        name,
        memoryMb,
        cpus: 0.5,
        tmpfs: "/tmp:size=16m,noexec",
      }),
      "-e",
      "PYTHONDONTWRITEBYTECODE=1",
      "-v",
      `${codeAbs}:/work/solution.py:ro`,
      PY_IMAGE,
      "python",
      "/work/solution.py",
    ];

    const r = await dockerRun({
      name,
      args,
      inputPath,
      timeoutMs: timeLimitMs + STARTUP_GRACE_MS,
      maxStdout: MAX_STDOUT_BYTES,
      maxStderr: MAX_STDERR_BYTES,
    });
    return verdictFromRun(r);
  };

  return { prepared: { compileMs: undefined, run, dispose() {} } };
}

// ---------------------------------------------------------------------------
// C++: compile once, then run the binary as many times as needed.
// ---------------------------------------------------------------------------

// Compiles solution.cpp in dir. Returns null on success, or a failure result.
async function compileCpp(dir) {
  const name = newName();
  const args = [
    ...baseFlags({
      name,
      memoryMb: COMPILE_MEMORY_MB,
      cpus: 1,
      tmpfs: "/tmp:size=64m",
    }),
    "-v",
    `${dir}:/work`,
    CPP_IMAGE,
    "g++",
    "-O2",
    "-std=c++17",
    "-fmax-errors=5",
    "-o",
    "/work/solution",
    "/work/solution.cpp",
  ];

  const r = await dockerRun({
    name,
    args,
    inputPath: null,
    timeoutMs: COMPILE_LIMIT_MS + STARTUP_GRACE_MS,
    maxStdout: MAX_STDERR_BYTES,
    maxStderr: MAX_STDERR_BYTES,
  });

  const fail = (reason) => ({
    status: "Compilation Error",
    reason,
    exitCode: r.code,
    timeMs: 0,
    stdout: "",
    stderr: r.stderr.slice(0, MAX_COMPILE_MESSAGE),
  });

  if (r.startError) return internalError(r);
  if (r.timedOut) return fail("compile time limit exceeded");
  if (r.outputExceeded) return fail("compiler output too large");
  if (r.oomKilled) return fail("compiler out of memory");
  if (r.code === 125) return internalError(r);
  if (r.code !== 0) return fail("compiler error");
  return null;
}

// Runs the already compiled binary in dir.
async function runBinary(dir, { inputPath, timeLimitMs, memoryMb }) {
  const name = newName();
  const args = [
    ...baseFlags({
      name,
      memoryMb,
      cpus: 0.5,
      tmpfs: "/tmp:size=16m,noexec",
    }),
    "-v",
    `${dir}:/work:ro`,
    CPP_IMAGE,
    "/work/solution",
  ];

  const r = await dockerRun({
    name,
    args,
    inputPath,
    timeoutMs: timeLimitMs + STARTUP_GRACE_MS,
    maxStdout: MAX_STDOUT_BYTES,
    maxStderr: MAX_STDERR_BYTES,
  });
  return verdictFromRun(r);
}

async function prepareCpp(codePath) {
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(WORK_ROOT, "run-"));
  fs.chmodSync(dir, 0o777); // the compiler runs as an unprivileged user

  const dispose = () => fs.rmSync(dir, { recursive: true, force: true });

  try {
    fs.copyFileSync(codePath, path.join(dir, "solution.cpp"));

    const compileStart = Date.now();
    const failure = await compileCpp(dir);
    const compileMs = Date.now() - compileStart;

    if (failure) {
      dispose();
      return { failure: { ...failure, compileMs } };
    }

    return {
      prepared: {
        compileMs,
        run: (opts) => runBinary(dir, opts),
        dispose,
      },
    };
  } catch (err) {
    dispose();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Compiles (C++) or just checks the language (Python), once per submission.
// Returns { failure } (a Compilation Error or Internal Error result) or
// { prepared } with:
//   prepared.compileMs                      compile time (C++ only)
//   prepared.run({ inputPath, timeLimitMs, memoryMb })  runs one test
//   prepared.dispose()                      deletes temp files; always call it
async function prepare({ language, codePath }) {
  if (language === "python") return preparePython(codePath);
  if (language === "cpp") return prepareCpp(codePath);
  throw new Error(`unsupported language: ${language}`);
}

// One-shot helper: prepare, run a single test, dispose. Same result shape as before.
async function runCode({
  language,
  codePath,
  inputPath,
  timeLimitMs = 1000,
  memoryMb = 256,
}) {
  const { failure, prepared } = await prepare({ language, codePath });
  if (failure) return failure;

  try {
    const result = await prepared.run({ inputPath, timeLimitMs, memoryMb });
    return prepared.compileMs !== undefined
      ? { ...result, compileMs: prepared.compileMs }
      : result;
  } finally {
    prepared.dispose();
  }
}

module.exports = { runCode, prepare };

if (require.main === module) {
  const [codePath, inputPath, timeArg, memArg] = process.argv.slice(2);
  if (!codePath) {
    console.error(
      "usage: node runner.js <code.py|code.cpp> [input.txt] [timeLimitMs] [memoryMb]",
    );
    process.exit(1);
  }

  const ext = path.extname(codePath);
  const language = ext === ".py" ? "python" : ext === ".cpp" ? "cpp" : null;
  if (!language) {
    console.error("file must end in .py or .cpp");
    process.exit(1);
  }

  const preview = (s) => (s.length > 300 ? s.slice(0, 300) + "...[cut]" : s);
  runCode({
    language,
    codePath,
    inputPath,
    timeLimitMs: Number(timeArg) || 1000,
    memoryMb: Number(memArg) || 256,
  })
    .then((r) => {
      console.log(
        JSON.stringify(
          { ...r, stdout: preview(r.stdout), stderr: preview(r.stderr) },
          null,
          2,
        ),
      );
    })
    .catch((e) => {
      console.error("runner crashed:", e.message);
      process.exit(1);
    });
}
