import Papa from "papaparse";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Empty, Field, Modal, PageHeader, StatusBadge, useToast } from "../components/ui";
import { date, isEmail } from "../lib/format";
import { supabase, type Contact, type List } from "../lib/supabase";

const PAGE = 50;
const STATUSES = ["new", "emailed", "replied", "bounced", "unsubscribed"];

export default function Contacts() {
  const toast = useToast();
  const [lists, setLists] = useState<(List & { count: number })[]>([]);
  const [listId, setListId] = useState<string>("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Contact | null>(null);

  const loadLists = useCallback(async () => {
    const { data } = await supabase.from("lists").select("*, list_contacts(count)").order("created_at", { ascending: false });
    setLists((data ?? []).map((l: List & { list_contacts: { count: number }[] }) => ({ ...l, count: l.list_contacts?.[0]?.count ?? 0 })));
  }, []);

  const loadRows = useCallback(async () => {
    let query = listId
      ? supabase.from("contacts").select("*, list_contacts!inner(list_id)", { count: "exact" }).eq("list_contacts.list_id", listId)
      : supabase.from("contacts").select("*", { count: "exact" });
    if (status) query = query.eq("status", status);
    if (q.trim()) {
      const s = q.trim().replace(/[%,()]/g, "");
      query = query.or(`email.ilike.%${s}%,first_name.ilike.%${s}%,last_name.ilike.%${s}%,company.ilike.%${s}%`);
    }
    const { data, count, error } = await query.order("created_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) toast(error.message, "bad");
    setRows((data ?? []) as Contact[]);
    setTotal(count ?? 0);
  }, [listId, status, q, page, toast]);

  useEffect(() => { loadLists(); }, [loadLists]);
  useEffect(() => { const t = setTimeout(loadRows, 200); return () => clearTimeout(t); }, [loadRows]);
  useEffect(() => setPage(0), [listId, status, q]);

  async function deleteList(l: List & { count: number }) {
    if (!confirm(`Delete the list "${l.name}"? Contacts stay in your database; only the list is removed.`)) return;
    const { error } = await supabase.from("lists").delete().eq("id", l.id);
    if (error) return toast(error.message.includes("foreign key") ? "A campaign uses this list, so it can't be deleted." : error.message, "bad");
    if (listId === l.id) setListId("");
    loadLists();
  }

  return (
    <>
      <PageHeader
        title="Contacts"
        sub={`${total} contact${total === 1 ? "" : "s"}${listId ? " in this list" : ""}`}
        actions={<button className="btn btn-primary" onClick={() => setImporting(true)}>Import CSV</button>}
      />
      <div className="split">
        <aside className="list-nav card">
          <button className={!listId ? "on" : ""} onClick={() => setListId("")}>All contacts</button>
          <div className="list-nav-title">Lists</div>
          {lists.length === 0 && <p className="muted small pad">Lists are created when you import.</p>}
          {lists.map((l) => (
            <div key={l.id} className={`list-nav-item ${listId === l.id ? "on" : ""}`}>
              <button onClick={() => setListId(l.id)}>
                <span>{l.name}</span>
                <span className="muted small">{l.count}</span>
              </button>
              <button className="btn-icon small" title="Delete list" onClick={() => deleteList(l)}>×</button>
            </div>
          ))}
        </aside>

        <section className="card grow">
          <div className="toolbar">
            <input className="search" placeholder="Search email, name or company" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {rows.length === 0 ? (
            <Empty title={total === 0 && !q && !status ? "No contacts yet" : "Nothing matches"}>
              {total === 0 && !q && !status && "Import a CSV with at least an email column."}
            </Empty>
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr><th>Email</th><th>Name</th><th>Company</th><th>Status</th><th>Added</th></tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} onClick={() => setSelected(c)} className="clickable">
                      <td>{c.email}</td>
                      <td>{[c.first_name, c.last_name].filter(Boolean).join(" ") || <span className="muted">–</span>}</td>
                      <td>{c.company || <span className="muted">–</span>}</td>
                      <td><StatusBadge status={c.status} /></td>
                      <td className="muted">{date(c.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {total > PAGE && (
                <div className="pager">
                  <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
                  <span className="muted small">{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}</span>
                  <button className="btn" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Next</button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {importing && (
        <ImportModal
          lists={lists}
          onClose={() => setImporting(false)}
          onDone={(id) => { setImporting(false); loadLists(); setListId(id); loadRows(); }}
        />
      )}
      {selected && <ContactModal contact={selected} onClose={() => setSelected(null)} onChanged={() => { setSelected(null); loadRows(); }} />}
    </>
  );
}

// ---------------------------------------------------------------------------

type Target = "email" | "first_name" | "last_name" | "company" | "field" | "skip";

const GUESS: [RegExp, Target][] = [
  [/^(e-?mail|email address|e-?mailov[áa] adresa|mail)$/i, "email"],
  [/^(first ?name|firstname|given name|jm[ée]no|k[řr]estn[íi] jm[ée]no|name)$/i, "first_name"],
  [/^(last ?name|lastname|surname|family name|p[řr][íi]jmen[íi])$/i, "last_name"],
  [/^(company|company name|organization|organisation|firma|spole[čc]nost|n[áa]zev firmy)$/i, "company"],
];

function guess(header: string): Target {
  for (const [re, t] of GUESS) if (re.test(header.trim())) return t;
  return "field";
}

function fieldKey(header: string): string {
  return header.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "field";
}

function ImportModal({ lists, onClose, onDone }: { lists: List[]; onClose: () => void; onDone: (listId: string) => void }) {
  const toast = useToast();
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [data, setData] = useState<Record<string, string>[]>([]);
  const [map, setMap] = useState<Record<string, Target>>({});
  const [listMode, setListMode] = useState<"new" | "existing">("new");
  const [listName, setListName] = useState("");
  const [existingId, setExistingId] = useState(lists[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  function onFile(f: File) {
    setFileName(f.name);
    setListName(f.name.replace(/\.(csv|txt)$/i, ""));
    Papa.parse<Record<string, string>>(f, {
      header: true,
      skipEmptyLines: "greedy",
      complete: (res) => {
        const hs = (res.meta.fields ?? []).filter((h) => h.trim());
        setHeaders(hs);
        setData(res.data);
        const m: Record<string, Target> = {};
        let haveEmail = false;
        for (const h of hs) {
          let t = guess(h);
          if (t === "email") { if (haveEmail) t = "field"; haveEmail = true; }
          m[h] = t;
        }
        if (!haveEmail) {
          const h = hs.find((x) => res.data.slice(0, 20).some((r) => isEmail(r[x] ?? "")));
          if (h) m[h] = "email";
        }
        setMap(m);
      },
      error: (err) => toast(`Couldn't read the file: ${err.message}`, "bad"),
    });
  }

  const emailCol = headers.find((h) => map[h] === "email");
  const summary = useMemo(() => {
    if (!emailCol) return null;
    const seen = new Set<string>();
    let invalid = 0, dupes = 0;
    for (const r of data) {
      const e = (r[emailCol] ?? "").trim().toLowerCase();
      if (!isEmail(e)) { invalid++; continue; }
      if (seen.has(e)) { dupes++; continue; }
      seen.add(e);
    }
    return { valid: seen.size, invalid, dupes };
  }, [data, emailCol]);

  async function run() {
    if (!emailCol || !summary) return;
    setBusy(true);
    try {
      let listId = existingId;
      if (listMode === "new") {
        const { data: l, error } = await supabase.from("lists").insert({ name: listName.trim() || fileName }).select("id").single();
        if (error) throw error;
        listId = l.id;
      }
      const seen = new Set<string>();
      const contacts = [];
      for (const r of data) {
        const email = (r[emailCol] ?? "").trim().toLowerCase();
        if (!isEmail(email) || seen.has(email)) continue;
        seen.add(email);
        const c: Record<string, unknown> = { email, first_name: null, last_name: null, company: null, fields: {} };
        const fields: Record<string, string> = {};
        for (const h of headers) {
          const v = (r[h] ?? "").trim();
          const t = map[h];
          if (t === "first_name" || t === "last_name" || t === "company") c[t] = v || null;
          else if (t === "field" && v) fields[fieldKey(h)] = v;
        }
        c.fields = fields;
        contacts.push(c);
      }
      let done = 0;
      for (let i = 0; i < contacts.length; i += 500) {
        const batch = contacts.slice(i, i + 500);
        const { data: saved, error } = await supabase.from("contacts").upsert(batch, { onConflict: "email" }).select("id");
        if (error) throw error;
        const links = (saved ?? []).map((s) => ({ list_id: listId, contact_id: s.id }));
        const { error: le } = await supabase.from("list_contacts").upsert(links, { onConflict: "list_id,contact_id", ignoreDuplicates: true });
        if (le) throw le;
        done += batch.length;
        setProgress(`${done} / ${contacts.length}`);
      }
      const { count: suppressed } = await supabase.from("contacts").select("id, list_contacts!inner(list_id)", { count: "exact", head: true })
        .eq("list_contacts.list_id", listId).in("status", ["bounced", "unsubscribed"]);
      toast(`Imported ${done} contacts${suppressed ? ` (${suppressed} previously bounced or unsubscribed will be skipped)` : ""}.`);
      onDone(listId);
    } catch (e) {
      toast((e as Error).message, "bad");
      setBusy(false);
    }
  }

  return (
    <Modal title="Import contacts" onClose={onClose} wide>
      {!headers.length ? (
        <div className="dropzone">
          <p>Choose a CSV file. The first row must be column names; an email column is required.</p>
          <input type="file" accept=".csv,text/csv,.txt" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          <p className="muted small">Other columns (e.g. city, role, a custom first line) become variables like {"{{city}}"} in templates.</p>
        </div>
      ) : (
        <>
          <p className="muted small">{fileName} · {data.length} rows</p>
          <table className="table compact">
            <thead><tr><th>Column</th><th>Use as</th><th>Example</th></tr></thead>
            <tbody>
              {headers.map((h) => (
                <tr key={h}>
                  <td><b>{h}</b></td>
                  <td>
                    <select value={map[h]} onChange={(e) => setMap({ ...map, [h]: e.target.value as Target })}>
                      <option value="email">Email</option>
                      <option value="first_name">First name</option>
                      <option value="last_name">Last name</option>
                      <option value="company">Company</option>
                      <option value="field">Custom field {`{{${fieldKey(h)}}}`}</option>
                      <option value="skip">Don't import</option>
                    </select>
                  </td>
                  <td className="muted clamp-1">{data.find((r) => r[h])?.[h] ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {headers.filter((h) => map[h] === "email").length > 1 && <p className="error">Pick only one email column.</p>}
          {!emailCol && <p className="error">Pick which column holds the email address.</p>}
          {summary && (
            <p className="notice">
              {summary.valid} contacts will be imported
              {summary.invalid ? `, ${summary.invalid} row${summary.invalid === 1 ? "" : "s"} skipped (no valid email)` : ""}
              {summary.dupes ? `, ${summary.dupes} duplicate${summary.dupes === 1 ? "" : "s"} merged` : ""}. Existing contacts are updated, not duplicated.
            </p>
          )}
          <div className="row gap">
            <Field label="Add to">
              <select value={listMode} onChange={(e) => setListMode(e.target.value as "new" | "existing")}>
                <option value="new">A new list</option>
                {lists.length > 0 && <option value="existing">An existing list</option>}
              </select>
            </Field>
            {listMode === "new" ? (
              <Field label="List name"><input value={listName} onChange={(e) => setListName(e.target.value)} /></Field>
            ) : (
              <Field label="List">
                <select value={existingId} onChange={(e) => setExistingId(e.target.value)}>
                  {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
            )}
          </div>
          <div className="modal-actions">
            {progress && <span className="muted small">Saving {progress}</span>}
            <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={busy || !summary?.valid || headers.filter((h) => map[h] === "email").length !== 1}
              onClick={run}
            >
              {busy ? "Importing…" : `Import ${summary?.valid ?? 0} contacts`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function ContactModal({ contact, onClose, onChanged }: { contact: Contact; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [history, setHistory] = useState<{ id: string; status: string; sent_at: string | null; replied_at: string | null; bounced_at: string | null; campaigns: { name: string } | null }[]>([]);
  useEffect(() => {
    supabase.from("sends").select("id, status, sent_at, replied_at, bounced_at, campaigns(name)").eq("contact_id", contact.id)
      .order("queued_at", { ascending: false }).then(({ data }) => setHistory((data ?? []) as never));
  }, [contact.id]);

  async function suppress() {
    await supabase.from("suppression").upsert({ email: contact.email, reason: "manual" }, { onConflict: "email", ignoreDuplicates: true });
    await supabase.from("contacts").update({ status: "unsubscribed" }).eq("id", contact.id);
    await supabase.from("sends").update({ status: "skipped", error: "Suppressed manually" }).eq("contact_id", contact.id).eq("status", "queued");
    toast("Contact won't be emailed again.");
    onChanged();
  }
  async function remove() {
    if (!confirm(`Delete ${contact.email} and its history?`)) return;
    const { error } = await supabase.from("contacts").delete().eq("id", contact.id);
    if (error) return toast(error.message, "bad");
    onChanged();
  }

  return (
    <Modal title={contact.email} onClose={onClose}>
      <dl className="dl">
        <dt>Name</dt><dd>{[contact.first_name, contact.last_name].filter(Boolean).join(" ") || "–"}</dd>
        <dt>Company</dt><dd>{contact.company || "–"}</dd>
        <dt>Status</dt><dd><StatusBadge status={contact.status} /></dd>
        {Object.entries(contact.fields ?? {}).map(([k, v]) => (
          <Fragment key={k}><dt>{`{{${k}}}`}</dt><dd>{v}</dd></Fragment>
        ))}
      </dl>
      <h3>Emails</h3>
      {history.length === 0 ? <p className="muted small">Not in any campaign yet.</p> : (
        <table className="table compact">
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td>{h.campaigns?.name}</td>
                <td><StatusBadge status={h.bounced_at ? "bounced" : h.replied_at ? "replied" : h.status} /></td>
                <td className="muted">{h.sent_at ? date(h.sent_at) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="modal-actions">
        <button className="btn btn-danger-ghost" onClick={remove}>Delete</button>
        {!["unsubscribed", "bounced"].includes(contact.status) && <button className="btn" onClick={suppress}>Never email again</button>}
        <button className="btn btn-primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
