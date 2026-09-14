// ESPN Fantasy Voetbal (Eredivisie) — price tracker sync
// Haalt bootstrap-static op, schrijft snapshots van gewijzigde spelers weg
// en detecteert prijswijzigingen. Bedoeld om elke 15 min door pg_cron te draaien.
// Synct daarnaast de eigen teams van elke gebruiker met toegang tot /overig
// (publiek leesbare endpoints, geen ESPN-login nodig) en mailt/pusht een
// prijswaarschuwing naar het bijbehorende e-mailadres.

import webpush from "npm:web-push@3.6.7";

const API = "https://fantasy.espngoal.nl/api/bootstrap-static/";
// Elke gebruiker met toegang tot /overig heeft hier zijn eigen ESPN Fantasy
// entry-ID + het e-mailadres waarnaar zijn prijswaarschuwingen gaan.
const MY_TEAMS = [
  { entryId: 28264, alertEmails: ["nandovelis@gmail.com"] },
  { entryId: 2640, alertEmails: ["duncanvelis@ziggo.nl", "nandovelis@gmail.com"] },
];
// Los van een eigen team: mailt Nando zodra ÉÉN willekeurige speler (ook een
// die hij niet bezit) de 90%-drempel van een prijswijziging nadert.
const GLOBAL_WATCH_EMAIL = "nandovelis@gmail.com";
// ESPN's "status"-veld: a=beschikbaar, d=twijfelachtig, i=geblesseerd,
// s=geschorst, u=niet inzetbaar (bv. langdurig geblesseerd/vertrokken).
const STATUS_LABELS: Record<string, string> = {
  a: "beschikbaar",
  d: "twijfelachtig",
  i: "geblesseerd",
  s: "geschorst",
  u: "niet inzetbaar",
};
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

// Supabase's gateway geeft af en toe een transiente 502/503/504 terug
// (geen structureel probleem, gewoon een korte hapering) -- zonder retry
// gooide dat meteen de hele sync-run weg, inclusief alle prijswaarschuwingen
// die verderop in dezelfde run verstuurd zouden worden. 2 pogingen met een
// korte pauze lost verreweg de meeste van die gevallen zelf op.
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
  // in blokken van 500 om payloadlimieten te vermijden
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const r = await fetchWithRetry(`${SB_URL}/rest/v1/${path}`, {
      method: "POST",
      headers: sbHeaders({ Prefer: prefer }),
      body: JSON.stringify(chunk),
    });
    if (!r.ok) throw new Error(`POST ${path} -> ${r.status} ${await r.text()}`);
  }
}

const num = (v: unknown) => {
  const n = parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
};

// ---- AUTOMATISCHE HERIJKING VAN DE PRIJSDREMPEL-FACTOREN ----
// Draait alleen als er deze run daadwerkelijk een prijswijziging
// gedetecteerd is (extra databasewerk anders overbodig). Herberekent
// rise_owner_factor/fall_owner_factor als het 75e percentiel van
// |net_since_prev|/owners_estimate over ALLE ooit waargenomen wijzigingen
// (met een bekend ankermoment, dus first_change_since_tracking uitgesloten
// -- die gebruiken een andere teller/basis en zijn niet vergelijkbaar). Het
// 75e percentiel i.p.v. de mediaan, zodat de meeste toekomstige wijzigingen
// nog wel door de "bijna"-waarschuwingszone gaan voordat ze omslaan, i.p.v.
// dat de helft ervan de drempel al gepasseerd is voordat we 'm zien. Minimaal
// 5 waarnemingen per richting nodig -- met minder is een percentiel te
// grillig (één uitschieter zou de drempel te veel laten springen).
const PRICE_THRESHOLD_MIN_SAMPLES = 5;
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}
async function recalibratePriceThresholdFactors() {
  const events: any[] = await sbGet(
    "espn_price_events?select=direction,net_since_prev,owners_estimate,first_change_since_tracking" +
      "&first_change_since_tracking=is.null&owners_estimate=gt.0",
  );
  const ratiosFor = (dir: number) =>
    events
      .filter((e) => e.direction === dir)
      .map((e) => Math.abs(e.net_since_prev) / e.owners_estimate)
      .sort((a, b) => a - b);

  const riseRatios = ratiosFor(1);
  const fallRatios = ratiosFor(-1);
  const nowIso = new Date().toISOString();
  const updates: any[] = [];

  if (riseRatios.length >= PRICE_THRESHOLD_MIN_SAMPLES) {
    const factor = percentile(riseRatios, 0.75)!;
    updates.push({
      key: "rise_owner_factor",
      value: factor.toFixed(4),
      note:
        `Automatisch herijkt op ${nowIso} o.b.v. ${riseRatios.length} waargenomen stijgingen ` +
        `(75e percentiel van |net_since_prev|/owners_estimate).`,
    });
  }
  if (fallRatios.length >= PRICE_THRESHOLD_MIN_SAMPLES) {
    const factor = percentile(fallRatios, 0.75)!;
    updates.push({
      key: "fall_owner_factor",
      value: factor.toFixed(4),
      note:
        `Automatisch herijkt op ${nowIso} o.b.v. ${fallRatios.length} waargenomen dalingen ` +
        `(75e percentiel van |net_since_prev|/owners_estimate).`,
    });
  }
  if (updates.length) {
    await sbPost("espn_model_config", updates, "return=minimal,resolution=merge-duplicates");
  }
}

