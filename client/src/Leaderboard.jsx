import { useEffect, useState } from "react";
import { api } from "./api.js";

const POLL_MS = 5000;

function Cell({ cell }) {
  if (!cell) return <td />;
  if (cell.solved) {
    return (
      <td className="cell ok">
        {cell.minutes}m{cell.attempts > 0 ? ` (+${cell.attempts})` : ""}
      </td>
    );
  }
  if (cell.attempts > 0) return <td className="cell bad">-{cell.attempts}</td>;
  return <td />;
}

// live = the contest is running, so keep refreshing every few seconds.
export default function Leaderboard({ contestId, live }) {
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load(skipIfHidden) {
      if (skipIfHidden && document.hidden) return;
      try {
        const data = await api(`/api/contests/${contestId}/leaderboard`);
        if (!cancelled) {
          setBoard(data);
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    load(false);
    if (!live) {
      return () => {
        cancelled = true;
      };
    }
    const timer = setInterval(() => load(true), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [contestId, live]);

  if (error && !board) return <p className="error">{error}</p>;
  if (!board) return <p>Loading leaderboard...</p>;

  const labels = board.problems.map((p) => p.label);

  return (
    <table className="board">
      <thead>
        <tr>
          <th>#</th>
          <th>User</th>
          <th>Solved</th>
          <th>Penalty</th>
          {labels.map((l) => (
            <th key={l}>{l}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {board.rows.length === 0 && (
          <tr>
            <td colSpan={4 + labels.length}>No submissions yet.</td>
          </tr>
        )}
        {board.rows.map((r) => (
          <tr key={r.user_id}>
            <td>{r.rank}</td>
            <td>{r.username}</td>
            <td>{r.solved}</td>
            <td>{r.penalty}</td>
            {labels.map((l) => (
              <Cell key={l} cell={r.problems[l]} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
