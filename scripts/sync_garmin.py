#!/usr/bin/env python3
"""Synchroniseert Garmin Connect-metrics (VO2max, HRV, rust-hartslag, slaap,
trainingsstatus), trainingsactiviteiten en gewicht naar Supabase.

Nu Tredict's API betaalde toegang vereist (status 402) en Runalyze's
activiteiten/lichaamsmetingen-endpoints een Supporter/Premium-abonnement
vereisen (403), is dit de enige nog werkende, gratis bron voor training +
gewicht -- niet meer alleen een aanvulling op de vitals-fallback.

Draait als GitHub Actions-workflow (.github/workflows/auto-sync-garmin.yml),
niet als Supabase edge function -- de onofficiele garminconnect-library
gebruikt curl_cffi (browser-TLS-fingerprint-imitatie) om Garmin's
bot-detectie te omzeilen, wat in de Deno-edge-function-omgeving niet
te repliceren is.

Login-sessietokens worden na een geslaagde login opgeslagen in de
garmin_session-tabel (Supabase), zodat niet elke run opnieuw met
gebruikersnaam/wachtwoord ingelogd hoeft te worden (kleiner risico op
MFA-verzoeken/rate-limiting). Vereist Multi-Factor-Authenticatie bij de
EERSTE login? Start de workflow dan handmatig via "Run workflow" in GitHub
Actions met de mfa_code-input ingevuld (code uit je e-mail/authenticator-app).
Alle volgende (geplande) runs hergebruiken daarna de opgeslagen sessie.
"""
import os
import sys
from datetime import date, datetime, timedelta, timezone

from garminconnect import Garmin, GarminConnectAuthenticationError
import requests

# Zelfde sportnaam-mapping als de (nu grotendeels buiten werking) Tredict-sync
# (supabase/functions/sync-tredict/index.ts), zodat activity_type-waarden in
# de "training"-tabel niet plots anders heten afhankelijk van de bron.
SPORT_TYPE_MAP = {
    "running": "hardlopen",
    "track_running": "hardlopen",
    "trail_running": "hardlopen",
    "treadmill_running": "hardlopen",
    "cycling": "fietsen",
    "road_biking": "fietsen",
    "indoor_cycling": "fietsen",
    "mountain_biking": "fietsen",
    "swimming": "zwemmen",
    "lap_swimming": "zwemmen",
    "open_water_swimming": "zwemmen",
    "strength_training": "sportschool",
    "fitness_equipment": "sportschool",
    "indoor_cardio": "sportschool",
}

# Dezelfde publieke "publishable" sleutel die al in index.html.html en de
# Tredict-sync-workflow staat -- geen geheim, RLS op de garmin_*-tabellen is
# net als de rest van deze app permissief ("using (true)").
SUPABASE_URL = "https://mhvduufxeqyxgkkvwimx.supabase.co"
SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Oy2NNm-yMP358eH3NPHl1A_d24-72WS"


def supabase_headers():
    return {
        "apikey": SUPABASE_PUBLISHABLE_KEY,
        "Authorization": f"Bearer {SUPABASE_PUBLISHABLE_KEY}",
        "Content-Type": "application/json",
    }


def load_session(owner):
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/garmin_session",
        headers=supabase_headers(),
        params={"owner": f"eq.{owner}", "select": "session_json"},
        timeout=15,
    )
    resp.raise_for_status()
    rows = resp.json()
    if rows and rows[0].get("session_json"):
        return rows[0]["session_json"]
    return None


def save_session(owner, session_json):
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/garmin_session",
        headers={**supabase_headers(), "Prefer": "resolution=merge-duplicates"},
        json={"owner": owner, "session_json": session_json, "updated_at": date.today().isoformat()},
        timeout=15,
    )
    if not resp.ok:
        print(f"WAARSCHUWING: sessie opslaan mislukt ({resp.status_code}): {resp.text[:300]}")


def upsert_metrics(owner, rows):
    if not rows:
        return
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/garmin_metrics",
        headers={**supabase_headers(), "Prefer": "resolution=merge-duplicates"},
        json=rows,
        timeout=30,
    )
    if not resp.ok:
        raise RuntimeError(f"Opslaan garmin_metrics mislukt ({resp.status_code}): {resp.text[:500]}")


