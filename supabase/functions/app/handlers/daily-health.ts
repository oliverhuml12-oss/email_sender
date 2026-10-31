// Called by pg_cron once a day. Sets each mailbox's daily limit (see run_daily_health in SQL)
// and emails a short summary to the alert address.
import { loadSettings } from "../lib/deliver.ts";
import { accessToken, sendEmail } from "../lib/gmail.ts";
import { escapeHtml } from "../lib/render.ts";
import { adminClient, errorMessage, isCronRequest, json } from "../lib/util.ts";

type Row = {
  email: string;
  action: "normal" | "slowed" | "paused" | "still_paused";
  reason: string | null;
  warmup_week: number;
  limit: number;
  override: number | null;
  sent7: number;
  bounces7: number;
  replies7: number;
  bounce_pct: number;
  reply_pct: number;
};

const LABEL: Record<Row["action"], string> = {
  normal: "OK",
  slowed: "Slowed down",
  paused: "PAUSED",
  still_paused: "Still paused",
};

export default async function handler(req: Request): Promise<Response> {
  if (!(await isCronRequest(req))) return json({ error: "forbidden" }, 403);
  const db = adminClient();
  try {
    const { data: report, error } = await db.rpc("run_daily_health");
    if (error) throw error;
    const rows = (report?.mailboxes ?? []) as Row[];
    const settings = await loadSettings(db);

    const needsAttention = rows.some((r) => r.action !== "normal");
    const hadActivity = rows.some((r) => r.sent7 > 0) || (report?.queued ?? 0) > 0;
    let emailed = false;

    if (rows.length && (needsAttention || hadActivity)) {
      const { data: sender } = await db.from("mailboxes").select("id, email, display_name")
        .neq("status", "disconnected").order("created_at").limit(1).maybeSingle();
      const to = settings.alert_email || sender?.email;
      if (sender && to) {
        const subject = needsAttention
          ? `Email sender: ${rows.filter((r) => r.action !== "normal").length} mailbox(es) need attention`
          : "Email sender: daily summary";
        const lines = rows.map((r) =>
          `${r.email}: ${LABEL[r.action]}${r.reason ? ` (${r.reason})` : ""}. ` +
          `Tomorrow's limit ${r.limit}/day${r.override !== null ? " (manual override)" : ""}, warm-up week ${r.warmup_week}. ` +
          `Last 7 days: ${r.sent7} sent, ${r.replies7} replies (${r.reply_pct}%), ${r.bounces7} bounces (${r.bounce_pct}%).`
        );
        const appLink = settings.app_url ? `\n\nOpen the dashboard: ${settings.app_url}` : "";
        const text = `${lines.join("\n\n")}\n\nEmails waiting in the queue: ${report?.queued ?? 0}.${appLink}`;
        const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:21px;color:#222">` +
          rows.map((r) =>
            `<p style="margin:0 0 14px"><b>${escapeHtml(r.email)}</b>: <span style="color:${
              r.action === "normal" ? "#1a7f37" : "#b42318"
            }">${LABEL[r.action]}</span>${r.reason ? ` &ndash; ${escapeHtml(r.reason)}` : ""}<br>` +
            `Tomorrow's limit: ${r.limit}/day${r.override !== null ? " (manual override)" : ""} &middot; warm-up week ${r.warmup_week}<br>` +
            `Last 7 days: ${r.sent7} sent &middot; ${r.replies7} replies (${r.reply_pct}%) &middot; ${r.bounces7} bounces (${r.bounce_pct}%)</p>`
          ).join("") +
          `<p style="margin:0 0 14px">Emails waiting in the queue: ${report?.queued ?? 0}</p>` +
          (settings.app_url ? `<p><a href="${escapeHtml(settings.app_url)}">Open the dashboard</a></p>` : "") +
          `</div>`;
        const token = await accessToken(db, sender.id);
        await sendEmail(token, { fromEmail: sender.email, fromName: "Email sender", to, subject, html, text });
        emailed = true;
      }
    }
    return json({ ok: true, report, emailed });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: errorMessage(e) }, 500);
  }
}
