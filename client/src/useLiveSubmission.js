import { useEffect, useState } from "react";

export function useLiveSubmission(submissionId, token) {
  const [live, setLive] = useState(null);

  useEffect(() => {
    if (!submissionId) {
      setLive(null);
      return;
    }

    setLive({ status: "Queued" });
    let done = false;
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);

    ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "authenticated") {
        ws.send(JSON.stringify({ type: "subscribe", submissionId }));
      } else if (msg.type === "status") {
        setLive((l) => ({ ...l, status: msg.status }));
      } else if (msg.type === "progress") {
        setLive((l) => ({
          ...l,
          status: msg.status,
          test: msg.test,
          total: msg.total,
        }));
      } else if (msg.type === "verdict") {
        done = true;
        setLive({
          status: msg.status,
          final: true,
          timeMs: msg.timeMs,
          message: msg.message,
        });
        ws.close();
      } else if (msg.type === "error") {
        done = true;
        setLive({ status: "Error", final: true, message: msg.error });
        ws.close();
      }
    };

    ws.onclose = () => {
      if (done) return;
      setLive((l) =>
        l && !l.final
          ? {
              status: "Connection lost",
              final: true,
              message: "The live connection closed. Refresh to see the result.",
            }
          : l,
      );
    };

    return () => {
      done = true;
      ws.close();
    };
  }, [submissionId, token]);

  return live;
}
