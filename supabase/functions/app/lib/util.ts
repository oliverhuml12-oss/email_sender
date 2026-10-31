import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1/app`;

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

let cachedSecret: string | null = null;

/** Internal secret generated in the database (table app_secret, service role only). */
export async function appSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const { data, error } = await adminClient().from("app_secret").select("cron_secret").eq("id", 1).single();
  if (error || !data?.cron_secret) throw new Error("app_secret missing");
  cachedSecret = data.cron_secret as string;
  return cachedSecret;
}

/** Scheduled jobs are called by pg_cron with the shared secret in a header. */
export async function isCronRequest(req: Request): Promise<boolean> {
  const got = req.headers.get("x-cron-secret") ?? "";
  if (!got) return false;
  try {
    return timingSafeEqual(got, await appSecret());
  } catch {
    return false;
  }
}

/** Returns the user id if the request carries a valid JWT of the admin user, else null. */
export async function adminUserId(req: Request, db: SupabaseClient): Promise<string | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: admin } = await db.from("admins").select("user_id").eq("user_id", data.user.id).maybeSingle();
  return admin ? data.user.id : null;
}

// --- HMAC signing (OAuth state) ---
const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

async function hmacKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    enc.encode(await appSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function sign(payload: Record<string, unknown>): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verify<T>(token: string): Promise<T | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(), b64urlDecode(sig), enc.encode(body));
  if (!ok) return null;
  return JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as T;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
