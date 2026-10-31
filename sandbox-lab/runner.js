"use strict";

const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const IMAGE = "python:3.12-slim";
const MAX_STDOUT_BYTES = 1024 * 1024; // 1 MB
const MAX_STDERR_BYTES = 64 * 1024; // 64 KB
// Docker needs time to start the container, and that time is included in the
// wall-clock timer. This grace keeps fast programs from failing the limit.
const STARTUP_GRACE_MS = 1000;

function removeContainer(name) {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}

function runPython(codePath, inputPath, timeLimitMs = 1000, memoryMb = 256) {
  return new Promise((resolve) => {
    const codeAbs = path.resolve(codePath);
    const name = "oj-run-" + crypto.randomBytes(6).toString("hex");

    const args = [
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
      "0.5",
      "--pids-limit",
      "64",
      "--read-only",
      "--tmpfs",
      "/tmp:size=16m,noexec",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      "65534:65534",
      "-e",
      "PYTHONDONTWRITEBYTECODE=1",
      "-v",
      `${codeAbs}:/work/solution.py:ro`,
      IMAGE,
      "python",
      "/work/solution.py",
    ];

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
    }, timeLimitMs + STARTUP_GRACE_MS);

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => {
      if (outputExceeded) return;
      outBytes += chunk.length;
      if (outBytes > MAX_STDOUT_BYTES) {
        outputExceeded = true;
        killContainer();
        return;
      }
      outChunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      if (errBytes >= MAX_STDERR_BYTES) return;
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
        status: "Internal Error",
        reason: `could not start docker: ${e.message}`,
        exitCode: null,
        timeMs: Date.now() - started,
        stdout: "",
        stderr: "",
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

      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");

      let status;
      let reason = "";
      if (timedOut) {
        status = "Time Limit Exceeded";
      } else if (outputExceeded) {
        status = "Runtime Error";
        reason = "output limit exceeded";
      } else if (oomKilled) {
        status = "Memory Limit Exceeded";
      } else if (code === 125) {
        status = "Internal Error";
        reason = "docker failed to start the container";
      } else if (code !== 0) {
        status = "Runtime Error";
        reason = `exit code ${code}`;
      } else {
        status = "OK"; // ran fine; comparing with expected output is the worker's job
      }

      finish({ status, reason, exitCode: code, timeMs, stdout, stderr });
    });
  });
}

module.exports = { runPython };

if (require.main === module) {
  const [codePath, inputPath, timeArg, memArg] = process.argv.slice(2);
  if (!codePath) {
    console.error(
      "usage: node runner.js <code.py> [input.txt] [timeLimitMs] [memoryMb]",
    );
    process.exit(1);
  }
  const preview = (s) => (s.length > 300 ? s.slice(0, 300) + "...[cut]" : s);
  runPython(
    codePath,
    inputPath,
    Number(timeArg) || 1000,
    Number(memArg) || 256,
  ).then((r) => {
    console.log(
      JSON.stringify(
        { ...r, stdout: preview(r.stdout), stderr: preview(r.stderr) },
        null,
        2,
      ),
    );
  });
}
