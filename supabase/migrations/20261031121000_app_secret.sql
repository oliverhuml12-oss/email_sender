-- Internal secret shared by pg_cron and the Edge Functions (cron auth + OAuth state signing).
-- Generated inside the database; readable only by the service role.
create table public.app_secret (
  id int primary key default 1 check (id = 1),
  cron_secret text not null default encode(extensions.gen_random_bytes(32), 'hex'),
  created_at timestamptz not null default now()
);
alter table public.app_secret enable row level security;
insert into public.app_secret default values;
