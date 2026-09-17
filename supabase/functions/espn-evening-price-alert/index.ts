// Dagelijkse avond-pushmelding met de prijsverwachting voor de nacht --
// draait via pg_cron om 21:45 UTC, dus ná het dagelijkse piekvenster van
// transferactiviteit (14:00-21:00 UTC, ontdekt via analyse van de 15-min-
// snapshots) en vlak vóór de nachtelijke prijsronde (~02:30-02:45 UTC). Op
// dat moment is het grootste deel van de dagelijkse opbouw al binnen, dus
// is dit de meest betrouwbare voorspelling van de dag -- en als pushmelding
// i.p.v. alleen data in de app, zodat 'm niet mist wie voor 22u slaapt.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GLOBAL_WATCH_EMAIL = "nandovelis@gmail.com";
const MY_TEAMS_EMAILS = ["nandovelis@gmail.com", "duncanvelis@ziggo.nl"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function sbHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function sbGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return await r.json();
}

async function sendPush(alertEmail: string, title: string, body: string, url = "/overig") {
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!vapidPublic || !vapidPrivate) return;
  const webpush = await import("npm:web-push@3.6.7");
  webpush.default.setVapidDetails(
    Deno.env.get("VAPID_SUBJECT") || "mailto:nandovelis@gmail.com",
    vapidPublic,
    vapidPrivate,
  );
  try {
    const subs: any[] = await sbGet(
      `espn_push_subscriptions?select=endpoint,p256dh,auth&alert_email=eq.${encodeURIComponent(alertEmail)}`,
    );
    for (const s of subs) {
      try {
        await webpush.default.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title, body, url }),
        );
      } catch { /* best-effort, opruimen gebeurt al in espn-fantasy-sync */ }
    }
  } catch (e) {
    console.warn(`Push-lookup (${alertEmail}) mislukt: ${String(e)}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const board: any[] = await sbGet(
      "espn_price_board?select=web_name,team_short,now_cost,verwachting&verwachting=neq.stabiel&verwachting=neq.onbekend",
    );
    if (!board.length) {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: "Geen dreigende wijzigingen" }), {
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const stijgers = board.filter((b) => b.verwachting === "stijgt");
    const dalers = board.filter((b) => b.verwachting === "daalt");
    const bijnaStijgers = board.filter((b) => b.verwachting === "stijgt bijna");
    const bijnaDalers = board.filter((b) => b.verwachting === "daalt bijna");

    const title = `Vanavond: ${stijgers.length} stijger(s), ${dalers.length} daler(s) verwacht`;
    const bodyLines: string[] = [];
    if (stijgers.length) bodyLines.push(`Stijgt: ${stijgers.map((p) => p.web_name).join(", ")}`);
    if (dalers.length) bodyLines.push(`Daalt: ${dalers.map((p) => p.web_name).join(", ")}`);
    if (bijnaStijgers.length || bijnaDalers.length) {
      bodyLines.push(`Bijna (${bijnaStijgers.length + bijnaDalers.length}x): mogelijk, minder zeker`);
    }
    const body = bodyLines.join(" | ") || "Bekijk het overzicht in de app.";

    const allEmails = new Set<string>([GLOBAL_WATCH_EMAIL, ...MY_TEAMS_EMAILS]);
    for (const email of allEmails) {
      await sendPush(email, title, body.slice(0, 300));
    }

    return new Response(
      JSON.stringify({
        ok: true,
        stijgers: stijgers.length,
        dalers: dalers.length,
        bijna_stijgers: bijnaStijgers.length,
        bijna_dalers: bijnaDalers.length,
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 900);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
