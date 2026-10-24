#!/usr/bin/env python3
"""Synchroniseert FITAGE/QNClouds-weegschaal-metingen (gewicht + lichaams-
samenstelling: vetpercentage, spierpercentage, water, bot, BMI, BMR,
visceraal vet) naar Supabase.

FITAGE heeft geen officiele publieke API -- dit script herbouwt het
inlog-/meetprotocol van de community-reverse-engineerde Home Assistant-
integratie (github.com/lampje25/ha-fitage), gecontroleerd tegen de echte
broncode op 24 okt 2026. Net als bij de (inmiddels verouderde) onofficiele
Garmin-login is dit dus geen door FITAGE ondersteunde/gedocumenteerde weg --
als FITAGE ooit iets aan het protocol wijzigt, kan dit script zonder
waarschuwing stoppen met werken.

NIET LIVE GETEST vanuit de ontwikkelomgeving: fitage.qnclouds.com is vanuit
die sandbox niet bereikbaar (zelfde soort netwerkbeperking als bij Garmin's
domeinen eerder). Dit script draait pas voor het eerst echt in GitHub
Actions -- controleer de eerste paar runs/Supabase-rijen extra goed.

Vereist GitHub Actions-secrets FITAGE_EMAIL_NANDO / FITAGE_PASSWORD_NANDO
(zie .github/workflows/auto-sync-fitage.yml) en hergebruikt
SUPABASE_SERVICE_ROLE_KEY.

FITAGE is leidend voor gewicht (op verzoek, i.p.v. het 2x moeten invoeren):
na het opslaan in Supabase wordt de meest recente FITAGE-weging ook
teruggeschreven naar Garmin Connect zelf (garmin.add_weigh_in), zodat
Garmin's eigen gewichtsgeschiedenis -- en alles dat daar binnen Garmin op
voortbouwt -- de FITAGE-waarde overneemt i.p.v. zelf een weegschaal nodig
te hebben. Dit gebruikt bewust de OUDE, onofficiele garminconnect-library
(met e-mail/wachtwoord-login + sessie-hergebruik via de garmin_session-
tabel, exact zoals sync_garmin.py dat deed voor de Personal API-migratie) --
niet de nieuwe Personal API, want die is alleen-lezen (geen enkel
schrijf-endpoint in de officiele swagger-docs). Dit is dus de enige plek
in dit project waar die kwetsbaarheid (bot-detectie/MFA/sessiebeheer)
bewust terugkomt, puur voor deze ene write-actie.
"""
import base64
import os
from datetime import datetime
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import requests
from Crypto.Cipher import PKCS1_v1_5
from Crypto.PublicKey import RSA
from garminconnect import Garmin, GarminConnectAuthenticationError

AMSTERDAM = ZoneInfo("Europe/Amsterdam")

API_BASE = "https://fitage.qnclouds.com/api/v4"
PATH_LOGIN = "/users/sign_in"
PATH_GET_PRIMARY_USER = "/users/get_primary_user"
PATH_MEASUREMENTS = "/measurements/list_measurement"

