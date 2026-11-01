import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

export default function Problems() {
  const [problems, setProblems] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/problems")
      .then((data) => setProblems(data.problems))
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!problems) return <p>Loading...</p>;

  return (
    <div className="card">
      <h2>Problems</h2>
      {problems.length === 0 && <p>No problems yet.</p>}
      <ul className="problem-list">
        {problems.map((p) => (
          <li key={p.id}>
            <Link to={`/problems/${p.slug}`}>{p.title}</Link>
            <span className={`badge ${p.difficulty}`}>{p.difficulty}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