// ---- GEDEELDE KWARTIER-VOOR-KWARTIER TRANSFERBEREKENING ----
// Gebruikt door zowel het pre-match-trendrapport (30 min vóór aftrap) als
// het post-match-rapport (na afloop) -- alleen het tijdvenster verschilt.
// net_transfers is cumulatief per speler, dus het verschil tussen twee
// opeenvolgende kwartier-standen is precies het aantal transfers dat in
// dat kwartier bijkwam.
async function computeTransferQuarters(
  playerIds: number[],
  homeIds: Set<number>,
  windowStart: Date,
  windowEnd: Date,
) {
  const baseline: any[] = await sbGet(
    `espn_snapshots?select=player_id,net_transfers,captured_at&player_id=in.(${playerIds.join(",")})` +
      `&captured_at=lte.${encodeURIComponent(windowStart.toISOString())}&order=captured_at.asc&limit=10000`,
  );
  const baselineByPlayer = new Map<number, number>();
  for (const s of baseline) baselineByPlayer.set(s.player_id, Number(s.net_transfers)); // laatste (asc) wint

  const inWindow: any[] = await sbGet(
    `espn_snapshots?select=player_id,net_transfers,captured_at&player_id=in.(${playerIds.join(",")})` +
      `&captured_at=gt.${encodeURIComponent(windowStart.toISOString())}&captured_at=lte.${encodeURIComponent(windowEnd.toISOString())}` +
      `&order=captured_at.asc&limit=10000`,
  );

  const current = new Map<number, number>(baselineByPlayer);
  let idx = 0;
  const totalMinutes = Math.round((windowEnd.getTime() - windowStart.getTime()) / 60000);
  const cumulativeBuckets: { minute: number; home: number; away: number }[] = [];
  for (let minute = 15; minute <= totalMinutes; minute += 15) {
    const boundary = windowStart.getTime() + minute * 60 * 1000;
    while (idx < inWindow.length && new Date(inWindow[idx].captured_at).getTime() <= boundary) {
      current.set(inWindow[idx].player_id, Number(inWindow[idx].net_transfers));
      idx++;
    }
    let home = 0, away = 0;
    for (const [pid, val] of current) {
      if (homeIds.has(pid)) home += val; else away += val;
    }
    cumulativeBuckets.push({ minute, home, away });
  }

  let prevHome = 0, prevAway = 0;
  for (const [pid, val] of baselineByPlayer) {
    if (homeIds.has(pid)) prevHome += val; else prevAway += val;
  }
  const quarters = cumulativeBuckets.map((b) => {
    const d = { minute: b.minute, home_net: b.home - prevHome, away_net: b.away - prevAway, total_net: (b.home - prevHome) + (b.away - prevAway) };
    prevHome = b.home;
    prevAway = b.away;
    return d;
  });

  const topMovers = [...current.entries()]
    .map(([pid, delta_val]) => ({ pid, delta: delta_val - (baselineByPlayer.get(pid) ?? 0) }))
    .filter((m) => m.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);

  return { quarters, topMovers };
}

async function loadMatchPlayers(f: any) {
  const players: any[] = await sbGet(
    `espn_players?select=id,web_name,team_id,team_short&team_id=in.(${f.team_h},${f.team_a})`,
  );
  const playerIds = players.map((p: any) => p.id);
  const homeIds = new Set(players.filter((p: any) => p.team_id === f.team_h).map((p: any) => p.id));
  const playerById = new Map(players.map((p: any) => [p.id, p]));
  return { players, playerIds, homeIds, playerById };
}

function namedMovers(topMovers: { pid: number; delta: number }[], playerById: Map<number, any>) {
  return topMovers.map((m) => {
    const p = playerById.get(m.pid);
    return { id: m.pid, web_name: p?.web_name ?? `#${m.pid}`, team_short: p?.team_short ?? null, net: m.delta };
  });
}

// ---- PRE-MATCH TRANSFERTREND (30 MIN VOOR AFTRAP) ----
// Zodra een fixture nog 15-45 min van aftrap verwijderd is (dat venster i.p.v.
// precies 30 min, want de sync draait elke 15 min en moet dit venster
// gegarandeerd één keer raken) en er nog geen pre-match-rapport voor is:
// kwartierstrend van de laatste 3 uur vóór aftrap, om een eventuele
// opstelling-gerelateerde transferbeweging vooraf te kunnen spotten.
async function checkUpcomingMatchesForPreMatchTrend(fixtures: any[], teams: Record<number, string>) {
  const upcoming = fixtures.filter((f: any) => {
    if (f.finished || !f.kickoff_time) return false;
    const minutesToKickoff = (new Date(f.kickoff_time).getTime() - Date.now()) / 60000;
    return minutesToKickoff >= 15 && minutesToKickoff <= 45;
  });
  if (!upcoming.length) return;

  const idsParam = upcoming.map((f: any) => f.id).join(",");
  const existing: any[] = await sbGet(`espn_pre_match_transfer_report?select=fixture_id&fixture_id=in.(${idsParam})`);
  const existingIds = new Set(existing.map((e: any) => e.fixture_id));
  const toReport = upcoming.filter((f: any) => !existingIds.has(f.id));

  for (const f of toReport) {
    try {
      await buildAndStorePreMatchTrendReport(f, teams);
    } catch (e) {
      console.warn(`Pre-match-transferrapport (fixture ${f.id}) mislukt: ${String(e)}`);
    }
  }
}

async function buildAndStorePreMatchTrendReport(f: any, teams: Record<number, string>) {
  const kickoff = new Date(f.kickoff_time);
  const windowStart = new Date(kickoff.getTime() - 180 * 60 * 1000);
  const homeShort = teams[f.team_h] ?? null;
  const awayShort = teams[f.team_a] ?? null;

  const { playerIds, homeIds, playerById } = await loadMatchPlayers(f);
  if (!playerIds.length) return;

  const { quarters, topMovers } = await computeTransferQuarters(playerIds, homeIds, windowStart, kickoff);
  // Labels omzetten naar "minuten vóór aftrap" (aflopend naar 0) i.p.v.
  // "minuten sinds windowStart", zodat de weergave logisch aanvoelt als
  // een aftelling richting de aftrap.
  const totalMinutes = Math.round((kickoff.getTime() - windowStart.getTime()) / 60000);
  const quartersBeforeKickoff = quarters.map((q) => ({ ...q, minutes_before_kickoff: totalMinutes - q.minute }));

  const payload = {
    generated_at: new Date().toISOString(),
    home_team: homeShort,
    away_team: awayShort,
    kickoff_time: f.kickoff_time,
    quarters: quartersBeforeKickoff,
    top_movers: namedMovers(topMovers, playerById),
  };

  await sbPost("espn_pre_match_transfer_report", [{
    fixture_id: f.id,
    event: f.event ?? null,
    team_h_short: homeShort,
    team_a_short: awayShort,
    kickoff_time: f.kickoff_time,
    payload,
  }], "return=minimal,resolution=merge-duplicates");

  const namedTop = payload.top_movers;
  const bodyText = namedTop.length
    ? `Meeste beweging vooraf: ${namedTop[0].web_name} (${namedTop[0].net > 0 ? "+" : ""}${namedTop[0].net})`
    : "Bekijk de transfertrend voor de wedstrijd in de app.";
  const allEmails = new Set<string>([GLOBAL_WATCH_EMAIL]);
  for (const { alertEmails } of MY_TEAMS) for (const e of alertEmails) allEmails.add(e);
  for (const email of allEmails) {
    await sendPush(email, `Trend vóór ${homeShort} - ${awayShort} (begint over ~30 min)`, bodyText);
  }
}

