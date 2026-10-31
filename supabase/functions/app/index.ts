// Single Edge Function with one route per job (deployed with verify_jwt = false; each route checks auth itself).
//   /app/jobs/send-tick | /app/jobs/inbox-sync | /app/jobs/daily-health   pg_cron (x-cron-secret)
//   /app/track/o|c|u/...                                                  public tracking + unsubscribe
//   /app/google-oauth                                                     connect a Gmail mailbox (admin)
//   /app/send-test                                                        send a test email (admin)
import dailyHealth from "./handlers/daily-health.ts";
import googleOauth from "./handlers/google-oauth.ts";
import inboxSync from "./handlers/inbox-sync.ts";
import sendTest from "./handlers/send-test.ts";
import sendTick from "./handlers/send-tick.ts";
import track from "./handlers/track.ts";
import { corsHeaders, json } from "./lib/util.ts";

const routes: Record<string, (req: Request) => Promise<Response>> = {
  "jobs/send-tick": sendTick,
  "jobs/inbox-sync": inboxSync,
  "jobs/daily-health": dailyHealth,
  "google-oauth": googleOauth,
  "send-test": sendTest,
  track,
};

Deno.serve(async (req) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const rest = parts.slice(parts.indexOf("app") + 1);
  const handler = routes[rest.slice(0, 2).join("/")] ?? routes[rest[0] ?? ""];
  if (!handler) {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    return json({ error: "Not found" }, 404);
  }
  return await handler(req);
});
