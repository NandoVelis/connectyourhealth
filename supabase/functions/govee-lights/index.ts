import { createClient } from "jsr:@supabase/supabase-js@2";

// Govee-lampen automatisch aan/uit.
// AAN: zodra de slaap van vandaag in garmin_metrics staat (= wakker + horloge gesynct), max 1x per dag.
// AAN op vaste tijden: ma t/m vr om 12:01 en 17:01 Europe/Amsterdam (venster :01-:14), max 1x per tijdstip per dag.
// UIT op vaste tijden: ma t/m vr om 07:53 en 13:53 Europe/Amsterdam (venster :53-:59), max 1x per tijdstip per dag.
// DIMMEN: zo t/m do vanaf 22:30, elke 5 min een stap, relatief aan de huidige helderheid (nooit hoger), alleen lampen die aan staan.
// Helderheid van vóór het dimmen wordt onthouden (govee_state.brightness_base) en bij de volgende 'aan' hersteld.
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

async function getState(key: string, d: any): Promise<{ on: boolean | null; brightness: number | null }> {
  const r = await fetch(`${BASE}/device/state`, {
    method: "POST", headers: H(key),
    body: JSON.stringify({ requestId: crypto.randomUUID(), payload: { sku: d.sku, device: d.device } }),
  });
  if (!r.ok) return { on: null, brightness: null };
  const j = await r.json();
  const caps = j?.payload?.capabilities ?? [];
  const pw = caps.find((c: any) => c.instance === "powerSwitch");
  const br = caps.find((c: any) => c.instance === "brightness");
  return {
    on: pw ? pw.state?.value === 1 : null,
    brightness: typeof br?.state?.value === "number" ? br.state.value : null,
  };
}

// Zet alle lampen aan of uit. Bij 'aan' wordt de helderheid van vóór het dimmen (base) teruggezet.
async function setAll(key: string, on: boolean, base: Record<string, number> = {}) {
  const lights = await listLights(key);
  let ok = 0;
  let restored = false;
  for (const d of lights) {
    if (await control(key, d, "devices.capabilities.on_off", "powerSwitch", on ? 1 : 0)) ok++;
    await sleep(700);
    if (on && hasBrightness(d) && typeof base[d.device] === "number") {
      await control(key, d, "devices.capabilities.range", "brightness", base[d.device]);
      restored = true;
      await sleep(700);
    }
  }
  return { total: lights.length, ok, restored };
}

// Dimt lampen die helderheid ondersteunen en aan staan: nieuwe helderheid = huidige x factor (nooit hoger dan nu).
// saveBase: onthoud de huidige helderheid als 'normale' helderheid (om bij 'aan' te herstellen).
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
    if (await control(key, d, "devices.capabilities.range", "brightness", target)) ok++;
    await sleep(700);
  }
  return { total: lights.length, dimmable, ok, seen, base: newBase };
}

Deno.serve(async () => {
  const key = Deno.env.get("GOVEE_KEY");
  if (!key) return Response.json({ status: "geen GOVEE_KEY secret gezet" });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: st } = await sb.from("govee_state").select("*").eq("id", 1).single();
  const t = nowAms();
  const base: Record<string, number> = ((st as any)?.brightness_base ?? {}) as Record<string, number>;
  const log = async (patch: Record<string, unknown>, msg: string) => {
    await sb.from("govee_state").update({ ...patch, last_log: `${t.date} ${t.hour}:${String(t.minute).padStart(2, "0")} ${msg}`, updated_at: new Date().toISOString() }).eq("id", 1);
  };

  try {
    // DIMMEN: zo t/m do, 22:30-22:59 in stappen van 5 min (relatief aan de huidige helderheid)
    const dimDays = ["Sun", "Mon", "Tue", "Wed", "Thu"];
    if (t.hour === 22 && t.minute >= 30 && dimDays.includes(t.weekday)) {
      const factors = [0.8, 0.75, 0.75, 0.67, 0.67, 0.5];
      const idx = Math.min(factors.length - 1, Math.floor((t.minute - 30) / 5));
      const mark = `${t.date}:${idx}`;
      if ((st as any)?.last_dim !== mark) {
        const r = await dimAll(key, factors[idx], idx === 0, base);
        await log({ last_dim: mark, brightness_base: r.base }, `dim x${factors[idx]} ${r.ok}/${r.dimmable} [${r.seen.join(", ")}]`);
        return Response.json({ action: `dim-${idx}`, ...r });
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
        const r = await setAll(key, true, base);
        if (r.ok > 0) await log({ [s.col]: t.date, ...(r.restored ? { brightness_base: null } : {}) }, `aan ${s.hour}:01 ${r.ok}/${r.total}`);
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
        const r = await setAll(key, true, base);
        if (r.ok > 0) await log({ last_on_date: t.date, ...(r.restored ? { brightness_base: null } : {}) }, `aan ${r.ok}/${r.total}`);
        return Response.json({ action: "on", ...r });
      }
    }
    return Response.json({ action: "none" });
  } catch (e) {
    await log({}, `fout: ${(e as Error).message}`);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
});
