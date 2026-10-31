// Connects a Google Workspace mailbox.
//   POST {return_to}          (admin JWT) -> { url } to Google's consent screen
//   GET  ?code=..&state=..    Google redirects here; stores tokens and sends the user back to the app
import { getProfile } from "../lib/gmail.ts";
import { adminClient, adminUserId, corsHeaders, errorMessage, FUNCTIONS_URL, json, sign, verify } from "../lib/util.ts";

const REDIRECT_URI = `${FUNCTIONS_URL}/google-oauth`;
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
].join(" ");

type State = { u: string; r: string; exp: number };

function back(returnTo: string, params: Record<string, string>) {
  const url = new URL(returnTo);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const db = adminClient();
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  if (req.method === "POST") {
    const uid = await adminUserId(req, db);
    if (!uid) return json({ error: "Not signed in as the admin" }, 401);
    if (!clientId || !clientSecret) {
      return json({ error: "Google is not set up yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the Edge Function secrets." }, 400);
    }
    const { return_to } = await req.json().catch(() => ({}));
    if (typeof return_to !== "string" || !/^https?:\/\//.test(return_to)) return json({ error: "Invalid return_to" }, 400);
    const state = await sign({ u: uid, r: return_to, exp: Date.now() + 15 * 60_000 } satisfies State);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state,
    }).toString();
    return json({ url: url.toString() });
  }

  // GET: Google's redirect back
  const params = new URL(req.url).searchParams;
  const state = await verify<State>(params.get("state") ?? "");
  if (!state || state.exp < Date.now()) {
    return new Response("This sign-in link expired. Go back to the app and click Connect again.", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }
  if (params.get("error")) return back(state.r, { gmail: "error", message: params.get("error")! });

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: params.get("code") ?? "",
        client_id: clientId ?? "",
        client_secret: clientSecret ?? "",
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description ?? tokens.error ?? "Token exchange failed");
    if (!tokens.refresh_token) throw new Error("Google did not return a refresh token. Remove the app's access in your Google account and try again.");
    const granted = String(tokens.scope ?? "");
    if (!granted.includes("gmail.send") || !granted.includes("gmail.readonly")) {
      throw new Error("Please allow both sending and reading email on Google's consent screen.");
    }

    const profile = await getProfile(tokens.access_token);
    const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    }).then((r) => r.json()).catch(() => ({}));
    const email = profile.emailAddress.toLowerCase();

    const { data: existing } = await db.from("mailboxes").select("id, display_name, status").eq("email", email).maybeSingle();
    let mailboxId = existing?.id as string | undefined;
    if (existing) {
      await db.from("mailboxes").update({
        display_name: existing.display_name ?? info.name ?? null,
        ...(existing.status === "disconnected" ? { status: "active", pause_reason: null } : {}),
      }).eq("id", existing.id);
    } else {
      const { data: created, error } = await db.from("mailboxes").insert({ email, display_name: info.name ?? null })
        .select("id").single();
      if (error) throw error;
      mailboxId = created.id;
    }
    const { error: credErr } = await db.from("mailbox_credentials").upsert({
      mailbox_id: mailboxId,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      access_token_expires_at: new Date(Date.now() + (tokens.expires_in - 30) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (credErr) throw credErr;
    // Requeue emails that were waiting while the mailbox was disconnected.
    await db.from("sends").update({ error: null }).eq("mailbox_id", mailboxId).eq("status", "queued");
    return back(state.r, { gmail: "connected", email });
  } catch (e) {
    console.error(e);
    return back(state.r, { gmail: "error", message: errorMessage(e).slice(0, 300) });
  }
}
