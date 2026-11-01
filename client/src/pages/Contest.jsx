import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import Leaderboard from "../Leaderboard.jsx";

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d > 0 ? `${d}d ` : ""}${pad(h)}:${pad(m)}:${pad(s)}`;
}

export default function Contest() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0); // server clock minus this computer's clock
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await api(`/api/contests/${id}`);
      setOffset(new Date(d.contest.server_time).getTime() - Date.now());
      setData(d);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const contest = data?.contest;
  const startMs = contest ? new Date(contest.starts_at).getTime() : 0;
  const endMs = contest ? new Date(contest.ends_at).getTime() : 0;
  const serverNow = now + offset;
  const state = !contest
    ? null
    : serverNow < startMs
      ? "upcoming"
      : serverNow < endMs
        ? "running"
        : "ended";

  // The clock says the state changed but the data is old: fetch again until
  // the server agrees (this is what makes problems appear at the start time).
  const stale = Boolean(contest) && state !== contest.state;
  useEffect(() => {
    if (!stale) return;
    const timer = setTimeout(load, 800);
    return () => clearTimeout(timer);
  }, [stale, data, load]);

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p>Loading...</p>;

  const countdown =
    state === "upcoming"
      ? `Starts in ${formatDuration(startMs - serverNow)}`
      : state === "running"
        ? `Ends in ${formatDuration(endMs - serverNow)}`
        : "Contest ended";

  return (
    <div className="contest-page">
      <section className="card">
        <div className="contest-header">
          <h2>{contest.title}</h2>
          <span className={`badge ${state}`}>{state}</span>
        </div>
        <p className="countdown">{countdown}</p>
        <p className="meta">
          {new Date(contest.starts_at).toLocaleString()} to{" "}
          {new Date(contest.ends_at).toLocaleString()}
        </p>
        {contest.description && <p>{contest.description}</p>}

        <h3>Problems</h3>
        {data.problems.length === 0 ? (
          <p className="meta">
            {state === "upcoming"
              ? "Problems appear when the contest starts."
              : "No problems."}
          </p>
        ) : (
          <ul className="problem-list">
            {data.problems.map((p) => (
              <li key={p.problem_id}>
                <span>
                  <strong>{p.label}.</strong>{" "}
                  <Link
                    to={
                      state === "running"
                        ? `/contests/${id}/problems/${p.slug}`
                        : `/problems/${p.slug}`
                    }
                  >
                    {p.title}
                  </Link>
                </span>
                <span className={`badge ${p.difficulty}`}>{p.difficulty}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {state !== "upcoming" && (
        <section className="card">
          <h3>Leaderboard</h3>
          <Leaderboard contestId={id} live={state === "running"} />
        </section>
      )}
    </div>
  );
}
