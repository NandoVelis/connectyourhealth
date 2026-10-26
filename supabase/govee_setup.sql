-- Govee-lampen automatisering (edge function: supabase/functions/govee-lights).
-- Dit staat al toegepast op het project; bewaard ter documentatie / herstel.

create table if not exists public.govee_state (
  id smallint primary key default 1 check (id = 1),
  last_on_date date,
  last_off_date date,
  last_log text,
  updated_at timestamptz not null default now()
);
alter table public.govee_state enable row level security;
insert into public.govee_state (id) values (1) on conflict do nothing;

-- Elke 5 min, alleen in de uren waar het ertoe doet. Cron draait in UTC:
-- 3-11 UTC dekt 04:00-12:00 lokaal in zowel zomer- als wintertijd, 21-22 UTC
-- dekt 23:00 lokaal. De functie zelf beslist op Europe/Amsterdam-tijd.
select cron.schedule(
  'govee-lights-5min',
  '*/5 3-11,21-22 * * *',
  $$select net.http_post(
      url := 'https://mhvduufxeqyxgkkvwimx.supabase.co/functions/v1/govee-lights',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
  );$$
);
