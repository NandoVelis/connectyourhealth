#!/usr/bin/env python3
"""Synchroniseert Garmin Connect-metrics (VO2max, HRV, rust-hartslag, slaap,
trainingsstatus) naar Supabase, als test-alternatief voor Tredict.

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
from datetime import date, timedelta

from garminconnect import Garmin, GarminConnectAuthenticationError
import requests

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
        row["raw"]["training_status"] = training_status

    rows = list(per_date.values())
    print(f"{len(rows)} dag(en) met metrics gevonden, opslaan in Supabase...")
    upsert_metrics(owner, rows)
    print("Klaar.")


if __name__ == "__main__":
    main()
