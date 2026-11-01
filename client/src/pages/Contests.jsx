import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

export default function Contests() {
  const [contests, setContests] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/contests")
      .then((data) => setContests(data.contests))
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!contests) return <p>Loading...</p>;

  return (
    <div className="card">
      <h2>Contests</h2>
      {contests.length === 0 && <p>No contests yet.</p>}
      <ul className="problem-list">
        {contests.map((c) => (
          <li key={c.id}>
            <span>
              <Link to={`/contests/${c.id}`}>{c.title}</Link>
              <span className="meta">
                {" "}
                {new Date(c.starts_at).toLocaleString()} ({c.problem_count}{" "}
                problems)
              </span>
            </span>
            <span className={`badge ${c.state}`}>{c.state}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
