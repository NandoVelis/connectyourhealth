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

from garminconnect import Garmin
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
    garmin = Garmin(email=email, password=password)
    stored_session = load_session(owner)
    if stored_session:
        try:
            garmin.client.loads(stored_session if isinstance(stored_session, str) else str(stored_session))
            # Sanity-check: een lichte call om te bevestigen dat de sessie nog geldig is.
            garmin.get_full_name()
            print("Ingelogd met opgeslagen sessietoken (geen nieuwe login nodig).")
            return garmin
        except Exception as e:
            print(f"Opgeslagen sessie ongeldig/verlopen ({e}), opnieuw inloggen met wachtwoord...")

    result1, result2 = garmin.login(return_on_mfa=True)
    if result1 == "needs_mfa":
        if not mfa_code:
            print(
                "MFA vereist maar geen mfa_code opgegeven. Start deze workflow handmatig "
                "via 'Run workflow' in GitHub Actions met de mfa_code-input ingevuld "
                "(code uit je Garmin-e-mail/authenticator-app)."
            )
            sys.exit(1)
        garmin.resume_login(result2, mfa_code)
        print("Ingelogd met wachtwoord + MFA-code.")
    else:
        print("Ingelogd met wachtwoord (geen MFA vereist).")

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

    # Elke bron heeft een net iets andere (en niet volledig gedocumenteerde)
    # vorm; we proberen defensief de bekende velden te vinden en bewaren
    # daarnaast altijd de ruwe respons in de 'raw'-kolom, zodat niets
    # verloren gaat ook als een van deze extracties net niet klopt.
    per_date = {}

    def bucket(d):
        return per_date.setdefault(d, {"owner": owner, "metric_date": d, "raw": {}})

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

    if isinstance(sleep, list):
        for entry in sleep:
            d = entry.get("calendarDate") or entry.get("date")
            if not d:
                continue
            row = bucket(d)
            sleep_seconds = entry.get("sleepTimeSeconds") or entry.get("totalSleepSeconds")
            row["sleep_minutes"] = round(sleep_seconds / 60) if sleep_seconds else None
            row["sleep_score"] = entry.get("sleepScore") or entry.get("overallScore")
            row["raw"]["sleep"] = entry

    if isinstance(max_metrics, list):
        for entry in max_metrics:
            d = entry.get("calendarDate") or entry.get("date")
            if not d:
                continue
            row = bucket(d)
            vo2 = entry.get("vo2MaxPreciseValue") or entry.get("vo2MaxValue") or entry.get("generic", {}).get("vo2MaxPreciseValue")
            row["vo2max"] = vo2
            row["raw"]["max_metrics"] = entry

    if training_status:
        row = bucket(today.isoformat())
        row["training_status"] = str(
            training_status.get("trainingStatus") or training_status.get("status") or training_status
        )[:200]
        row["raw"]["training_status"] = training_status

    rows = list(per_date.values())
    print(f"{len(rows)} dag(en) met metrics gevonden, opslaan in Supabase...")
    upsert_metrics(owner, rows)
    print("Klaar.")


if __name__ == "__main__":
    main()
