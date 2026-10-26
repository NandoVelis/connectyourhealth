import { createClient } from "jsr:@supabase/supabase-js@2";

// Govee-lampen automatisch aan/uit.
// AAN: zodra de slaap van vandaag in garmin_metrics staat (= wakker + horloge gesynct), max 1x per dag.
// AAN op vaste tijden: ma t/m vr om 12:01 en 17:01 Europe/Amsterdam (venster :01-:14), max 1x per tijdstip per dag.
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

async function setAll(key: string, on: boolean) {
  const h = { "Govee-API-Key": key, "Content-Type": "application/json" };
  const res = await fetch(`${BASE}/user/devices`, { headers: h });
  if (!res.ok) throw new Error(`devices ${res.status}`);
  const { data } = await res.json();
  const lights = (data ?? []).filter((d: any) => d.type === "devices.types.light");
  let ok = 0;
  for (const d of lights) {
    const r = await fetch(`${BASE}/device/control`, {
      method: "POST", headers: h,
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        payload: {
          sku: d.sku, device: d.device,
          capability: { type: "devices.capabilities.on_off", instance: "powerSwitch", value: on ? 1 : 0 },
        },
      }),
    });
    if (r.ok) ok++;
    await new Promise((res) => setTimeout(res, 700));
  }
  return { total: lights.length, ok };
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
    // UIT: zo t/m do, 23:00-23:14
    const offDays = ["Sun", "Mon", "Tue", "Wed", "Thu"];
    if (t.hour === 23 && t.minute < 15 && offDays.includes(t.weekday) && st?.last_off_date !== t.date) {
      const r = await setAll(key, false);
      if (r.ok > 0) await log({ last_off_date: t.date }, `uit ${r.ok}/${r.total}`);
      return Response.json({ action: "off", ...r });
    }

    // AAN op vaste tijden: ma t/m vr 12:01 en 17:01
    const onDays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
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

    // AAN: tussen 04:00 en 12:00, slaap van vandaag staat erin
    if (t.hour >= 4 && t.hour < 12 && st?.last_on_date !== t.date) {
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