// ---- KWARTIER-VOOR-KWARTIER TRANSFERRAPPORT PER WEDSTRIJD (NA AFLOOP) ----
// Zodra een wedstrijd als "finished" binnenkomt (en nog geen rapport heeft),
// wordt voor de spelers van BEIDE clubs berekend hoeveel netto transfers er
// per kwartier bijkwamen, vanaf aftrap tot 3 uur erna (dekt de wedstrijd +
// een post-wedstrijd-reactievenster).
async function checkFinishedMatchesForTransferReport(fixtures: any[], teams: Record<number, string>) {
  const recentFinished = fixtures.filter((f: any) =>
    f.finished && f.kickoff_time && Date.now() - new Date(f.kickoff_time).getTime() < 24 * 3600 * 1000
  );
  if (!recentFinished.length) return;

  const idsParam = recentFinished.map((f: any) => f.id).join(",");
  const existing: any[] = await sbGet(`espn_match_transfer_report?select=fixture_id&fixture_id=in.(${idsParam})`);
  const existingIds = new Set(existing.map((e: any) => e.fixture_id));
  const toReport = recentFinished.filter((f: any) => !existingIds.has(f.id));

  for (const f of toReport) {
    try {
      await buildAndStoreMatchTransferReport(f, teams);
    } catch (e) {
      console.warn(`Wedstrijd-transferrapport (fixture ${f.id}) mislukt: ${String(e)}`);
    }
  }
}

async function buildAndStoreMatchTransferReport(f: any, teams: Record<number, string>) {
  const kickoff = new Date(f.kickoff_time);
  const windowEnd = new Date(kickoff.getTime() + 180 * 60 * 1000);
  const homeShort = teams[f.team_h] ?? null;
  const awayShort = teams[f.team_a] ?? null;

  const { playerIds, homeIds, playerById } = await loadMatchPlayers(f);
  if (!playerIds.length) return;

  const { quarters, topMovers } = await computeTransferQuarters(playerIds, homeIds, kickoff, windowEnd);
  const namedTop = namedMovers(topMovers, playerById);

  const payload = {
    generated_at: new Date().toISOString(),
    home_team: homeShort,
    away_team: awayShort,
    kickoff_time: f.kickoff_time,
    quarters,
    top_movers: namedTop,
  };

  await sbPost("espn_match_transfer_report", [{
    fixture_id: f.id,
    event: f.event ?? null,
    team_h_short: homeShort,
    team_a_short: awayShort,
    kickoff_time: f.kickoff_time,
    payload,
  }], "return=minimal,resolution=merge-duplicates");

  const bodyText = namedTop.length
    ? `Meeste beweging: ${namedTop[0].web_name} (${namedTop[0].net > 0 ? "+" : ""}${namedTop[0].net})`
    : "Bekijk de kwartier-voor-kwartier transfers in de app.";
  const allEmails = new Set<string>([GLOBAL_WATCH_EMAIL]);
  for (const { alertEmails } of MY_TEAMS) for (const e of alertEmails) allEmails.add(e);
  for (const email of allEmails) {
    await sendPush(email, `Transferupdate: ${homeShort} - ${awayShort} afgelopen`, bodyText);
  }
}

// ---- PUSHMELDINGEN (Web Push) ----
// Alleen actief als de VAPID-sleutels als Supabase-secrets gezet zijn
// (Edge Functions -> Manage secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
// optioneel VAPID_SUBJECT) -- zonder die secrets slaat dit stil over, net
// als de e-mailwaarschuwing zonder RESEND_API_KEY.
const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
const vapidSubject = Deno.env.get("VAPID_SUBJECT") || "mailto:nandovelis@gmail.com";
if (vapidPublic && vapidPrivate) {
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
}

