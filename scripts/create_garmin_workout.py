#!/usr/bin/env python3
"""Maakt een gestructureerde hardlooptraining aan in Garmin Connect
(zichtbaar in de Garmin Connect-app en te syncen naar het horloge).

Gebruikt dezelfde login-aanpak (sessie-hergebruik via de garmin_session-
tabel) als sync_garmin.py, dus ook dit draait als GitHub Actions-workflow
i.p.v. een Supabase edge function (curl_cffi/bot-detectie-omzeiling werkt
niet in Deno).

Eenmalig aangemaakt op verzoek: 15 km progressieve duurloop, aflopend naar
3:59/km wedstrijdtempo in het laatste blok.
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


def distance_step(step_order, step_type_id, step_type_key, display_order,
                   distance_m, slow_pace, fast_pace, description=None):
    """Eén blok op afstand met een tempo-bandbreedte (langzaamste..snelste
    tempo van het blok, als (min, sec)-tuples)."""
    from garminconnect.workout import ExecutableStep, ConditionType, TargetType

    extra = {"description": description} if description else {}
    return ExecutableStep(
        stepOrder=step_order,
        stepType={"stepTypeId": step_type_id, "stepTypeKey": step_type_key, "displayOrder": display_order},
        endCondition={
            "conditionTypeId": ConditionType.DISTANCE,
            "conditionTypeKey": "distance",
            "displayOrder": 3,
            "displayable": True,
        },
        endConditionValue=float(distance_m),
        targetType={
            "workoutTargetTypeId": TargetType.SPEED,
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


def build_progressive_15k():
    from garminconnect.workout import (
        RunningWorkout, WorkoutSegment, StepType, create_warmup_step, create_cooldown_step,
    )

    warmup = create_warmup_step(600.0, step_order=1)  # 10 min inlopen, geen doel
    block1 = distance_step(2, StepType.INTERVAL, "interval", 3, 5000,
                            slow_pace=(4, 40), fast_pace=(4, 20),
                            description="Blok 1/3: 5 km rustig opbouwend")
    block2 = distance_step(3, StepType.INTERVAL, "interval", 3, 5000,
                            slow_pace=(4, 15), fast_pace=(4, 0),
                            description="Blok 2/3: 5 km richting tempo")
    block3 = distance_step(4, StepType.INTERVAL, "interval", 3, 5000,
                            slow_pace=(4, 0), fast_pace=(3, 50),
                            description="Blok 3/3: 5 km op wedstrijdtempo (~3:59/km)")
    cooldown = create_cooldown_step(300.0, step_order=5)  # 5 min uitlopen

    return RunningWorkout(
        workoutName="Progressieve duurloop 15 km (3:59/km slot)",
        estimatedDurationInSecs=int(600 + 5000 / pace_to_speed(4, 30) + 5000 / pace_to_speed(4, 7)
                                     + 5000 / pace_to_speed(3, 55) + 300),
        description=(
            "15 km progressief: 10 min inlopen, dan 3x5 km met oplopend tempo "
            "(4:40-4:20 / 4:15-4:00 / 4:00-3:50 per km), 5 min uitlopen. "
            "Laatste blok rond het 3:59/km wedstrijdtempo."
        ),
        workoutSegments=[
            WorkoutSegment(
                segmentOrder=1,
                sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                workoutSteps=[warmup, block1, block2, block3, cooldown],
            )
        ],
    )


def main():
    owner = os.environ["GARMIN_OWNER"]
    email = os.environ["GARMIN_EMAIL"]
    password = os.environ["GARMIN_PASSWORD"]
    mfa_code = os.environ.get("GARMIN_MFA_CODE") or None
    schedule_date = os.environ.get("WORKOUT_SCHEDULE_DATE") or None  # YYYY-MM-DD, optioneel

    garmin = login(owner, email, password, mfa_code)

    workout = build_progressive_15k()
    result = garmin.upload_running_workout(workout)
    workout_id = result.get("workoutId") or result.get("workoutID") or result.get("id")
    print(f"Training aangemaakt in Garmin Connect (workoutId={workout_id}).")

    if schedule_date and workout_id:
        garmin.schedule_workout(workout_id, schedule_date)
        print(f"Ingepland op {schedule_date}.")


if __name__ == "__main__":
    main()