# Zelfde publieke sleutel als in ha-fitage's const.py -- FITAGE's app
# versleutelt het wachtwoord hiermee (RSA/PKCS1v1.5) voor het over de lijn
# gaat, in plaats van een simpele HTTPS-POST met platte tekst.
PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC+25I2upukpfQ7rIaaTZtVE744
u2zV+HaagrUhDOTq8fMVf9yFQvEZh2/HKxFudUxP0dXUa8F6X4XmWumHdQnum3zm
Jr04fz2b2WCcN0ta/rbF2nYAnMVAk2OJVZAMudOiMWhcxV1nNJiKgTNNr13de0EQ
IiOL2CUBzu+HmIfUbQIDAQAB
-----END PUBLIC KEY-----"""

# Vaste app-identificatie-velden die de FITAGE-Android-app op elk verzoek
# meestuurt -- zonder (een deel van) deze query-params wees de API in de
# ha-fitage-broncode verzoeken af, dus kopieer ze letterlijk.
DEFAULT_QUERY_PARAMS = {
    "app_revision": "4.16.0",
    "html_version": "14.16.0",
    "cellphone_type": "samsung SM-T510",
    "system_type": "11_30",
    "zone": "Europe/Amsterdam",
    "area_code": "NL",
    "locale": "nl",
    "app_id": "Fitage",
    "platform": "android",
}
COMMON_HEADERS = {
    "Accept-Encoding": "gzip",
    "Connection": "Keep-Alive",
    "Host": "fitage.qnclouds.com",
    "User-Agent": "okhttp/4.9.1",
}

SUPABASE_URL = "https://mhvduufxeqyxgkkvwimx.supabase.co"
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


class FitageAuthError(Exception):
    pass


class FitageApiError(Exception):
    pass


def supabase_headers():
    return {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }


def _build_url(path, extra_params=None):
    params = dict(DEFAULT_QUERY_PARAMS)
    if extra_params:
        params.update({k: str(v) for k, v in extra_params.items()})
    return f"{API_BASE}{path}?{urlencode(params, safe='/')}"


def _encrypt_password(password):
    rsa_key = RSA.import_key(PUBLIC_KEY)
    cipher = PKCS1_v1_5.new(rsa_key)
    encrypted = cipher.encrypt(password.encode("utf-8"))
    return base64.b64encode(encrypted).decode("utf-8")


def login(email, password):
    headers = {
        **COMMON_HEADERS,
        "Authorization": "Bearer",
        "Content-Type": "application/json;charset=UTF-8",
    }
    payload = {"email": email, "password": _encrypt_password(password)}
    resp = requests.post(_build_url(PATH_LOGIN), headers=headers, json=payload, timeout=15)
    if resp.status_code != 200:
        raise FitageApiError(f"FITAGE-login gaf HTTP {resp.status_code}: {resp.text[:300]}")
    result = resp.json()
    code = str(result.get("code"))
    if code == "401":
        raise FitageAuthError("FITAGE-login afgewezen (verkeerd e-mailadres/wachtwoord)")
    if code not in ("200", "0"):
        raise FitageApiError(f"FITAGE-login-API gaf een fout: {result}")
    data = result.get("data") or {}
    token = (data.get("token_info") or {}).get("token")
    if not token:
        raise FitageApiError("FITAGE-login-respons bevatte geen token")
    return token, (data.get("user_info") or {})


def fitage_get(token, path, extra_params=None):
    headers = {**COMMON_HEADERS, "Authorization": f"Bearer {token}"}
    resp = requests.get(_build_url(path, extra_params), headers=headers, timeout=15)
    if resp.status_code != 200:
        raise FitageApiError(f"FITAGE-aanvraag {path} gaf HTTP {resp.status_code}: {resp.text[:300]}")
    result = resp.json()
    if isinstance(result, dict) and str(result.get("code")) == "401":
        raise FitageAuthError("FITAGE-sessie afgewezen (token verlopen/ongeldig)")
    if isinstance(result, dict) and "data" in result:
        return result["data"]
    return result


def fetch_all_measurements(token, user_id):
    """PATH_MEASUREMENTS is cursor-gepagineerd: de respons geeft zelf
    last_updated_at/last_measurement_id terug (door te geven als params van
    de volgende aanroep) plus een finish_flag die 0 blijft zolang er meer
    pagina's zijn. Zonder dit door te lopen (ontdekt via GARMIN_DEBUG_RAW-
    achtige logging op 24 okt 2026) kreeg je stilzwijgend alleen de EERSTE
    pagina -- in de praktijk de oudste ~350 dagen, niet de meest recente
    metingen waar het eigenlijk om gaat."""
    all_measurements = []
    last_updated_at, last_measurement_id = 0, "0"
    for _ in range(100):  # veiligheidslimiet i.p.v. een eventuele oneindige lus
        data = fitage_get(
            token, PATH_MEASUREMENTS,
            {"user_id": user_id, "last_updated_at": last_updated_at, "last_measurement_id": last_measurement_id},
        )
        if not isinstance(data, dict):
            break
        batch = data.get("measurements")
        if isinstance(batch, list):
            all_measurements.extend(batch)
        if os.environ.get("FITAGE_DEBUG_RAW"):
            print(f"DEBUG pagina: {len(batch) if isinstance(batch, list) else 0} meting(en), finish_flag={data.get('finish_flag')}")
        if str(data.get("finish_flag")) in ("1", "True", "true") or not batch:
            break
        next_updated_at = data.get("last_updated_at")
        next_measurement_id = data.get("last_measurement_id")
        if next_updated_at == last_updated_at and next_measurement_id == last_measurement_id:
            # Cursor schuift niet meer op -- stoppen i.p.v. oneindig dezelfde
            # pagina opvragen.
            break
        last_updated_at, last_measurement_id = next_updated_at, next_measurement_id
    return all_measurements


def safe(fn, *args):
    try:
        return fn(*args)
    except Exception as e:
        print(f"  (kon {fn.__name__} niet ophalen: {e})")
        return None


def get_user_id(user_info):
    # Exacte veldnaam niet bevestigd vanuit de broncode (die liet alleen het
    # algehele user_info-object zien, geen schema) -- probeer de meest
    # voor de hand liggende kandidaten.
    for key in ("id", "user_id", "userId"):
        if user_info.get(key) is not None:
            return user_info[key]
    return None


def extract_measurement_date(m):
    # time_stamp is vrijwel zeker een unix-timestamp (seconden of
    # milliseconden) -- beide varianten proberen, in Amsterdamse tijd zodat
    # een meting rond middernacht niet per ongeluk op de verkeerde dag valt.
    ts = m.get("time_stamp")
    if ts is None:
        return None
    ts = float(ts)
    if ts > 1e12:  # milliseconden
        ts = ts / 1000
    try:
        return datetime.fromtimestamp(ts, tz=AMSTERDAM).date().isoformat()
    except (ValueError, OSError):
        return None


def upsert_body_composition(owner, rows):
    if not rows:
        return
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/body_composition",
        headers={**supabase_headers(), "Prefer": "resolution=merge-duplicates"},
        params={"on_conflict": "owner,measurement_date"},
        json=rows,
        timeout=30,
    )
    if not resp.ok:
        raise RuntimeError(f"Opslaan body_composition mislukt ({resp.status_code}): {resp.text[:500]}")


def upsert_weight(owner, rows):
    if not rows:
        return
    # Zelfde on_conflict-aanpak als sync_garmin.py's upsert_weight -- de
    # "weight"-tabel heeft een losse "id"-kolom als primary key, dus zonder
    # expliciete on_conflict probeert PostgREST te conflicten op "id" i.p.v.
    # de echte unieke combinatie owner+weight_date.
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/weight",
        headers={**supabase_headers(), "Prefer": "resolution=merge-duplicates"},
        params={"on_conflict": "owner,weight_date"},
        json=rows,
        timeout=30,
    )
    if not resp.ok:
        raise RuntimeError(f"Opslaan gewicht mislukt ({resp.status_code}): {resp.text[:500]}")


def load_garmin_push_state(owner):
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/garmin_session",
        headers=supabase_headers(),
        params={"owner": f"eq.{owner}", "select": "session_json,garmin_weight_push_date,garmin_weight_push_kg"},
        timeout=15,
    )
    resp.raise_for_status()
    rows = resp.json()
    return rows[0] if rows else {}


def save_garmin_push_state(owner, session_json, pushed_date, pushed_kg):
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/garmin_session",
        headers={**supabase_headers(), "Prefer": "resolution=merge-duplicates"},
        json={
            "owner": owner,
            "session_json": session_json,
            "updated_at": datetime.now(AMSTERDAM).date().isoformat(),
            "garmin_weight_push_date": pushed_date,
            "garmin_weight_push_kg": pushed_kg,
        },
        timeout=15,
    )
    if not resp.ok:
        print(f"  WAARSCHUWING: opslaan Garmin-sessie/push-status mislukt ({resp.status_code}): {resp.text[:300]}")


def push_latest_weight_to_garmin(owner, latest_date, latest_kg, garmin_email, garmin_password):
    """Schrijft de meest recente FITAGE-weging terug naar Garmin Connect,
    maar alleen als die datum+gewicht nog niet eerder gepusht is -- anders
    zou elke 2-uurlijkse run dezelfde dag telkens als nieuwe (duplicaat)
    handmatige weging in Garmin aanmaken (Garmins weigh-in-endpoint is
    puur toevoegend, geen upsert op datum)."""
    if latest_kg is None or not garmin_email or not garmin_password:
        return
    state = load_garmin_push_state(owner)
    if state.get("garmin_weight_push_date") == latest_date and state.get("garmin_weight_push_kg") == latest_kg:
        print(f"  Garmin heeft {latest_date} ({latest_kg} kg) al -- niet opnieuw gepusht.")
        return

    print(f"  Terugschrijven naar Garmin: {latest_date} -> {latest_kg} kg...")
    garmin = Garmin(email=garmin_email, password=garmin_password)
    stored_session = state.get("session_json")
    try:
        garmin.login(tokenstore=stored_session)
    except GarminConnectAuthenticationError as e:
        print(f"  WAARSCHUWING: kon niet inloggen bij Garmin om gewicht terug te schrijven ({e}) -- overgeslagen.")
        return
    try:
        garmin.add_weigh_in(weight=latest_kg, unitKey="kg", timestamp=f"{latest_date}T08:00:00")
    except Exception as e:
        print(f"  WAARSCHUWING: terugschrijven naar Garmin mislukt ({e}).")
        return
    save_garmin_push_state(owner, garmin.client.dumps(), latest_date, latest_kg)
    print("  Gewicht teruggeschreven naar Garmin.")


def main():
    owner = os.environ["FITAGE_OWNER"]
    email = os.environ["FITAGE_EMAIL"]
    password = os.environ["FITAGE_PASSWORD"]

    print("Inloggen bij FITAGE...")
    token, user_info = login(email, password)
    user_id = get_user_id(user_info)
    if user_id is None:
        # Val terug op het primaire-gebruikersprofiel-endpoint als de
        # login-respons zelf geen bruikbaar id-veld bevat.
        primary = safe(fitage_get, token, PATH_GET_PRIMARY_USER) or {}
        user_id = get_user_id(primary.get("user_info") or primary)
    if user_id is None:
        raise FitageApiError("Kon geen FITAGE user_id vinden in login-/profielrespons")
    print(f"Ingelogd bij FITAGE (user_id={user_id}).")

    print("Metingen ophalen...")
    # Geen cursor-opslag tussen runs -- simpelweg elke run de volledige
    # (doorgepagineerde) geschiedenis opnieuw ophalen en per dag upserten (de
    # "weight"/"body_composition"-tabellen zijn toch al idempotent op
    # owner+datum). Zie fetch_all_measurements() voor waarom dit paginering
    # nodig heeft.
    measurements = safe(fetch_all_measurements, token, user_id) or []

    # Per dag de meest recente meting bewaren (meerdere wegingen op een dag
    # zijn mogelijk, bv. ochtend en avond) -- latere item in de lijst wint
    # ervan uitgaande dat de API chronologisch aflevert; bij twijfel wint
    # toch de laatste upsert, dus dit is vooral om niet 2x dezelfde dag in
    # 1 bulk-insert te hebben (PostgREST staat dat niet toe op dezelfde
    # conflict-sleutel).
    by_date = {}
    for m in measurements:
        if not isinstance(m, dict):
            continue
        d = extract_measurement_date(m)
        if not d:
            continue
        by_date[d] = m

    body_comp_rows = []
    weight_rows = []
    for d, m in by_date.items():
        kg = m.get("weight")
        body_comp_rows.append({
            "owner": owner,
            "measurement_date": d,
            "kg": kg,
            "bodyfat_pct": m.get("bodyfat"),
            "muscle_pct": m.get("muscle"),
            "water_pct": m.get("water"),
            "bone_kg": m.get("bone"),
            "bmi": m.get("bmi"),
            "bmr": round(m["bmr"]) if m.get("bmr") is not None else None,
            "visceral_fat": m.get("visfat"),
            "raw": m,
        })
        if kg is not None:
            weight_rows.append({"owner": owner, "weight_date": d, "kg": kg})

    print(f"{len(body_comp_rows)} dag(en) met metingen gevonden, opslaan in Supabase...")
    upsert_body_composition(owner, body_comp_rows)
    upsert_weight(owner, weight_rows)

    if weight_rows:
        latest_date = max(r["weight_date"] for r in weight_rows)
        latest_kg = next(r["kg"] for r in weight_rows if r["weight_date"] == latest_date)
        garmin_email = os.environ.get("GARMIN_EMAIL")
        garmin_password = os.environ.get("GARMIN_PASSWORD")
        safe(push_latest_weight_to_garmin, owner, latest_date, latest_kg, garmin_email, garmin_password)

    print("Klaar.")


if __name__ == "__main__":
    main()
