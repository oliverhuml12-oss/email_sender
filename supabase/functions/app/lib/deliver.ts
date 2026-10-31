import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { accessToken, GmailAuthError, sendEmail } from "./gmail.ts";
import { renderEmail } from "./render.ts";
import { errorMessage, FUNCTIONS_URL } from "./util.ts";

export type Settings = {
  app_url: string | null;
  alert_email: string | null;
  footer_html: string;
  footer_text: string;
  timezone: string;
};

export async function loadSettings(db: SupabaseClient): Promise<Settings> {
  const { data, error } = await db.from("settings").select("*").eq("id", 1).single();
  if (error) throw error;
  return data as Settings;
}

export function unsubscribeLinks(settings: Settings, sendId: string) {
  const oneClick = `${FUNCTIONS_URL}/track/u/${sendId}`;
  const page = settings.app_url ? `${settings.app_url.replace(/\/$/, "")}/unsubscribe?t=${sendId}` : oneClick;
  return { page, oneClick };
}

type Send = { id: string; campaign_id: string; contact_id: string; mailbox_id: string };
type Mailbox = { id: string; email: string; display_name: string | null };

/** Render and send one claimed row from `sends`. Never throws. */
export async function deliverSend(db: SupabaseClient, send: Send, mailbox: Mailbox, settings: Settings) {
  try {
    const [{ data: contact }, { data: campaign }] = await Promise.all([
      db.from("contacts").select("*").eq("id", send.contact_id).single(),
      db.from("campaigns").select("*, templates(*)").eq("id", send.campaign_id).single(),
    ]);
    if (!contact || !campaign) throw new Error("Contact or campaign no longer exists");

    const { data: suppressed } = await db.from("suppression").select("email").eq("email", contact.email).maybeSingle();
    if (suppressed || ["bounced", "unsubscribed"].includes(contact.status)) {
      await db.from("sends").update({ status: "skipped", error: "Address is suppressed" }).eq("id", send.id);
      return { send: send.id, result: "skipped" };
    }

    const t = campaign.templates;
    const links = unsubscribeLinks(settings, send.id);
    const rendered = renderEmail(
      { subject: t.subject, html: t.html, text_body: t.text_body, footer_html: settings.footer_html, footer_text: settings.footer_text },
      contact,
      {
        unsubscribeUrl: links.page,
        clickUrl: campaign.track_clicks ? (i) => `${FUNCTIONS_URL}/track/c/${send.id}/${i}` : undefined,
        pixelUrl: campaign.track_opens ? `${FUNCTIONS_URL}/track/o/${send.id}` : undefined,
      },
    );

    const token = await accessToken(db, mailbox.id);
    const sent = await sendEmail(token, {
      fromEmail: mailbox.email,
      fromName: mailbox.display_name,
      to: contact.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      unsubscribeUrl: links.oneClick,
    });

    await db.from("sends").update({
      status: "sent",
      sent_at: new Date().toISOString(),
      subject: rendered.subject,
      links: rendered.links,
      gmail_message_id: sent.id,
      gmail_thread_id: sent.threadId,
      error: null,
    }).eq("id", send.id);
    if (contact.status === "new") await db.from("contacts").update({ status: "emailed" }).eq("id", contact.id);
    return { send: send.id, result: "sent" };
  } catch (e) {
    if (e instanceof GmailAuthError) {
      // Mailbox lost access: put the email back in the queue so it goes out after reconnecting.
      await db.from("sends").update({ status: "queued", claimed_at: null, error: errorMessage(e) }).eq("id", send.id);
      return { send: send.id, result: "requeued", error: errorMessage(e) };
    }
    await db.from("sends").update({ status: "failed", error: errorMessage(e).slice(0, 500) }).eq("id", send.id);
    return { send: send.id, result: "failed", error: errorMessage(e) };
  }
}

/** Stop emailing an address everywhere (bounce or unsubscribe). */
export async function suppressContact(
  db: SupabaseClient,
  contactId: string,
  email: string,
  reason: "bounced" | "unsubscribed",
) {
  await db.from("suppression").upsert({ email, reason }, { onConflict: "email", ignoreDuplicates: true });
  await db.from("contacts").update({ status: reason }).eq("id", contactId);
  await db.from("sends").update({ status: "skipped", error: reason === "bounced" ? "Address bounced" : "Unsubscribed" })
    .eq("contact_id", contactId).eq("status", "queued");
}
