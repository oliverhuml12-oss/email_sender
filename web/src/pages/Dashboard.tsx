import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DailyChart from "../components/DailyChart";
import { Badge, Empty, PageHeader, StatusBadge } from "../components/ui";
import { ago, dateTime, pct, plural, warmupWeek } from "../lib/format";
import { supabase, type DashboardStats, type Mailbox } from "../lib/supabase";

type Reply = {
  id: number;
  type: string;
  occurred_at: string;
  detail: { from?: string; subject?: string; snippet?: string };
  contacts: { email: string; first_name: string | null; company: string | null } | null;
};

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [today, setToday] = useState<Record<string, number>>({});
  const [replies, setReplies] = useState<Reply[]>([]);
  const [failed, setFailed] = useState(0);
  const [period, setPeriod] = useState<7 | 30>(7);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [s, m, t, r, f] = await Promise.all([
      supabase.rpc("dashboard_stats", { p_days: 30 }),
      supabase.from("mailboxes").select("*").order("created_at"),
      supabase.rpc("today_sent_counts"),
      supabase.from("events").select("id, type, occurred_at, detail, contacts(email, first_name, company)")
        .eq("type", "reply").order("occurred_at", { ascending: false }).limit(8),
      supabase.from("sends").select("id", { count: "exact", head: true }).eq("status", "failed")
        .gte("claimed_at", new Date(Date.now() - 7 * 86400000).toISOString()),
    ]);
    if (s.error) setError(s.error.message);
    setStats(s.data as DashboardStats);
    setMailboxes((m.data ?? []) as Mailbox[]);
    setToday(Object.fromEntries(((t.data ?? []) as { mailbox_id: string; sent_today: number }[]).map((x) => [x.mailbox_id, Number(x.sent_today)])));
    setReplies((r.data ?? []) as unknown as Reply[]);
    setFailed(f.count ?? 0);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!stats) return <div className="boot">Loading…</div>;

  const p = period === 7 ? stats.last7 : stats.last30;
  const alerts: { tone: "bad" | "warn"; text: string; link: string }[] = [];
  for (const mb of mailboxes) {
    if (mb.status === "disconnected") alerts.push({ tone: "bad", text: `${mb.email} is disconnected: ${mb.pause_reason ?? "reconnect it."}`, link: "/settings" });
    if (mb.status === "paused") alerts.push({ tone: "warn", text: `${mb.email} is paused: ${mb.pause_reason ?? "paused manually."}`, link: "/settings" });
  }
  if (failed) alerts.push({ tone: "bad", text: `${failed} email(s) failed to send in the last 7 days.`, link: "/campaigns" });

  return (
    <>
      <PageHeader
        title="Dashboard"
        sub={`${stats.queued} email${stats.queued === 1 ? "" : "s"} waiting in the queue`}
        actions={
          <div className="segmented">
            <button className={period === 7 ? "on" : ""} onClick={() => setPeriod(7)}>7 days</button>
            <button className={period === 30 ? "on" : ""} onClick={() => setPeriod(30)}>30 days</button>
          </div>
        }
      />

      {alerts.length > 0 && (
        <div className="alerts">
          {alerts.map((a, i) => (
            <Link key={i} to={a.link} className={`alert alert-${a.tone}`}>{a.text}</Link>
          ))}
        </div>
      )}

      <section className="kpis">
        <Kpi label="Sent" value={String(p.sent)} />
        <Kpi label="Reply rate" value={pct(p.replies, p.sent)} sub={plural(p.replies, "reply", "replies")} strong />
        <Kpi label="Bounce rate" value={pct(p.bounces, p.sent)} sub={plural(p.bounces, "bounce", "bounces")} warn={p.sent >= 20 && p.bounces / p.sent >= 0.02} />
        <Kpi label="Click rate" value={pct(p.clicks, p.sent)} sub={`${p.clicks} clicked`} />
        <Kpi label="Open rate" value={p.opens ? pct(p.opens, p.sent) : "–"} sub={p.opens ? "rough estimate" : "tracking off"} />
        <Kpi label="Unsubscribes" value={String(p.unsubscribes)} />
      </section>
      <p className="muted small kpi-note">Rates are for emails sent in the last {period} days.</p>

      <section className="card">
        <h2>Last 30 days</h2>
        {stats.daily.some((d) => d.sent) ? <DailyChart rows={stats.daily} /> : <Empty title="Nothing sent yet">Start a campaign and the daily numbers appear here.</Empty>}
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>Mailboxes</h2>
          {mailboxes.length === 0 ? (
            <Empty title="No mailbox connected"><Link to="/settings">Connect your Google Workspace mailbox</Link> to start sending.</Empty>
          ) : (
            <div className="mailbox-list">
              {mailboxes.map((mb) => {
                const limit = mb.daily_limit_override ?? mb.current_daily_limit;
                const sent = today[mb.id] ?? 0;
                return (
                  <div className="mailbox-row" key={mb.id}>
                    <div className="mailbox-main">
                      <div className="mailbox-name">{mb.email} <StatusBadge status={mb.status} /></div>
                      <div className="muted small">
                        Warm-up week {warmupWeek(mb.warmup_start_date)}
                        {mb.daily_limit_override !== null && " · manual limit"} · inbox checked {ago(mb.last_inbox_sync_at)}
                      </div>
                    </div>
                    <div className="meter" title={`${sent} of ${limit} today`}>
                      <div className="meter-label"><b>{sent}</b> / {limit} today</div>
                      <div className="meter-track"><div className="meter-fill" style={{ width: `${Math.min(100, (100 * sent) / Math.max(limit, 1))}%` }} /></div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="card">
          <h2>Latest replies</h2>
          {replies.length === 0 ? (
            <Empty title="No replies yet">Replies show up here within 15 minutes of arriving in your inbox.</Empty>
          ) : (
            <ul className="reply-list">
              {replies.map((r) => (
                <li key={r.id}>
                  <div className="reply-head">
                    <b>{r.contacts?.first_name || r.contacts?.email}</b>
                    {r.contacts?.company && <span className="muted"> · {r.contacts.company}</span>}
                    <span className="muted small right">{dateTime(r.occurred_at)}</span>
                  </div>
                  <div className="muted small clamp">{r.detail?.snippet}</div>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">Open Gmail to answer. <Badge tone="info">auto-replies are filtered out</Badge></p>
        </section>
      </div>
    </>
  );
}

function Kpi({ label, value, sub, strong, warn }: { label: string; value: string; sub?: string; strong?: boolean; warn?: boolean }) {
  return (
    <div className={`kpi ${strong ? "kpi-strong" : ""} ${warn ? "kpi-warn" : ""}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
