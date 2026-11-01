import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { useLiveSubmission } from "../useLiveSubmission.js";

const STARTERS = {
  python: "",
  cpp: "#include <iostream>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n",
};

export default function Problem() {
  const { slug } = useParams();
  const { token } = useAuth();
  const [problem, setProblem] = useState(null);
  const [error, setError] = useState("");
  const [language, setLanguage] = useState("python");
  const [codes, setCodes] = useState(STARTERS);
  const [submissionId, setSubmissionId] = useState(null);
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const live = useLiveSubmission(submissionId, token);
  const judging = submitting || (live && !live.final);

  useEffect(() => {
    setProblem(null);
    setError("");
    setSubmissionId(null);
    api(`/api/problems/${slug}`)
      .then((data) => setProblem(data.problem))
      .catch((err) => setError(err.message));
  }, [slug]);

  async function submit() {
    setSubmitError("");
    setSubmitting(true);
    setSubmissionId(null);
    try {
      const data = await api("/api/submissions", {
        method: "POST",
        body: {
          problem_id: problem.id,
          language,
          code: codes[language],
        },
      });
      setSubmissionId(data.submission.id);
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!problem) return <p>Loading...</p>;

  const extensions = language === "python" ? [python()] : [cpp()];
  const showMessage =
    live?.final &&
    live.message &&
    !["Time Limit Exceeded", "Accepted"].includes(live.status);

  return (
    <div className="problem-layout">
      <section className="card">
        <h2>{problem.title}</h2>
        <p className="meta">
          <span className={`badge ${problem.difficulty}`}>
            {problem.difficulty}
          </span>{" "}
          Time limit {problem.time_limit_ms} ms, memory limit{" "}
          {problem.memory_limit_mb} MB
        </p>
        <div className="statement">{problem.statement}</div>
        {problem.sample_test_cases.map((t, i) => (
          <div key={t.id} className="sample">
            <h4>Sample {i + 1}</h4>
            <div className="sample-grid">
              <div>
                <strong>Input</strong>
                <pre>{t.input}</pre>
              </div>
              <div>
                <strong>Output</strong>
                <pre>{t.expected_output}</pre>
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <div className="editor-bar">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            disabled={judging}
          >
            <option value="python">Python</option>
            <option value="cpp">C++</option>
          </select>
          <button
            onClick={submit}
            disabled={judging || !codes[language].trim()}
          >
            {judging ? "Judging..." : "Submit"}
          </button>
        </div>

        <CodeMirror
          value={codes[language]}
          height="360px"
          extensions={extensions}
          onChange={(value) => setCodes((c) => ({ ...c, [language]: value }))}
        />

        {submitError && <p className="error">{submitError}</p>}

        {live && (
          <div className={`verdict ${live.final ? "final" : ""}`}>
            <div className="verdict-status">
              {live.final ? live.status : live.status}
              {live.final &&
              live.timeMs != null &&
              live.status !== "Compilation Error"
                ? ` (${live.timeMs} ms)`
                : ""}
            </div>
            {!live.final && live.total > 0 && (
              <>
                <progress value={live.test} max={live.total} />
                <div className="meta">
                  Test {live.test} of {live.total}
                </div>
              </>
            )}
            {showMessage && <pre>{live.message}</pre>}
          </div>
        )}
      </section>
    </div>
  );
}
