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


def hr_step(step_order, step_type_id, step_type_key, display_order,
            condition, value, hr_low, hr_high, description=None):
    """Eén stap met een hartslag-bandbreedte als sturend doel (i.p.v. tempo)
    -- gebruikt voor de Noorse 4x4-methode, waar de intervallen bewust op
    hartslag i.p.v. tempo gestuurd worden (zo blijft het protocol consistent
    ongeacht terrein/vermoeidheid, precies het idee achter de methode).

    condition: "distance" (value in meter) of "time" (value in seconden).
    hr_low/hr_high: bpm-grenzen. Zelfde rauwe-Garmin-API-waarden-aanpak als
    pace_step hierboven (workoutTargetTypeId 4 = heart.rate.zone) i.p.v. de
    library-enums, om dezelfde reden (inconsistent tussen lokaal/CI)."""
    from garminconnect.workout import ExecutableStep

    cond_id, cond_key = (1, "distance") if condition == "distance" else (2, "time")
    extra = {"description": description} if description else {}
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
            "workoutTargetTypeId": 4,
            "workoutTargetTypeKey": "heart.rate.zone",
            "displayOrder": 4,
        },
        targetValueOne=float(hr_low),
        targetValueTwo=float(hr_high),
        **extra,
    )


def build_norwegian_4x4():
    """Noorse 4x4-methode: 4x 4 min op 90-95% maxHF (162-171bpm, maxHF 180)
    met 3 min actief herstel (rustige jog) ertussen. Op verzoek, 23 sept --
    hartslaggestuurd i.p.v. tempogestuurd, want dat is het hele punt van de
    methode (consistent effort ongeacht terrein/vermoeidheid)."""
    from garminconnect.workout import RunningWorkout, WorkoutSegment, create_cooldown_step

    WARMUP_STEP_TYPE, INTERVAL_STEP_TYPE, RECOVERY_STEP_TYPE = 1, 3, 4

    steps = [pace_step(1, WARMUP_STEP_TYPE, "warmup", 1, "time", 900.0,
                        slow_pace=(5, 15), fast_pace=(4, 25), hr_note="< 140",
                        description="Warming-up")]
    order = 2
    for i in range(1, 5):
        steps.append(hr_step(order, INTERVAL_STEP_TYPE, "interval", 3, "time", 240,
                              hr_low=162, hr_high=171,
                              description=f"Herhaling {i}/4 (90-95% maxHF)"))
        order += 1
        if i < 4:
            steps.append(pace_step(order, RECOVERY_STEP_TYPE, "recovery", 4, "time", 180,
                                    slow_pace=(6, 0), fast_pace=(5, 20),
                                    description="Actief herstel (rustige jog)"))
            order += 1
    steps.append(create_cooldown_step(600.0, step_order=order))  # 10 min rustig uitlopen, HS < 140

    total_secs = int(900 + 4 * 240 + 3 * 180 + 600)

    return RunningWorkout(
        workoutName="Hardlopen: Noorse 4x4 (90-95% maxHF)",
        estimatedDurationInSecs=total_secs,
        description=(
            "15 min inlopen (4:25-5:15/km, HS<140), dan 4x4 min op 162-171bpm "
            "(90-95% maxHF 180) met 3 min actief herstel (jog, 5:20-6:00/km) "
            "ertussen, 10 min rustig uitlopen (HS<140)."
        ),
        workoutSegments=[
            WorkoutSegment(
                segmentOrder=1,
                sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                workoutSteps=steps,
            )
        ],
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


def build_interval_6x1000():
    """Dinsdag: 6x1000m op 3:35/km (VDOT 56 I-tempo), met hersteljog ertussen.
    Alle stappen hebben een afstand-/tijd-eindconditie (geen lap.button), dus
    het horloge schakelt zelf door -- geen laptoets nodig."""
    from garminconnect.workout import RunningWorkout, WorkoutSegment, create_cooldown_step

    WARMUP_STEP_TYPE, INTERVAL_STEP_TYPE, RECOVERY_STEP_TYPE = 1, 3, 4

    steps = [pace_step(1, WARMUP_STEP_TYPE, "warmup", 1, "time", 900.0,
                        slow_pace=(5, 15), fast_pace=(4, 25), hr_note="< 140",
                        description="Warming-up")]
    order = 2
    for i in range(1, 7):
        steps.append(pace_step(order, INTERVAL_STEP_TYPE, "interval", 3, "distance", 1000,
                                slow_pace=(3, 40), fast_pace=(3, 30), hr_note="170-175",
                                description=f"Herhaling {i}/6"))
        order += 1
        if i < 6:
            steps.append(pace_step(order, RECOVERY_STEP_TYPE, "recovery", 4, "distance", 400,
                                    slow_pace=(6, 0), fast_pace=(5, 20),
                                    description="Hersteljog"))
            order += 1
    steps.append(create_cooldown_step(600.0, step_order=order))  # 10 min rustig uitlopen, HS < 140

    total_secs = int(900 + 6 * (1000 / pace_to_speed(3, 35)) + 5 * (400 / pace_to_speed(5, 40)) + 600)

    return RunningWorkout(
        workoutName="Hardlopen: 6x1000m interval (3:35/km)",
        estimatedDurationInSecs=total_secs,
        description=(
            "15 min inlopen (4:25-5:15/km, HS<140), dan 6x1000m op 3:30-3:40/km "
            "(HS 170-175) met 400m hersteljog (5:20-6:00/km) ertussen, "
            "10 min rustig uitlopen (HS<140)."
        ),
        workoutSegments=[
            WorkoutSegment(
                segmentOrder=1,
                sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                workoutSteps=steps,
            )
        ],
    )


def build_tempo_10k_355():
    """Donderdag: 10 km aaneengesloten op 3:55/km (verlaagd t.o.v. de
    oorspronkelijke 12 km op 3:53 -- op verzoek iets minder scherp)."""
    from garminconnect.workout import RunningWorkout, WorkoutSegment, create_cooldown_step

    WARMUP_STEP_TYPE, INTERVAL_STEP_TYPE = 1, 3

    warmup = pace_step(1, WARMUP_STEP_TYPE, "warmup", 1, "time", 900.0,
                        slow_pace=(5, 15), fast_pace=(4, 25), hr_note="< 140",
                        description="Warming-up")
    tempo = pace_step(2, INTERVAL_STEP_TYPE, "interval", 3, "distance", 10000,
                       slow_pace=(3, 58), fast_pace=(3, 52), hr_note="165-168",
                       description="Drempeltempo")
    cooldown = create_cooldown_step(600.0, step_order=3)  # 10 min rustig uitlopen, HS < 140

    total_secs = int(900 + 10000 / pace_to_speed(3, 55) + 600)

    return RunningWorkout(
        workoutName="Hardlopen: 10 km drempel (3:55/km)",
        estimatedDurationInSecs=total_secs,
        description=(
            "15 min inlopen (4:25-5:15/km, HS<140), dan 10 km aaneengesloten "
            "op 3:52-3:58/km (HS 165-168), 10 min rustig uitlopen (HS<140)."
        ),
        workoutSegments=[
            WorkoutSegment(
                segmentOrder=1,
                sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                workoutSteps=[warmup, tempo, cooldown],
            )
        ],
    )


def build_long_run_24k():
    """Zaterdag: 24 km rustige duurloop (E-tempo, geen harde HS-eis)."""
    from garminconnect.workout import RunningWorkout, WorkoutSegment

    INTERVAL_STEP_TYPE = 3  # één aaneengesloten blok op E-tempo

    long_run = pace_step(1, INTERVAL_STEP_TYPE, "interval", 1, "distance", 24000,
                          slow_pace=(5, 15), fast_pace=(4, 25), hr_note="< 155",
                          description="Duurloop")

    total_secs = int(24000 / pace_to_speed(5, 0))

    return RunningWorkout(
        workoutName="Hardlopen: 24 km duurloop (rustig)",
        estimatedDurationInSecs=total_secs,
        description="24 km rustig op 4:25-5:15/km, HS < 155.",
        workoutSegments=[
            WorkoutSegment(
                segmentOrder=1,
                sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                workoutSteps=[long_run],
            )
        ],
    )


def build_hm_surge_float():
    """15 km HM-tempo surge/float: 2 km inlopen op 4:40/km, dan 4x (2 km op
    HM-tempo 3:53/km + 1 km float-herstel op 4:40/km), waarbij het laatste
    blok een dubbele float (2 km i.p.v. 1 km) heeft als afsluiting. Exact
    15 km totaal: 2 + (2+1)x3 + (2+2) = 15. Op verzoek, 23 sept."""
    from garminconnect.workout import RunningWorkout, WorkoutSegment

    WARMUP_STEP_TYPE, INTERVAL_STEP_TYPE, RECOVERY_STEP_TYPE = 1, 3, 4

    steps = [pace_step(1, WARMUP_STEP_TYPE, "warmup", 1, "distance", 2000,
                        slow_pace=(4, 43), fast_pace=(4, 37),
                        description="Inlopen op float-tempo")]
    order = 2
    for i in range(1, 5):
        steps.append(pace_step(order, INTERVAL_STEP_TYPE, "interval", 3, "distance", 2000,
                                slow_pace=(3, 56), fast_pace=(3, 50),
                                description=f"Blok {i}/4: HM-tempo"))
        order += 1
        float_km = 2000 if i == 4 else 1000
        steps.append(pace_step(order, RECOVERY_STEP_TYPE, "recovery", 4, "distance", float_km,
                                slow_pace=(4, 43), fast_pace=(4, 37),
                                description=f"Blok {i}/4: float-herstel"))
        order += 1

    total_secs = int(2000 / pace_to_speed(4, 40) + 4 * (2000 / pace_to_speed(3, 53)) + 3 * (1000 / pace_to_speed(4, 40)) + 2000 / pace_to_speed(4, 40))

    return RunningWorkout(
        workoutName="Hardlopen: 15 km HM surge/float (3:53 + 4:40)",
        estimatedDurationInSecs=total_secs,
        description=(
            "2 km inlopen op 4:40/km, dan 4x (2 km op 3:50-3:56/km HM-tempo + "
            "1 km float-herstel op 4:37-4:43/km), laatste float 2 km i.p.v. 1 km. "
            "Totaal 15 km, geen aparte cooling-down (laatste float doet die rol)."
        ),
        workoutSegments=[
            WorkoutSegment(
                segmentOrder=1,
                sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                workoutSteps=steps,
            )
        ],
    )


def build_strides(order_start, reps=5, final_cooldown_secs=None):
    """5x (100m stride op ~3:00/km + 300m jog-herstel), afstandgebaseerd
    (geen lap.button, schakelt zelf door) -- korte versnellingen voor
    beenspeed/loopeconomie, geen aerobe belasting (vandaar losse, brede
    tempoband i.p.v. een harde HS-eis). Zonder final_cooldown_secs is dit
    exact 2 km (5x 100m+300m). Met final_cooldown_secs vervangt een formele
    cooling-down-stap (tijdgebaseerd) de laatste 300m-jog na de 5e stride."""
    from garminconnect.workout import create_cooldown_step

    RECOVERY_STEP_TYPE = 4
    INTERVAL_STEP_TYPE = 3
    steps = []
    order = order_start
    for i in range(1, reps + 1):
        steps.append(pace_step(order, INTERVAL_STEP_TYPE, "interval", 3, "distance", 100,
                                slow_pace=(3, 20), fast_pace=(2, 40),
                                description=f"Stride {i}/{reps}"))
        order += 1
        if i == reps and final_cooldown_secs:
            steps.append(create_cooldown_step(float(final_cooldown_secs), step_order=order))
        else:
            steps.append(pace_step(order, RECOVERY_STEP_TYPE, "recovery", 4, "distance", 300,
                                    slow_pace=(6, 0), fast_pace=(5, 20),
                                    description="Jog-herstel"))
        order += 1
    return steps, order


def build_easy_with_strides(total_km, workout_name, final_cooldown_secs=None):
    """Rustige duurloop met de laatste 2 km strides (5x 100m/300m-blok, zie
    build_strides) -- de rest van de afstand aaneengesloten op E-tempo.
    total_km is de totale afstand incl. het 2 km strides-blok (bij een
    final_cooldown_secs komt de tijdgebaseerde cooling-down er nog bovenop)."""
    from garminconnect.workout import RunningWorkout, WorkoutSegment

    INTERVAL_STEP_TYPE = 3
    easy_km = total_km - 2

    easy = pace_step(1, INTERVAL_STEP_TYPE, "interval", 1, "distance", easy_km * 1000,
                      slow_pace=(5, 15), fast_pace=(4, 25), hr_note="< 140",
                      description="Rustig")
    stride_steps, _ = build_strides(2, final_cooldown_secs=final_cooldown_secs)

    total_secs = int(
        easy_km * 1000 / pace_to_speed(5, 0)
        + 4 * (100 / pace_to_speed(3, 0) + 300 / pace_to_speed(5, 40))
        + 100 / pace_to_speed(3, 0)
        + (final_cooldown_secs if final_cooldown_secs else 300 / pace_to_speed(5, 40))
    )

    cooldown_note = (
        f", dan {final_cooldown_secs/60:.0f} min cooling-down (HS<140)" if final_cooldown_secs else ""
    )
    return RunningWorkout(
        workoutName=workout_name,
        estimatedDurationInSecs=total_secs,
        description=(
            f"{easy_km} km rustig op 4:25-5:15/km (HS<140), dan 5x (100m stride "
            f"op ~2:40-3:20/km + 300m jog-herstel op 5:20-6:00/km) -- laatste 2 km{cooldown_note}."
        ),
        workoutSegments=[
            WorkoutSegment(
                segmentOrder=1,
                sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                workoutSteps=[easy] + stride_steps,
            )
        ],
    )


def build_easy_10k_strides():
    """Vrijdag: 10 km rustig met laatste 2 km strides, na de 5e stride een
    tijdgebaseerde cooling-down van 5 min i.p.v. de normale 300m-jog. Op
    verzoek, 23-24 sept."""
    return build_easy_with_strides(10, "Hardlopen: 10 km rustig + strides", final_cooldown_secs=300.0)


def build_easy_8k_strides():
    """Maandag: 8 km rustig met laatste 2 km strides. Op verzoek, 23 sept."""
    return build_easy_with_strides(8, "Hardlopen: 8 km rustig + strides")


def build_long_run_18k():
    """Zondag: 18 km rustige duurloop (E-tempo, geen harde HS-eis). Op
    verzoek, 23 sept."""
    from garminconnect.workout import RunningWorkout, WorkoutSegment

    INTERVAL_STEP_TYPE = 3

    long_run = pace_step(1, INTERVAL_STEP_TYPE, "interval", 1, "distance", 18000,
                          slow_pace=(5, 15), fast_pace=(4, 25), hr_note="< 155",
                          description="Duurloop")

    total_secs = int(18000 / pace_to_speed(5, 0))

    return RunningWorkout(
        workoutName="Hardlopen: 18 km duurloop (rustig)",
        estimatedDurationInSecs=total_secs,
        description="18 km rustig op 4:25-5:15/km, HS < 155.",
        workoutSegments=[
            WorkoutSegment(
                segmentOrder=1,
                sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                workoutSteps=[long_run],
            )
        ],
    )


def build_4mile_pace_test():
    """4 mijl race-tempotest: 10 min inlopen, dan 4x 1 mijl op 6:00/mijl
    (3:44/km, doel sub 24 min -- zelfde tempo als het racedoel "4 Mijl,
    sub 24" in race_goals), 10 min uitlopen. Op verzoek, 23 sept."""
    from garminconnect.workout import RunningWorkout, WorkoutSegment, create_cooldown_step

    WARMUP_STEP_TYPE, INTERVAL_STEP_TYPE = 1, 3
    MILE_M = 1609.34

    steps = [pace_step(1, WARMUP_STEP_TYPE, "warmup", 1, "time", 600.0,
                        slow_pace=(5, 15), fast_pace=(4, 25), hr_note="< 140",
                        description="Warming-up")]
    order = 2
    for i in range(1, 5):
        steps.append(pace_step(order, INTERVAL_STEP_TYPE, "interval", 3, "distance", MILE_M,
                                slow_pace=(3, 46), fast_pace=(3, 42),
                                description=f"Mijl {i}/4 op 6:00/mijl (doel 24 min totaal)"))
        order += 1
    steps.append(create_cooldown_step(600.0, step_order=order))  # 10 min rustig uitlopen, HS < 140

    total_secs = int(600 + 4 * (MILE_M / pace_to_speed(3, 44)) + 600)

    return RunningWorkout(
        workoutName="Hardlopen: 4 mijl op 6:00/mijl (doel 24:00)",
        estimatedDurationInSecs=total_secs,
        description=(
            "10 min inlopen (4:25-5:15/km, HS<140), dan 4x 1 mijl op "
            "3:42-3:46/km (6:00/mijl, doel 24 min totaal), 10 min rustig uitlopen (HS<140)."
        ),
        workoutSegments=[
            WorkoutSegment(
                segmentOrder=1,
                sportType={"sportTypeId": 1, "sportTypeKey": "running"},
                workoutSteps=steps,
            )
        ],
    )


WORKOUT_BUILDERS = {
    "progressive_15k": build_five_by_three_progressive,
    "interval_6x1000": build_interval_6x1000,
    "tempo_10k_355": build_tempo_10k_355,
    "long_run_24k": build_long_run_24k,
    "norwegian_4x4": build_norwegian_4x4,
    "hm_surge_float": build_hm_surge_float,
    "4mile_pace_test": build_4mile_pace_test,
    "easy_10k_strides": build_easy_10k_strides,
    "easy_8k_strides": build_easy_8k_strides,
    "long_run_18k": build_long_run_18k,
}


def unschedule_workout_on_date(garmin, date_str):
    """Haalt alle ingeplande trainingen op voor de maand van date_str en
    verwijdert elke training die exact op date_str staat (de training zelf
    -- de 'template' -- blijft bestaan, alleen de kalenderinplanning wordt
    verwijderd). Robuust tegen wisselende veldnamen in Garmin's respons
    (calendarDate/date, workoutScheduleId/id)."""
    from datetime import date as date_cls

    d = date_cls.fromisoformat(date_str)
    scheduled = garmin.get_scheduled_workouts(d.year, d.month)
    entries = scheduled if isinstance(scheduled, list) else (
        scheduled.get("workouts") or scheduled.get("scheduledWorkouts") or
        scheduled.get("items") or []
    )
    removed = 0
    for entry in entries:
        entry_date = (
            entry.get("calendarDate") or entry.get("date") or
            entry.get("startDate") or entry.get("workoutDate")
        )
        if not entry_date or entry_date[:10] != date_str:
            continue
        scheduled_id = (
            entry.get("workoutScheduleId") or entry.get("scheduleId") or
            entry.get("id") or entry.get("scheduledWorkoutId")
        )
        if not scheduled_id:
            print(f"  (kon geen scheduled_workout_id vinden in entry: {entry})")
            continue
        garmin.unschedule_workout(scheduled_id)
        name = entry.get("workoutName") or entry.get("name") or "?"
        print(f"  Verwijderd van kalender: '{name}' op {date_str} (scheduleId={scheduled_id}).")
        removed += 1
    if removed == 0:
        print(f"  Geen ingeplande training gevonden op {date_str}.")
    return removed


def main():
    owner = os.environ["GARMIN_OWNER"]
    email = os.environ["GARMIN_EMAIL"]
    password = os.environ["GARMIN_PASSWORD"]
    mfa_code = os.environ.get("GARMIN_MFA_CODE") or None
    schedule_date = os.environ.get("WORKOUT_SCHEDULE_DATE") or None  # YYYY-MM-DD, optioneel
    existing_workout_id = os.environ.get("WORKOUT_ID") or None  # als gezet: niet opnieuw aanmaken, alleen inplannen
    workout_type = os.environ.get("WORKOUT_TYPE") or "progressive_15k"
    unschedule_date = os.environ.get("UNSCHEDULE_DATE") or None  # YYYY-MM-DD: verwijdert alleen de kalenderinplanning die dag

    garmin = login(owner, email, password, mfa_code)

    if unschedule_date:
        unschedule_workout_on_date(garmin, unschedule_date)
        return

    if existing_workout_id:
        workout_id = existing_workout_id
    else:
        builder = WORKOUT_BUILDERS.get(workout_type)
        if builder is None:
            print(f"Onbekend WORKOUT_TYPE '{workout_type}', kies uit: {', '.join(WORKOUT_BUILDERS)}")
            sys.exit(1)
        workout = builder()
        result = garmin.upload_running_workout(workout)
        workout_id = result.get("workoutId") or result.get("workoutID") or result.get("id")
        print(f"Training aangemaakt in Garmin Connect (workoutId={workout_id}, type={workout_type}).")

    if schedule_date and workout_id:
        garmin.schedule_workout(workout_id, schedule_date)
        print(f"Ingepland op {schedule_date}.")


if __name__ == "__main__":
    main()