def load_profile(owner):
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/profiles",
        headers=supabase_headers(),
        params={"owner": f"eq.{owner}", "select": "birth_date,height_cm"},
        timeout=15,
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else {}


def load_overridden_dates(owner):
    # Dagen die handmatig gecorrigeerd zijn (bv. een fout gesynchroniseerde
    # activiteit) mogen niet stilzwijgend weer overschreven worden -- zelfde
    # regel als de Tredict-sync.
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/training",
        headers=supabase_headers(),
        params={"owner": f"eq.{owner}", "manual_override": "eq.true", "select": "training_date"},
        timeout=15,
    )
    resp.raise_for_status()
    return {r["training_date"] for r in resp.json()}


def latest_weight_before(owner, date_str):
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/weight",
        headers=supabase_headers(),
        params={
            "owner": f"eq.{owner}",
            "weight_date": f"lte.{date_str}",
            "select": "kg",
            "order": "weight_date.desc",
            "limit": "1",
        },
        timeout=15,
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows[0]["kg"] if rows else 63


def upsert_weight(owner, rows):
    if not rows:
        return
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/weight",
        headers={**supabase_headers(), "Prefer": "resolution=merge-duplicates"},
        json=rows,
        timeout=30,
    )
    if not resp.ok:
        raise RuntimeError(f"Opslaan gewicht mislukt ({resp.status_code}): {resp.text[:500]}")


def replace_training_for_date(owner, date_str, rows):
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/training",
        headers=supabase_headers(),
        params={"owner": f"eq.{owner}", "training_date": f"eq.{date_str}"},
        timeout=15,
    )
    if not resp.ok:
        raise RuntimeError(f"Verwijderen training mislukt ({resp.status_code}): {resp.text[:500]}")
    if not rows:
        return
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/training",
        headers=supabase_headers(),
        json=rows,
        timeout=30,
    )
    if not resp.ok:
        raise RuntimeError(f"Opslaan training mislukt ({resp.status_code}): {resp.text[:500]}")


def calculate_age(birth_date, at_date):
    age = at_date.year - birth_date.year
    if (at_date.month, at_date.day) < (birth_date.month, birth_date.day):
        age -= 1
    return age


# Zelfde Mifflin-St Jeor-formule als de Tredict-sync (calculateBMR), x1.2 voor
# een puur sedentaire rustverbranding -- losse stappen tellen apart mee via
# extraKcalFromSteps in index.html.html.
def calculate_rest_kcal(weight_kg, height_cm, birth_date, at_date):
    age = calculate_age(birth_date, at_date)
    bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + 5
    return round(bmr * 1.2)


def login(owner, email, password, mfa_code):
    # return_on_mfa/prompt_mfa horen bij de Garmin(...)-constructor in deze
    # library-versie, niet bij login() zelf. Met prompt_mfa ingesteld (als er
    # een mfa_code is meegegeven) rondt garmin.login() een eventuele
    # MFA-uitdaging in één keer af -- geen aparte resume_login()-stap nodig.
    # Zonder mfa_code laten we prompt_mfa leeg: als MFA dan alsnog vereist is,
    # gooit de library een GarminConnectAuthenticationError, die we hieronder
    # opvangen met een duidelijke instructie.
    prompt_mfa = (lambda: mfa_code) if mfa_code else None
    garmin = Garmin(email=email, password=password, prompt_mfa=prompt_mfa)

    # garmin.login(tokenstore=...) accepteert zowel een bestandspad als de
    # sessie-JSON direct als string, en valt automatisch terug op een verse
    # wachtwoord-login als de opgeslagen sessie verlopen/ongeldig is -- dus
    # één aanroep dekt "hergebruik sessie", "verse login" en "MFA-login" alle drie.
    stored_session = load_session(owner)
    try:
        garmin.login(tokenstore=stored_session)
    except GarminConnectAuthenticationError as e:
        if "mfa" in str(e).lower():
            print(
                "MFA vereist maar geen (geldige) mfa_code opgegeven. Start deze workflow "
                "handmatig via 'Run workflow' in GitHub Actions met de mfa_code-input "
                "ingevuld (code uit je Garmin-e-mail/authenticator-app)."
            )
            sys.exit(1)
        raise

    print("Ingelogd bij Garmin Connect (sessie hergebruikt of vers ingelogd).")
    save_session(owner, garmin.client.dumps())
    return garmin


