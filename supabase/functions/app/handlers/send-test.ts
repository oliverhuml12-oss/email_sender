// Sends a test of a template to any address, from a connected mailbox. Admin only.
// POST { template_id?, subject?, html?, text_body?, mailbox_id, to, contact? }
import { loadSettings } from "../lib/deliver.ts";
import { accessToken, sendEmail } from "../lib/gmail.ts";
import { renderEmail } from "../lib/render.ts";
import { adminClient, adminUserId, corsHeaders, errorMessage, json } from "../lib/util.ts";

const SAMPLE = { email: "jana.novakova@example.com", first_name: "Jana", last_name: "Nováková", company: "Example s.r.o.", fields: {} };

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const db = adminClient();
  if (!(await adminUserId(req, db))) return json({ error: "Not signed in as the admin" }, 401);
  try {
    const body = await req.json();
    const to = String(body.to ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return json({ error: "Enter a valid email address" }, 400);

    let tpl = { subject: body.subject, html: body.html, text_body: body.text_body };
    if (body.template_id) {
      const { data, error } = await db.from("templates").select("subject, html, text_body").eq("id", body.template_id).single();
      if (error) throw error;
      tpl = { subject: tpl.subject ?? data.subject, html: tpl.html ?? data.html, text_body: tpl.text_body ?? data.text_body };
    }
    const { data: mb, error: mbErr } = await db.from("mailboxes").select("id, email, display_name, status")
      .eq("id", body.mailbox_id).single();
    if (mbErr || !mb) return json({ error: "Pick a connected mailbox" }, 400);
    if (mb.status === "disconnected") return json({ error: "That mailbox is disconnected. Reconnect it in Settings." }, 400);

    const settings = await loadSettings(db);
    const unsub = settings.app_url ? `${settings.app_url.replace(/\/$/, "")}/unsubscribe?t=test` : "#unsubscribe";
    const r = renderEmail(
      { subject: tpl.subject ?? "", html: tpl.html ?? "", text_body: tpl.text_body, footer_html: settings.footer_html, footer_text: settings.footer_text },
      { ...SAMPLE, ...(body.contact ?? {}) },
      { unsubscribeUrl: unsub },
    );
    const token = await accessToken(db, mb.id);
    const sent = await sendEmail(token, {
      fromEmail: mb.email,
      fromName: mb.display_name,
      to,
      subject: `[TEST] ${r.subject}`,
      html: r.html,
      text: r.text,
    });
    return json({ ok: true, id: sent.id });
  } catch (e) {
    console.error(e);
    return json({ error: errorMessage(e) }, 500);
  }
}
