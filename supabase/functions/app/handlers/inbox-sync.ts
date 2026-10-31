// Called by pg_cron every 15 minutes. Finds replies, auto-replies and bounces to our emails.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { suppressContact } from "../lib/deliver.ts";
import { accessToken, getMessageMeta, listMessages, type MessageMeta } from "../lib/gmail.ts";
import { adminClient, errorMessage, isCronRequest, json } from "../lib/util.ts";

const AUTO_SUBJECT =
  /(out of (the )?office|automatic reply|auto.?reply|autoreply|abwesenheit|automatick[áa] odpov[ěe][ďd]|nep[řr][íi]tom|dovolen[áa]|vacation)/i;
const DELAY_SUBJECT = /(delay|delayed|warning: message .* not yet delivered|zpo[žz]d)/i;

function isBounce(m: MessageMeta): boolean {
  const from = (m.headers["from"] ?? "").toLowerCase();
  if (m.headers["x-failed-recipients"]) return true;
  if (/mailer-daemon|postmaster|mail delivery (subsystem|system)/.test(from)) return true;
  return /multipart\/report.*delivery-status/i.test(m.headers["content-type"] ?? "");
}

function isAutoReply(m: MessageMeta): boolean {
  const auto = (m.headers["auto-submitted"] ?? "").toLowerCase();
  if (auto && auto !== "no") return true;
  if (m.headers["x-autoreply"] || m.headers["x-autorespond"]) return true;
  if (/auto_reply/i.test(m.headers["precedence"] ?? "")) return true;
  return AUTO_SUBJECT.test(m.headers["subject"] ?? "");
}

type SendRow = { id: string; contact_id: string; gmail_thread_id: string; replied_at: string | null; bounced_at: string | null };

async function recordEvent(db: SupabaseClient, send: SendRow, type: string, m: MessageMeta) {
  const { error } = await db.from("events").upsert({
    send_id: send.id,
    contact_id: send.contact_id,
    type,
    occurred_at: new Date(Number(m.internalDate)).toISOString(),
    external_id: `gmail:${m.id}`,
    detail: { from: m.headers["from"] ?? null, subject: m.headers["subject"] ?? null, snippet: m.snippet.slice(0, 300) },
  }, { onConflict: "external_id", ignoreDuplicates: true });
  if (error) throw error;
}

async function syncMailbox(db: SupabaseClient, mb: { id: string; email: string }) {
  const token = await accessToken(db, mb.id);
  const counts = { replies: 0, auto_replies: 0, bounces: 0, checked: 0 };

  const [inbound, bounceCandidates] = await Promise.all([
    listMessages(token, "newer_than:3d -in:sent -in:drafts -in:chats -from:me", 300),
    listMessages(token, "newer_than:7d from:(mailer-daemon OR postmaster)", 100),
  ]);
  const all = new Map<string, { id: string; threadId: string }>();
  for (const m of [...inbound, ...bounceCandidates]) all.set(m.id, m);
  if (all.size === 0) return counts;

  const ids = [...all.keys()];
  const { data: seen } = await db.from("inbox_seen").select("message_id").eq("mailbox_id", mb.id).in("message_id", ids);
  const seenSet = new Set((seen ?? []).map((r) => r.message_id));
  const fresh = [...all.values()].filter((m) => !seenSet.has(m.id));
  if (fresh.length === 0) return counts;

  const threadIds = [...new Set(fresh.map((m) => m.threadId))];
  const { data: sends } = await db.from("sends").select("id, contact_id, gmail_thread_id, replied_at, bounced_at")
    .eq("mailbox_id", mb.id).in("gmail_thread_id", threadIds);
  const byThread = new Map((sends ?? []).map((s) => [s.gmail_thread_id as string, s as SendRow]));
  const bounceIds = new Set(bounceCandidates.map((m) => m.id));

  for (const ref of fresh) {
    const send = byThread.get(ref.threadId);
    if (!send && !bounceIds.has(ref.id)) continue; // not related to our campaigns
    const m = await getMessageMeta(token, ref.id);
    counts.checked++;

    if (isBounce(m)) {
      let target = send;
      if (!target) {
        // Bounce in its own thread: find the recipient address in the headers or snippet.
        const text = `${m.headers["x-failed-recipients"] ?? ""} ${m.snippet}`.toLowerCase();
        const emails = [...new Set(text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [])]
          .filter((e) => e !== mb.email.toLowerCase());
        if (emails.length) {
          const { data: candidates } = await db.from("sends")
            .select("id, contact_id, gmail_thread_id, replied_at, bounced_at, contacts!inner(email)")
            .eq("mailbox_id", mb.id).in("contacts.email", emails).not("sent_at", "is", null)
            .order("sent_at", { ascending: false }).limit(1);
          target = candidates?.[0] as SendRow | undefined;
        }
      }
      if (target && !DELAY_SUBJECT.test(m.headers["subject"] ?? "")) {
        await recordEvent(db, target, "bounce", m);
        if (!target.bounced_at) await db.from("sends").update({ bounced_at: new Date().toISOString() }).eq("id", target.id);
        const { data: c } = await db.from("contacts").select("email").eq("id", target.contact_id).single();
        if (c) await suppressContact(db, target.contact_id, c.email, "bounced");
        counts.bounces++;
      }
    } else if (send) {
      if (isAutoReply(m)) {
        await recordEvent(db, send, "auto_reply", m);
        counts.auto_replies++;
      } else {
        await recordEvent(db, send, "reply", m);
        if (!send.replied_at) {
          await db.from("sends").update({ replied_at: new Date(Number(m.internalDate)).toISOString() }).eq("id", send.id);
        }
        await db.from("contacts").update({ status: "replied" }).eq("id", send.contact_id).neq("status", "unsubscribed");
        counts.replies++;
      }
    }
  }

  await db.from("inbox_seen").upsert(fresh.map((m) => ({ mailbox_id: mb.id, message_id: m.id })), {
    onConflict: "mailbox_id,message_id",
    ignoreDuplicates: true,
  });
  return counts;
}

export default async function handler(req: Request): Promise<Response> {
  if (!(await isCronRequest(req))) return json({ error: "forbidden" }, 403);
  const db = adminClient();
  const { data: mailboxes } = await db.from("mailboxes").select("id, email").neq("status", "disconnected");
  const results = [];
  for (const mb of mailboxes ?? []) {
    try {
      const counts = await syncMailbox(db, mb);
      await db.from("mailboxes").update({ last_inbox_sync_at: new Date().toISOString() }).eq("id", mb.id);
      results.push({ mailbox: mb.email, ...counts });
    } catch (e) {
      console.error(mb.email, e);
      results.push({ mailbox: mb.email, error: errorMessage(e) });
    }
  }
  return json({ ok: true, results });
}
