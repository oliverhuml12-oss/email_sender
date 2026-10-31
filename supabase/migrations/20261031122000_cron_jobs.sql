-- Background jobs: pg_cron calls the Edge Function with the internal secret.
-- Times are UTC: daily-health at 05:00 UTC = 06:00 Prague in winter, 07:00 in summer.
create or replace function public.call_job(p_job text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://nhnryvxhirqrqgciolxn.supabase.co/functions/v1/app/jobs/' || p_job,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select cron_secret from public.app_secret where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
$$;
revoke execute on function public.call_job(text) from public, anon, authenticated;

select cron.schedule('email-send-tick', '*/2 * * * *', $$select public.call_job('send-tick')$$);
select cron.schedule('email-inbox-sync', '*/15 * * * *', $$select public.call_job('inbox-sync')$$);
select cron.schedule('email-daily-health', '0 5 * * *', $$select public.call_job('daily-health')$$);
