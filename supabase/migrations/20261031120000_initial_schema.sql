-- Email Sender: initial schema
-- Single-admin app. The first user who signs up becomes the admin; everyone else is locked out by RLS.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
create table public.admins (
  user_id uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = (select auth.uid()));
$$;

create or replace function public.has_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins);
$$;

create policy "admins read self" on public.admins for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.admins) then
    insert into public.admins (user_id) values (new.id);
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Settings (single row)
-- ---------------------------------------------------------------------------
create table public.settings (
  id int primary key default 1 check (id = 1),
  timezone text not null default 'Europe/Prague',
  app_url text,
  alert_email text,
  min_gap_seconds int not null default 120 check (min_gap_seconds >= 30),
  max_gap_seconds int not null default 360,
  warmup_schedule int[] not null default '{10,20,30,40}',
  max_daily_per_mailbox int not null default 50,
  min_sample_for_rules int not null default 20,
  bounce_slow_pct numeric not null default 2,
  bounce_pause_pct numeric not null default 5,
  reply_drop_ratio numeric not null default 0.5,
  zero_reply_pause_after int not null default 100,
  footer_html text not null default
    '<p style="margin:24px 0 0;font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#8a8a8a;">If you''d rather not receive these emails, <a href="{{unsubscribe_url}}" style="color:#8a8a8a;text-decoration:underline;">unsubscribe here</a>.</p>',
  footer_text text not null default 'If you''d rather not receive these emails, unsubscribe here: {{unsubscribe_url}}',
  updated_at timestamptz not null default now(),
  constraint gap_order check (max_gap_seconds >= min_gap_seconds)
);
insert into public.settings default values;

-- ---------------------------------------------------------------------------
-- Mailboxes
-- ---------------------------------------------------------------------------
create table public.mailboxes (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text,
  provider text not null default 'gmail' check (provider in ('gmail')),
  status text not null default 'active' check (status in ('active', 'paused', 'disconnected')),
  pause_reason text,
  warmup_start_date date not null default current_date,
  current_daily_limit int not null default 10,
  daily_limit_override int check (daily_limit_override is null or daily_limit_override >= 0),
  next_send_at timestamptz not null default now(),
  last_health_check_at timestamptz,
  last_inbox_sync_at timestamptz,
  created_at timestamptz not null default now()
);

