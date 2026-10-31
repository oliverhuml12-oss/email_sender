import { createClient } from "@supabase/supabase-js";

// Public values (safe to commit): the project URL and its publishable key. Data is protected by RLS.
export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "https://nhnryvxhirqrqgciolxn.supabase.co";
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY ?? "sb_publishable_MWqGE37lpRRFeIGB5FJQHQ_1AClnoky";
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1/app`;

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/** Call a route of the `app` Edge Function as the signed-in admin. */
export async function callFunction<T = unknown>(path: string, body: unknown): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${FUNCTIONS_URL}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `Request failed (${res.status})`);
  return out as T;
}

export type Mailbox = {
  id: string;
  email: string;
  display_name: string | null;
  status: "active" | "paused" | "disconnected";
  pause_reason: string | null;
  warmup_start_date: string;
  current_daily_limit: number;
  daily_limit_override: number | null;
  next_send_at: string;
  last_health_check_at: string | null;
  last_inbox_sync_at: string | null;
  created_at: string;
};

export type Contact = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  fields: Record<string, string>;
  status: "new" | "emailed" | "replied" | "bounced" | "unsubscribed";
  created_at: string;
};

export type List = { id: string; name: string; created_at: string };

export type Template = {
  id: string;
  name: string;
  subject: string;
  html: string;
  text_body: string | null;
  created_at: string;
  updated_at: string;
};

export type Campaign = {
  id: string;
  name: string;
  list_id: string;
  template_id: string;
  mailbox_id: string;
  status: "draft" | "active" | "paused" | "completed";
  send_days: number[];
  send_start: string;
  send_end: string;
  track_opens: boolean;
  track_clicks: boolean;
  created_at: string;
  started_at: string | null;
};

export type CampaignStats = {
  campaign_id: string;
  total: number;
  queued: number;
  sent: number;
  failed: number;
  skipped: number;
  replies: number;
  bounces: number;
  opens: number;
  clicks: number;
  unsubscribes: number;
};

export type Settings = {
  id: number;
  timezone: string;
  app_url: string | null;
  alert_email: string | null;
  min_gap_seconds: number;
  max_gap_seconds: number;
  warmup_schedule: number[];
  max_daily_per_mailbox: number;
  min_sample_for_rules: number;
  bounce_slow_pct: number;
  bounce_pause_pct: number;
  reply_drop_ratio: number;
  zero_reply_pause_after: number;
  footer_html: string;
  footer_text: string;
};

export type PeriodStats = { sent: number; replies: number; bounces: number; opens: number; clicks: number; unsubscribes: number };
export type DailyRow = PeriodStats & { day: string };
export type DashboardStats = { daily: DailyRow[]; last7: PeriodStats; last30: PeriodStats; queued: number };
