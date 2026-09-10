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

async function sbGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status} ${await r.text()}`);
  return await r.json();
}

async function sbPost(path: string, rows: unknown[], prefer = "return=minimal") {
  if (!rows.length) return;
  // in blokken van 500 om payloadlimieten te vermijden
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
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

// ---- EENMALIGE TEST MET TERUGWERKENDE KRACHT (?backfill=1) ----
// Herhaalt de "daadwerkelijke prijswijziging"-meldingen hierboven, maar dan
// voor prijswijzigingen die al eerder gedetecteerd zijn (bv. vannacht) en
// dus niet meer als "changedPlayerIds" in een normale sync-run voorkomen.
// Uitsluitend handmatig aan te roepen met ?backfill=1 -- pg_cron roept de
// functie nooit met die query-param aan, dus dit draait nooit vanzelf mee.
// Bedoeld als eenmalige test na het toevoegen van de melding hierboven,
// niet als permanent onderdeel van de reguliere sync.
async function runBackfillTest(sinceIso: string): Promise<Response> {
  const events: any[] = await sbGet(
    `espn_price_events?select=*&detected_at=gte.${encodeURIComponent(sinceIso)}&order=detected_at.asc`,
  );
  if (!events.length) {
    return new Response(JSON.stringify({ ok: true, message: `Geen prijswijzigingen sinds ${sinceIso}.` }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const playerIds = [...new Set(events.map((e) => e.player_id))];
  const players: any[] = await sbGet(`espn_players?select=id,web_name,team_short&id=in.(${playerIds.join(",")})`);
  const playerById = new Map(players.map((p) => [p.id, p]));
  const eventByPlayerId = new Map(events.map((e) => [e.player_id, e]));
  const line = (id: number) => {
    const pl = playerById.get(id)!;
    const ev = eventByPlayerId.get(id)!;
    return `- ${pl.web_name} (${pl.team_short}): €${(ev.old_cost / 10).toFixed(1)} -> €${(ev.new_cost / 10).toFixed(1)}`;
  };
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const alertedTo = new Set<string>();
  const summary: Record<string, number> = {};

  for (const { entryId, alertEmails } of MY_TEAMS) {
    try {
      const entryRes = await fetch(`https://fantasy.espngoal.nl/api/entry/${entryId}/`);
      if (!entryRes.ok) continue;
      const entry = await entryRes.json();
      const currentEvent: number | null = entry.current_event ?? null;
      if (!currentEvent) continue;
      const picksRes = await fetch(`https://fantasy.espngoal.nl/api/entry/${entryId}/event/${currentEvent}/picks/`);
      if (!picksRes.ok) continue;
      const picks = await picksRes.json();
      const ownedChangedIds: number[] = (picks?.picks ?? [])
        .map((p: any) => p.element)
        .filter((id: number) => playerById.has(id));
      if (!ownedChangedIds.length) continue;
      const lines = ownedChangedIds.map(line).join("\n");
      for (const alertEmail of alertEmails) {
        if (resendKey) {
          const mailRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: "ConnectYourHealth <onboarding@resend.dev>",
              to: [alertEmail],
              subject: `ESPN Fantasy (test, terugwerkend): prijs gewijzigd voor ${ownedChangedIds.length} speler(s) in dit team`,
              text: `Eenmalige test met terugwerkende kracht sinds ${sinceIso}:\n\n${lines}\n\nBekijk het overzicht: https://connectyourhealth.vercel.app/overig`,
            }),
          });
          if (!mailRes.ok) console.warn(`Backfill-mail (${alertEmail}) mislukt: ${mailRes.status} ${await mailRes.text()}`);
        }
        await sendPush(
          alertEmail,
          `(test) ${ownedChangedIds.length} speler(s) in dit team van prijs veranderd`,
          ownedChangedIds.map((id) => playerById.get(id)!.web_name).join(", "),
        );
        ownedChangedIds.forEach((id) => alertedTo.add(`${alertEmail}:${id}`));
        summary[alertEmail] = (summary[alertEmail] ?? 0) + ownedChangedIds.length;
      }
    } catch (e) {
      console.warn(`Backfill-team ${entryId} mislukt: ${String(e)}`);
    }
  }

  const globalIds = playerIds.filter((id) => !alertedTo.has(`${GLOBAL_WATCH_EMAIL}:${id}`));
  if (globalIds.length) {
    const lines = globalIds.map(line).join("\n");
    if (resendKey) {
      const mailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "ConnectYourHealth <onboarding@resend.dev>",
          to: [GLOBAL_WATCH_EMAIL],
          subject: `ESPN Fantasy (test, terugwerkend): ${globalIds.length} speler(s) van prijs veranderd`,
          text: `Eenmalige test met terugwerkende kracht sinds ${sinceIso}:\n\n${lines}\n\nBekijk het overzicht: https://connectyourhealth.vercel.app/overig`,
        }),
      });
      if (!mailRes.ok) console.warn(`Backfill-mail (globaal) mislukt: ${mailRes.status} ${await mailRes.text()}`);
    }
    await sendPush(
      GLOBAL_WATCH_EMAIL,
      `(test) ${globalIds.length} speler(s) van prijs veranderd`,
      globalIds.map((id) => playerById.get(id)!.web_name).join(", "),
    );
    summary[GLOBAL_WATCH_EMAIL] = (summary[GLOBAL_WATCH_EMAIL] ?? 0) + globalIds.length;
  }

  return new Response(
    JSON.stringify({ ok: true, since: sinceIso, events_found: events.length, sent_per_email: summary }),
    { headers: { ...CORS, "Content-Type": "application/json" } },
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  if (url.searchParams.get("backfill") === "1") {
    const since = url.searchParams.get("since") || new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    try {
      return await runBackfillTest(since);
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).slice(0, 900);
      return new Response(JSON.stringify({ ok: false, error: msg }), {
        status: 500,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
  }

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
      "espn_players?select=id,now_cost,transfers_in,transfers_out,net_at_last_change&limit=2000",
    );
    const prev = new Map<number, any>(prevRows.map((r) => [r.id, r]));

    const capturedAt = new Date().toISOString();
    const playerRows: any[] = [];
    const changedRows: any[] = [];
    const snapRows: any[] = [];
    const eventRows: any[] = [];
    const changedPlayerIds: number[] = [];

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

      const changedSincePrev = !p ||
        p.now_cost !== e.now_cost ||
        Number(p.transfers_in) !== tin ||
        Number(p.transfers_out) !== tout;

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

    // Lookup-tabellen voor de "daadwerkelijke wijziging"-meldingen hieronder
    // (los van de "dreigt te wijzigen"-waarschuwing, die alleen de fase
    // vóór de wijziging dekt -- een wijziging die tussen twee syncs door
    // "in één keer" gebeurt, sloeg die fase soms over zonder ooit gemeld
    // te zijn). alertedActualChange voorkomt een dubbele melding aan
    // hetzelfde e-mailadres (bv. Nando krijgt 'm al via zijn eigen team,
    // dan hoeft de algemene melding hieronder niet nogmaals).
    const changedById = new Map(playerRows.filter((r) => changedPlayerIds.includes(r.id)).map((r) => [r.id, r]));
    const eventByPlayerId = new Map(eventRows.map((e) => [e.player_id, e]));
    const alertedActualChange = new Set<string>();

    // Een speler die daadwerkelijk van prijs veranderd is, start weer op 0 --
    // eerder verstuurde waarschuwingen voor die speler mogen dus weer
    // opnieuw kunnen afgaan bij een volgende dreigende wijziging.
    if (changedPlayerIds.length) {
      await fetch(
        `${SB_URL}/rest/v1/espn_price_alerts_sent?player_id=in.(${changedPlayerIds.join(",")})`,
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
              ownedChangedIds.forEach((id) => alertedActualChange.add(`${alertEmail}:${id}`));
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

    // ---- ALGEMENE DAADWERKELIJKE PRIJSWIJZIGING (los van eigen team) ----
    // Net als de 90%-waarschuwing hierboven, maar dan voor de wijziging
    // zelf i.p.v. het naderen ervan -- dekt ook spelers die je niet bezit
    // (bv. Edvardsen, geen speler in een van de gevolgde teams). Spelers
    // die al via hun eigen team aan hetzelfde e-mailadres gemeld zijn
    // (alertedActualChange hierboven) worden hier overgeslagen, anders
    // krijgt Nando (die ook GLOBAL_WATCH_EMAIL is) 'm dubbel.
    if (changedPlayerIds.length) {
      try {
        const toReport = changedPlayerIds.filter((id) =>
          !alertedActualChange.has(`${GLOBAL_WATCH_EMAIL}:${id}`)
        );
        if (toReport.length) {
          const lines = toReport.map((id) => {
            const pl = changedById.get(id)!;
            const ev = eventByPlayerId.get(id)!;
            return `- ${pl.web_name} (${pl.team_short}): €${(ev.old_cost / 10).toFixed(1)} -> €${
              (ev.new_cost / 10).toFixed(1)
            }`;
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
                to: [GLOBAL_WATCH_EMAIL],
                subject: `ESPN Fantasy: ${toReport.length} speler(s) van prijs veranderd`,
                text:
                  `Deze spelers zijn zojuist van prijs veranderd (ongeacht of ze in een van jullie teams zitten):\n\n${lines}\n\nBekijk het overzicht: https://connectyourhealth.vercel.app/overig`,
              }),
            });
            if (!mailRes.ok) {
              console.warn(`Algemene prijswijziging-mail mislukt: ${mailRes.status} ${await mailRes.text()}`);
            }
          }
          await sendPush(
            GLOBAL_WATCH_EMAIL,
            `${toReport.length} speler(s) van prijs veranderd`,
            toReport.map((id) => changedById.get(id)!.web_name).join(", "),
          );
        }
      } catch (e) {
        console.warn(`Algemene prijswijziging-melding mislukt: ${String(e)}`);
      }
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
