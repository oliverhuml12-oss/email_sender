// Called by pg_cron every 2 minutes. Sends at most one email per mailbox per run.
// Limits, the send window and the random gap between emails are enforced in claim_next_send().
import { deliverSend, loadSettings } from "../lib/deliver.ts";
import { adminClient, errorMessage, isCronRequest, json } from "../lib/util.ts";

export default async function handler(req: Request): Promise<Response> {
  if (!(await isCronRequest(req))) return json({ error: "forbidden" }, 403);
  const db = adminClient();
  try {
    const settings = await loadSettings(db);
    const { data: mailboxes, error } = await db.from("mailboxes").select("id, email, display_name")
      .eq("status", "active").lte("next_send_at", new Date().toISOString());
    if (error) throw error;

    const results = [];
    for (const mb of mailboxes ?? []) {
      const { data: rows, error: claimErr } = await db.rpc("claim_next_send", { p_mailbox: mb.id });
      if (claimErr) {
        results.push({ mailbox: mb.email, error: claimErr.message });
        continue;
      }
      const send = rows?.[0];
      if (!send) continue;
      results.push({ mailbox: mb.email, ...(await deliverSend(db, send, mb, settings)) });
    }
    await db.rpc("housekeeping");
    return json({ ok: true, results });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: errorMessage(e) }, 500);
  }
}
