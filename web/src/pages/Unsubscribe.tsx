import { useState } from "react";
import { FUNCTIONS_URL, SUPABASE_KEY } from "../lib/supabase";

// Public page linked from every email. Requires a click so link scanners can't unsubscribe people by accident.
export default function Unsubscribe() {
  const token = new URLSearchParams(window.location.search).get("t") ?? "";
  const [state, setState] = useState<"ask" | "busy" | "done" | "error">("ask");

  async function confirm() {
    setState("busy");
    try {
      const res = await fetch(`${FUNCTIONS_URL}/track/u/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
        body: "{}",
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card center">
        {state === "done" ? (
          <>
            <h1>You're unsubscribed</h1>
            <p className="muted">You won't receive any more emails from us. Sorry for the bother.</p>
          </>
        ) : state === "error" || !token ? (
          <>
            <h1>Something went wrong</h1>
            <p className="muted">This link didn't work. Reply to the email with “unsubscribe” and we'll remove you right away.</p>
          </>
        ) : (
          <>
            <h1>Unsubscribe?</h1>
            <p className="muted">Click below and we'll stop sending you emails.</p>
            <button className="btn btn-primary btn-block" onClick={confirm} disabled={state === "busy"}>
              {state === "busy" ? "…" : "Unsubscribe"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
