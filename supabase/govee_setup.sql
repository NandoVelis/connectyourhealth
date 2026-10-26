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

-- Toegevoegd: vaste aan-tijden ma t/m vr 12:01 en 17:01 (Amsterdam).
alter table public.govee_state
  add column if not exists last_on_1201_date date,
  add column if not exists last_on_1701_date date;
select cron.schedule('govee-lights-5min', '*/5 3-11,15-16,21-22 * * *',
  $$select net.http_post(url := 'https://mhvduufxeqyxgkkvwimx.supabase.co/functions/v1/govee-lights', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);$$);
select cron.schedule('govee-lights-timed-on', '1 10,11,15,16 * * 1-5',
  $$select net.http_post(url := 'https://mhvduufxeqyxgkkvwimx.supabase.co/functions/v1/govee-lights', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);$$);

-- Toegevoegd: vaste uit-tijden ma t/m vr 07:53 en 13:53 (Amsterdam).
alter table public.govee_state
  add column if not exists last_off_0753_date date,
  add column if not exists last_off_1353_date date;
select cron.schedule('govee-lights-5min', '*/5 3-12,15-16,21-22 * * *',
  $$select net.http_post(url := 'https://mhvduufxeqyxgkkvwimx.supabase.co/functions/v1/govee-lights', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);$$);
select cron.schedule('govee-lights-timed-off', '53 5,6,11,12 * * 1-5',
  $$select net.http_post(url := 'https://mhvduufxeqyxgkkvwimx.supabase.co/functions/v1/govee-lights', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);$$);

-- Toegevoegd: dimmen zo t/m do vanaf 22:30 (stappen van 5 min) voor de 23:00-uit.
alter table public.govee_state add column if not exists last_dim text;
select cron.schedule('govee-lights-5min', '*/5 3-12,15-16,20-22 * * *',
  $$select net.http_post(url := 'https://mhvduufxeqyxgkkvwimx.supabase.co/functions/v1/govee-lights', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);$$);

-- Toegevoegd: helderheid van vóór het dimmen onthouden.
alter table public.govee_state add column if not exists brightness_base jsonb;

-- Toegevoegd: wekker-licht, kleur-indicatie, warm licht, ESPN-deadline-knipper, ochtend-sync.
alter table public.govee_state
  add column if not exists last_wake_step text,
  add column if not exists wake_devices jsonb,
  add column if not exists last_warm_date date,
  add column if not exists color_base jsonb,
  add column if not exists normal_brightness jsonb,
  add column if not exists last_espn_alert text,
  add column if not exists last_color_date date;
select cron.schedule('govee-lights-5min', '*/5 3-12,15-16,18-22 * * *',
  $$select net.http_post(url := 'https://mhvduufxeqyxgkkvwimx.supabase.co/functions/v1/govee-lights', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);$$);
select cron.schedule('govee-wake-light', '30-39 4,5 * * 1-5',
  $$select net.http_post(url := 'https://mhvduufxeqyxgkkvwimx.supabase.co/functions/v1/govee-lights', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);$$);
select cron.schedule('govee-espn-deadline', '*/5 * * * *',
  $$select net.http_post(url := 'https://mhvduufxeqyxgkkvwimx.supabase.co/functions/v1/govee-lights', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000)
    from public.espn_game where next_deadline between now() + interval '50 minutes' and now() + interval '65 minutes';$$);
-- Garmin-sync elke 10 min tussen 06:00-06:59 lokaal (ma-vr), DST-proof via WHERE op lokaal uur.
select cron.schedule('garmin-sync-wake', '*/10 4,5 * * 1-5',
  $$select net.http_post(url := 'https://mhvduufxeqyxgkkvwimx.supabase.co/functions/v1/trigger-garmin-sync', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000)
    where extract(hour from (now() at time zone 'Europe/Amsterdam')) = 6;$$);
