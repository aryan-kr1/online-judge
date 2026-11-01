const { attachWebSocket } = require("./ws");
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/auth");
const problemRoutes = require("./routes/problems");
const submissionRoutes = require("./routes/submissions");
const contestRoutes = require("./routes/contests");
const leaderboardRoutes = require("./routes/leaderboard");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is missing in .env");
  process.exit(1);
}

const app = express();

app.use(cors());

app.use("/api/problems", express.json({ limit: "10mb" }), problemRoutes);
app.use("/api/submissions", express.json({ limit: "200kb" }), submissionRoutes);
app.use("/api/contests", express.json({ limit: "100kb" }), contestRoutes);
app.use("/api/contests", express.json({ limit: "100kb" }), leaderboardRoutes);
app.use("/api/auth", express.json({ limit: "100kb" }), authRoutes);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body too large" });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  console.error("Unhandled error:", err);
  return res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
attachWebSocket(server);
