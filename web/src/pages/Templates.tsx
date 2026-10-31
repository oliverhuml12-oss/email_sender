import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Empty, Field, Modal, PageHeader, useToast } from "../components/ui";
import { dateTime, isEmail } from "../lib/format";
import { renderEmail } from "../lib/render";
import { STARTERS, VARIABLES } from "../lib/starters";
import { callFunction, supabase, type Mailbox, type Settings, type Template } from "../lib/supabase";

type Draft = Pick<Template, "name" | "subject" | "html" | "text_body"> & { id?: string };

const SAMPLE = { email: "jana.novakova@example.com", first_name: "Jana", last_name: "Nováková", company: "Example s.r.o.", fields: {} };
const BLANK: Draft = { name: "", subject: "", html: "", text_body: "" };

export default function Templates({ userEmail }: { userEmail: string }) {
  const toast = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [view, setView] = useState<"desktop" | "mobile" | "text">("desktop");
  const [testing, setTesting] = useState(false);
  const [starter, setStarter] = useState(false);
  const htmlRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.from("templates").select("*").order("updated_at", { ascending: false });
    setTemplates((data ?? []) as Template[]);
    return (data ?? []) as Template[];
  }, []);

  useEffect(() => {
    load().then((t) => { if (t[0]) open(t[0]); });
    supabase.from("settings").select("*").eq("id", 1).single().then(({ data }) => setSettings(data as Settings));
    supabase.from("mailboxes").select("*").neq("status", "disconnected").then(({ data }) => setMailboxes((data ?? []) as Mailbox[]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function open(t: Template | Draft) {
    const d = { id: t.id, name: t.name, subject: t.subject, html: t.html, text_body: t.text_body ?? "" };
    setDraft(d);
    setSaved(JSON.stringify(d));
  }

  const dirty = draft ? JSON.stringify(draft) !== saved : false;

  const preview = useMemo(() => {
    if (!draft || !settings) return null;
    return renderEmail(
      { subject: draft.subject, html: draft.html, text_body: draft.text_body, footer_html: settings.footer_html, footer_text: settings.footer_text },
      SAMPLE,
      { unsubscribeUrl: "#unsubscribe" },
    );
  }, [draft, settings]);

  async function save() {
    if (!draft) return;
    if (!draft.name.trim() || !draft.subject.trim()) return toast("Give the template a name and a subject.", "bad");
    const row = { name: draft.name.trim(), subject: draft.subject, html: draft.html, text_body: draft.text_body?.trim() ? draft.text_body : null, updated_at: new Date().toISOString() };
    const res = draft.id
      ? await supabase.from("templates").update(row).eq("id", draft.id).select().single()
      : await supabase.from("templates").insert(row).select().single();
    if (res.error) return toast(res.error.message, "bad");
    toast("Template saved.");
    open(res.data as Template);
    load();
  }

  async function remove() {
    if (!draft?.id || !confirm(`Delete "${draft.name}"?`)) return;
    const { error } = await supabase.from("templates").delete().eq("id", draft.id);
    if (error) return toast(error.message.includes("foreign key") ? "A campaign uses this template, so it can't be deleted." : error.message, "bad");
    const t = await load();
    if (t[0]) open(t[0]); else setDraft(null);
  }

  function insertVar(key: string) {
    if (!draft) return;
    const el = htmlRef.current;
    const token = `{{${key}}}`;
    if (!el) return setDraft({ ...draft, html: draft.html + token });
    const { selectionStart: a, selectionEnd: b } = el;
    const html = draft.html.slice(0, a) + token + draft.html.slice(b);
    setDraft({ ...draft, html });
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = a + token.length; });
  }

  function trySwitch(next: () => void) {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    next();
  }

  return (
    <>
      <PageHeader
        title="Templates"
        sub="Paste a designed HTML email or write a simple one. {{variables}} are filled in per contact."
        actions={<button className="btn btn-primary" onClick={() => trySwitch(() => setStarter(true))}>New template</button>}
      />
      <div className="split">
        <aside className="list-nav card">
          {templates.length === 0 && <p className="muted small pad">No templates yet.</p>}
          {templates.map((t) => (
            <div key={t.id} className={`list-nav-item ${draft?.id === t.id ? "on" : ""}`}>
              <button onClick={() => trySwitch(() => open(t))}>
                <span>{t.name}</span>
                <span className="muted small">{dateTime(t.updated_at)}</span>
              </button>
            </div>
          ))}
        </aside>

        {!draft ? (
          <section className="card grow">
            <Empty title="No template selected">Create one with “New template”. You can start from a design or paste your own HTML.</Empty>
          </section>
        ) : (
          <div className="editor grow">
            <section className="card editor-form">
              <div className="row gap">
                <Field label="Name"><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Cold intro v1" /></Field>
              </div>
              <Field label="Subject"><input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="Quick question about {{company}}" /></Field>
              <div className="var-chips">
                <span className="muted small">Insert:</span>
                {VARIABLES.map((v) => <button key={v.key} className="chip" onClick={() => insertVar(v.key)} title={`{{${v.key}}}`}>{v.label}</button>)}
                <span className="muted small">Fallback: {"{{first_name | there}}"}</span>
              </div>
              <Field label="HTML" hint="Table-based HTML with inline styles renders best. If there's no {{unsubscribe_url}}, the footer from Settings is added automatically.">
                <textarea ref={htmlRef} className="code" rows={18} spellCheck={false} wrap="off" value={draft.html} onChange={(e) => setDraft({ ...draft, html: e.target.value })} />
              </Field>
              <details>
                <summary className="small">Plain-text version {draft.text_body?.trim() ? "(custom)" : "(generated automatically)"}</summary>
                <Field label="Plain text" hint="Leave empty to generate it from the HTML. Every email is sent with both versions.">
                  <textarea rows={8} value={draft.text_body ?? ""} onChange={(e) => setDraft({ ...draft, text_body: e.target.value })} />
                </Field>
              </details>
              <div className="editor-actions">
                {draft.id && <button className="btn btn-danger-ghost" onClick={remove}>Delete</button>}
                {draft.id && <button className="btn" onClick={() => open({ ...draft, id: undefined, name: `${draft.name} (copy)` })}>Duplicate</button>}
                <button className="btn" onClick={() => setTesting(true)} disabled={!draft.subject}>Send test</button>
                <button className="btn btn-primary" onClick={save} disabled={!dirty && !!draft.id}>{dirty || !draft.id ? "Save" : "Saved"}</button>
              </div>
            </section>

            <section className="card preview">
              <div className="preview-head">
                <div className="segmented">
                  <button className={view === "desktop" ? "on" : ""} onClick={() => setView("desktop")}>Desktop</button>
                  <button className={view === "mobile" ? "on" : ""} onClick={() => setView("mobile")}>Mobile</button>
                  <button className={view === "text" ? "on" : ""} onClick={() => setView("text")}>Plain text</button>
                </div>
                <span className="muted small">Sample: Jana Nováková, Example s.r.o.</span>
              </div>
              <div className="inbox-line">
                <b>{preview?.subject || <span className="muted">No subject</span>}</b>
              </div>
              {view === "text" ? (
                <pre className="text-preview">{preview?.text}</pre>
              ) : (
                <div className={`frame-wrap ${view}`}>
                  <iframe title="Email preview" sandbox="" srcDoc={preview?.html ?? ""} />
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {starter && (
        <Modal title="New template" onClose={() => setStarter(false)}>
          <div className="starter-list">
            {STARTERS.map((s) => (
              <button key={s.name} className="starter" onClick={() => { open({ ...BLANK, name: s.name.split(" (")[0], subject: s.subject, html: s.html }); setStarter(false); }}>
                <b>{s.name}</b>
                <span className="muted small">{s.note}</span>
              </button>
            ))}
            <button className="starter" onClick={() => { open({ ...BLANK }); setStarter(false); }}>
              <b>Blank</b>
              <span className="muted small">Paste HTML you designed elsewhere (or that Claude built for you).</span>
            </button>
          </div>
        </Modal>
      )}

      {testing && draft && (
        <TestModal draft={draft} mailboxes={mailboxes} defaultTo={userEmail} onClose={() => setTesting(false)} />
      )}
    </>
  );
}

function TestModal({ draft, mailboxes, defaultTo, onClose }: { draft: Draft; mailboxes: Mailbox[]; defaultTo: string; onClose: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState(defaultTo);
  const [mailboxId, setMailboxId] = useState(mailboxes[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      await callFunction("send-test", { mailbox_id: mailboxId, to, subject: draft.subject, html: draft.html, text_body: draft.text_body || null });
      toast(`Test sent to ${to}.`);
      onClose();
    } catch (e) {
      toast((e as Error).message, "bad");
    }
    setBusy(false);
  }

  return (
    <Modal title="Send a test email" onClose={onClose}>
      {mailboxes.length === 0 ? (
        <p className="error">Connect a mailbox in Settings first.</p>
      ) : (
        <>
          <Field label="From">
            <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
              {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
            </select>
          </Field>
          <Field label="To" hint="Sends the current editor content, filled with the sample contact. Subject starts with [TEST].">
            <input type="email" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <p className="muted small">Tip: send to a Gmail and an Outlook address to check where it lands (Primary, Promotions or Spam).</p>
        </>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !mailboxId || !isEmail(to)} onClick={send}>{busy ? "Sending…" : "Send test"}</button>
      </div>
    </Modal>
  );
}
