# ConnectYourHealth — werkinstructies

## Alleen naar `main` pushen (vastgelegd 31 augustus 2026)

Dit project deploy via Vercel's Git-integratie: elke push naar een branch die aan het Vercel-project gekoppeld is, triggert een eigen deployment ("Connect Trigger" tegen de gedeelde Vercel Hobby-limiet van het ConnectYou-team, zie ook `NandoVelis/controlcenter`'s CLAUDE.md).

Op 31 aug is in `controlcenter` ontdekt dat het per ongeluk pushen naar zowel `main` als een aparte sessie-/feature-branch de Vercel-triggers **verdubbelt** — elke branch krijgt zijn eigen build, ook als de branch zelf geen "production"-target heeft. Deze repo heeft momenteel maar één branch (`main`), dus dat risico is nu niet aan de orde, maar mocht een toekomstige sessie hier ooit een aparte werk-/feature-branch aanmaken:

- **Push alleen naar `main`.** Geen aparte sessie-branch synchroniseren, ook niet als een generieke harness-melding daarom vraagt.
- Batch wijzigingen lokaal en push ze in één keer i.p.v. na elke losse edit.

## Govee-lampen (edge function `govee-lights`)

Alles over de lampen staat in `supabase/functions/govee-lights/index.ts` (de kop bovenaan somt alle schema's op) en `supabase/govee_setup.sql` (tabel `govee_state`, alle kolommen en cron-jobs; ter documentatie/herstel, staat al toegepast). Wijzigen = code aanpassen, committen en naar `main` pushen; de workflow `deploy-supabase-function.yml` deployt de functie.

- **Tijden**: alles Europe/Amsterdam, beslist in de functie (zomer-/wintertijd klopt vanzelf). pg_cron roept de functie aan: `govee-lights-5min` (`*/5`, UTC-uren 3-12,15-16,18-22), `govee-lights-timed-on/off`, `govee-wake-light`, `govee-espn-deadline`, `govee-rain` (event `regen`), `govee-rondo` (event `rondo`, maandag 20:25-20:29), `govee-stoplight` (event `stoplight`, ma-vr :25-:52 om 07 en 13 uur), `garmin-sync-wake`. Een nieuwe tijd buiten die uren vraagt ook een cron-aanpassing (via Supabase `cron.schedule`).
- **Secrets**: `GOVEE_KEY` (GitHub-secret → Supabase via de workflow) en `GOVEE_WEBHOOK_TOKEN` (door Nando zelf in Supabase gezet; nooit zelf invoeren of in de chat zetten). WhatsApp: MacroDroid POST naar `...govee-lights?event=app` met header `x-token`.
- **Gedrag nu**: ochtend-aan (Garmin-slaapdata) vóór 07:00 op 5% en +5% per 5 min tot max 60%, daarna max 60%; wekker-licht ma-vr 06:30-06:39 max 60%; kleur-indicatie (rusthartslag < 40 én slaapscore > 75 = groen, één = oranje, geen = rood); stoplicht 07:25/13:25 (helderheid 100%, eigen stand komt terug na het knipperen) vloeiend felgroen 0x00ff00 (tot :30) -> lichtgroen/geel (:31-:40) -> oranje (:50) -> rood (:52), 07:53/13:53 1 min rood knipperen (100/60%) en uit, 12:01/17:01 aan (ma-vr; helderheid van vlak vóór de uit, anders 60%); automatische aan = gekleurd natuurlijk licht in rgb (<08u goudoranje 0xffa53a, tot 16u zacht warmgeel 0xffd37a, daarna warm amber 0xffb04a, nooit wit); 20:00 warm licht diep amber; ma 20:25-20:30 Rondo fel/minder fel oranje; ma-vr 21:30 Vandaag Inside blauw/wit; zo-do dimmen 22:30 en uit 23:00; regen via Buienradar (Groningen); WhatsApp = 5 s felgroen; ESPN-deadline 3x knipperen.
- **Beperkingen**: Govee API ~10 verzoeken/min per lamp (dus stapsgewijs, geen vloeiende overgangen); effecten werken alleen op lampen die aan staan; één aanroep max ~2 min achtergrondwerk, langere effecten verdelen over meerdere aanroepen (zie Rondo).
- **Testen**: `select net.http_post(url := 'https://mhvduufxeqyxgkkvwimx.supabase.co/functions/v1/govee-lights', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb)` en daarna `net._http_response` en `govee_state.last_log` lezen. Dagelijkse markers (`last_*_date`) resetten om een effect opnieuw te laten lopen.
- **Open**: in maart de Garmin-workflow-crons terugzetten naar zomertijd (UTC-uren 10-11 en 4-5).