def safe(fn, *args):
    try:
        return fn(*args)
    except Exception as e:
        print(f"  (kon {fn.__name__} niet ophalen: {e})")
        return None


def main():
    owner = os.environ["GARMIN_OWNER"]
    email = os.environ["GARMIN_EMAIL"]
    password = os.environ["GARMIN_PASSWORD"]
    mfa_code = os.environ.get("GARMIN_MFA_CODE") or None

    garmin = login(owner, email, password, mfa_code)

    today = date.today()
    week_start = today - timedelta(days=7)

    print("Metrics ophalen...")
    rhr = safe(garmin.get_rhr_daily, week_start.isoformat(), today.isoformat())
    hrv = safe(garmin.get_hrv_data_range, week_start.isoformat(), today.isoformat())
    sleep = safe(garmin.get_sleep_daily, week_start.isoformat(), today.isoformat())
    max_metrics = safe(garmin.get_max_metrics_range, week_start.isoformat(), today.isoformat())
    training_status = safe(garmin.get_training_status, today.isoformat())
    # Alleen voor vandaag: totaal-stappen (voor de "extra stappen naast
    # training"-functie in de app) en de stappen die Garmin toeschrijft aan
    # de hardloopactiviteit(en) van vandaag, zodat de app die eraf kan
    # trekken (anders tellen dezelfde stappen twee keer mee: eenmaal via de
    # gesynchroniseerde training, eenmaal via het losse stappenverbruik).
    today_stats = safe(garmin.get_stats, today.isoformat())
    today_run_activities = safe(garmin.get_activities_by_date, today.isoformat(), today.isoformat(), "running")
    for name, val in [("rhr", rhr), ("hrv", hrv), ("sleep", sleep), ("max_metrics", max_metrics)]:
        if not isinstance(val, list):
            print(f"  (let op: {name} kwam terug als {type(val).__name__} i.p.v. een lijst -- ruwe vorm: {str(val)[:300]})")

    # Elke bron heeft een net iets andere (en niet volledig gedocumenteerde)
    # vorm; we proberen defensief de bekende velden te vinden en bewaren
    # daarnaast altijd de ruwe respons in de 'raw'-kolom, zodat niets
    # verloren gaat ook als een van deze extracties net niet klopt.
    per_date = {}

    # PostgREST's bulk-insert (POST met een JSON-array) eist dat elk object
    # exact dezelfde keys heeft ("All object keys must match") -- dus elke
    # rij begint met alle kolommen expliciet op None, in plaats van dat een
    # rij alleen de kolommen krijgt waarvoor toevallig data gevonden is.
    def bucket(d):
        return per_date.setdefault(d, {
            "owner": owner,
            "metric_date": d,
            "vo2max": None,
            "resting_hr": None,
            "hrv": None,
            "sleep_minutes": None,
            "sleep_score": None,
            "training_status": None,
            "body_battery_max": None,
            "hrv_status": None,
            "sleep_quality": None,
            "body_battery_change": None,
            "respiration": None,
            "training_load_acute": None,
            "training_load_chronic": None,
            "training_load_ratio": None,
            "training_feedback": None,
            "acwr_status": None,
            "training_balance_feedback": None,
            "steps_total": None,
            "steps_training": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "raw": {},
        })

    if isinstance(rhr, list):
        for entry in rhr:
            d = entry.get("calendarDate") or entry.get("date")
            if not d:
                continue
            row = bucket(d)
            row["resting_hr"] = entry.get("value") or entry.get("restingHeartRate")
            row["raw"]["rhr"] = entry

    if isinstance(hrv, list):
        for entry in hrv:
            d = entry.get("calendarDate") or entry.get("date")
            if not d:
                continue
            row = bucket(d)
            row["hrv"] = entry.get("lastNightAvg") or entry.get("weeklyAvg") or entry.get("value")
            row["raw"]["hrv"] = entry

    # De slaap-respons zet de eigenlijke metingen genest onder "values"
    # (i.p.v. los op het top-niveau van elk dag-object) -- en bevat daar ook
    # meteen een eigen HRV- en rust-hartslagmeting (avgOvernightHrv /
    # restingHeartRate), die als vangnet dienen als de losse hrv/rhr-oproepen
    # voor die dag niets opleveren.
    if isinstance(sleep, list):
        for entry in sleep:
            d = entry.get("calendarDate") or entry.get("date")
            if not d:
                continue
            values = entry.get("values") or entry
            row = bucket(d)
            sleep_seconds = values.get("totalSleepTimeInSeconds") or values.get("sleepTimeSeconds")
            row["sleep_minutes"] = round(sleep_seconds / 60) if sleep_seconds else None
            row["sleep_score"] = values.get("sleepScore")
            if row["hrv"] is None:
                row["hrv"] = values.get("avgOvernightHrv") or values.get("hrv7dAverage")
            if row["resting_hr"] is None:
                row["resting_hr"] = values.get("restingHeartRate")
            row["hrv_status"] = values.get("hrvStatus")
            row["sleep_quality"] = values.get("sleepScoreQuality")
            row["body_battery_change"] = values.get("bodyBatteryChange")
            row["respiration"] = values.get("respiration")
            row["raw"]["sleep"] = entry

    if isinstance(max_metrics, list):
        for entry in max_metrics:
            d = entry.get("calendarDate") or entry.get("date")
            if not d:
                continue
            row = bucket(d)
            generic = entry.get("generic") or {}
            vo2 = entry.get("vo2MaxPreciseValue") or entry.get("vo2MaxValue") or generic.get("vo2MaxPreciseValue") or generic.get("vo2MaxValue")
            row["vo2max"] = vo2
            row["raw"]["max_metrics"] = entry

    if training_status:
        row = bucket(today.isoformat())
        row["training_status"] = str(
            training_status.get("trainingStatus") or training_status.get("status") or training_status
        )[:200]
        # Vangnet voor VO2max op vandaag: staat ook in de training-status-
        # respons (mostRecentVO2Max), ook als get_max_metrics_range niets
        # bruikbaars teruggaf.
        if row["vo2max"] is None:
            most_recent_vo2 = (training_status.get("mostRecentVO2Max") or {}).get("generic") or {}
            row["vo2max"] = most_recent_vo2.get("vo2MaxPreciseValue") or most_recent_vo2.get("vo2MaxValue")

        # Garmin's eigen equivalent van ATL/CTL/ACWR (Runalyze-achtige
        # trainingsbelasting-metrics) zit genest onder een per-apparaat key
        # (deviceId) -- we pakken gewoon het eerste/primaire apparaat.
        latest_status_by_device = (
            (training_status.get("mostRecentTrainingStatus") or {}).get("latestTrainingStatusData") or {}
        )
        status_entry = next(iter(latest_status_by_device.values()), None)
        if status_entry:
            row["training_feedback"] = status_entry.get("trainingStatusFeedbackPhrase")
            acute = status_entry.get("acuteTrainingLoadDTO") or {}
            row["training_load_acute"] = acute.get("dailyTrainingLoadAcute")
            row["training_load_chronic"] = acute.get("dailyTrainingLoadChronic")
            row["training_load_ratio"] = acute.get("dailyAcuteChronicWorkloadRatio")
            row["acwr_status"] = acute.get("acwrStatus")

        balance_by_device = (
            (training_status.get("mostRecentTrainingLoadBalance") or {}).get("metricsTrainingLoadBalanceDTOMap") or {}
        )
        balance_entry = next(iter(balance_by_device.values()), None)
        if balance_entry:
            row["training_balance_feedback"] = balance_entry.get("trainingBalanceFeedbackPhrase")

        row["raw"]["training_status"] = training_status

    if today_stats:
        row = bucket(today.isoformat())
        row["steps_total"] = today_stats.get("totalSteps")
        row["raw"]["stats"] = today_stats

    if isinstance(today_run_activities, list):
        row = bucket(today.isoformat())
        run_steps = sum(a.get("steps") or 0 for a in today_run_activities)
        row["steps_training"] = run_steps if today_run_activities else None
        row["raw"]["run_activities_steps"] = run_steps

    rows = list(per_date.values())
    print(f"{len(rows)} dag(en) met metrics gevonden, opslaan in Supabase...")
    upsert_metrics(owner, rows)

    # ---- GEWICHT ----
    print("Gewicht ophalen...")
    body_comp = safe(garmin.get_body_composition, week_start.isoformat(), today.isoformat())
    weight_rows = []
    if isinstance(body_comp, dict):
        for entry in body_comp.get("dateWeightList") or []:
            ts = entry.get("date")
            grams = entry.get("weight")
            if not ts or not grams:
                continue
            d = datetime.fromtimestamp(ts / 1000, tz=timezone.utc).date().isoformat()
            weight_rows.append({"owner": owner, "weight_date": d, "kg": round(grams / 1000, 1)})
    if weight_rows:
        print(f"  {len(weight_rows)} gewichtmeting(en) gevonden, opslaan...")
        upsert_weight(owner, weight_rows)
    else:
        print("  geen gewichtmetingen gevonden (geen gekoppelde weegschaal, of niets nieuws deze week).")

    # ---- TRAINING (activiteiten) ----
    print("Trainingsactiviteiten ophalen...")
    profile = safe(load_profile, owner) or {}
    env_suffix = owner.upper()
    birth_date_str = profile.get("birth_date") or os.environ.get(f"BIRTHDATE_{env_suffix}") or "1990-01-01"
    height_cm = float(profile.get("height_cm") or os.environ.get(f"HEIGHT_CM_{env_suffix}") or 175)
    birth_date = datetime.strptime(birth_date_str, "%Y-%m-%d").date()
    overridden_dates = safe(load_overridden_dates, owner) or set()

    activities = safe(garmin.get_activities_by_date, week_start.isoformat(), today.isoformat())
    activities_by_date = {}
    if isinstance(activities, list):
        for act in activities:
            start_local = act.get("startTimeLocal") or act.get("startTimeGMT")
            if not start_local:
                continue
            d = start_local[:10]
            if d in overridden_dates:
                continue
            activity_type = ((act.get("activityType") or {}).get("typeKey")) or "misc"
            distance_m = act.get("distance") or 0
            duration_s = act.get("duration") or 0
            activities_by_date.setdefault(d, []).append({
                "name": act.get("activityName") or activity_type,
                "kcal": round(act.get("calories") or 0),
                "km": round(distance_m / 1000, 2) if distance_m else 0,
                "duration_minutes": round(duration_s / 60, 1) if duration_s else 0,
                "type": SPORT_TYPE_MAP.get(activity_type, activity_type),
                "avg_heartrate": act.get("averageHR"),
            })

    if not activities_by_date:
        print("  geen activiteiten gevonden in dit venster.")
    for d, acts in activities_by_date.items():
        activity_kcal_sum = sum(a["kcal"] for a in acts)
        weight_kg = safe(latest_weight_before, owner, d) or 63
        at_date = datetime.strptime(d, "%Y-%m-%d").date()
        rest_kcal = calculate_rest_kcal(weight_kg, height_cm, birth_date, at_date)
        total_kcal = rest_kcal + activity_kcal_sum
        training_rows = [{
            "owner": owner,
            "training_date": d,
            "activity_name": a["name"],
            "kcal": a["kcal"],
            "km": a["km"],
            "duration_minutes": a["duration_minutes"],
            "activity_type": a["type"],
            "avg_heartrate": a["avg_heartrate"],
            "rest_kcal": rest_kcal,
            "total_kcal": total_kcal,
        } for a in acts]
        replace_training_for_date(owner, d, training_rows)
        print(f"  {d}: {len(training_rows)} activiteit(en) weggeschreven ({activity_kcal_sum} kcal training, {total_kcal} kcal totaal)")

    print("Klaar.")


if __name__ == "__main__":
    main()
