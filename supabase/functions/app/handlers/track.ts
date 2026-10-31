// Public endpoints placed in emails:
//   GET  /track/o/{sendId}        open pixel (1x1 gif)
//   GET  /track/c/{sendId}/{i}    click redirect to the i-th original link
//   POST /track/u/{sendId}        unsubscribe (one-click header and the web unsubscribe page)
//   GET  /track/u/{sendId}        redirects to the web unsubscribe page
import { suppressContact } from "../lib/deliver.ts";
import { adminClient, corsHeaders, json } from "../lib/util.ts";

const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pixel() {
  return new Response(GIF, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, private" },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const at = parts.indexOf("track");
  const [kind, id, index] = parts.slice(at + 1);
  const db = adminClient();

  if (kind === "o") {
    if (id && UUID.test(id)) {
      const { data: send } = await db.from("sends").select("id, contact_id, opened_at, open_count, campaigns(track_opens)")
        .eq("id", id).maybeSingle();
      // deno-lint-ignore no-explicit-any
      if (send && (send.campaigns as any)?.track_opens) {
        await db.from("sends").update({
          opened_at: send.opened_at ?? new Date().toISOString(),
          open_count: (send.open_count ?? 0) + 1,
        }).eq("id", id);
        await db.from("events").insert({
          send_id: id,
          contact_id: send.contact_id,
          type: "open",
          detail: { ua: req.headers.get("user-agent")?.slice(0, 200) ?? null },
        });
      }
    }
    return pixel();
  }

  if (kind === "c") {
    const i = Number(index);
    if (id && UUID.test(id) && Number.isInteger(i) && i >= 0) {
      const { data: send } = await db.from("sends").select("id, contact_id, links, clicked_at, click_count")
        .eq("id", id).maybeSingle();
      const target = send?.links?.[i];
      if (typeof target === "string" && /^https?:\/\//i.test(target)) {
        await db.from("sends").update({
          clicked_at: send!.clicked_at ?? new Date().toISOString(),
          click_count: (send!.click_count ?? 0) + 1,
        }).eq("id", id);
        await db.from("events").insert({ send_id: id, contact_id: send!.contact_id, type: "click", detail: { url: target } });
        return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
      }
    }
    return new Response("Link not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  if (kind === "u") {
    if (req.method === "GET") {
      const { data: st } = await db.from("settings").select("app_url").eq("id", 1).single();
      if (st?.app_url) {
        return new Response(null, {
          status: 302,
          headers: { Location: `${st.app_url.replace(/\/$/, "")}/unsubscribe?t=${encodeURIComponent(id ?? "")}` },
        });
      }
      return new Response("To unsubscribe, use the link at the bottom of the email.", {
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (req.method === "POST") {
      if (id === "test") return json({ ok: true, test: true });
      if (!id || !UUID.test(id)) return json({ ok: false, error: "Invalid link" }, 400);
      const { data: send } = await db.from("sends").select("id, contact_id, unsubscribed_at, contacts(email)")
        .eq("id", id).maybeSingle();
      if (!send) return json({ ok: false, error: "Invalid link" }, 404);
      // deno-lint-ignore no-explicit-any
      const email = (send.contacts as any)?.email as string;
      if (!send.unsubscribed_at) {
        await db.from("sends").update({ unsubscribed_at: new Date().toISOString() }).eq("id", id);
        await db.from("events").upsert(
          { send_id: id, contact_id: send.contact_id, type: "unsubscribe", external_id: `unsub:${id}` },
          { onConflict: "external_id", ignoreDuplicates: true },
        );
      }
      await suppressContact(db, send.contact_id, email, "unsubscribed");
      return json({ ok: true });
    }
  }

  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}
