// Ochtendoverzicht -- draait elke ochtend om 06:00 lokale tijd (via
// pg_cron, zie migratie create_morning_digest_table_and_cron), ruim na de
// nachtelijke 04:45-prijsbatch. Berekent:
//  - welke spelers vannacht daadwerkelijk van prijs zijn veranderd
//  - de grootste stijgers/dalers van de afgelopen 24u in procenten
//    (gebaseerd op dezelfde prijswijzigingen, dus meestal een deelverzameling
//    van de vorige lijst -- maar hier gesorteerd op %-verandering i.p.v.
//    tijdstip, en met meerdere wijzigingen per speler binnen 24u samengevoegd
//    tot één netto %-verandering)
//  - spelers die een prijswijziging naderen vóór de eerstvolgende deadline
//    (uit espn_price_board, verwachting + voortgang)
// Slaat het resultaat op in espn_morning_digest (overig.html toont 'm als
// popup, zelfde patroon als de andere periodieke overzichten) en stuurt een
// korte pushmelding als aankondiging.

const MY_TEAMS = [
  { entryId: 28264, alertEmails: ["nandovelis@gmail.com"] },
  { entryId: 2640, alertEmails: ["duncanvelis@ziggo.nl", "nandovelis@gmail.com"] },
];
const GLOBAL_WATCH_EMAIL = "nandovelis@gmail.com";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

const RETRYABLE_STATUS = new Set([502, 503, 504]);
async function fetchWithRetry(url: string, init: RequestInit, retries = 2, delayMs = 800) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, init);
    if (r.ok || attempt >= retries || !RETRYABLE_STATUS.has(r.status)) return r;
    await new Promise((res) => setTimeout(res, delayMs * (attempt + 1)));
  }
}

