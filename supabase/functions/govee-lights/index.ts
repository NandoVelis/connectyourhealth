import { createClient } from "jsr:@supabase/supabase-js@2";

// Govee-lampen automatisch. Alle tijden Europe/Amsterdam, dus zomer-/wintertijd klopt vanzelf.
//
// WEKKER-LICHT   ma t/m vr 06:30-06:39: lamp gaat in 10 stappen van 1% naar normale helderheid (max 60%) (alleen lampen die uit stonden).
// KLEUR BIJ AAN  automatische aan = gekleurd natuurlijk licht (rgb): <08u diep goudoranje, tot 16u warmgeel-oranje, daarna diep amber (nooit wit).
// AAN (wakker)   zodra de slaap van vandaag in garmin_metrics staat, max 1x per dag (werkdagen alleen vóór 07:53); vóór 07:00 start op 5% en elke 5 min +5% tot max 60%.
//                Daarna 1 minuut kleur-indicatie: groen = rusthartslag < 40 én slaapscore > 75,
//                oranje = één van de twee, rood = geen van beide; daarna terug naar de vorige kleur.
// TV: maandag 20:25-20:30 (Rondo, Ziggo Sport 20:30): 5 min Ziggo-oranje, elke ~10 s fel/minder fel. Ma t/m vr 21:30 (Vandaag Inside, SBS6 21:35):
//     blauw/wit wisselend (SBS-kleuren), ~1 min, daarna terug naar de vorige stand. Alleen lampen die aan staan.
// STOPLICHT      ma t/m vr 07:25 en 13:25 (helderheid 100%, daarna eigen stand terug): vloeiend felgroen (tot :30), lichtgroen -> geel (:31-:40), -> oranje (:50), -> rood (:52); elke 30 s een tint (event stoplight, minuut-cron).
// UIT            ma t/m vr 07:53 en 13:53: eerst 1 min rood knipperen (100%/60%), kleur+helderheid terug, dan uit.
// AAN            ma t/m vr 12:01 en 17:01: helderheid van vóór de uit (handmatig), anders 60%.
// WARM LICHT     dagelijks 20:00: diep amber (rgb 0xff5a00; 2000K als de lamp geen kleur kan) (lampen die aan staan); herstel bij de volgende 'aan'.
// DIMMEN         zo t/m do vanaf 22:30, elke 5 min een stap, relatief aan de huidige helderheid (nooit hoger).
// UIT            zo t/m do 23:00.
// REGEN          overdag 07:00-20:15 (body {"event":"regen"}, elke 10 min): droog nu, regen binnen 30 min (Buienradar) -> 2x blauw pulseren, max 1x per uur.
// APP-MELDING    event "app" + geheime sleutel (secret GOVEE_WEBHOOK_TOKEN): lampen die aan staan 5 s vast felgroen op 100% (bv. WhatsApp via MacroDroid), max 1x per minuut.
// ESPN-DEADLINE  50-65 min voor espn_game.next_deadline: lampen die aan staan knipperen 3x (1x per deadline).
//
// Vereist secret GOVEE_KEY. Optioneel GOVEE_OWNER (default Nando).
// Aangeroepen door pg_cron-jobs, zie supabase/govee_setup.sql.

const TZ = "Europe/Amsterdam";
const BASE = "https://openapi.api.govee.com/router/api/v1";
const OWNER = Deno.env.get("GOVEE_OWNER") ?? "Nando";

function nowAms() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit",
    year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  const hour = parseInt(g("hour")) % 24;
  return {
    date: `${g("year")}-${g("month")}-${g("day")}`,
    weekday: g("weekday"), // Mon, Tue, ...
    hour,
    minute: parseInt(g("minute")),
  };
}

const H = (key: string) => ({ "Govee-API-Key": key, "Content-Type": "application/json" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasCap = (d: any, inst: string) => (d.capabilities ?? []).some((c: any) => c.instance === inst);
const hasBrightness = (d: any) => hasCap(d, "brightness");
const hasTemp = (d: any) => hasCap(d, "colorTemperatureK");
const hasColor = (d: any) => hasCap(d, "colorRgb");
function tempRange(d: any) {
  const c = (d.capabilities ?? []).find((c: any) => c.instance === "colorTemperatureK");
  const r = c?.parameters?.range;
  return { min: r?.min ?? 2000, max: r?.max ?? 9000 };
}

async function listLights(key: string) {
  const res = await fetch(`${BASE}/user/devices`, { headers: H(key) });
  if (!res.ok) throw new Error(`devices ${res.status}`);
  const { data } = await res.json();
  return (data ?? []).filter((d: any) => d.type === "devices.types.light");
}

async function control(key: string, d: any, type: string, instance: string, value: number) {
  const r = await fetch(`${BASE}/device/control`, {
    method: "POST", headers: H(key),
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      payload: { sku: d.sku, device: d.device, capability: { type, instance, value } },
    }),
  });
  return r.ok;
}
const setPower = (k: string, d: any, on: boolean) => control(k, d, "devices.capabilities.on_off", "powerSwitch", on ? 1 : 0);
const setBrightness = (k: string, d: any, v: number) => control(k, d, "devices.capabilities.range", "brightness", Math.max(1, Math.min(100, Math.round(v))));
const setTemp = (k: string, d: any, v: number) => {
  const { min, max } = tempRange(d);
  return control(k, d, "devices.capabilities.color_setting", "colorTemperatureK", Math.max(min, Math.min(max, v)));
};
const setRgb = (k: string, d: any, v: number) => control(k, d, "devices.capabilities.color_setting", "colorRgb", v);

