#!/usr/bin/env python3
"""Maakt een gestructureerde hardlooptraining aan in Garmin Connect
(zichtbaar in de Garmin Connect-app en te syncen naar het horloge).

Gebruikt dezelfde login-aanpak (sessie-hergebruik via de garmin_session-
tabel) als sync_garmin.py, dus ook dit draait als GitHub Actions-workflow
i.p.v. een Supabase edge function (curl_cffi/bot-detectie-omzeiling werkt
niet in Deno).

Eenmalig aangemaakt op verzoek: 15 km progressief (5x3 km oplopend in
tempo, met hartslagzones als referentie per blok).
"""
import os
import sys

from garminconnect import Garmin, GarminConnectAuthenticationError
import requests

# Zelfde login-/sessie-opslaglogica als sync_garmin.py -- zie dat bestand
# voor de uitleg waarom sessie-hergebruik nodig is (MFA/rate-limiting).
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
        json={"owner": owner, "session_json": session_json},
        timeout=15,
    )
    if not resp.ok:
        print(f"WAARSCHUWING: sessie opslaan mislukt ({resp.status_code}): {resp.text[:300]}")


def login(owner, email, password, mfa_code):
    prompt_mfa = (lambda: mfa_code) if mfa_code else None
    garmin = Garmin(email=email, password=password, prompt_mfa=prompt_mfa)
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


def pace_to_speed(min_per_km, sec_per_km):
    """min:sec per km -> snelheid in m/s (Garmin's interne eenheid voor
    pace-doelen, ook al toont de app het weer terug als tempo)."""
    return 1000.0 / (min_per_km * 60 + sec_per_km)


def pace_step(step_order, step_type_id, step_type_key, display_order,
              condition, value, slow_pace, fast_pace, hr_note=None, description=None):
    """Eén stap met een tempo-bandbreedte (langzaamste..snelste tempo, als
    (min, sec)-tuples) en optioneel een hartslagzone als toelichting.

    condition: "distance" (value in meter) of "time" (value in seconden).
    Garmin's structured-workout-schema ondersteunt geen twee live-doelen
    (tempo EN hartslag) tegelijk op één stap -- tempo is hier het sturende
    doel (zichtbaar als balk op het horloge), de hartslagzone staat erbij
    in de stap-omschrijving zodat je 'm ter referentie ziet.

    Gebruikt bewust de rauwe Garmin-API-waarden i.p.v. de ConditionType/
    TargetType-enums van de library: die enums bleken tussen lokaal en de
    GitHub Actions-runner (zelfde library-versie) inconsistent -- de
    runner miste TargetType.SPEED terwijl die er lokaal wel was. De
    onderliggende ID's zijn Garmin's eigen, stabiele API-schema en dus
    geen afhankelijkheid van de library-enums.
    """
    from garminconnect.workout import ExecutableStep

    cond_id, cond_key = (1, "distance") if condition == "distance" else (2, "time")
    full_description = " · ".join(p for p in [description, f"HS {hr_note}" if hr_note else None] if p)
    extra = {"description": full_description} if full_description else {}
    return ExecutableStep(
        stepOrder=step_order,
        stepType={"stepTypeId": step_type_id, "stepTypeKey": step_type_key, "displayOrder": display_order},
        endCondition={
            "conditionTypeId": cond_id,
            "conditionTypeKey": cond_key,
            "displayOrder": 3,
            "displayable": True,
        },
        endConditionValue=float(value),
        targetType={
            "workoutTargetTypeId": 5,
            "workoutTargetTypeKey": "speed.zone",
            "displayOrder": 5,
        },
        # targetValueOne = ondergrens (laagste snelheid = langzaamste tempo),
        # targetValueTwo = bovengrens (hoogste snelheid = snelste tempo) --
        # Garmin's gebruikelijke min/max-volgorde voor een snelheidszone.
        targetValueOne=pace_to_speed(*slow_pace),
        targetValueTwo=pace_to_speed(*fast_pace),
        **extra,
    )


