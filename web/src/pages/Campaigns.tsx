import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Empty, Field, Modal, PageHeader, StatusBadge, useToast } from "../components/ui";
import { DAY_NAMES, pct } from "../lib/format";
import { supabase, type Campaign, type CampaignStats, type List, type Mailbox, type Template } from "../lib/supabase";

type Row = Campaign & { lists: { name: string } | null; templates: { name: string } | null; mailboxes: { email: string } | null };

export default function Campaigns() {
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState<Record<string, CampaignStats>>({});
  const [creating, setCreating] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([
      supabase.from("campaigns").select("*, lists(name), templates(name), mailboxes(email)").order("created_at", { ascending: false }),
      supabase.from("campaign_stats").select("*"),
    ]);
    setRows((c.data ?? []) as Row[]);
    setStats(Object.fromEntries(((s.data ?? []) as CampaignStats[]).map((x) => [x.campaign_id, x])));
    setLoaded(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHeader title="Campaigns" sub="A campaign sends one template to one list, from one mailbox, inside a send window." actions={<button className="btn btn-primary" onClick={() => setCreating(true)}>New campaign</button>} />
      <section className="card">
        {loaded && rows.length === 0 ? (
          <Empty title="No campaigns yet">You'll need a connected mailbox, a contact list and a template.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Campaign</th><th>Status</th><th>Progress</th><th className="num">Replies</th><th className="num">Bounces</th><th className="num">Clicks</th><th>From</th></tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const s = stats[c.id];
                const done = s ? s.sent + s.failed + s.skipped : 0;
                return (
                  <tr key={c.id} className="clickable" onClick={() => navigate(`/campaigns/${c.id}`)}>
                    <td><Link to={`/campaigns/${c.id}`}><b>{c.name}</b></Link><div className="muted small">{c.lists?.name} · {c.templates?.name}</div></td>
                    <td><StatusBadge status={c.status} /></td>
                    <td>
                      {s && s.total > 0 ? (
                        <div className="meter slim">
                          <div className="meter-label"><b>{s.sent}</b> / {s.total} sent</div>
                          <div className="meter-track"><div className="meter-fill" style={{ width: `${(100 * done) / s.total}%` }} /></div>
                        </div>
                      ) : <span className="muted">not started</span>}
                    </td>
                    <td className="num">{s?.replies ?? 0} <span className="muted small">{s ? pct(s.replies, s.sent) : ""}</span></td>
                    <td className="num">{s?.bounces ?? 0} <span className="muted small">{s ? pct(s.bounces, s.sent) : ""}</span></td>
                    <td className="num">{c.track_clicks ? (s?.clicks ?? 0) : <span className="muted">off</span>}</td>
                    <td className="muted small">{c.mailboxes?.email}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      {creating && <CampaignForm onClose={() => setCreating(false)} onSaved={(id) => navigate(`/campaigns/${id}`)} />}
    </>
  );
}

export function CampaignForm({ campaign, onClose, onSaved }: { campaign?: Campaign; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const [lists, setLists] = useState<List[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [form, setForm] = useState({
    name: campaign?.name ?? "",
    list_id: campaign?.list_id ?? "",
    template_id: campaign?.template_id ?? "",
    mailbox_id: campaign?.mailbox_id ?? "",
    send_days: campaign?.send_days ?? [1, 2, 3, 4, 5],
    send_start: campaign?.send_start?.slice(0, 5) ?? "08:00",
    send_end: campaign?.send_end?.slice(0, 5) ?? "17:00",
    track_clicks: campaign?.track_clicks ?? true,
    track_opens: campaign?.track_opens ?? false,
  });
  const started = !!campaign && campaign.status !== "draft";

  useEffect(() => {
    Promise.all([
      supabase.from("lists").select("*").order("created_at", { ascending: false }),
      supabase.from("templates").select("*").order("updated_at", { ascending: false }),
      supabase.from("mailboxes").select("*").neq("status", "disconnected").order("created_at"),
    ]).then(([l, t, m]) => {
      const L = (l.data ?? []) as List[], T = (t.data ?? []) as Template[], M = (m.data ?? []) as Mailbox[];
      setLists(L); setTemplates(T); setMailboxes(M);
      setForm((f) => ({ ...f, list_id: f.list_id || L[0]?.id || "", template_id: f.template_id || T[0]?.id || "", mailbox_id: f.mailbox_id || M[0]?.id || "" }));
    });
  }, []);

  function toggleDay(d: number) {
    setForm((f) => ({ ...f, send_days: f.send_days.includes(d) ? f.send_days.filter((x) => x !== d) : [...f.send_days, d].sort() }));
  }

  async function save() {
    if (!form.name.trim()) return toast("Name the campaign.", "bad");
    if (!form.list_id || !form.template_id || !form.mailbox_id) return toast("Pick a list, a template and a mailbox.", "bad");
    if (!form.send_days.length) return toast("Pick at least one sending day.", "bad");
    if (form.send_end <= form.send_start) return toast("The send window must end after it starts.", "bad");
    const row = { ...form, name: form.name.trim() };
    const res = campaign
      ? await supabase.from("campaigns").update(started ? { name: row.name, send_days: row.send_days, send_start: row.send_start, send_end: row.send_end, track_clicks: row.track_clicks, track_opens: row.track_opens } : row).eq("id", campaign.id).select("id").single()
      : await supabase.from("campaigns").insert(row).select("id").single();
    if (res.error) return toast(res.error.message, "bad");
    toast(campaign ? "Campaign updated." : "Campaign created as a draft.");
    onSaved(res.data.id);
  }

  const missing = [!lists.length && "a contact list", !templates.length && "a template", !mailboxes.length && "a connected mailbox"].filter(Boolean);

  return (
    <Modal title={campaign ? "Edit campaign" : "New campaign"} onClose={onClose}>
      {missing.length > 0 && <p className="error">You need {missing.join(", ")} first.</p>}
      <Field label="Name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Prague agencies – November" /></Field>
      <Field label="Contact list"><select disabled={started} value={form.list_id} onChange={(e) => setForm({ ...form, list_id: e.target.value })}>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
      <Field label="Template"><select disabled={started} value={form.template_id} onChange={(e) => setForm({ ...form, template_id: e.target.value })}>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
      <Field label="Send from"><select disabled={started} value={form.mailbox_id} onChange={(e) => setForm({ ...form, mailbox_id: e.target.value })}>{mailboxes.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}</select></Field>
      {started && <p className="muted small">List, template and mailbox are fixed once a campaign has started.</p>}
      <div className="field">
        <span className="field-label">Send on</span>
        <div className="day-picks">
          {DAY_NAMES.map((n, i) => (
            <button key={n} type="button" className={`chip ${form.send_days.includes(i + 1) ? "chip-on" : ""}`} onClick={() => toggleDay(i + 1)}>{n}</button>
          ))}
        </div>
      </div>
      <div className="row gap">
        <Field label="From"><input type="time" value={form.send_start} onChange={(e) => setForm({ ...form, send_start: e.target.value })} /></Field>
        <Field label="Until"><input type="time" value={form.send_end} onChange={(e) => setForm({ ...form, send_end: e.target.value })} /></Field>
      </div>
      <p className="muted small">Times are in Prague time. Emails go out one at a time with a random 2–6 minute gap, within the mailbox's daily limit.</p>
      <label className="check"><input type="checkbox" checked={form.track_clicks} onChange={(e) => setForm({ ...form, track_clicks: e.target.checked })} /> Track link clicks</label>
      <label className="check"><input type="checkbox" checked={form.track_opens} onChange={(e) => setForm({ ...form, track_opens: e.target.checked })} /> Track opens <span className="muted small">(inaccurate, and a tracking pixel slightly hurts deliverability; best left off during warm-up)</span></label>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save} disabled={missing.length > 0}>{campaign ? "Save" : "Create draft"}</button>
      </div>
    </Modal>
  );
}