type LampState = { on: boolean | null; brightness: number | null; temp: number | null; rgb: number | null };
async function getState(key: string, d: any): Promise<LampState> {
  const r = await fetch(`${BASE}/device/state`, {
    method: "POST", headers: H(key),
    body: JSON.stringify({ requestId: crypto.randomUUID(), payload: { sku: d.sku, device: d.device } }),
  });
  if (!r.ok) return { on: null, brightness: null, temp: null, rgb: null };
  const j = await r.json();
  const caps = j?.payload?.capabilities ?? [];
  const val = (inst: string) => caps.find((c: any) => c.instance === inst)?.state?.value;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    on: val("powerSwitch") === undefined ? null : val("powerSwitch") === 1,
    brightness: num(val("brightness")),
    temp: num(val("colorTemperatureK")),
    rgb: num(val("colorRgb")),
  };
}

// Zet alle lampen aan of uit. Bij 'aan': helderheid en kleurtemperatuur van vóór dimmen/warm licht terugzetten.
async function setAll(key: string, on: boolean, base: Record<string, number> = {}, colorBase: Record<string, number> = {}, maxBrightness: number | null = null, fallbackBrightness: number | null = null, naturalRgb: number | null = null) {
  const lights = await listLights(key);
  let ok = 0;
  let restored = false;
  let restoredColor = false;
  for (const d of lights) {
    if (await setPower(key, d, on)) ok++;
    await sleep(700);
    if (!on) continue;
    if (hasBrightness(d) && (typeof base[d.device] === "number" || maxBrightness != null || fallbackBrightness != null)) {
      const v = typeof base[d.device] === "number" ? base[d.device] : (fallbackBrightness ?? 100);
      await setBrightness(key, d, Math.min(v, maxBrightness ?? 100));
      if (typeof base[d.device] === "number") restored = true;
      await sleep(700);
    }
    if (naturalRgb != null && (hasColor(d) || hasTemp(d))) { // automatische aan: gekleurd natuurlijk licht i.p.v. wit
      if (hasColor(d)) await setRgb(key, d, naturalRgb); else await setTemp(key, d, 2000);
      restoredColor = true;
      await sleep(700);
    } else if (hasTemp(d) && typeof colorBase[d.device] === "number") {
      await setTemp(key, d, colorBase[d.device]);
      restoredColor = true;
      await sleep(700);
    }
  }
  return { total: lights.length, ok, restored, restoredColor };
}

// Dimt lampen die helderheid ondersteunen en aan staan: nieuwe helderheid = huidige x factor (nooit hoger).
async function dimAll(key: string, factor: number, saveBase: boolean, base: Record<string, number>) {
  const lights = await listLights(key);
  let ok = 0;
  let dimmable = 0;
  const seen: string[] = [];
  const newBase: Record<string, number> = { ...base };
  for (const d of lights) {
    if (!hasBrightness(d)) continue;
    dimmable++;
    const st = await getState(key, d);
    await sleep(700);
    if (!st.on || st.brightness == null) continue;
    if (saveBase || newBase[d.device] == null) newBase[d.device] = st.brightness;
    const target = Math.max(1, Math.round(st.brightness * factor));
    seen.push(`${st.brightness}->${target}`);
    if (target >= st.brightness) continue;
    if (await setBrightness(key, d, target)) ok++;
    await sleep(700);
  }
  return { total: lights.length, dimmable, ok, seen, base: newBase };
}

// Kleur-indicatie: groen/oranje/rood 1 minuut, daarna terug naar de vorige kleur(temperatuur).
function indicatorRgb(score: number | null, rhr: number | null): number | null {
  if (score == null && rhr == null) return null;
  const good = (score != null && score > 75 ? 1 : 0) + (rhr != null && rhr < 40 ? 1 : 0);
  if (good === 2) return 0x00c800; // groen
  if (good === 1) return 0xff8c00; // oranje
  return 0xff0000; // rood
}
async function colorFlash(key: string, rgb: number) {
  const lights = (await listLights(key)).filter(hasColor);
  const prev: LampState[] = [];
  for (const d of lights) {
    const s = await getState(key, d);
    await sleep(700);
    prev.push(s);
    if (s.on) { await setRgb(key, d, rgb); await sleep(700); }
  }
  await sleep(60_000);
  for (let i = 0; i < lights.length; i++) {
    const d = lights[i], s = prev[i];
    if (!s.on) continue;
    if (s.temp && s.temp > 0 && hasTemp(d)) await setTemp(key, d, s.temp);
    else if (s.rgb != null) await setRgb(key, d, s.rgb);
    else await setTemp(key, d, 4000);
    await sleep(700);
  }
}
function background(p: Promise<unknown>) {
  const er = (globalThis as any).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(p.catch(() => {}));
  else p.catch(() => {});
}