def build_five_by_three_progressive():
    """15 km progressief: 5x3 km oplopend in tempo, met hartslagzones als
    referentie per blok (opgegeven specificatie, 19 sept)."""
    from garminconnect.workout import RunningWorkout, WorkoutSegment, create_cooldown_step

    WARMUP_STEP_TYPE, INTERVAL_STEP_TYPE = 1, 3  # Garmin's eigen stepType-ID's

    warmup = pace_step(1, WARMUP_STEP_TYPE, "warmup", 1, "time", 600.0,
                        slow_pace=(5, 22), fast_pace=(4, 52), hr_note="< 140",
                        description="Warming-up")
    block1 = pace_step(2, INTERVAL_STEP_TYPE, "interval", 3, "distance", 3000,
                        slow_pace=(4, 9), fast_pace=(4, 1), hr_note="~150")
    block2 = pace_step(3, INTERVAL_STEP_TYPE, "interval", 3, "distance", 3000,
                        slow_pace=(4, 6), fast_pace=(3, 58), hr_note="158-163")
    block3 = pace_step(4, INTERVAL_STEP_TYPE, "interval", 3, "distance", 3000,
                        slow_pace=(4, 4), fast_pace=(3, 56), hr_note="163-166")
    block4 = pace_step(5, INTERVAL_STEP_TYPE, "interval", 3, "distance", 3000,
                        slow_pace=(4, 1), fast_pace=(3, 53), hr_note="166-169")
    block5 = pace_step(6, INTERVAL_STEP_TYPE, "interval", 3, "distance", 3000,
                        slow_pace=(3, 56), fast_pace=(3, 48), hr_note="169-173")
    cooldown = create_cooldown_step(300.0, step_order=7)  # 5 min rustig uitlopen, HS < 140

    total_secs = int(
        600
        + 3000 / pace_to_speed(4, 5) + 3000 / pace_to_speed(4, 2)
        + 3000 / pace_to_speed(4, 0) + 3000 / pace_to_speed(3, 57)
        + 3000 / pace_to_speed(3, 52) + 300
    )

    return RunningWorkout(
        workoutName="Hardlopen: 15 km progressief (5x3 km, HS-gestuurd)",
        estimatedDurationInSecs=total_secs,
        description=(
            "10 min inlopen (4:52-5:22/km, HS<140), dan 5x3 km oplopend in tempo: "
            "4:01-4:09 (HS~150) / 3:58-4:06 (HS 158-163) / 3:56-4:04 (HS 163-166) / "
            "3:53-4:01 (HS 166-169) / 3:48-3:56 (HS 169-173), 5 min rustig uitlopen (HS<140)."
        ),
        workoutSegments=[
            WorkoutSegment(
                segmentOrder=1,
                sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                workoutSteps=[warmup, block1, block2, block3, block4, block5, cooldown],
            )
        ],
    )


def main():
    owner = os.environ["GARMIN_OWNER"]
    email = os.environ["GARMIN_EMAIL"]
    password = os.environ["GARMIN_PASSWORD"]
    mfa_code = os.environ.get("GARMIN_MFA_CODE") or None
    schedule_date = os.environ.get("WORKOUT_SCHEDULE_DATE") or None  # YYYY-MM-DD, optioneel
    existing_workout_id = os.environ.get("WORKOUT_ID") or None  # als gezet: niet opnieuw aanmaken, alleen inplannen

    garmin = login(owner, email, password, mfa_code)

    if existing_workout_id:
        workout_id = existing_workout_id
    else:
        workout = build_five_by_three_progressive()
        result = garmin.upload_running_workout(workout)
        workout_id = result.get("workoutId") or result.get("workoutID") or result.get("id")
        print(f"Training aangemaakt in Garmin Connect (workoutId={workout_id}).")

    if schedule_date and workout_id:
        garmin.schedule_workout(workout_id, schedule_date)
        print(f"Ingepland op {schedule_date}.")


if __name__ == "__main__":
    main()
