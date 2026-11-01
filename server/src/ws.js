const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const { QueueEvents } = require("bullmq");
const pool = require("./db");
const { connection } = require("./queue");

const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30000;
const MAX_SUBSCRIPTIONS = 20;
const MAX_INT = 2147483647;
const IN_PROGRESS = ["Queued", "Running"];

// submissionId -> Set of sockets watching it
const subscribers = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(submissionId, payload) {
  const set = subscribers.get(submissionId);
  if (!set) return;
  for (const ws of set) send(ws, payload);
}

function unsubscribe(ws, submissionId) {
  ws.subscriptions.delete(submissionId);
  const set = subscribers.get(submissionId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) subscribers.delete(submissionId);
}

function finish(submissionId) {
  const set = subscribers.get(submissionId);
  if (!set) return;
  for (const ws of set) ws.subscriptions.delete(submissionId);
  subscribers.delete(submissionId);
}

async function getSubmission(id) {
  const result = await pool.query(
    "SELECT user_id, status, time_ms, error_message FROM submissions WHERE id = $1",
    [id],
  );
  return result.rows[0] || null;
}

function verdictPayload(id, row) {
  return {
    type: "verdict",
    submissionId: id,
    status: row.status,
    timeMs: row.time_ms,
    message: row.error_message,
  };
}

async function handleSubscribe(ws, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1 || id > MAX_INT) {
    return send(ws, { type: "error", error: "Invalid submission id" });
  }
  if (ws.subscriptions.size >= MAX_SUBSCRIPTIONS && !ws.subscriptions.has(id)) {
    return send(ws, { type: "error", error: "Too many subscriptions" });
  }

  // Ownership check first, so a non-owner is never added to the listener set.
  const first = await getSubmission(id);
  if (!first || first.user_id !== ws.userId) {
    return send(ws, { type: "error", error: "Submission not found" });
  }

  // Register, then read again, so an event between the two reads is not missed.
  if (!ws.subscriptions.has(id)) {
    ws.subscriptions.add(id);
    if (!subscribers.has(id)) subscribers.set(id, new Set());
    subscribers.get(id).add(ws);
  }

  const row = await getSubmission(id);
  if (!row) {
    unsubscribe(ws, id);
    return send(ws, { type: "error", error: "Submission not found" });
  }

  if (IN_PROGRESS.includes(row.status)) {
    send(ws, { type: "status", submissionId: id, status: row.status });
  } else {
    send(ws, verdictPayload(id, row));
    unsubscribe(ws, id);
  }
}

function authenticateToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const userId = Number(payload.id ?? payload.userId ?? payload.sub);
    return Number.isInteger(userId) ? userId : null;
  } catch {
    return null;
  }
}

function submissionIdFromJob(jobId) {
  const m = /^sub-(\d+)$/.exec(String(jobId));
  return m ? Number(m[1]) : null;
}

function startQueueEvents() {
  const queueEvents = new QueueEvents("submissions", { connection });

  queueEvents.on("progress", ({ jobId, data }) => {
    const id = submissionIdFromJob(jobId);
    if (!id || !subscribers.has(id) || typeof data !== "object" || !data)
      return;
    broadcast(id, { type: "progress", submissionId: id, ...data });
  });

  queueEvents.on("completed", async ({ jobId }) => {
    const id = submissionIdFromJob(jobId);
    if (!id || !subscribers.has(id)) return;
    try {
      const row = await getSubmission(id);
      if (row) broadcast(id, verdictPayload(id, row));
    } catch (err) {
      console.error("WS completed handler error:", err);
    }
    finish(id);
  });

  // Fires only after all retries are used up.
  queueEvents.on("failed", ({ jobId }) => {
    const id = submissionIdFromJob(jobId);
    if (!id || !subscribers.has(id)) return;
    broadcast(id, {
      type: "verdict",
      submissionId: id,
      status: "Internal Error",
      timeMs: null,
      message: null,
    });
    finish(id);
  });

  queueEvents.on("error", (err) => console.error("QueueEvents error:", err));
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });
  startQueueEvents();

  wss.on("connection", (ws) => {
    ws.userId = null;
    ws.subscriptions = new Set();
    ws.isAlive = true;

    const authTimer = setTimeout(() => {
      if (ws.userId === null) ws.close(4001, "Auth timeout");
    }, AUTH_TIMEOUT_MS);

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return send(ws, { type: "error", error: "Invalid JSON" });
      }
      if (!msg || typeof msg !== "object") {
        return send(ws, { type: "error", error: "Invalid message" });
      }

      try {
        if (ws.userId === null) {
          if (msg.type !== "auth" || typeof msg.token !== "string") {
            return ws.close(4001, "Auth required");
          }
          const userId = authenticateToken(msg.token);
          if (userId === null) return ws.close(4001, "Invalid token");
          ws.userId = userId;
          clearTimeout(authTimer);
          return send(ws, { type: "authenticated" });
        }

        if (msg.type === "subscribe") {
          return await handleSubscribe(ws, msg.submissionId);
        }
        if (msg.type === "unsubscribe") {
          return unsubscribe(ws, Number(msg.submissionId));
        }
        return send(ws, { type: "error", error: "Unknown message type" });
      } catch (err) {
        console.error("WS message error:", err);
        send(ws, { type: "error", error: "Internal server error" });
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      for (const id of [...ws.subscriptions]) unsubscribe(ws, id);
    });

    ws.on("error", (err) => console.error("WS socket error:", err.message));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}

module.exports = { attachWebSocket };