// ESPN-deadline: 3x knipperen (helderheid 1% en terug) bij lampen die aan staan.
async function blinkAll(key: string) {
  const lights = (await listLights(key)).filter(hasBrightness);
  let n = 0;
  for (const d of lights) {
    const s = await getState(key, d);
    await sleep(700);
    if (!s.on || s.brightness == null) continue;
    for (let i = 0; i < 3; i++) {
      await setBrightness(key, d, 1); await sleep(900);
      await setBrightness(key, d, s.brightness); await sleep(900);
    }
    n++;
  }
  return n;
}

// TV-effecten (stapsgewijs via de API; max ~10 commando's/min per lamp, dus elke ~10 s een stap).
const WARM_AMBER = 0xff5a00; // diep amber, richting rood
const ZIGGO_ORANJE = 0xff5000;
const SBS_BLAUW = 0x0057b8;
const WIT = 0xffffff;
async function tvEffect(key: string, kind: "rondo" | "vi") {
  const lights = (await listLights(key)).filter(hasColor);
  const prev: LampState[] = [];
  const active: number[] = [];
  for (let i = 0; i < lights.length; i++) {
    const s = await getState(key, lights[i]);
    await sleep(700);
    prev.push(s);
    if (s.on) active.push(i);
  }
  if (!active.length) return 0;
  const stepMs = 10_000;
  const run = async (fn: (d: any) => Promise<unknown>) => {
    const t0 = Date.now();
    for (const i of active) { await fn(lights[i]); await sleep(300); }
    const left = stepMs - (Date.now() - t0);
    if (left > 0) await sleep(left);
  };
  if (kind === "rondo") {
    await run(async (d) => { await setRgb(key, d, ZIGGO_ORANJE); await setBrightness(key, d, 100); });
    for (const b of [85, 70, 55, 40]) await run((d) => setBrightness(key, d, b));
  } else {
    for (const c of [SBS_BLAUW, WIT, SBS_BLAUW, WIT, SBS_BLAUW, WIT]) await run((d) => setRgb(key, d, c));
  }
  for (const i of active) {
    const d = lights[i], s = prev[i];
    if (s.temp && s.temp > 0 && hasTemp(d)) await setTemp(key, d, s.temp);
    else if (s.rgb != null) await setRgb(key, d, s.rgb);
    await sleep(700);
    if (s.brightness != null) { await setBrightness(key, d, s.brightness); await sleep(700); }
  }
  return active.length;
}

// REGEN (Buienradar): kijkt 30 min vooruit voor Groningen (centrum, ca. 53.22 N / 6.57 E).
// Regen begint straks (nu droog, binnen 30 min nat) -> lampen die aan staan pulseren 2x blauw. Max 1x per uur.
const RAIN_URL = "https://gpsgadget.buienradar.nl/data/raintext?lat=53.22&lon=6.57";
const RAIN_BLAUW = 0x1e64ff;
// Waarde 0-255 -> mm/u = 10^((v-109)/32). 100 is ruim 0,5 mm/u: merkbare regen.
const RAIN_MIN = 100;
async function rainSoon(): Promise<{ soon: boolean; minutes: number | null; raw: string }> {
  const res = await fetch(RAIN_URL);
  if (!res.ok) throw new Error(`buienradar ${res.status}`);
  const raw = (await res.text()).trim();
  const vals = raw.split(/\r?\n/).map((l) => parseInt(l.split("|")[0])).filter((n) => !isNaN(n));
  if (vals.length < 7) return { soon: false, minutes: null, raw: raw.slice(0, 80) };
  const dryNow = vals[0] < RAIN_MIN;
  const idx = vals.slice(1, 7).findIndex((v) => v >= RAIN_MIN); // komende 30 min
  return { soon: dryNow && idx >= 0, minutes: idx >= 0 ? (idx + 1) * 5 : null, raw: raw.slice(0, 80) };
}
async function rainPulse(key: string, rgbColor = RAIN_BLAUW, pulses = 2, holdMs = 0) {
  const lights = (await listLights(key)).filter(hasColor);
  const prev: LampState[] = [];
  const active: number[] = [];
  for (let i = 0; i < lights.length; i++) {
    const s = await getState(key, lights[i]);
    await sleep(700);
    prev.push(s);
    if (s.on) active.push(i);
  }
  if (!active.length) return 0;
  for (const i of active) {
    await setRgb(key, lights[i], rgbColor); await sleep(300);
    if (holdMs > 0 && hasBrightness(lights[i])) { await setBrightness(key, lights[i], 100); await sleep(300); }
  }
  await sleep(holdMs > 0 ? holdMs : 2000);
  for (let k = 0; k < pulses; k++) {
    for (const lvl of [100, 20]) {
      for (const i of active) { if (hasBrightness(lights[i])) await setBrightness(key, lights[i], lvl); await sleep(300); }
      await sleep(2200);
    }
  }
  for (const i of active) {
    const d = lights[i], s = prev[i];
    if (s.temp && s.temp > 0 && hasTemp(d)) await setTemp(key, d, s.temp);
    else if (s.rgb != null) await setRgb(key, d, s.rgb);
    await sleep(700);
    if (s.brightness != null && hasBrightness(d)) { await setBrightness(key, d, s.brightness); await sleep(700); }
  }
  return active.length;
}