async function sbGet(path: string) {
  const r = await fetchWithRetry(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return await r.json();
}

async function sbPost(path: string, rows: unknown[], prefer = "return=minimal") {
  if (!rows.length) return;
  const r = await fetchWithRetry(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: sbHeaders({ Prefer: prefer }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status} ${await r.text()}`);
}

let vapidReady = false;
async function sendPush(alertEmail: string, title: string, body: string, url = "/overig") {
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!vapidPublic || !vapidPrivate) return;
  if (!vapidReady) {
    const webpush = await import("npm:web-push@3.6.7");
    webpush.default.setVapidDetails(
      Deno.env.get("VAPID_SUBJECT") || "mailto:nandovelis@gmail.com",
      vapidPublic,
      vapidPrivate,
    );
    (globalThis as any).__webpush = webpush.default;
    vapidReady = true;
  }
  const webpush = (globalThis as any).__webpush;
  try {
    const subs: any[] = await sbGet(
      `espn_push_subscriptions?select=endpoint,p256dh,auth&alert_email=eq.${encodeURIComponent(alertEmail)}`,
    );
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title, body, url }),
        );
      } catch { /* best-effort, geen cleanup nodig -- gebeurt al in de hoofd-sync */ }
    }
  } catch { /* best-effort */ }
}

const slim = (p: any, extra: Record<string, any>) => ({
  id: p.id,
  web_name: p.web_name,
  team_short: p.team_short,
  now_cost: p.now_cost,
  ...extra,
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const game = (await sbGet("espn_game?id=eq.1&select=current_event,next_event,next_deadline")) as any[];
    const nextDeadline: string | null = game[0]?.next_deadline ?? null;

    const players: any[] = await sbGet("espn_players?select=id,web_name,team_short,now_cost");
    const playersById = new Map(players.map((p) => [p.id, p]));

    // ---- VANNACHT GEWIJZIGD ----
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rawEvents: any[] = await sbGet(
      `espn_price_events?select=player_id,old_cost,new_cost,direction,detected_at` +
        `&detected_at=gte.${encodeURIComponent(since)}&order=detected_at.asc&limit=500`,
    );
    const changesLastNight = rawEvents
      .map((e) => {
        const pl = playersById.get(e.player_id);
        if (!pl) return null;
        return slim(pl, {
          old_cost: e.old_cost,
          new_cost: e.new_cost,
          direction: e.direction,
          detected_at: e.detected_at,
        });
      })
      .filter((r): r is NonNullable<typeof r> => !!r);

    // ---- GROOTSTE STIJGERS/DALERS AFGELOPEN 24U (IN %) ----
    // Meerdere wijzigingen van dezelfde speler binnen 24u samengevoegd tot
    // één netto %-verandering (eerste old_cost -> laatste new_cost, events
    // hierboven al oplopend gesorteerd op tijd).
    const netByPlayer = new Map<number, { old_cost: number; new_cost: number }>();
    for (const e of rawEvents) {
      const existing = netByPlayer.get(e.player_id);
      if (existing) existing.new_cost = e.new_cost;
      else netByPlayer.set(e.player_id, { old_cost: e.old_cost, new_cost: e.new_cost });
    }
    const pctMovers = [...netByPlayer.entries()]
      .map(([playerId, { old_cost, new_cost }]) => {
        const pl = playersById.get(playerId);
        if (!pl || !old_cost) return null;
        const pctChange = ((new_cost - old_cost) / old_cost) * 100;
        return slim(pl, { old_cost, new_cost, pct_change: Math.round(pctChange * 10) / 10 });
      })
      .filter((r): r is NonNullable<typeof r> => !!r);
    const topRisersPct = pctMovers.filter((r) => r.pct_change > 0).sort((a, b) => b.pct_change - a.pct_change).slice(0, 5);
    const topFallersPct = pctMovers.filter((r) => r.pct_change < 0).sort((a, b) => a.pct_change - b.pct_change).slice(0, 5);

    // ---- VERWACHTE WIJZIGINGEN VOOR DE KOMENDE DEADLINE ----
    // Filter op verwachting gebeurt hier in JS i.p.v. via een PostgREST
    // in.()-lijst -- die waardes bevatten spaties ("stijgt bijna"), en dat
    // URL-encoderen binnen een in.()-lijst is foutgevoelig. espn_price_board
    // is met ~600 rijen klein genoeg om zonder filter op te halen.
    const boardAll: any[] = await sbGet(
      `espn_price_board?select=id,web_name,team_short,now_cost,verwachting,progress,eta_at&order=progress.desc&limit=1000`,
    );
    const RELEVANT_VERWACHTING = new Set(["stijgt", "stijgt bijna", "daalt", "daalt bijna"]);
    const expectedBeforeDeadline = boardAll
      .filter((b) => RELEVANT_VERWACHTING.has(b.verwachting))
      .slice(0, 20)
      .map((b) => slim(b, { verwachting: b.verwachting, progress: b.progress, eta_at: b.eta_at }));

    const payload = {
      generated_at: new Date().toISOString(),
      next_deadline: nextDeadline,
      changes_last_night: changesLastNight,
      top_risers_pct: topRisersPct,
      top_fallers_pct: topFallersPct,
      expected_before_deadline: expectedBeforeDeadline,
    };
    await sbPost("espn_morning_digest", [{ payload }]);

    const bodyParts: string[] = [];
    if (changesLastNight.length) bodyParts.push(`${changesLastNight.length} wijziging(en) vannacht`);
    if (expectedBeforeDeadline.length) bodyParts.push(`${expectedBeforeDeadline.length} verwacht vóór de deadline`);
    const bodyText = bodyParts.length ? bodyParts.join(" · ") : "Bekijk het overzicht in de app.";

    const allEmails = new Set<string>([GLOBAL_WATCH_EMAIL]);
    for (const { alertEmails } of MY_TEAMS) for (const e of alertEmails) allEmails.add(e);
    for (const email of allEmails) {
      await sendPush(email, "Ochtendoverzicht prijzen klaar", bodyText);
    }

    return new Response(JSON.stringify({ ok: true, payload }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 900);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