-- OAuth tokens: RLS on, no policies => only the service role (Edge Functions) can read them.
create table public.mailbox_credentials (
  mailbox_id uuid primary key references public.mailboxes on delete cascade,
  refresh_token text not null,
  access_token text,
  access_token_expires_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.mailbox_credentials enable row level security;

-- ---------------------------------------------------------------------------
-- Contacts and lists
-- ---------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  first_name text,
  last_name text,
  company text,
  fields jsonb not null default '{}'::jsonb,
  status text not null default 'new'
    check (status in ('new', 'emailed', 'replied', 'bounced', 'unsubscribed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.normalize_contact() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.email := lower(trim(new.email));
  new.updated_at := now();
  return new;
end $$;
create trigger contacts_normalize before insert or update on public.contacts
  for each row execute function public.normalize_contact();

create table public.lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.list_contacts (
  list_id uuid not null references public.lists on delete cascade,
  contact_id uuid not null references public.contacts on delete cascade,
  added_at timestamptz not null default now(),
  primary key (list_id, contact_id)
);
create index list_contacts_contact_idx on public.list_contacts (contact_id);

create table public.suppression (
  email text primary key,
  reason text not null check (reason in ('bounced', 'unsubscribed', 'manual')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Templates and campaigns
-- ---------------------------------------------------------------------------
create table public.templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text not null,
  html text not null default '',
  text_body text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  list_id uuid not null references public.lists,
  template_id uuid not null references public.templates,
  mailbox_id uuid not null references public.mailboxes,
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'completed')),
  send_days int[] not null default '{1,2,3,4,5}',
  send_start time not null default '08:00',
  send_end time not null default '17:00',
  track_opens boolean not null default false,
  track_clicks boolean not null default true,
  created_at timestamptz not null default now(),
  started_at timestamptz
);
create index campaigns_list_idx on public.campaigns (list_id);
create index campaigns_template_idx on public.campaigns (template_id);
create index campaigns_mailbox_idx on public.campaigns (mailbox_id);

-- One row per email: the queue and the history.
create table public.sends (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns on delete cascade,
  contact_id uuid not null references public.contacts on delete cascade,
  mailbox_id uuid not null references public.mailboxes,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  queued_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  subject text,
  links jsonb not null default '[]'::jsonb,
  gmail_message_id text,
  gmail_thread_id text,
  error text,
  opened_at timestamptz,
  open_count int not null default 0,
  clicked_at timestamptz,
  click_count int not null default 0,
  replied_at timestamptz,
  bounced_at timestamptz,
  unsubscribed_at timestamptz,
  unique (campaign_id, contact_id)
);
create index sends_queue_idx on public.sends (mailbox_id, status, queued_at);
create index sends_sent_idx on public.sends (mailbox_id, sent_at);
create index sends_thread_idx on public.sends (gmail_thread_id);
create index sends_contact_idx on public.sends (contact_id);

create table public.events (
  id bigint generated always as identity primary key,
  send_id uuid references public.sends on delete cascade,
  contact_id uuid references public.contacts on delete cascade,
  type text not null check (type in ('open', 'click', 'reply', 'auto_reply', 'bounce', 'unsubscribe')),
  occurred_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb,
  external_id text unique
);
create index events_send_idx on public.events (send_id);
create index events_contact_idx on public.events (contact_id);
create index events_time_idx on public.events (occurred_at, type);

-- Gmail messages already looked at by inbox-sync (so they are not fetched twice).
create table public.inbox_seen (
  mailbox_id uuid not null references public.mailboxes on delete cascade,
  message_id text not null,
  seen_at timestamptz not null default now(),
  primary key (mailbox_id, message_id)
);
alter table public.inbox_seen enable row level security;

-- ---------------------------------------------------------------------------
-- RLS: admin has full access to app tables
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['settings','mailboxes','contacts','lists','list_contacts','suppression',
                           'templates','campaigns','sends','events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "admin all" on public.%I for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Functions used by the web app (run as the calling admin, RLS applies)
-- ---------------------------------------------------------------------------

-- Queue every eligible contact of the campaign's list. Safe to call again (adds only new contacts).
create or replace function public.start_campaign(p_campaign uuid) returns int
language plpgsql security invoker set search_path = '' as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;

  insert into public.sends (campaign_id, contact_id, mailbox_id)
  select c.id, ct.id, c.mailbox_id
  from public.campaigns c
  join public.list_contacts lc on lc.list_id = c.list_id
  join public.contacts ct on ct.id = lc.contact_id
  where c.id = p_campaign
    and ct.status not in ('bounced', 'unsubscribed')
    and not exists (select 1 from public.suppression s where s.email = ct.email)
  order by lc.added_at, ct.id
  on conflict (campaign_id, contact_id) do nothing;
  get diagnostics n = row_count;

  update public.campaigns
     set status = 'active', started_at = coalesce(started_at, now())
   where id = p_campaign;
  return n;
end $$;

-- Dashboard numbers for the last p_days days (dates in the configured timezone).
create or replace function public.dashboard_stats(p_days int default 30) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare tz text; since timestamptz; result jsonb;
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  select timezone into tz from public.settings where id = 1;
  since := (date_trunc('day', now() at time zone tz) - make_interval(days => p_days - 1)) at time zone tz;

  with days as (
    select generate_series(since at time zone tz, now() at time zone tz, interval '1 day')::date as day
  ),
  sent as (
    select (sent_at at time zone tz)::date as day, count(*) as n
    from public.sends where sent_at >= since group by 1
  ),
  ev as (
    select (occurred_at at time zone tz)::date as day, type, count(distinct send_id) as n
    from public.events where occurred_at >= since group by 1, 2
  )
  select jsonb_build_object(
    'daily', coalesce(jsonb_agg(jsonb_build_object(
        'day', d.day,
        'sent', coalesce(s.n, 0),
        'replies', coalesce((select n from ev where ev.day = d.day and type = 'reply'), 0),
        'bounces', coalesce((select n from ev where ev.day = d.day and type = 'bounce'), 0),
        'opens', coalesce((select n from ev where ev.day = d.day and type = 'open'), 0),
        'clicks', coalesce((select n from ev where ev.day = d.day and type = 'click'), 0),
        'unsubscribes', coalesce((select n from ev where ev.day = d.day and type = 'unsubscribe'), 0)
      ) order by d.day), '[]'::jsonb),
    'last7', (select public.period_stats(7)),
    'last30', (select public.period_stats(30)),
    'queued', (select count(*) from public.sends where status = 'queued')
  ) into result
  from days d left join sent s on s.day = d.day;

  return result;
end $$;

-- Cohort rates: of the emails sent in the last p_days, how many were replied to, bounced, etc.
create or replace function public.period_stats(p_days int, p_mailbox uuid default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'sent', count(*),
    'replies', count(replied_at),
    'bounces', count(bounced_at),
    'opens', count(opened_at),
    'clicks', count(clicked_at),
    'unsubscribes', count(unsubscribed_at)
  )
  from public.sends
  where sent_at >= now() - make_interval(days => p_days)
    and (p_mailbox is null or mailbox_id = p_mailbox);
$$;

create or replace view public.campaign_stats with (security_invoker = true) as
select c.id as campaign_id,
       count(s.id) as total,
       count(*) filter (where s.status = 'queued') as queued,
       count(*) filter (where s.status = 'sent') as sent,
       count(*) filter (where s.status = 'failed') as failed,
       count(*) filter (where s.status = 'skipped') as skipped,
       count(s.replied_at) as replies,
       count(s.bounced_at) as bounces,
       count(s.opened_at) as opens,
       count(s.clicked_at) as clicks,
       count(s.unsubscribed_at) as unsubscribes
from public.campaigns c
left join public.sends s on s.campaign_id = c.id
group by c.id;

create or replace function public.today_sent_counts() returns table (mailbox_id uuid, sent_today bigint)
language sql stable security invoker set search_path = '' as $$
  select s.mailbox_id, count(*)
  from public.sends s, public.settings st
  where st.id = 1
    and s.sent_at >= (date_trunc('day', now() at time zone st.timezone) at time zone st.timezone)
  group by s.mailbox_id;
$$;

-- ---------------------------------------------------------------------------
-- Functions used only by Edge Functions (service role)
-- ---------------------------------------------------------------------------

-- Atomically claim the next email for a mailbox, if the mailbox is allowed to send right now.
create or replace function public.claim_next_send(p_mailbox uuid) returns setof public.sends
language plpgsql security definer set search_path = '' as $$
declare
  st public.settings;
  mb public.mailboxes;
  lim int;
  used int;
  local_now timestamp;
  claimed public.sends;
begin
  select * into st from public.settings where id = 1;
  select * into mb from public.mailboxes where id = p_mailbox for update;
  if not found or mb.status <> 'active' or mb.next_send_at > now() then return; end if;

  lim := coalesce(mb.daily_limit_override, mb.current_daily_limit);
  select count(*) into used from public.sends
   where mailbox_id = p_mailbox
     and (status = 'sending'
          or sent_at >= (date_trunc('day', now() at time zone st.timezone) at time zone st.timezone));
  if used >= lim then return; end if;

  local_now := now() at time zone st.timezone;

  update public.sends s
     set status = 'sending', claimed_at = now()
   where s.id = (
     select s2.id
     from public.sends s2
     join public.campaigns c on c.id = s2.campaign_id
     where s2.mailbox_id = p_mailbox
       and s2.status = 'queued'
       and c.status = 'active'
       and extract(isodow from local_now)::int = any (c.send_days)
       and local_now::time >= c.send_start
       and local_now::time < c.send_end
     order by s2.queued_at, s2.id
     limit 1
     for update of s2 skip locked)
  returning s.* into claimed;

  if claimed.id is null then return; end if;

  update public.mailboxes
     set next_send_at = now() + make_interval(secs =>
           st.min_gap_seconds + random() * (st.max_gap_seconds - st.min_gap_seconds))
   where id = p_mailbox;

  return next claimed;
end $$;

-- Mark campaigns with nothing left in the queue as completed; fail rows stuck in 'sending'.
create or replace function public.housekeeping() returns void
language sql security definer set search_path = '' as $$
  update public.sends set status = 'failed', error = 'Interrupted while sending (not retried to avoid duplicates)'
   where status = 'sending' and claimed_at < now() - interval '10 minutes';
  update public.campaigns c set status = 'completed'
   where c.status = 'active'
     and exists (select 1 from public.sends s where s.campaign_id = c.id)
     and not exists (select 1 from public.sends s where s.campaign_id = c.id and s.status in ('queued', 'sending'));
  delete from public.inbox_seen where seen_at < now() - interval '14 days';
$$;

-- Daily health check: set each mailbox's limit for the coming day from warm-up stage and recent results.
create or replace function public.run_daily_health() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  st public.settings;
  mb public.mailboxes;
  report jsonb := '[]'::jsonb;
  week int;
  base int;
  new_limit int;
  sent7 int; bounces7 int; replies7 int;
  sent28 int; replies28 int;
  last_n_replies int; last_n_count int;
  bounce_pct numeric; reply_pct numeric; reply_pct28 numeric;
  action text;
  reason text;
begin
  select * into st from public.settings where id = 1;
  perform public.housekeeping();

  for mb in select * from public.mailboxes where status <> 'disconnected' order by created_at loop
    week := greatest(0, (current_date - mb.warmup_start_date) / 7);
    base := case when week < coalesce(array_length(st.warmup_schedule, 1), 0)
                 then least(st.warmup_schedule[week + 1], st.max_daily_per_mailbox)
                 else st.max_daily_per_mailbox end;

    select count(*), count(bounced_at), count(replied_at) into sent7, bounces7, replies7
      from public.sends where mailbox_id = mb.id and sent_at >= now() - interval '7 days';
    select count(*), count(replied_at) into sent28, replies28
      from public.sends where mailbox_id = mb.id and sent_at >= now() - interval '28 days';
    select count(*), count(replied_at) into last_n_count, last_n_replies
      from (select replied_at from public.sends
             where mailbox_id = mb.id and sent_at is not null
             order by sent_at desc limit st.zero_reply_pause_after) x;

    bounce_pct := case when sent7 > 0 then round(100.0 * bounces7 / sent7, 1) else 0 end;
    reply_pct := case when sent7 > 0 then round(100.0 * replies7 / sent7, 1) else 0 end;
    reply_pct28 := case when sent28 > 0 then round(100.0 * replies28 / sent28, 1) else 0 end;

    action := 'normal';
    reason := null;
    new_limit := base;

    if mb.status = 'paused' then
      action := 'still_paused';
      reason := mb.pause_reason;
    elsif sent7 >= st.min_sample_for_rules and bounce_pct > st.bounce_pause_pct then
      action := 'paused';
      reason := format('Bounce rate %s%% over the last 7 days (limit %s%%)', bounce_pct, st.bounce_pause_pct);
    elsif last_n_count >= st.zero_reply_pause_after and last_n_replies = 0 then
      action := 'paused';
      reason := format('No replies in the last %s emails', st.zero_reply_pause_after);
    elsif sent7 >= st.min_sample_for_rules and bounce_pct >= st.bounce_slow_pct then
      action := 'slowed';
      new_limit := greatest(1, base / 2);
      reason := format('Bounce rate %s%% over the last 7 days', bounce_pct);
    elsif sent7 >= st.min_sample_for_rules and sent28 >= 2 * st.min_sample_for_rules and reply_pct28 > 0
          and reply_pct < reply_pct28 * st.reply_drop_ratio then
      action := 'slowed';
      new_limit := greatest(1, base / 2);
      reason := format('Reply rate dropped to %s%% (4-week average %s%%)', reply_pct, reply_pct28);
    end if;

    if action = 'paused' then
      update public.mailboxes set status = 'paused', pause_reason = reason,
             current_daily_limit = new_limit, last_health_check_at = now() where id = mb.id;
    else
      update public.mailboxes set current_daily_limit = new_limit, last_health_check_at = now() where id = mb.id;
    end if;

    report := report || jsonb_build_object(
      'mailbox_id', mb.id, 'email', mb.email, 'action', action, 'reason', reason,
      'warmup_week', week + 1, 'limit', coalesce(mb.daily_limit_override, new_limit),
      'override', mb.daily_limit_override,
      'sent7', sent7, 'bounces7', bounces7, 'replies7', replies7,
      'bounce_pct', bounce_pct, 'reply_pct', reply_pct, 'reply_pct28', reply_pct28);
  end loop;

  return jsonb_build_object('mailboxes', report, 'queued',
    (select count(*) from public.sends where status = 'queued'));
end $$;

-- Lock down: service-role-only functions
revoke execute on function public.claim_next_send(uuid) from public, anon, authenticated;
revoke execute on function public.housekeeping() from public, anon, authenticated;
revoke execute on function public.run_daily_health() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.start_campaign(uuid) from public, anon;
revoke execute on function public.dashboard_stats(int) from public, anon;
revoke execute on function public.period_stats(int, uuid) from public, anon;
revoke execute on function public.today_sent_counts() from public, anon;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.has_admin() to anon, authenticated;