// Stoplicht-kleurverloop: kleur op minuut m (t.o.v. het hele uur, 25..52), lineair tussen de sleutelpunten.
const STOP_KF: Array<[number, number]> = [
  [25, 0x00ff00], [30, 0x00ff00], // felgroen
  [31, 0x9bff00], [40, 0xffe600], // lichtgroen -> geel
  [50, 0xff8c00],                  // geel -> oranje
  [52, 0xff0000],                  // oranje -> rood
];
function stopColor(m: number): number {
  if (m <= STOP_KF[0][0]) return STOP_KF[0][1];
  for (let i = 1; i < STOP_KF.length; i++) {
    const [m1, c1] = STOP_KF[i], [m0, c0] = STOP_KF[i - 1];
    if (m <= m1) {
      const f = (m - m0) / (m1 - m0);
      const ch = (shift: number) => Math.round(((c0 >> shift) & 255) + ((((c1 >> shift) & 255) - ((c0 >> shift) & 255)) * f));
      return (ch(16) << 16) | (ch(8) << 8) | ch(0);
    }
  }
  return STOP_KF[STOP_KF.length - 1][1];
}

// Helderheid van lampen die aan staan vastleggen (vlak vóór de vaste uit), zodat de volgende 'aan' die stand terugzet.
async function snapshotBrightness(key: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const d of (await listLights(key)).filter(hasBrightness)) {
    const s = await getState(key, d);
    await sleep(700);
    if (s.on && s.brightness != null) out[d.device] = s.brightness;
  }
  return out;
}

// Teruglezen wat de lampen na een automatische aan echt melden (voor de log).
async function readback(key: string): Promise<string> {
  const out: string[] = [];
  for (const d of (await listLights(key)).filter((x) => hasColor(x) || hasBrightness(x))) {
    const s = await getState(key, d);
    await sleep(500);
    out.push(`${s.on ? "aan" : "uit"} b${s.brightness ?? "?"} rgb${s.rgb != null ? "#" + s.rgb.toString(16).padStart(6, "0") : "?"} t${s.temp ?? "?"}`);
  }
  return out.join("; ");
}

// Natuurlijke lichtkleur per tijdstip, gekleurd (geen wit): ochtend diep goudoranje, dag warmgeel-oranje, middag/avond diep amber (verzadigd en warm).
const naturalRgb = (hour: number) => (hour < 8 ? 0xff7f1a : hour < 16 ? 0xffb52e : 0xff8a14);

// Vaste uit (07:53/13:53): 1 minuut rood knipperen (100% / 60% wisselend, ~9 s per stap), kleur en helderheid terugzetten, dan uit.
async function offWithBlink(key: string, sb: any, sp: Record<string, LampState> | null, base: Record<string, number>, done: (msg: string, patch?: Record<string, unknown>) => Promise<void>) {
  const lights = await listLights(key);
  const prev: Record<string, LampState> = {};
  const snap: Record<string, number> = {};
  for (const d of lights) {
    const st2 = await getState(key, d);
    await sleep(700);
    if (!st2.on) continue;
    prev[d.device] = sp?.[d.device] ?? st2; // kleur van vóór het stoplicht, anders de huidige
    const own = sp?.[d.device]?.brightness ?? st2.brightness; // eigen stand van vóór het stoplicht
    if (own != null) snap[d.device] = own;
  }
  if (Object.keys(snap).length) await sb.from("govee_state").update({ brightness_base: { ...base, ...snap } }).eq("id", 1);
  const blinkers = lights.filter((d) => prev[d.device] && hasColor(d));
  for (const d of blinkers) { await setRgb(key, d, 0xff0000); await sleep(300); }
  const levels = [100, 60, 100, 60, 100, 60];
  for (const lvl of levels) {
    const t0 = Date.now();
    for (const d of blinkers) { if (hasBrightness(d)) await setBrightness(key, d, lvl); await sleep(300); }
    const left = 9_000 - (Date.now() - t0);
    if (left > 0) await sleep(left);
  }
  for (const d of blinkers) {
    const p2 = prev[d.device];
    if (p2.temp && p2.temp > 0 && hasTemp(d)) await setTemp(key, d, p2.temp);
    else if (p2.rgb != null) await setRgb(key, d, p2.rgb);
    await sleep(600);
    if (snap[d.device] != null && hasBrightness(d)) { await setBrightness(key, d, snap[d.device]); await sleep(600); }
  }
  const r = await setAll(key, false);
  await done(`uit na rood knipperen ${r.ok}/${r.total}`, { stoplight_prev: null });
}

