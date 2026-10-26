import { createClient } from "jsr:@supabase/supabase-js@2";

// Govee-lampen automatisch aan/uit.
// AAN: zodra de slaap van vandaag in garmin_metrics staat (= wakker + horloge gesynct), max 1x per dag.
// AAN op vaste tijden: ma t/m vr om 12:01 en 17:01 Europe/Amsterdam (venster :01-:14), max 1x per tijdstip per dag.
// UIT op vaste tijden: ma t/m vr om 07:53 en 13:53 Europe/Amsterdam (venster :53-:59), max 1x per tijdstip per dag.
// DIMMEN: zo t/m do vanaf 22:30, elke 5 min een stap (80,60,45,30,20,10%), alleen lampen die aan staan.
// UIT: zondag t/m donderdag om 23:00 Europe/Amsterdam (venster 23:00-23:14), max 1x per dag.
// Alle tijden via Europe/Amsterdam, dus zomer-/wintertijd klopt vanzelf.
// Vereist secret GOVEE_KEY (via GitHub-secret + deploy-workflow). Optioneel: GOVEE_OWNER (default Nando).
// Aangeroepen door pg_cron-job 'govee-lights-5min' (zie supabase/govee_setup.sql).

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
const hasBrightness = (d: any) => (d.capabilities ?? []).some((c: any) => c.instance === "brightness");

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

async function isOn(key: string, d: any): Promise<boolean | null> {
  const r = await fetch(`${BASE}/device/state`, {
    method: "POST", headers: H(key),
    body: JSON.stringify({ requestId: crypto.randomUUID(), payload: { sku: d.sku, device: d.device } }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const cap = (j?.payload?.capabilities ?? []).find((c: any) => c.instance === "powerSwitch");
  return cap ? cap.state?.value === 1 : null;
}

// Zet alle lampen aan of uit. Bij 'aan' ook helderheid terug naar 100% (na het dimmen 's avonds).
async function setAll(key: string, on: boolean) {
  const lights = await listLights(key);
  let ok = 0;
  for (const d of lights) {
    if (await control(key, d, "devices.capabilities.on_off", "powerSwitch", on ? 1 : 0)) ok++;
    await sleep(700);
    if (on && hasBrightness(d)) {
      await control(key, d, "devices.capabilities.range", "brightness", 100);
      await sleep(700);
    }
  }
  return { total: lights.length, ok };
}

// Dimt alleen lampen die helderheid ondersteunen en op dit moment aan staan.
async function dimAll(key: string, pct: number) {
  const lights = await listLights(key);
  let ok = 0;
  let dimmable = 0;
  for (const d of lights) {
    if (!hasBrightness(d)) continue;
    dimmable++;
    if ((await isOn(key, d)) !== true) { await sleep(700); continue; }
    if (await control(key, d, "devices.capabilities.range", "brightness", pct)) ok++;
    await sleep(700);
  }
  return { total: lights.length, dimmable, ok };
}

Deno.serve(async () => {
  const key = Deno.env.get("GOVEE_KEY");
  if (!key) return Response.json({ status: "geen GOVEE_KEY secret gezet" });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: st } = await sb.from("govee_state").select("*").eq("id", 1).single();
  const t = nowAms();
  const log = async (patch: Record<string, unknown>, msg: string) => {
    await sb.from("govee_state").update({ ...patch, last_log: `${t.date} ${t.hour}:${String(t.minute).padStart(2, "0")} ${msg}`, updated_at: new Date().toISOString() }).eq("id", 1);
  };

  try {
    // DIMMEN: zo t/m do, 22:30-22:59 in stappen van 5 min
    const dimDays = ["Sun", "Mon", "Tue", "Wed", "Thu"];
    if (t.hour === 22 && t.minute >= 30 && dimDays.includes(t.weekday)) {
      const steps = [80, 60, 45, 30, 20, 10];
      const idx = Math.min(steps.length - 1, Math.floor((t.minute - 30) / 5));
      const mark = `${t.date}:${idx}`;
      if ((st as any)?.last_dim !== mark) {
        const r = await dimAll(key, steps[idx]);
        await log({ last_dim: mark }, `dim ${steps[idx]}% ${r.ok}/${r.dimmable}`);
        return Response.json({ action: `dim-${steps[idx]}`, ...r });
      }
    }

    // UIT: zo t/m do, 23:00-23:14
    const offDays = ["Sun", "Mon", "Tue", "Wed", "Thu"];
    if (t.hour === 23 && t.minute < 15 && offDays.includes(t.weekday) && st?.last_off_date !== t.date) {
      const r = await setAll(key, false);
      if (r.ok > 0) await log({ last_off_date: t.date }, `uit ${r.ok}/${r.total}`);
      return Response.json({ action: "off", ...r });
    }

    // UIT op vaste tijden: ma t/m vr 07:53 en 13:53
    const onDays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
    const timedOff = [
      { hour: 7, col: "last_off_0753_date" },
      { hour: 13, col: "last_off_1353_date" },
    ];
    for (const s of timedOff) {
      if (t.hour === s.hour && t.minute >= 53 && onDays.includes(t.weekday) && (st as any)?.[s.col] !== t.date) {
        const r = await setAll(key, false);
        if (r.ok > 0) await log({ [s.col]: t.date }, `uit ${s.hour}:53 ${r.ok}/${r.total}`);
        return Response.json({ action: `off-${s.hour}53`, ...r });
      }
    }

    // AAN op vaste tijden: ma t/m vr 12:01 en 17:01
    const timedOn = [
      { hour: 12, col: "last_on_1201_date" },
      { hour: 17, col: "last_on_1701_date" },
    ];
    for (const s of timedOn) {
      if (t.hour === s.hour && t.minute >= 1 && t.minute < 15 && onDays.includes(t.weekday) && (st as any)?.[s.col] !== t.date) {
        const r = await setAll(key, true);
        if (r.ok > 0) await log({ [s.col]: t.date }, `aan ${s.hour}:01 ${r.ok}/${r.total}`);
        return Response.json({ action: `on-${s.hour}01`, ...r });
      }
    }

    // AAN: tussen 04:00 en 12:00, slaap van vandaag staat erin.
    // Op werkdagen alleen vóór 07:53, anders gaan de lampen na de vaste 'uit' weer aan.
    const beforeLeave = !onDays.includes(t.weekday) || t.hour < 7 || (t.hour === 7 && t.minute < 53);
    if (t.hour >= 4 && t.hour < 12 && beforeLeave && st?.last_on_date !== t.date) {
      const { data: row } = await sb.from("garmin_metrics").select("sleep_minutes")
        .eq("owner", OWNER).eq("metric_date", t.date).maybeSingle();
      if (row && Number(row.sleep_minutes) > 0) {
        const r = await setAll(key, true);
        if (r.ok > 0) await log({ last_on_date: t.date }, `aan ${r.ok}/${r.total}`);
        return Response.json({ action: "on", ...r });
      }
    }
    return Response.json({ action: "none" });
  } catch (e) {
    await log({}, `fout: ${(e as Error).message}`);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
