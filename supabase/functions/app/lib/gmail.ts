import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { b64url } from "./util.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const enc = new TextEncoder();

export class GmailAuthError extends Error {}

export async function exchangeRefreshToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = `${body.error ?? res.status}: ${body.error_description ?? ""}`;
    if (body.error === "invalid_grant" || body.error === "unauthorized_client") throw new GmailAuthError(msg);
    throw new Error(`Token refresh failed ${msg}`);
  }
  return body as { access_token: string; expires_in: number };
}

/** Returns a valid access token for the mailbox, refreshing and caching it if needed. */
export async function accessToken(db: SupabaseClient, mailboxId: string): Promise<string> {
  const { data: cred, error } = await db.from("mailbox_credentials").select("*").eq("mailbox_id", mailboxId).single();
  if (error || !cred) throw new GmailAuthError("Mailbox has no stored Google credentials");
  if (cred.access_token && cred.access_token_expires_at && new Date(cred.access_token_expires_at).getTime() > Date.now() + 60_000) {
    return cred.access_token;
  }
  try {
    const t = await exchangeRefreshToken(cred.refresh_token);
    await db.from("mailbox_credentials").update({
      access_token: t.access_token,
      access_token_expires_at: new Date(Date.now() + (t.expires_in - 30) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("mailbox_id", mailboxId);
    return t.access_token;
  } catch (e) {
    if (e instanceof GmailAuthError) {
      await db.from("mailboxes").update({
        status: "disconnected",
        pause_reason: "Google access was revoked or expired. Reconnect the mailbox in Settings.",
      }).eq("id", mailboxId);
    }
    throw e;
  }
}

async function gmailFetch(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${GMAIL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (res.status === 401) throw new GmailAuthError(body?.error?.message ?? "Unauthorized");
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${body?.error?.message ?? text}`);
  return body;
}

// --- MIME ---

function encodeWord(s: string): string {
  // deno-lint-ignore no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  // Split into chunks so each encoded-word stays short and never splits a character.
  const chars = Array.from(s);
  const parts: string[] = [];
  let cur = "";
  for (const ch of chars) {
    if (enc.encode(cur + ch).length > 42) {
      parts.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => `=?UTF-8?B?${btoa(String.fromCharCode(...enc.encode(p)))}?=`).join("\r\n ");
}

function b64Lines(s: string): string {
  const bytes = enc.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return (btoa(bin).match(/.{1,76}/g) ?? []).join("\r\n");
}

function formatAddress(name: string | null | undefined, email: string): string {
  if (!name) return email;
  // deno-lint-ignore no-control-regex
  const safe = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "")}"` : encodeWord(name);
  return `${safe} <${email}>`;
}

export type OutgoingEmail = {
  fromEmail: string;
  fromName?: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl?: string;
  unsubscribeMailto?: string;
};

export function buildMime(m: OutgoingEmail): string {
  const boundary = `b_${crypto.randomUUID().replace(/-/g, "")}`;
  const domain = m.fromEmail.split("@")[1] ?? "localhost";
  const headers = [
    `From: ${formatAddress(m.fromName, m.fromEmail)}`,
    `To: ${m.to}`,
    `Subject: ${encodeWord(m.subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
  ];
  if (m.unsubscribeUrl) {
    const targets = [`<${m.unsubscribeUrl}>`];
    if (m.unsubscribeMailto) targets.unshift(`<${m.unsubscribeMailto}>`);
    headers.push(`List-Unsubscribe: ${targets.join(", ")}`);
    headers.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(m.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64Lines(m.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export async function sendEmail(token: string, m: OutgoingEmail) {
  const raw = b64url(enc.encode(buildMime(m)));
  const body = await gmailFetch(token, "/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
  return body as { id: string; threadId: string };
}

export async function listMessages(token: string, q: string, max = 200) {
  const out: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, maxResults: "100", includeSpamTrash: "false" });
    if (pageToken) params.set("pageToken", pageToken);
    const body = await gmailFetch(token, `/messages?${params}`);
    out.push(...(body.messages ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken && out.length < max);
  return out;
}

export type MessageMeta = {
  id: string;
  threadId: string;
  internalDate: string;
  snippet: string;
  headers: Record<string, string>;
};

export async function getMessageMeta(token: string, id: string): Promise<MessageMeta> {
  const want = ["From", "To", "Subject", "Auto-Submitted", "X-Autoreply", "X-Autorespond", "Precedence",
    "X-Failed-Recipients", "Content-Type"];
  const params = new URLSearchParams({ format: "metadata" });
  for (const h of want) params.append("metadataHeaders", h);
  const body = await gmailFetch(token, `/messages/${id}?${params}`);
  const headers: Record<string, string> = {};
  for (const h of body.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  return { id: body.id, threadId: body.threadId, internalDate: body.internalDate, snippet: body.snippet ?? "", headers };
}

export async function getProfile(token: string) {
  return await gmailFetch(token, "/profile") as { emailAddress: string };
}