// Rondo: 5 minuten (20:25-20:29), elke ~10 s wisselen tussen fel en minder fel Ziggo-oranje.
// Verdeeld over 5 aanroepen van 1 minuut (k = 0..4); de oorspronkelijke lampstand staat in govee_state.tv_prev.
async function rondoBlock(key: string, sb: any, k: number, saved: Record<string, LampState> | null, date: string) {
  const lights = (await listLights(key)).filter(hasColor);
  const prev: Record<string, LampState> = saved ?? {};
  if (!saved) {
    for (const d of lights) {
      const s = await getState(key, d);
      await sleep(700);
      if (s.on) prev[d.device] = s;
    }
    await sb.from("govee_state").update({ tv_prev: prev }).eq("id", 1);
  }
  const active = lights.filter((d) => prev[d.device]);
  if (active.length) {
    const stepMs = 9_500;
    for (let j = 0; j < 6; j++) {
      const bright = (k * 6 + j) % 2 === 0;
      const t0 = Date.now();
      for (const d of active) {
        if (j === 0) { await setRgb(key, d, ZIGGO_ORANJE); await sleep(200); }
        await setBrightness(key, d, bright ? 100 : 25);
        await sleep(300);
      }
      const left = stepMs - (Date.now() - t0);
      if (left > 0) await sleep(left);
    }
  }
  if (k === 4) {
    for (const d of active) {
      const s = prev[d.device];
      if (s.temp && s.temp > 0 && hasTemp(d)) await setTemp(key, d, s.temp);
      else if (s.rgb != null) await setRgb(key, d, s.rgb);
      await sleep(700);
      if (s.brightness != null) { await setBrightness(key, d, s.brightness); await sleep(700); }
    }
    await sb.from("govee_state").update({ tv_prev: null, last_tv_rondo_date: date }).eq("id", 1);
  }
  return active.length;
}

