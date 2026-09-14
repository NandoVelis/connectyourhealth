// Wekelijks zondagoverzicht -- draait elke zondag om 19:30 lokale tijd (via
// pg_cron, zie migratie create_sunday_report_table_and_cron), ruim na de
// laatste zondag-aftrap van de speelronde. Berekent voor deze speelronde:
//  - per speler: doelpunten/assists/bonuspunten/clean sheets DEZE ronde
//    (verschil t.o.v. de stand vlak voor de eerste aftrap van de ronde --
//    ESPN geeft alleen seizoenstotalen terug, dus dit moet zelf berekend
//    worden uit de eigen snapshot-geschiedenis)
//  - of spelers die deze ronde goed presteerden ook meer transfers (laatste
//    24u) kregen dan spelers die dat niet deden -- een eerste, simpele
//    correlatie-analyse tussen wedstrijdprestatie en transfermarkt-reactie
//  - een top-10 van sterkste combinatie van prestatie + transferreactie
// Slaat het resultaat op in espn_sunday_report (overig.html toont 'm als
// popup, zelfde patroon als de vrijdag-digest) en stuurt een korte
// pushmelding als aankondiging.

const MY_TEAMS = [
  { entryId: 28264, alertEmails: ["nandovelis@gmail.com"] },
  { entryId: 2640, alertEmails: ["duncanvelis@ziggo.nl", "nandovelis@gmail.com"] },
];
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
    const game = (await sbGet("espn_game?id=eq.1&select=current_event")) as any[];
    const currentEvent: number | null = game[0]?.current_event ?? null;
    if (!currentEvent) {
      return new Response(JSON.stringify({ ok: false, error: "Geen current_event bekend" }), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const fixtures: any[] = await sbGet(
      `espn_fixtures?select=kickoff_time&event=eq.${currentEvent}&kickoff_time=not.is.null&order=kickoff_time.asc&limit=1`,
    );
    const gameweekStart: string | null = fixtures[0]?.kickoff_time ?? null;
    if (!gameweekStart) {
      return new Response(JSON.stringify({ ok: false, error: "Geen aftraptijd bekend voor deze ronde" }), {
        status: 200,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Baseline: laatst bekende stand van elke speler vlak vóór de eerste
    // aftrap van deze ronde (tot 7 dagen terug, ruim genoeg om altijd een
    // punt te vinden). Zonder baseline (nieuw gevolgde speler) telt 0.
    const baselineWindStart = new Date(new Date(gameweekStart).getTime() - 7 * 24 * 3600 * 1000).toISOString();
    const baselineSnaps: any[] = await sbGet(
      `espn_snapshots?select=player_id,captured_at,goals_scored,assists,bonus,clean_sheets` +
        `&captured_at=gte.${encodeURIComponent(baselineWindStart)}&captured_at=lte.${encodeURIComponent(gameweekStart)}` +
        `&order=captured_at.asc&limit=10000`,
    );
    const baselineByPlayer = new Map<number, any>();
    for (const s of baselineSnaps) baselineByPlayer.set(s.player_id, s); // laatste wint (asc-sortering)

    const players: any[] = await sbGet(
      "espn_players?select=id,web_name,team_short,now_cost,goals_scored,assists,bonus,clean_sheets,element_type,transfers_in,transfers_out",
    );
    const playersById = new Map(players.map((p) => [p.id, p]));
    const momentum: any[] = await sbGet("espn_transfer_momentum?select=id,net_1h,net_24h");
    const momentumById = new Map(momentum.map((m) => [m.id, m]));

    const performers: any[] = [];
    for (const p of players) {
      const base = baselineByPlayer.get(p.id);
      const deltaGoals = Number(p.goals_scored ?? 0) - Number(base?.goals_scored ?? 0);
      const deltaAssists = Number(p.assists ?? 0) - Number(base?.assists ?? 0);
      const deltaBonus = Number(p.bonus ?? 0) - Number(base?.bonus ?? 0);
      const deltaCleanSheets = Number(p.clean_sheets ?? 0) - Number(base?.clean_sheets ?? 0);
      if (deltaGoals <= 0 && deltaAssists <= 0 && deltaBonus <= 0 && deltaCleanSheets <= 0) continue;
      const m = momentumById.get(p.id);
      performers.push({
        id: p.id,
        web_name: p.web_name,
        team_short: p.team_short,
        now_cost: p.now_cost,
        goals: deltaGoals,
        assists: deltaAssists,
        bonus: deltaBonus,
        clean_sheets: deltaCleanSheets,
        net_1h: m?.net_1h ?? null,
        net_24h: m?.net_24h ?? null,
        score: deltaGoals * 3 + deltaAssists * 2 + deltaBonus,
      });
    }

    // Simpele correlatie: gemiddelde 24u-transferbeweging van spelers die
    // deze ronde presteerden (goal/assist/bonus) t.o.v. de rest -- een
    // eerste, ruwe indicatie of prestatie samenhangt met transfermarkt-
    // reactie, geen echte statistische toets (daarvoor is dit te weinig
    // data per ronde).
    const performerIds = new Set(performers.map((p) => p.id));
    const withMomentum = players
      .map((p) => momentumById.get(p.id))
      .filter((m): m is any => !!m && m.net_24h != null);
    const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    const performersNet24h = withMomentum.filter((m) => performerIds.has(m.id)).map((m) => Number(m.net_24h));
    const othersNet24h = withMomentum.filter((m) => !performerIds.has(m.id)).map((m) => Number(m.net_24h));
    const correlation = {
      performers_count: performerIds.size,
      performers_avg_net_24h: avg(performersNet24h) != null ? Math.round(avg(performersNet24h)!) : null,
      others_avg_net_24h: avg(othersNet24h) != null ? Math.round(avg(othersNet24h)!) : null,
    };

    // Blessures/schorsingen vs. transfers: voor elke statusomslag van de
    // afgelopen 7 dagen (gelogd door espn-fantasy-sync in espn_injury_events)
    // de daadwerkelijke netto-transferbeweging sinds dat moment -- zelfde
    // soort correlatie als hierboven voor prestaties, maar dan voor "reageert
    // de markt op een blessure/schorsing, en hoe snel/hard".
    const injuryWindowStart = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const injuryEvents: any[] = await sbGet(
      `espn_injury_events?select=player_id,status,detected_at,net_transfers_at_detection` +
        `&detected_at=gte.${encodeURIComponent(injuryWindowStart)}&order=detected_at.desc&limit=200`,
    );
    const injuryReactions = injuryEvents
      .map((ev) => {
        const pl = playersById.get(ev.player_id);
        if (!pl) return null;
        const currentNet = Number(pl.transfers_in ?? 0) - Number(pl.transfers_out ?? 0);
        const netSinceDetection = currentNet - Number(ev.net_transfers_at_detection ?? 0);
        return {
          id: ev.player_id,
          web_name: pl.web_name,
          team_short: pl.team_short,
          status: ev.status,
          detected_at: ev.detected_at,
          net_transfers_since: netSinceDetection,
        };
      })
      .filter((r): r is NonNullable<typeof r> => !!r)
      .sort((a, b) => Math.abs(b.net_transfers_since) - Math.abs(a.net_transfers_since))
      .slice(0, 10);

    const topPerformers = performers
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((p) => slim(p, {
        goals: p.goals,
        assists: p.assists,
        bonus: p.bonus,
        clean_sheets: p.clean_sheets,
        net_1h: p.net_1h,
        net_24h: p.net_24h,
      }));

    const payload = {
      generated_at: new Date().toISOString(),
      event_id: currentEvent,
      gameweek_start: gameweekStart,
      top_performers: topPerformers,
      correlation,
      injury_reactions: injuryReactions,
    };
    await sbPost("espn_sunday_report", [{ event_id: currentEvent, payload }]);

    const notifiedEmails = new Set<string>();
    for (const { alertEmails } of MY_TEAMS) {
      for (const email of alertEmails) {
        if (notifiedEmails.has(email)) continue;
        notifiedEmails.add(email);
        await sendPush(
          email,
          `Zondagoverzicht speelronde ${currentEvent} klaar`,
          topPerformers.length
            ? `Beste prestatie: ${topPerformers[0].web_name} -- bekijk de volledige analyse in de app.`
            : "Bekijk het overzicht in de app.",
        );
      }
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
