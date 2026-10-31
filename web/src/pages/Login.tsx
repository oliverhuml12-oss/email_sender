import { FormEvent, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export default function Login() {
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    supabase.rpc("has_admin").then(({ data }) => setHasAdmin(!!data));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    if (hasAdmin) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) setError(error.message);
      else if (!data.session) {
        setNotice("Account created. Check your inbox for the confirmation email, click the link, then sign in here.");
        setHasAdmin(true);
      }
    }
    setBusy(false);
  }

  if (hasAdmin === null) return <div className="boot">Loading…</div>;

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <h1>{hasAdmin ? "Sign in" : "Create the admin account"}</h1>
        <p className="muted">
          {hasAdmin
            ? "Email Sender"
            : "This is the first sign-up, so this account becomes the only admin. Nobody else will be able to get in."}
        </p>
        <label className="field">
          <span className="field-label">Email</span>
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            type="password"
            required
            minLength={hasAdmin ? 1 : 10}
            autoComplete={hasAdmin ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {!hasAdmin && <span className="field-hint">At least 10 characters.</span>}
        </label>
        {error && <p className="error">{error}</p>}
        {notice && <p className="notice">{notice}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? "…" : hasAdmin ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