Deno.serve(async (req) => {
  const key = Deno.env.get("GOVEE_KEY");
  if (!key) return Response.json({ status: "geen GOVEE_KEY secret gezet" });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: stRow } = await sb.from("govee_state").select("*").eq("id", 1).single();
  const st: any = stRow ?? {};
  const t = nowAms();
  const base: Record<string, number> = (st.brightness_base ?? {}) as Record<string, number>;
  const colorBase: Record<string, number> = (st.color_base ?? {}) as Record<string, number>;
  const normal: Record<string, number> = (st.normal_brightness ?? {}) as Record<string, number>;
  const log = async (patch: Record<string, unknown>, msg: string) => {
    await sb.from("govee_state").update({ ...patch, last_log: `${t.date} ${t.hour}:${String(t.minute).padStart(2, "0")} ${msg}`, updated_at: new Date().toISOString() }).eq("id", 1);
  };
  const clearPatch = (r: { restored: boolean; restoredColor: boolean }) => ({
    ...(r.restored ? { brightness_base: null } : {}),
    ...(r.restoredColor ? { color_base: null } : {}),
  });
  const onDays = ["Mon", "Tue", "Wed", "Thu", "Fri"];

  const url = new URL(req.url);
  let event = url.searchParams.get("event") ?? "";
  let token = req.headers.get("x-token") ?? url.searchParams.get("token") ?? "";
  try {
    const b = await req.json();
    if (b?.event) event = String(b.event);
    if (b?.token) token = String(b.token);
  } catch { /* geen body */ }

  try {
    // EVENT app (bv. WhatsApp via MacroDroid): groen pulseren, alleen met geheime sleutel (GOVEE_WEBHOOK_TOKEN)
    if (event === "app") {
      const secret = Deno.env.get("GOVEE_WEBHOOK_TOKEN");
      if (!secret || token !== secret) return Response.json({ error: "niet toegestaan" }, { status: 401 });
      const mins = t.hour * 60 + t.minute;
      const busy = [
        [20 * 60 + 24, 20 * 60 + 36], [21 * 60 + 29, 21 * 60 + 36], [22 * 60 + 30, 23 * 60 + 5],
        [6 * 60 + 29, 6 * 60 + 41], [7 * 60 + 24, 7 * 60 + 56], [13 * 60 + 24, 13 * 60 + 56],
      ].some(([a, b]) => mins >= a && mins <= b);
      const last = st.last_msg_alert ? new Date(st.last_msg_alert).getTime() : 0;
      if (busy) return Response.json({ action: "app-skip" });
      if (Date.now() - last < 60_000) return Response.json({ action: "app-throttled" });
      await sb.from("govee_state").update({ last_msg_alert: new Date().toISOString() }).eq("id", 1);
      background(rainPulse(key, 0x00ff00, 0, 5000).then((n) => log({}, `app-pulse groen ${n} lampen`)));
      return Response.json({ action: "app" });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }

  try {
    // EVENT stoplight: ma t/m vr 07:25-07:52 en 13:25-13:52: vloeiend groen -> lichtgroen -> geel -> oranje -> rood (elke 30 s een tint).
    // De uit van :53 knippert rood en zet daarna de oorspronkelijke kleur terug.
    if (event === "stoplight" && onDays.includes(t.weekday) && (t.hour === 7 || t.hour === 13) && t.minute >= 25 && t.minute <= 52) {
      const mark = `${t.date}:${t.hour}:${t.minute}`;
      if (st.stoplight_step === mark) return Response.json({ action: "stoplight-skip" });
      const lights = (await listLights(key)).filter(hasColor);
      let prev: Record<string, LampState> | null = st.stoplight_prev && typeof st.stoplight_prev === "object" ? (st.stoplight_prev as Record<string, LampState>) : null;
      const startRun = !prev; // eerste aanroep van deze reeks: eigen stand vastleggen en helderheid op 100%
      if (!prev) {
        prev = {};
        for (const d of lights) { const s2 = await getState(key, d); await sleep(700); if (s2.on) prev[d.device] = s2; }
      }
      const apply = async (m: number, withBrightness = false) => {
        let n = 0;
        for (const d of lights) {
          if (!prev![d.device]) continue;
          if (withBrightness && hasBrightness(d)) { await setBrightness(key, d, 100); await sleep(300); }
          if (await setRgb(key, d, stopColor(m))) n++;
          await sleep(400);
        }
        return n;
      };
      await log({ stoplight_step: mark, stoplight_prev: prev }, `stoplicht #${stopColor(t.minute).toString(16).padStart(6, "0")}`);
      const n = await apply(t.minute, startRun);
      if (t.minute < 52) background((async () => { await sleep(30_000); await apply(t.minute + 0.5); })());
      return Response.json({ action: "stoplight", minute: t.minute, lamps: n });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }

  try {
    // EVENT regen: alleen overdag (07:00-20:15) en niet rond de vaste knipper/uit-momenten
    if (event === "regen") {
      const mins = t.hour * 60 + t.minute;
      const inWindow = mins >= 7 * 60 && mins <= 20 * 60 + 15;
      const clash = onDays.includes(t.weekday) && [[7 * 60 + 24, 7 * 60 + 56], [13 * 60 + 24, 13 * 60 + 56]].some(([a, b]) => mins >= a && mins <= b);
      if (!inWindow || clash) return Response.json({ action: "regen-skip" });
      const last = st.last_rain_alert ? new Date(st.last_rain_alert).getTime() : 0;
      if (Date.now() - last < 60 * 60_000) return Response.json({ action: "regen-throttled" });
      const r = await rainSoon();
      if (!r.soon) return Response.json({ action: "regen-none", sample: r.raw });
      await sb.from("govee_state").update({ last_rain_alert: new Date().toISOString() }).eq("id", 1);
      await log({}, `regen over ~${r.minutes} min, pulse gestart`);
      background(rainPulse(key).then(async (n) => {
        if (!n) await sb.from("govee_state").update({ last_rain_alert: null }).eq("id", 1); // lampen uit: niet verbruiken
        await log({}, `regen-pulse ${n} lampen`);
      }));
      return Response.json({ action: "regen", minutes: r.minutes });
    }

    // ESPN-DEADLINE: 50-65 min ervoor, 1x per deadline
    const { data: game } = await sb.from("espn_game").select("next_deadline").eq("id", 1).maybeSingle();
    if (game?.next_deadline) {
      const ms = new Date(game.next_deadline).getTime() - Date.now();
      if (ms > 50 * 60_000 && ms <= 65 * 60_000 && st.last_espn_alert !== game.next_deadline) {
        await log({ last_espn_alert: game.next_deadline }, "espn-deadline knipperen gestart");
        const n = await blinkAll(key);
        await log({}, `espn-deadline geknipperd ${n} lampen`);
        return Response.json({ action: "espn-blink", lamps: n });
      }
    }

    // TV: Rondo (maandag 20:25-20:27) en Vandaag Inside (ma t/m vr 21:30-21:32), 1x per dag, op de achtergrond
    if (event === "rondo" && t.weekday === "Mon" && t.hour === 20 && t.minute >= 25 && t.minute <= 29 && st.last_tv_rondo_date !== t.date) {
      const k = t.minute - 25;
      const mark = `${t.date}:${k}`;
      if (st.last_tv_step === mark) return Response.json({ action: "tv-rondo-skip" });
      await log({ last_tv_step: mark }, `tv rondo blok ${k + 1}/5`);
      const saved = k > 0 && st.tv_prev ? (st.tv_prev as Record<string, LampState>) : null;
      background(rondoBlock(key, sb, k, saved, t.date));
      return Response.json({ action: "tv-rondo", block: k + 1 });
    }
    if (onDays.includes(t.weekday) && t.hour === 21 && t.minute >= 30 && t.minute <= 32 && st.last_tv_vi_date !== t.date) {
      await log({ last_tv_vi_date: t.date }, "tv vandaag inside gestart");
      background(tvEffect(key, "vi"));
      return Response.json({ action: "tv-vi" });
    }

    // OCHTEND-RAMP: na de ochtend-aan elke 5 min +5% helderheid, tot 60%, stopt om 07:00
    if (t.hour >= 4 && t.hour < 7 && typeof st.wake_ramp === "string" && st.wake_ramp.startsWith(t.date + "|")) {
      const [, lv, at] = st.wake_ramp.split("|");
      const level = parseInt(lv), nowMin = t.hour * 60 + t.minute;
      if (level < 60 && nowMin - parseInt(at) >= 4) {
        const next = Math.min(60, level + 5);
        const lights = (await listLights(key)).filter(hasBrightness);
        let n = 0;
        for (const d of lights) {
          const s = await getState(key, d);
          await sleep(700);
          if (!s.on || s.brightness == null || s.brightness > level + 2) continue; // uit of door jou zelf aangepast: met rust laten
          if (await setBrightness(key, d, Math.min(next, normal[d.device] ?? 100))) n++;
          await sleep(700);
        }
        await log({ wake_ramp: `${t.date}|${next}|${nowMin}` }, `ochtend-ramp ${next}% (${n} lampen)`);
        return Response.json({ action: "wake-ramp", level: next, lamps: n });
      }
    }

    // WEKKER-LICHT: ma t/m vr 06:30-06:39, in 10 stappen naar de normale helderheid
    if (onDays.includes(t.weekday) && t.hour === 6 && t.minute >= 30 && t.minute < 40) {
      const k = t.minute - 30;
      const mark = `${t.date}:${k}`;
      if (st.last_wake_step !== mark) {
        const lights = await listLights(key);
        const wd: string[] = k === 0 ? [] : ((st.wake_devices ?? []) as string[]);
        let n = 0;
        for (const d of lights) {
          if (!hasBrightness(d)) continue;
          if (k === 0) {
            const s = await getState(key, d);
            await sleep(700);
            if (s.on) continue; // staat al aan: met rust laten
            wd.push(d.device);
          } else if (!wd.includes(d.device)) continue;
          const target = Math.min(60, normal[d.device] ?? 70); // nooit fellers dan 60%
          const pct = Math.max(1, Math.round(target * (k + 1) / 10));
          if (k === 0) {
            await setBrightness(key, d, pct); await sleep(700);
            await setPower(key, d, true); await sleep(700);
            if (hasColor(d)) { await setRgb(key, d, naturalRgb(t.hour)); await sleep(700); }
          }
          if (await setBrightness(key, d, pct)) n++;
          await sleep(700);
        }
        await log({ last_wake_step: mark, wake_devices: wd }, `wekker-licht stap ${k + 1}/10 (${n} lampen)`);
        return Response.json({ action: "wake-light", step: k + 1, lamps: n });
      }
    }

    // DIMMEN: zo t/m do, 22:30-22:59 in stappen van 5 min (relatief aan de huidige helderheid)
    const dimDays = ["Sun", "Mon", "Tue", "Wed", "Thu"];
    if (t.hour === 22 && t.minute >= 30 && dimDays.includes(t.weekday)) {
      const factors = [0.8, 0.75, 0.75, 0.67, 0.67, 0.5];
      const idx = Math.min(factors.length - 1, Math.floor((t.minute - 30) / 5));
      const mark = `${t.date}:${idx}`;
      if (st.last_dim !== mark) {
        const r = await dimAll(key, factors[idx], idx === 0, base);
        const patch: Record<string, unknown> = { last_dim: mark, brightness_base: r.base };
        if (idx === 0) patch.normal_brightness = { ...normal, ...r.base }; // 'normale' helderheid voor het wekker-licht
        await log(patch, `dim x${factors[idx]} ${r.ok}/${r.dimmable} [${r.seen.join(", ")}]`);
        return Response.json({ action: `dim-${idx}`, ...r });
      }
    }

    // UIT: zo t/m do, 23:00-23:14
    if (t.hour === 23 && t.minute < 15 && dimDays.includes(t.weekday) && st.last_off_date !== t.date) {
      const r = await setAll(key, false);
      if (r.ok > 0) await log({ last_off_date: t.date }, `uit ${r.ok}/${r.total}`);
      return Response.json({ action: "off", ...r });
    }

    // WARM LICHT: dagelijks 20:00-20:14, alleen lampen die aan staan. Diep amber (rgb) als de lamp kleur kan, anders 2000K.
    if (t.hour === 20 && t.minute < 15 && st.last_warm_date !== t.date) {
      const lights = await listLights(key);
      const cb: Record<string, number> = { ...colorBase };
      let n = 0;
      for (const d of lights) {
        if (!hasTemp(d) && !hasColor(d)) continue;
        const s = await getState(key, d);
        await sleep(700);
        if (!s.on) continue;
        if (s.temp && s.temp > 2000) cb[d.device] = s.temp; // oorspronkelijke wit-stand onthouden (niet de eigen amber-stand)
        const ok = hasColor(d) ? await setRgb(key, d, WARM_AMBER) : await setTemp(key, d, 2000);
        if (ok) n++;
        await sleep(700);
      }
      await log({ last_warm_date: t.date, color_base: cb }, `warm licht amber ${n} lampen`);
      return Response.json({ action: "warm", lamps: n });
    }

    // UIT op vaste tijden: ma t/m vr 07:53 en 13:53
    const timedOff = [
      { hour: 7, col: "last_off_0753_date" },
      { hour: 13, col: "last_off_1353_date" },
    ];
    for (const s of timedOff) {
      if (t.hour === s.hour && t.minute >= 53 && onDays.includes(t.weekday) && st[s.col] !== t.date) {
        await log({ [s.col]: t.date }, `uit ${s.hour}:53 gestart (rood knipperen)`);
        const sp = st.stoplight_prev && typeof st.stoplight_prev === "object" ? (st.stoplight_prev as Record<string, LampState>) : null;
        background(offWithBlink(key, sb, sp, base, (msg, patch) => log(patch ?? {}, msg)));
        return Response.json({ action: `off-${s.hour}53-blink` });
      }
    }

    // AAN op vaste tijden: ma t/m vr 12:01 en 17:01
    const timedOn = [
      { hour: 12, col: "last_on_1201_date" },
      { hour: 17, col: "last_on_1701_date" },
    ];
    for (const s of timedOn) {
      if (t.hour === s.hour && t.minute >= 1 && t.minute < 15 && onDays.includes(t.weekday) && st[s.col] !== t.date) {
        const r = await setAll(key, true, base, colorBase, null, 60, naturalRgb(t.hour)); // vorige handmatige helderheid, anders 60%; natuurlijke kleur
        if (r.ok > 0) { const rb = await readback(key); await log({ [s.col]: t.date, ...clearPatch(r) }, `aan ${s.hour}:01 ${r.ok}/${r.total} [${rb}]`); }
        return Response.json({ action: `on-${s.hour}01`, ...r });
      }
    }

    // AAN (wakker): tussen 04:00 en 12:00, slaap van vandaag staat erin.
    // Op werkdagen alleen vóór 07:53, anders gaan de lampen na de vaste 'uit' weer aan.
    const beforeLeave = !onDays.includes(t.weekday) || t.hour < 7 || (t.hour === 7 && t.minute < 53);
    if (t.hour >= 4 && t.hour < 12 && beforeLeave && st.last_on_date !== t.date) {
      const { data: row } = await sb.from("garmin_metrics").select("sleep_minutes, sleep_score, resting_hr")
        .eq("owner", OWNER).eq("metric_date", t.date).maybeSingle();
      if (row && Number(row.sleep_minutes) > 0) {
        const ramp = t.hour < 7; // vóór 07:00: zacht beginnen op 5% en per 5 min 5% omhoog
        const r = await setAll(key, true, base, colorBase, ramp ? 5 : 60, null, naturalRgb(t.hour)); // ochtend-aan nooit boven 60%
        if (r.ok > 0) {
          const patch: Record<string, unknown> = { last_on_date: t.date, ...clearPatch(r) };
          if (ramp) patch.wake_ramp = `${t.date}|5|${t.hour * 60 + t.minute}`;
          const rgb = indicatorRgb(
            row.sleep_score != null ? Number(row.sleep_score) : null,
            row.resting_hr != null ? Number(row.resting_hr) : null,
          );
          let msg = `aan ${r.ok}/${r.total} [${await readback(key)}]`;
          if (rgb != null && st.last_color_date !== t.date) {
            patch.last_color_date = t.date;
            msg += ` + kleur #${rgb.toString(16).padStart(6, "0")} (score ${row.sleep_score}, rhr ${row.resting_hr})`;
            background(colorFlash(key, rgb));
          }
          await log(patch, msg);
        }
        return Response.json({ action: "on", ...r });
      }
    }
    return Response.json({ action: "none" });
  } catch (e) {
    await log({}, `fout: ${(e as Error).message}`);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
