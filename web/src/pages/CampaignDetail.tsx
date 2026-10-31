import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Empty, PageHeader, StatusBadge, useToast } from "../components/ui";
import { DAY_NAMES, dateTime, pct, plural } from "../lib/format";
import { supabase, type Campaign, type CampaignStats } from "../lib/supabase";
import { CampaignForm } from "./Campaigns";

type SendRow = {
  id: string;
  status: string;
  sent_at: string | null;
  opened_at: string | null;
  open_count: number;
  clicked_at: string | null;
  click_count: number;
  replied_at: string | null;
  bounced_at: string | null;
  unsubscribed_at: string | null;
  error: string | null;
  contacts: { email: string; first_name: string | null; company: string | null } | null;
};

type C = Campaign & { lists: { name: string } | null; templates: { name: string; subject: string } | null; mailboxes: { email: string; status: string } | null };

const FILTERS: { key: string; label: string }[] = [
  { key: "", label: "All" },
  { key: "queued", label: "Queued" },
  { key: "sent", label: "Sent" },
  { key: "replied", label: "Replied" },
  { key: "clicked", label: "Clicked" },
  { key: "bounced", label: "Bounced" },
  { key: "failed", label: "Failed / skipped" },
];

export default function CampaignDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [c, setC] = useState<C | null>(null);
  const [s, setS] = useState<CampaignStats | null>(null);
  const [sends, setSends] = useState<SendRow[]>([]);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [cr, sr] = await Promise.all([
      supabase.from("campaigns").select("*, lists(name), templates(name, subject), mailboxes(email, status)").eq("id", id!).single(),
      supabase.from("campaign_stats").select("*").eq("campaign_id", id!).single(),
    ]);
    setC(cr.data as C);
    setS(sr.data as CampaignStats);
    let q = supabase.from("sends").select("id, status, sent_at, opened_at, open_count, clicked_at, click_count, replied_at, bounced_at, unsubscribed_at, error, contacts(email, first_name, company)").eq("campaign_id", id!);
    if (filter === "queued" || filter === "sent") q = q.eq("status", filter);
    if (filter === "replied") q = q.not("replied_at", "is", null);
    if (filter === "clicked") q = q.not("clicked_at", "is", null);
    if (filter === "bounced") q = q.not("bounced_at", "is", null);
    if (filter === "failed") q = q.in("status", ["failed", "skipped"]);
    const { data } = await q.order("sent_at", { ascending: false, nullsFirst: false }).order("queued_at").limit(500);
    setSends((data ?? []) as unknown as SendRow[]);
  }, [id, filter]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function start() {
    setBusy(true);
    const { data, error } = await supabase.rpc("start_campaign", { p_campaign: id });
    setBusy(false);
    if (error) return toast(error.message, "bad");
    toast(c?.status === "draft" ? `Started: ${data} emails queued.` : `${data} new contact(s) from the list added to the queue.`);
    load();
  }
  async function setStatus(status: "paused" | "active") {
    const { error } = await supabase.from("campaigns").update({ status }).eq("id", id!);
    if (error) return toast(error.message, "bad");
    load();
  }
  async function retryFailed() {
    const { error, count } = await supabase.from("sends").update({ status: "queued", error: null, claimed_at: null }, { count: "exact" }).eq("campaign_id", id!).eq("status", "failed");
    if (error) return toast(error.message, "bad");
    if (c?.status === "completed") await supabase.from("campaigns").update({ status: "active" }).eq("id", id!);
    toast(`${count ?? 0} failed email(s) queued again.`);
    load();
  }
  async function remove() {
    if (!confirm(`Delete "${c?.name}" and all its send history?`)) return;
    const { error } = await supabase.from("campaigns").delete().eq("id", id!);
    if (error) return toast(error.message, "bad");
    navigate("/campaigns");
  }

  if (!c) return <div className="boot">Loading…</div>;
  const days = c.send_days.map((d) => DAY_NAMES[d - 1]).join(", ");

  return (
    <>
      <PageHeader
        title={c.name}
        sub={<><StatusBadge status={c.status} /> {c.lists?.name} · {c.templates?.name} · from {c.mailboxes?.email} · {days} {c.send_start.slice(0, 5)}–{c.send_end.slice(0, 5)}</>}
        actions={
          <>
            <Link to="/campaigns" className="btn">Back</Link>
            <button className="btn" onClick={() => setEditing(true)}>Edit</button>
            {c.status === "draft" && <button className="btn btn-primary" onClick={start} disabled={busy}>Start sending</button>}
            {c.status === "active" && <button className="btn" onClick={() => setStatus("paused")}>Pause</button>}
            {c.status === "paused" && <button className="btn btn-primary" onClick={() => setStatus("active")}>Resume</button>}
            {(c.status === "active" || c.status === "paused" || c.status === "completed") && (
              <button className="btn" onClick={start} disabled={busy} title="Queue contacts added to the list since the campaign started">Add new list contacts</button>
            )}
          </>
        }
      />
      {c.mailboxes?.status !== "active" && c.status === "active" && (
        <div className="alerts"><Link to="/settings" className="alert alert-warn">The sending mailbox is {c.mailboxes?.status}, so nothing goes out until it's active again.</Link></div>
      )}

      {s && (
        <section className="kpis">
          <div className="kpi"><div className="kpi-label">Sent</div><div className="kpi-value">{s.sent}</div><div className="kpi-sub">{s.queued} queued</div></div>
          <div className="kpi kpi-strong"><div className="kpi-label">Reply rate</div><div className="kpi-value">{pct(s.replies, s.sent)}</div><div className="kpi-sub">{plural(s.replies, "reply", "replies")}</div></div>
          <div className={`kpi ${s.sent >= 20 && s.bounces / s.sent >= 0.02 ? "kpi-warn" : ""}`}><div className="kpi-label">Bounce rate</div><div className="kpi-value">{pct(s.bounces, s.sent)}</div><div className="kpi-sub">{plural(s.bounces, "bounce", "bounces")}</div></div>
          <div className="kpi"><div className="kpi-label">Click rate</div><div className="kpi-value">{c.track_clicks ? pct(s.clicks, s.sent) : "–"}</div><div className="kpi-sub">{c.track_clicks ? `${s.clicks} clicked` : "tracking off"}</div></div>
          <div className="kpi"><div className="kpi-label">Open rate</div><div className="kpi-value">{c.track_opens ? pct(s.opens, s.sent) : "–"}</div><div className="kpi-sub">{c.track_opens ? "rough estimate" : "tracking off"}</div></div>
          <div className="kpi"><div className="kpi-label">Unsubscribed</div><div className="kpi-value">{s.unsubscribes}</div><div className="kpi-sub">{s.failed + s.skipped} failed / skipped</div></div>
        </section>
      )}

      <section className="card">
        <div className="toolbar">
          <div className="segmented">
            {FILTERS.map((f) => <button key={f.key} className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)}>{f.label}</button>)}
          </div>
          {s && s.failed > 0 && <button className="btn" onClick={retryFailed}>Retry {s.failed} failed</button>}
        </div>
        {sends.length === 0 ? (
          <Empty title={c.status === "draft" ? "Not started" : "Nothing here"}>{c.status === "draft" && "Press “Start sending” to queue every contact in the list."}</Empty>
        ) : (
          <table className="table">
            <thead><tr><th>Contact</th><th>Status</th><th>Sent</th><th>Clicked</th><th>Opened</th><th>Replied</th></tr></thead>
            <tbody>
              {sends.map((r) => (
                <tr key={r.id}>
                  <td>{r.contacts?.email}<div className="muted small">{[r.contacts?.first_name, r.contacts?.company].filter(Boolean).join(" · ")}</div></td>
                  <td>
                    <StatusBadge status={r.bounced_at ? "bounced" : r.unsubscribed_at ? "unsubscribed" : r.replied_at ? "replied" : r.status} />
                    {r.error && <div className="error small clamp-1" title={r.error}>{r.error}</div>}
                  </td>
                  <td className="muted">{dateTime(r.sent_at)}</td>
                  <td className="muted">{r.clicked_at ? `${dateTime(r.clicked_at)}${r.click_count > 1 ? ` (${r.click_count}×)` : ""}` : "–"}</td>
                  <td className="muted">{r.opened_at ? dateTime(r.opened_at) : "–"}</td>
                  <td className="muted">{dateTime(r.replied_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sends.length === 500 && <p className="muted small">Showing the first 500.</p>}
      </section>

      <div className="danger-zone"><button className="btn btn-danger-ghost" onClick={remove}>Delete campaign</button></div>
      {editing && <CampaignForm campaign={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
    </>
  );
}