async function sendPush(alertEmail: string, title: string, body: string, url = "/overig") {
  if (!vapidPublic || !vapidPrivate) return;
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
      } catch (e: any) {
        // Verlopen/ingetrokken subscription (bv. gebruiker heeft meldingen
        // uitgezet in de browser) -- opruimen zodat we 'm niet blijven
        // proberen.
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await fetch(
            `${SB_URL}/rest/v1/espn_push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
            { method: "DELETE", headers: sbHeaders() },
          );
        } else {
          console.warn(`Push naar ${alertEmail} mislukt: ${String(e)}`);
        }
      }
    }
  } catch (e) {
    console.warn(`Push-lookup (${alertEmail}) mislukt: ${String(e)}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const t0 = Date.now();
  let seen = 0, snaps = 0, changes = 0;

  try {
    const res = await fetch(API, {
      headers: {
        "User-Agent": "connectyourhealth-price-tracker/1.0",
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(`bootstrap-static -> ${res.status}`);
    const data = await res.json();

    const elements: any[] = data.elements ?? [];
    const teams: Record<number, string> = {};
    for (const t of data.teams ?? []) teams[t.id] = t.short_name;
    seen = elements.length;

    const teamRows = (data.teams ?? []).map((t: any) => ({
      id: t.id,
      name: t.name,
      short_name: t.short_name,
      position: t.position ?? null,
      points: t.points ?? null,
      played: t.played ?? null,
      win: t.win ?? null,
      draw: t.draw ?? null,
      loss: t.loss ?? null,
    }));
    await sbPost("espn_teams", teamRows, "return=minimal,resolution=merge-duplicates");

    const cur = (data.events ?? []).find((e: any) => e.is_current);
    const nxt = (data.events ?? []).find((e: any) => e.is_next);
    const totalPlayers: number = data.total_players ?? 0;

    // bestaande stand ophalen
    const prevRows: any[] = await sbGet(
      "espn_players?select=id,now_cost,transfers_in,transfers_out,net_at_last_change,goals_scored,assists,bonus,clean_sheets,status&limit=2000",
    );
    const prev = new Map<number, any>(prevRows.map((r) => [r.id, r]));

    const capturedAt = new Date().toISOString();
    const playerRows: any[] = [];
    const changedRows: any[] = [];
    const snapRows: any[] = [];
    const eventRows: any[] = [];
    const changedPlayerIds: number[] = [];
    // Blessure-/schorsingsrisico: ESPN's "status" (a=beschikbaar,
    // d=twijfelachtig, i=geblesseerd, s=geschorst, u=niet inzetbaar) i.c.m.
    // chance_of_playing_next_round. newlyUnavailable = spelers die deze run
    // van "beschikbaar" naar iets anders omslaan (ongeacht of ze in een
    // gevolgd team zitten -- het team-filter gebeurt verderop bij het
    // versturen). recovered = spelers die weer beschikbaar zijn -- hun
    // eerder verstuurde waarschuwingen mogen dan weer opnieuw kunnen afgaan
    // bij een volgende blessure, net als bij de prijswaarschuwingen.
    const newlyUnavailable: { id: number; status: string }[] = [];
    const recoveredIds: number[] = [];

    for (const e of elements) {
      const tin = Number(e.transfers_in ?? 0);
      const tout = Number(e.transfers_out ?? 0);
      const net = tin - tout;
      const p = prev.get(e.id);

      let netAtLastChange = p ? Number(p.net_at_last_change ?? 0) : net;
      let lastChangeAt: string | null | undefined = undefined;
      let lastDir: number | undefined = undefined;

      // prijswijziging?
      if (p && p.now_cost !== e.now_cost) {
        const dir = e.now_cost > p.now_cost ? 1 : -1;
        const own = num(e.selected_by_percent);
        eventRows.push({
          player_id: e.id,
          detected_at: capturedAt,
          old_cost: p.now_cost,
          new_cost: e.now_cost,
          direction: dir,
          net_since_prev: net - netAtLastChange,
          owners_estimate: own != null ? Math.round((own / 100) * totalPlayers) : null,
          selected_by_percent: own,
          event_id: cur?.id ?? null,
        });
        netAtLastChange = net;
        lastChangeAt = capturedAt;
        lastDir = dir;
        changes++;
        changedPlayerIds.push(e.id);
      }

      // Status-omslag (blessure/schorsing/twijfelachtig) detecteren.
      if (p && p.status === "a" && e.status !== "a") {
        newlyUnavailable.push({ id: e.id, status: e.status });
      } else if (p && p.status !== "a" && e.status === "a") {
        recoveredIds.push(e.id);
      }

      // Goals/assists/bonus/clean sheets meenemen in de wijzigingscheck (niet
      // alleen prijs/transfers) -- zonder dit zou een speler die net heeft
      // gescoord maar toevallig geen transferbeweging heeft, geen snapshot
      // krijgen op precies het moment dat voor de wedstrijd-correlatie-
      // analyse relevant is.
      const goals = Number(e.goals_scored ?? 0);
      const assists = Number(e.assists ?? 0);
      const bonus = Number(e.bonus ?? 0);
      const cleanSheets = Number(e.clean_sheets ?? 0);
      const changedSincePrev = !p ||
        p.now_cost !== e.now_cost ||
        Number(p.transfers_in) !== tin ||
        Number(p.transfers_out) !== tout ||
        Number(p.goals_scored ?? 0) !== goals ||
        Number(p.assists ?? 0) !== assists ||
        Number(p.bonus ?? 0) !== bonus ||
        Number(p.clean_sheets ?? 0) !== cleanSheets;

      if (changedSincePrev) {
        snapRows.push({
          captured_at: capturedAt,
          player_id: e.id,
          now_cost: e.now_cost,
          transfers_in: tin,
          transfers_out: tout,
          net_transfers: net,
          net_since_change: net - netAtLastChange,
          selected_by_percent: num(e.selected_by_percent),
          goals_scored: goals,
          assists: assists,
          bonus: bonus,
          clean_sheets: cleanSheets,
          event_points: e.event_points ?? null,
        });
      }

      const row: any = {
        id: e.id,
        code: e.code,
        web_name: e.web_name,
        first_name: e.first_name,
        second_name: e.second_name,
        team_id: e.team,
        team_short: teams[e.team] ?? null,
        element_type: e.element_type,
        status: e.status,
        chance_of_playing_next_round: e.chance_of_playing_next_round ?? null,
        news: e.news ?? "",
        now_cost: e.now_cost,
        cost_change_start: e.cost_change_start ?? 0,
        cost_change_event: e.cost_change_event ?? 0,
        selected_by_percent: num(e.selected_by_percent),
        transfers_in: tin,
        transfers_out: tout,
        transfers_in_event: Number(e.transfers_in_event ?? 0),
        transfers_out_event: Number(e.transfers_out_event ?? 0),
        total_points: e.total_points ?? 0,
        event_points: e.event_points ?? 0,
        form: num(e.form),
        points_per_game: num(e.points_per_game),
        minutes: e.minutes ?? 0,
        ep_next: num(e.ep_next),
        net_at_last_change: netAtLastChange,
        goals_scored: goals,
        assists: assists,
        bonus: bonus,
        clean_sheets: cleanSheets,
        updated_at: capturedAt,
      };
      playerRows.push(row);
      // Losse batch voor spelers met een net gedetecteerde prijswijziging:
      // PostgREST vereist dat alle objecten in één bulk-insert dezelfde
      // sleutels hebben, dus deze twee extra velden (alleen relevant bij
      // een echte wijziging) kunnen niet zomaar aan een deel van de rijen
      // in dezelfde POST hangen.
      if (lastChangeAt !== undefined) {
        changedRows.push({ ...row, last_change_at: lastChangeAt, last_change_direction: lastDir });
      }
    }

    await sbPost("espn_players", playerRows, "return=minimal,resolution=merge-duplicates");
    await sbPost("espn_players", changedRows, "return=minimal,resolution=merge-duplicates");
    await sbPost("espn_snapshots", snapRows);
    await sbPost("espn_price_events", eventRows);
    snaps = snapRows.length;

    // Alleen herijken als er deze run ook echt iets te leren viel.
    if (eventRows.length) {
      try {
        await recalibratePriceThresholdFactors();
      } catch (e) {
        console.warn(`Herijking prijsdrempel-factoren mislukt: ${String(e)}`);
      }
    }

    // Lookup-tabellen voor de "daadwerkelijke wijziging"-melding hieronder
    // (los van de "dreigt te wijzigen"-waarschuwing, die alleen de fase
    // vóór de wijziging dekt -- een wijziging die tussen twee syncs door
    // "in één keer" gebeurt, sloeg die fase soms over zonder ooit gemeld
    // te zijn). Alleen voor eigen team, niet voor alle spelers.
    const changedById = new Map(playerRows.filter((r) => changedPlayerIds.includes(r.id)).map((r) => [r.id, r]));
    const eventByPlayerId = new Map(eventRows.map((e) => [e.player_id, e]));
    const playerById = new Map(playerRows.map((r) => [r.id, r]));

    // Een speler die daadwerkelijk van prijs veranderd is, start weer op 0 --
    // eerder verstuurde waarschuwingen voor die speler mogen dus weer
    // opnieuw kunnen afgaan bij een volgende dreigende wijziging.
    if (changedPlayerIds.length) {
      await fetch(
        `${SB_URL}/rest/v1/espn_price_alerts_sent?player_id=in.(${changedPlayerIds.join(",")})`,
        { method: "DELETE", headers: sbHeaders() },
      );
    }

    const unavailableById = new Map(newlyUnavailable.map((u) => [u.id, u]));

    // Spelers die weer beschikbaar zijn: oude blessure-/schorsings-
    // waarschuwingen wissen zodat een volgende blessure weer een nieuwe
    // melding oplevert (zelfde patroon als de prijswaarschuwing hierboven).
    if (recoveredIds.length) {
      await fetch(
        `${SB_URL}/rest/v1/espn_injury_alerts_sent?player_id=in.(${recoveredIds.join(",")})`,
        { method: "DELETE", headers: sbHeaders() },
      );
    }

    await fetch(`${SB_URL}/rest/v1/espn_game?id=eq.1`, {
      method: "PATCH",
      headers: sbHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({
        total_players: totalPlayers,
        current_event: cur?.id ?? null,
        current_event_name: cur?.name ?? null,
        next_event: nxt?.id ?? null,
        next_deadline: nxt?.deadline_time ?? null,
        updated_at: capturedAt,
      }),
    });

    // ---- WEDSTRIJDSCHEMA (voor transfersuggesties: dubbele speelrondes) ----
    // Best-effort, net als de andere aanvullende syncs hieronder.
    try {
      const fixturesRes = await fetch("https://fantasy.espngoal.nl/api/fixtures/");
      if (fixturesRes.ok) {
        const fixtures: any[] = await fixturesRes.json();
        const fixtureRows = fixtures.map((f: any) => ({
          id: f.id,
          event: f.event ?? null,
          team_h: f.team_h ?? null,
          team_a: f.team_a ?? null,
          kickoff_time: f.kickoff_time ?? null,
          finished: !!f.finished,
          updated_at: capturedAt,
        }));
        await sbPost("espn_fixtures", fixtureRows, "return=minimal,resolution=merge-duplicates");

        // Ong. 30 min vóór aftrap: transfertrend van de laatste 3 uur, om een
        // eventuele opstelling-gerelateerde beweging vooraf te kunnen spotten.
        try {
          await checkUpcomingMatchesForPreMatchTrend(fixtureRows, teams);
        } catch (e) {
          console.warn(`Pre-match-transferrapporten mislukt: ${String(e)}`);
        }

        // Zodra een wedstrijd deze run als "finished" binnenkomt: kwartier-
        // voor-kwartier transferrapport voor de spelers van beide clubs
        // (best-effort, faalt dit dan gaat de rest van de sync door).
        try {
          await checkFinishedMatchesForTransferReport(fixtureRows, teams);
        } catch (e) {
          console.warn(`Wedstrijd-transferrapporten mislukt: ${String(e)}`);
        }
      } else {
        console.warn(`espn fixtures gaf status ${fixturesRes.status}, overgeslagen.`);
      }
    } catch (e) {
      console.warn(`Fixtures-sync mislukt: ${String(e)}`);
    }

    // ---- MIJN TEAMS (publiek leesbare endpoints, geen ESPN-login nodig) ----
    // Voor elke gebruiker met toegang tot /overig (zie MY_TEAMS). Best-effort
    // per team: gaat er eentje mis, dan proberen de andere teams en de rest
    // van de sync (prijzen, kritieker) gewoon door.
    const resendKey = Deno.env.get("RESEND_API_KEY");
    for (const { entryId, alertEmails } of MY_TEAMS) {
      try {
        const entryRes = await fetch(`https://fantasy.espngoal.nl/api/entry/${entryId}/`);
        if (!entryRes.ok) {
          console.warn(`espn entry ${entryId} gaf status ${entryRes.status}, overgeslagen.`);
          continue;
        }
        const entry = await entryRes.json();
        const historyRes = await fetch(`https://fantasy.espngoal.nl/api/entry/${entryId}/history/`);
        const history = historyRes.ok ? await historyRes.json() : null;

        const currentEvent: number | null = entry.current_event ?? null;
        let picks: any = null;
        if (currentEvent) {
          const picksRes = await fetch(
            `https://fantasy.espngoal.nl/api/entry/${entryId}/event/${currentEvent}/picks/`,
          );
          if (picksRes.ok) picks = await picksRes.json();
        }

        await fetch(`${SB_URL}/rest/v1/espn_my_team`, {
          method: "POST",
          headers: sbHeaders({ Prefer: "return=minimal,resolution=merge-duplicates" }),
          body: JSON.stringify([{
            entry_id: entryId,
            player_name: `${entry.player_first_name ?? ""} ${entry.player_last_name ?? ""}`.trim(),
            current_event: currentEvent,
            overall_points: entry.summary_overall_points ?? null,
            overall_rank: entry.summary_overall_rank ?? null,
            event_points: entry.summary_event_points ?? null,
            event_rank: entry.summary_event_rank ?? null,
            bank: picks?.entry_history?.bank ?? null,
            team_value: picks?.entry_history?.value ?? null,
            leagues: entry.leagues ?? null,
            picks: picks?.picks ?? null,
            history: history?.current ?? null,
            updated_at: capturedAt,
          }]),
        });

        // ---- DAADWERKELIJKE PRIJSWIJZIGING VOOR SPELERS IN DIT TEAM ----
        // Los van de "dreigt te wijzigen"-waarschuwing hieronder: zodra een
        // speler in dit team ECHT van prijs is veranderd (deze sync-run),
        // altijd een melding -- ook als de dreigende fase gemist is. Push
        // gaat altijd (als VAPID-secrets gezet zijn), mail alleen met
        // RESEND_API_KEY, net als hieronder.
        if (changedPlayerIds.length && picks?.picks?.length) {
          const ownedChangedIds: number[] = picks.picks
            .map((p: any) => p.element)
            .filter((id: number) => changedById.has(id));
          if (ownedChangedIds.length) {
            const lines = ownedChangedIds.map((id) => {
              const pl = changedById.get(id)!;
              const ev = eventByPlayerId.get(id)!;
              return `- ${pl.web_name} (${pl.team_short}): €${(ev.old_cost / 10).toFixed(1)} -> €${
                (ev.new_cost / 10).toFixed(1)
              }`;
            }).join("\n");
            for (const alertEmail of alertEmails) {
              if (resendKey) {
                const mailRes = await fetch("https://api.resend.com/emails", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${resendKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    from: "ConnectYourHealth <onboarding@resend.dev>",
                    to: [alertEmail],
                    subject: `ESPN Fantasy: prijs gewijzigd voor ${ownedChangedIds.length} speler(s) in dit team`,
                    text:
                      `Deze spelers in het gevolgde team zijn zojuist van prijs veranderd:\n\n${lines}\n\nBekijk het overzicht: https://connectyourhealth.vercel.app/overig`,
                  }),
                });
                if (!mailRes.ok) {
                  console.warn(`Prijswijziging-mail (${alertEmail}) mislukt: ${mailRes.status} ${await mailRes.text()}`);
                }
              }
              await sendPush(
                alertEmail,
                `${ownedChangedIds.length} speler(s) in dit team van prijs veranderd`,
                ownedChangedIds.map((id) => changedById.get(id)!.web_name).join(", "),
              );
            }
          }
        }

        // ---- BLESSURE-/SCHORSINGSRISICO VOOR SPELERS IN DIT TEAM ----
        // Zodra een speler in dit team van "beschikbaar" naar twijfelachtig/
        // geblesseerd/geschorst/niet-inzetbaar omslaat: altijd een melding,
        // net als de prijswijziging hierboven. Dedup per (e-mailadres,
        // speler, status) via espn_injury_alerts_sent, opgeschoond zodra de
        // speler weer beschikbaar is (zie eerder in dit bestand) -- zodat
        // een volgende blessure gewoon weer een nieuwe melding oplevert.
        if (newlyUnavailable.length && picks?.picks?.length) {
          const ownedUnavailableIds: number[] = picks.picks
            .map((p: any) => p.element)
            .filter((id: number) => unavailableById.has(id));
          if (ownedUnavailableIds.length) {
            for (const alertEmail of alertEmails) {
              const alreadyRes = await fetch(
                `${SB_URL}/rest/v1/espn_injury_alerts_sent?select=player_id,status&alert_email=eq.${
                  encodeURIComponent(alertEmail)
                }&player_id=in.(${ownedUnavailableIds.join(",")})`,
                { headers: sbHeaders() },
              );
              const already: any[] = alreadyRes.ok ? await alreadyRes.json() : [];
              const alreadySet = new Set(already.map((a) => `${a.player_id}:${a.status}`));
              const toAlert = ownedUnavailableIds.filter((id) =>
                !alreadySet.has(`${id}:${unavailableById.get(id)!.status}`)
              );
              if (!toAlert.length) continue;
              const lines = toAlert.map((id) => {
                const pl = playerById.get(id)!;
                const u = unavailableById.get(id)!;
                const chance = pl.chance_of_playing_next_round;
                return `- ${pl.web_name} (${pl.team_short}): ${STATUS_LABELS[u.status] ?? u.status}` +
                  (chance != null ? ` (${chance}% kans om te spelen)` : "") +
                  (pl.news ? ` -- ${pl.news}` : "");
              }).join("\n");
              if (resendKey) {
                const mailRes = await fetch("https://api.resend.com/emails", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${resendKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    from: "ConnectYourHealth <onboarding@resend.dev>",
                    to: [alertEmail],
                    subject: `ESPN Fantasy: ${toAlert.length} speler(s) in dit team mogelijk niet inzetbaar`,
                    text:
                      `Deze spelers in het gevolgde team zijn zojuist als twijfelachtig/geblesseerd/geschorst gemarkeerd:\n\n${lines}\n\nBekijk het overzicht: https://connectyourhealth.vercel.app/overig`,
                  }),
                });
                if (!mailRes.ok) {
                  console.warn(`Blessurewaarschuwing-mail (${alertEmail}) mislukt: ${mailRes.status} ${await mailRes.text()}`);
                }
              }
              await sendPush(
                alertEmail,
                `${toAlert.length} speler(s) in dit team mogelijk niet inzetbaar`,
                toAlert.map((id) =>
                  `${playerById.get(id)!.web_name}: ${STATUS_LABELS[unavailableById.get(id)!.status] ?? unavailableById.get(id)!.status}`
                ).join(", "),
              );
              await sbPost(
                "espn_injury_alerts_sent",
                toAlert.map((id) => ({
                  alert_email: alertEmail,
                  player_id: id,
                  status: unavailableById.get(id)!.status,
                  sent_at: capturedAt,
                })),
                "return=minimal,resolution=merge-duplicates",
              );
            }
          }
        }

        // ---- PRIJSWAARSCHUWING VOOR SPELERS IN DIT TEAM ----
        // Mailt alleen als RESEND_API_KEY als Supabase-secret gezet is
        // (Edge Functions -> Manage secrets) -- zonder die secret slaat dit
        // stil over, de rest van de sync blijft gewoon werken. Elke speler
        // wordt maar 1x per gebruiker per "verwachting"-status gemaild
        // (bijgehouden in espn_price_alerts_sent, opgeschoond zodra de prijs
        // echt wijzigt), zodat dezelfde dreigende wijziging niet elke 15 min
        // opnieuw mailt -- en niet gedeeld tussen teams, anders mist de een
        // een mail omdat de ander 'm al kreeg voor dezelfde speler.
        if (resendKey && picks?.picks?.length) {
          const elementIds = picks.picks.map((p: any) => p.element);
          const boardRes = await fetch(
            `${SB_URL}/rest/v1/espn_price_board?select=id,web_name,team_short,now_cost,verwachting,progress&id=in.(${
              elementIds.join(",")
            })`,
            { headers: sbHeaders() },
          );
          if (boardRes.ok) {
            const board: any[] = await boardRes.json();
            const threatened = board.filter((b) =>
              b.verwachting && b.verwachting !== "stabiel" && b.verwachting !== "onbekend"
            );
            // Elk gekoppeld e-mailadres van dit team (bv. zowel Duncan als
            // Nando bij Duncan's team) krijgt zijn eigen, los bijgehouden
            // waarschuwing -- zo mist niemand een mail omdat een ander 'm
            // al kreeg voor dezelfde speler.
            for (const alertEmail of alertEmails) {
              if (!threatened.length) continue;
              const alreadyRes = await fetch(
                `${SB_URL}/rest/v1/espn_price_alerts_sent?select=player_id,verwachting&alert_email=eq.${
                  encodeURIComponent(alertEmail)
                }&player_id=in.(${threatened.map((t) => t.id).join(",")})`,
                { headers: sbHeaders() },
              );
              const already: any[] = alreadyRes.ok ? await alreadyRes.json() : [];
              const alreadySet = new Set(already.map((a) => `${a.player_id}:${a.verwachting}`));
              const toAlert = threatened.filter((t) => !alreadySet.has(`${t.id}:${t.verwachting}`));
              if (toAlert.length) {
                const lines = toAlert.map((t) =>
                  `- ${t.web_name} (${t.team_short}): ${t.verwachting} (${
                    Math.round((t.progress || 0) * 100)
                  }% van de drempel, huidige prijs €${(t.now_cost / 10).toFixed(1)})`
                ).join("\n");
                const mailRes = await fetch("https://api.resend.com/emails", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${resendKey}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    from: "ConnectYourHealth <onboarding@resend.dev>",
                    to: [alertEmail],
                    subject: `ESPN Fantasy: ${toAlert.length} speler(s) in dit team dreigen van prijs te veranderen`,
                    text:
                      `Deze spelers in het gevolgde team staan dicht bij een prijswijziging:\n\n${lines}\n\nBekijk het overzicht: https://connectyourhealth.vercel.app/overig`,
                  }),
                });
                await sendPush(
                  alertEmail,
                  `${toAlert.length} speler(s) dreigen van prijs te veranderen`,
                  toAlert.map((t) => `${t.web_name}: ${t.verwachting}`).join(", "),
                );
                if (mailRes.ok) {
                  await sbPost(
                    "espn_price_alerts_sent",
                    toAlert.map((t) => ({
                      alert_email: alertEmail,
                      player_id: t.id,
                      verwachting: t.verwachting,
                      sent_at: capturedAt,
                    })),
                    "return=minimal,resolution=merge-duplicates",
                  );
                } else {
                  console.warn(`Prijswaarschuwing-mail (${alertEmail}) mislukt: ${mailRes.status} ${await mailRes.text()}`);
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn(`Mijn-team-sync (entry ${entryId}) mislukt: ${String(e)}`);
      }
    }

    // ---- ALGEMENE 90%-WAARSCHUWING (los van eigen team) ----
    // Mailt Nando zodra ÉÉN willekeurige speler (ook een die hij niet
    // bezit) 90% of meer van de drempel van een prijswijziging heeft
    // bereikt. Gebruikt dezelfde dedup-tabel als de team-waarschuwingen
    // hierboven, dus een speler die al gemaild is (bv. omdat hij ook in
    // een van de gevolgde teams zit) wordt niet dubbel gemaild.
    if (resendKey) {
      try {
        const boardRes = await fetch(
          `${SB_URL}/rest/v1/espn_price_board?select=id,web_name,team_short,now_cost,verwachting,progress&progress=gte.0.9`,
          { headers: sbHeaders() },
        );
        if (boardRes.ok) {
          const board: any[] = await boardRes.json();
          if (board.length) {
            const alreadyRes = await fetch(
              `${SB_URL}/rest/v1/espn_price_alerts_sent?select=player_id,verwachting&alert_email=eq.${
                encodeURIComponent(GLOBAL_WATCH_EMAIL)
              }&player_id=in.(${board.map((t) => t.id).join(",")})`,
              { headers: sbHeaders() },
            );
            const already: any[] = alreadyRes.ok ? await alreadyRes.json() : [];
            const alreadySet = new Set(already.map((a) => `${a.player_id}:${a.verwachting}`));
            const toAlert = board.filter((t) => !alreadySet.has(`${t.id}:${t.verwachting}`));
            if (toAlert.length) {
              const lines = toAlert.map((t) =>
                `- ${t.web_name} (${t.team_short}): ${t.verwachting} (${
                  Math.round((t.progress || 0) * 100)
                }% van de drempel, huidige prijs €${(t.now_cost / 10).toFixed(1)})`
              ).join("\n");
              const mailRes = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${resendKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  from: "ConnectYourHealth <onboarding@resend.dev>",
                  to: [GLOBAL_WATCH_EMAIL],
                  subject: `ESPN Fantasy: ${toAlert.length} speler(s) op 90%+ richting een prijswijziging`,
                  text:
                    `Deze spelers staan op 90% of meer richting een prijswijziging (ongeacht of ze in een van jullie teams zitten):\n\n${lines}\n\nBekijk het overzicht: https://connectyourhealth.vercel.app/overig`,
                }),
              });
              await sendPush(
                GLOBAL_WATCH_EMAIL,
                `${toAlert.length} speler(s) op 90%+ richting een prijswijziging`,
                toAlert.map((t) => `${t.web_name}: ${t.verwachting}`).join(", "),
              );
              if (mailRes.ok) {
                await sbPost(
                  "espn_price_alerts_sent",
                  toAlert.map((t) => ({
                    alert_email: GLOBAL_WATCH_EMAIL,
                    player_id: t.id,
                    verwachting: t.verwachting,
                    sent_at: capturedAt,
                  })),
                  "return=minimal,resolution=merge-duplicates",
                );
              } else {
                console.warn(`90%-waarschuwing-mail mislukt: ${mailRes.status} ${await mailRes.text()}`);
              }
            }
          }
        }
      } catch (e) {
        console.warn(`Algemene 90%-waarschuwing mislukt: ${String(e)}`);
      }
    }

    // ---- GROTE TRANSFERBEWEGING LAATSTE UUR ----
    // Los van de prijsdrempel: mailt/pusht zodra een speler in het afgelopen
    // uur opvallend veel netto transfers heeft (in of uit), ongeacht of hij
    // dicht bij een echte prijswijziging staat. Max 1x per kalenderuur (niet
    // elke 15 min opnieuw) via espn_momentum_alerts_sent.
    const MOMENTUM_THRESHOLD = 150;
    try {
      const momentumRes = await fetch(
        `${SB_URL}/rest/v1/espn_transfer_momentum?select=id,web_name,team_short,now_cost,net_1h&net_1h=not.is.null`,
        { headers: sbHeaders() },
      );
      if (momentumRes.ok) {
        const momentum: any[] = await momentumRes.json();
        const movers = momentum
          .filter((r) => Math.abs(r.net_1h) >= MOMENTUM_THRESHOLD)
          .sort((a, b) => Math.abs(b.net_1h) - Math.abs(a.net_1h))
          .slice(0, 5);
        if (movers.length) {
          const hourBucket = new Date(capturedAt);
          hourBucket.setUTCMinutes(0, 0, 0);
          const hourBucketIso = hourBucket.toISOString();
          const lines = movers.map((m) =>
            `- ${m.web_name} (${m.team_short}): ${m.net_1h > 0 ? "+" : ""}${m.net_1h} netto transfers, huidige prijs €${
              (m.now_cost / 10).toFixed(1)
            }`
          ).join("\n");
          const allEmails = new Set<string>([GLOBAL_WATCH_EMAIL]);
          for (const { alertEmails } of MY_TEAMS) for (const e of alertEmails) allEmails.add(e);
          for (const alertEmail of allEmails) {
            const alreadyRes = await fetch(
              `${SB_URL}/rest/v1/espn_momentum_alerts_sent?select=alert_email&alert_email=eq.${
                encodeURIComponent(alertEmail)
              }&hour_bucket=eq.${encodeURIComponent(hourBucketIso)}`,
              { headers: sbHeaders() },
            );
            const already: any[] = alreadyRes.ok ? await alreadyRes.json() : [];
            if (already.length) continue;
            if (resendKey) {
              const mailRes = await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  from: "ConnectYourHealth <onboarding@resend.dev>",
                  to: [alertEmail],
                  subject: `ESPN Fantasy: grote transferbeweging in het afgelopen uur`,
                  text:
                    `Deze spelers hebben in het afgelopen uur opvallend veel transfers gehad:\n\n${lines}\n\nBekijk het overzicht: https://connectyourhealth.vercel.app/overig`,
                }),
              });
              if (!mailRes.ok) {
                console.warn(`Momentum-mail (${alertEmail}) mislukt: ${mailRes.status} ${await mailRes.text()}`);
              }
            }
            await sendPush(
              alertEmail,
              `Grote transferbeweging in het afgelopen uur`,
              movers.map((m) => `${m.web_name}: ${m.net_1h > 0 ? "+" : ""}${m.net_1h}`).join(", "),
            );
            await sbPost(
              "espn_momentum_alerts_sent",
              [{ alert_email: alertEmail, hour_bucket: hourBucketIso, sent_at: capturedAt }],
              "return=minimal,resolution=merge-duplicates",
            );
          }
        }
      }
    } catch (e) {
      console.warn(`Momentum-waarschuwing mislukt: ${String(e)}`);
    }

    // ---- BEKENDE MANAGERS (mogelijke inside info) ----
    // Volgt transfers van handmatig toegevoegde bekende personen (bv.
    // oud-profs) -- een onverwachte aan-/verkoop kan wijzen op kennis over
    // een aankomende opstelling die nog niet publiek is. Best-effort: faalt
    // dit, dan gaat de rest van de sync gewoon door.
    try {
      const knownManagers: any[] = await sbGet("espn_known_managers?select=entry_id,name&active=eq.true");
      if (knownManagers.length) {
        const newTransfers: any[] = [];
        for (const km of knownManagers) {
          const trRes = await fetch(`https://fantasy.espngoal.nl/api/entry/${km.entry_id}/transfers/`);
          if (!trRes.ok) continue;
          const transfers: any[] = await trRes.json();
          for (const t of transfers) {
            const already: any[] = await sbGet(
              `espn_known_manager_transfers_seen?select=entry_id&entry_id=eq.${km.entry_id}&element_in=eq.${t.element_in}&element_out=eq.${t.element_out}&occurred_at=eq.${
                encodeURIComponent(t.time)
              }`,
            );
            if (already.length) continue;
            newTransfers.push({
              entry_id: km.entry_id,
              manager: km.name,
              element_in: t.element_in,
              element_out: t.element_out,
              event: t.event,
              occurred_at: t.time,
            });
          }
        }
        if (newTransfers.length) {
          const ids = [...new Set(newTransfers.flatMap((t) => [t.element_in, t.element_out]))];
          const players: any[] = await sbGet(`espn_players?select=id,web_name,team_short&id=in.(${ids.join(",")})`);
          const byId = new Map(players.map((p) => [p.id, p]));
          const detail = newTransfers.map((t) => {
            const pin = byId.get(t.element_in), pout = byId.get(t.element_out);
            const inLabel = pin ? `${pin.web_name} (${pin.team_short})` : `#${t.element_in}`;
            const outLabel = pout ? `${pout.web_name} (${pout.team_short})` : `#${t.element_out}`;
            return `${t.manager}: ${outLabel} → ${inLabel} (ronde ${t.event})`;
          });
          if (resendKey) {
            const mailRes = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${resendKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                from: "ConnectYourHealth <onboarding@resend.dev>",
                to: [GLOBAL_WATCH_EMAIL],
                subject: `ESPN Fantasy: ${newTransfers.length} nieuwe transfer(s) van bekende manager(s)`,
                text: `Mogelijk relevant (inside info?):\n\n${detail.map((d) => `- ${d}`).join("\n")}\n\nBekijk het overzicht: https://connectyourhealth.vercel.app/overig`,
              }),
            });
            if (!mailRes.ok) {
              console.warn(`Bekende-manager-mail mislukt: ${mailRes.status} ${await mailRes.text()}`);
            }
          }
          await sendPush(
            GLOBAL_WATCH_EMAIL,
            `${newTransfers.length} nieuwe transfer(s) van bekende manager(s)`,
            detail.join(", "),
          );
          await sbPost(
            "espn_known_manager_transfers_seen",
            newTransfers.map((t) => ({
              entry_id: t.entry_id,
              element_in: t.element_in,
              element_out: t.element_out,
              event: t.event,
              occurred_at: t.occurred_at,
              notified_at: capturedAt,
            })),
            "return=minimal,resolution=merge-duplicates",
          );
        }
      }
    } catch (e) {
      console.warn(`Bekende-managers-check mislukt: ${String(e)}`);
    }

    const ms = Date.now() - t0;
    await sbPost("espn_sync_log", [{
      ok: true,
      players_seen: seen,
      snapshots_written: snaps,
      price_changes: changes,
      duration_ms: ms,
    }]);

    return new Response(
      JSON.stringify({ ok: true, players_seen: seen, snapshots_written: snaps, price_changes: changes, duration_ms: ms }),
      { headers: { ...CORS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 900);
    try {
      await sbPost("espn_sync_log", [{
        ok: false,
        players_seen: seen,
        snapshots_written: snaps,
        price_changes: changes,
        duration_ms: Date.now() - t0,
        error: msg,
      }]);
    } catch { /* log mag falen */ }
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
