import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Empty, Field, PageHeader, StatusBadge, useToast } from "../components/ui";
import { ago, dateTime, warmupWeek } from "../lib/format";
import { callFunction, supabase, type Mailbox, type Settings } from "../lib/supabase";

export default function SettingsPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savedSettings, setSavedSettings] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [suppressed, setSuppressed] = useState<{ email: string; reason: string; created_at: string }[]>([]);
  const [suppressInput, setSuppressInput] = useState("");

  const load = useCallback(async () => {
    const [m, s, sp] = await Promise.all([
      supabase.from("mailboxes").select("*").order("created_at"),
      supabase.from("settings").select("*").eq("id", 1).single(),
      supabase.from("suppression").select("*").order("created_at", { ascending: false }).limit(50),
    ]);
    setMailboxes((m.data ?? []) as Mailbox[]);
    setSettings(s.data as Settings);
    setSavedSettings(JSON.stringify(s.data));
    setSuppressed(sp.data ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const g = params.get("gmail");
    if (!g) return;
    if (g === "connected") toast(`Connected ${params.get("email") ?? "mailbox"}.`);
    else toast(`Couldn't connect: ${params.get("message") ?? "unknown error"}`, "bad");
    setParams({}, { replace: true });
  }, [params, setParams, toast]);

  async function connect() {
    setConnecting(true);
    try {
      const { url } = await callFunction<{ url: string }>("google-oauth", { return_to: `${window.location.origin}/settings` });
      window.location.href = url;
    } catch (e) {
      toast((e as Error).message, "bad");
      setConnecting(false);
    }
  }

  async function updateMailbox(id: string, patch: Partial<Mailbox>, msg?: string) {
    const { error } = await supabase.from("mailboxes").update(patch).eq("id", id);
    if (error) return toast(error.message, "bad");
    if (msg) toast(msg);
    load();
  }

  async function removeMailbox(mb: Mailbox) {
    if (!confirm(`Remove ${mb.email}? Its stored Google access is deleted. Campaigns using it must be deleted first.`)) return;
    const { error } = await supabase.from("mailboxes").delete().eq("id", mb.id);
    if (error) return toast(error.message.includes("foreign key") ? "Campaigns still use this mailbox. Delete them first, or just pause the mailbox." : error.message, "bad");
    load();
  }

  async function saveSettings() {
    if (!settings) return;
    const { id: _id, ...rest } = settings;
    void _id;
    if (rest.max_gap_seconds < rest.min_gap_seconds) return toast("The maximum gap must be at least the minimum gap.", "bad");
    const { error } = await supabase.from("settings").update({ ...rest, app_url: rest.app_url?.replace(/\/$/, "") || null, alert_email: rest.alert_email || null, updated_at: new Date().toISOString() }).eq("id", 1);
    if (error) return toast(error.message, "bad");
    toast("Settings saved.");
    load();
  }

  async function addSuppression() {
    const emails = suppressInput.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@"));
    if (!emails.length) return;
    const { error } = await supabase.from("suppression").upsert(emails.map((email) => ({ email, reason: "manual" })), { onConflict: "email", ignoreDuplicates: true });
    if (error) return toast(error.message, "bad");
    await supabase.from("contacts").update({ status: "unsubscribed" }).in("email", emails).not("status", "in", "(bounced,unsubscribed)");
    setSuppressInput("");
    toast(`${emails.length} address(es) added to the do-not-email list.`);
    load();
  }

  if (!settings) return <div className="boot">Loading…</div>;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings({ ...settings, [k]: v });
  const dirty = JSON.stringify(settings) !== savedSettings;

  return (
    <>
      <PageHeader title="Settings" />

      <section className="card">
        <div className="card-head">
          <h2>Mailboxes</h2>
          <button className="btn btn-primary" onClick={connect} disabled={connecting}>{connecting ? "Opening Google…" : "Connect Google mailbox"}</button>
        </div>
        {mailboxes.length === 0 ? (
          <Empty title="No mailbox connected">Click “Connect Google mailbox” and sign in with the Workspace address you want to send from.</Empty>
        ) : mailboxes.map((mb) => (
          <div key={mb.id} className="mailbox-settings">
            <div className="mailbox-settings-head">
              <div>
                <div className="mailbox-name">{mb.email} <StatusBadge status={mb.status} /></div>
                {mb.pause_reason && <div className={mb.status === "disconnected" ? "error small" : "warn-text small"}>{mb.pause_reason}</div>}
                <div className="muted small">
                  Warm-up week {warmupWeek(mb.warmup_start_date)} · today's limit {mb.daily_limit_override ?? mb.current_daily_limit}/day ·
                  health check {mb.last_health_check_at ? dateTime(mb.last_health_check_at) : "not yet run"} · inbox checked {ago(mb.last_inbox_sync_at)}
                </div>
              </div>
              <div className="row gap-s">
                {mb.status === "active" && <button className="btn" onClick={() => updateMailbox(mb.id, { status: "paused", pause_reason: "Paused manually" }, "Mailbox paused.")}>Pause</button>}
                {mb.status === "paused" && <button className="btn btn-primary" onClick={() => updateMailbox(mb.id, { status: "active", pause_reason: null }, "Mailbox resumed.")}>Resume</button>}
                {mb.status === "disconnected" && <button className="btn btn-primary" onClick={connect}>Reconnect</button>}
                <button className="btn btn-danger-ghost" onClick={() => removeMailbox(mb)}>Remove</button>
              </div>
            </div>
            <div className="row gap wrap">
              <Field label="Sender name" hint="Shown as the From name.">
                <input defaultValue={mb.display_name ?? ""} onBlur={(e) => e.target.value !== (mb.display_name ?? "") && updateMailbox(mb.id, { display_name: e.target.value || null }, "Sender name saved.")} />
              </Field>
              <Field label="Warm-up started" hint="Sets the ramp: earlier date = higher limit.">
                <input type="date" defaultValue={mb.warmup_start_date} onBlur={(e) => e.target.value && e.target.value !== mb.warmup_start_date && updateMailbox(mb.id, { warmup_start_date: e.target.value }, "Saved. The limit updates at the next daily check.")} />
              </Field>
              <Field label="Manual daily limit" hint="Empty = automatic (warm-up + health rules).">
                <input type="number" min={0} placeholder="automatic" defaultValue={mb.daily_limit_override ?? ""} onBlur={(e) => {
                  const v = e.target.value === "" ? null : Math.max(0, Number(e.target.value));
                  if (v !== mb.daily_limit_override) updateMailbox(mb.id, { daily_limit_override: v }, "Daily limit saved.");
                }} />
              </Field>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>Sending rules</h2>
        <p className="muted small">The daily check (06:00) sets each mailbox's limit from the warm-up ramp, then slows down or pauses it based on the last 7 days.</p>
        <div className="form-grid">
          <Field label="Warm-up ramp (emails/day per week)" hint="Week 1, week 2, … After the last week the maximum applies.">
            <input value={settings.warmup_schedule.join(", ")} onChange={(e) => set("warmup_schedule", e.target.value.split(/[,\s]+/).map(Number).filter((n) => n > 0))} />
          </Field>
          <Field label="Maximum per mailbox per day"><input type="number" min={1} value={settings.max_daily_per_mailbox} onChange={(e) => set("max_daily_per_mailbox", Number(e.target.value))} /></Field>
          <Field label="Gap between emails: min (minutes)"><input type="number" min={0.5} step={0.5} value={settings.min_gap_seconds / 60} onChange={(e) => set("min_gap_seconds", Math.round(Number(e.target.value) * 60))} /></Field>
          <Field label="Gap between emails: max (minutes)"><input type="number" min={0.5} step={0.5} value={settings.max_gap_seconds / 60} onChange={(e) => set("max_gap_seconds", Math.round(Number(e.target.value) * 60))} /></Field>
          <Field label="Slow down at bounce rate (%)" hint="Halves the next day's limit."><input type="number" min={0} step={0.5} value={settings.bounce_slow_pct} onChange={(e) => set("bounce_slow_pct", Number(e.target.value))} /></Field>
          <Field label="Pause above bounce rate (%)" hint="Pauses the mailbox and emails you."><input type="number" min={0} step={0.5} value={settings.bounce_pause_pct} onChange={(e) => set("bounce_pause_pct", Number(e.target.value))} /></Field>
          <Field label="Slow down when reply rate falls below" hint="Share of the 4-week average, e.g. 0.5 = half."><input type="number" min={0} max={1} step={0.05} value={settings.reply_drop_ratio} onChange={(e) => set("reply_drop_ratio", Number(e.target.value))} /></Field>
          <Field label="Pause after this many emails with no reply"><input type="number" min={10} value={settings.zero_reply_pause_after} onChange={(e) => set("zero_reply_pause_after", Number(e.target.value))} /></Field>
          <Field label="Minimum emails before rules apply" hint="Avoids reacting to tiny samples."><input type="number" min={1} value={settings.min_sample_for_rules} onChange={(e) => set("min_sample_for_rules", Number(e.target.value))} /></Field>
        </div>

        <h2>General</h2>
        <div className="form-grid">
          <Field label="Alert and summary email" hint="Daily summary and pause alerts. Empty = the first mailbox."><input type="email" value={settings.alert_email ?? ""} onChange={(e) => set("alert_email", e.target.value)} /></Field>
          <Field label="App address" hint="Used for unsubscribe links in emails. Filled in automatically on first sign-in."><input value={settings.app_url ?? ""} onChange={(e) => set("app_url", e.target.value)} placeholder="https://email-sender.pages.dev" /></Field>
          <Field label="Time zone" hint="For send windows and daily counts."><input value={settings.timezone} onChange={(e) => set("timezone", e.target.value)} /></Field>
        </div>

        <h2>Unsubscribe footer</h2>
        <p className="muted small">Added to emails whose template doesn't contain {"{{unsubscribe_url}}"}. Every email also carries a one-click unsubscribe header that Gmail and Outlook show next to the sender.</p>
        <Field label="HTML footer"><textarea className="code" rows={3} value={settings.footer_html} onChange={(e) => set("footer_html", e.target.value)} /></Field>
        <Field label="Plain-text footer"><textarea rows={2} value={settings.footer_text} onChange={(e) => set("footer_text", e.target.value)} /></Field>
        <div className="editor-actions">
          <button className="btn" disabled={!dirty} onClick={load}>Discard</button>
          <button className="btn btn-primary" disabled={!dirty} onClick={saveSettings}>Save settings</button>
        </div>
      </section>

      <section className="card">
        <h2>Do-not-email list</h2>
        <p className="muted small">Bounced and unsubscribed addresses are added automatically and are never emailed again.</p>
        <div className="row gap">
          <input className="grow" placeholder="Add addresses, separated by commas or spaces" value={suppressInput} onChange={(e) => setSuppressInput(e.target.value)} />
          <button className="btn" onClick={addSuppression}>Add</button>
        </div>
        {suppressed.length > 0 && (
          <table className="table compact">
            <tbody>
              {suppressed.map((s) => (
                <tr key={s.email}><td>{s.email}</td><td><StatusBadge status={s.reason} /></td><td className="muted">{dateTime(s.created_at)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
