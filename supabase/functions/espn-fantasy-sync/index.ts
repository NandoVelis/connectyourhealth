// ESPN Fantasy Voetbal (Eredivisie) — price tracker sync
// Haalt bootstrap-static op, schrijft snapshots van gewijzigde spelers weg
// en detecteert prijswijzigingen. Bedoeld om elke 15 min door pg_cron te draaien.
// Synct daarnaast Nando's eigen team (entry 28264) -- publiek leesbare
// endpoints, geen ESPN-login nodig.

const API = "https://fantasy.espngoal.nl/api/bootstrap-static/";
const ENTRY_ID = 28264;
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
      if (lastChangeAt !== undefined) {
        row.last_change_at = lastChangeAt;
        row.last_change_direction = lastDir;
      }
      playerRows.push(row);
    }

    await sbPost("espn_players", playerRows, "return=minimal,resolution=merge-duplicates");
    await sbPost("espn_snapshots", snapRows);
    await sbPost("espn_price_events", eventRows);
    snaps = snapRows.length;

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

    // ---- MIJN TEAM (entry 28264, publiek leesbare endpoints) ----
    // Best-effort: gaat dit mis, dan mag de rest van de sync (prijzen,
    // kritieker) gewoon doorlopen.
    try {
      const entryRes = await fetch(`https://fantasy.espngoal.nl/api/entry/${ENTRY_ID}/`);
      if (entryRes.ok) {
        const entry = await entryRes.json();
        const historyRes = await fetch(`https://fantasy.espngoal.nl/api/entry/${ENTRY_ID}/history/`);
        const history = historyRes.ok ? await historyRes.json() : null;

        const currentEvent: number | null = entry.current_event ?? null;
        let picks: any = null;
        if (currentEvent) {
          const picksRes = await fetch(
            `https://fantasy.espngoal.nl/api/entry/${ENTRY_ID}/event/${currentEvent}/picks/`,
          );
          if (picksRes.ok) picks = await picksRes.json();
        }

        await fetch(`${SB_URL}/rest/v1/espn_my_team`, {
          method: "POST",
          headers: sbHeaders({ Prefer: "return=minimal,resolution=merge-duplicates" }),
          body: JSON.stringify([{
            entry_id: ENTRY_ID,
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

        // ---- PRIJSWAARSCHUWING VOOR SPELERS IN MIJN TEAM ----
        // Mailt alleen als RESEND_API_KEY als Supabase-secret gezet is
        // (Edge Functions -> Manage secrets) -- zonder die secret slaat dit
        // stil over, de rest van de sync blijft gewoon werken. Elke speler
        // wordt maar 1x per "verwachting"-status gemaild (bijgehouden in
        // espn_price_alerts_sent, opgeschoond zodra de prijs echt wijzigt),
        // zodat dezelfde dreigende wijziging niet elke 15 min opnieuw mailt.
        const resendKey = Deno.env.get("RESEND_API_KEY");
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
            if (threatened.length) {
              const alreadyRes = await fetch(
                `${SB_URL}/rest/v1/espn_price_alerts_sent?select=player_id,verwachting&player_id=in.(${
                  threatened.map((t) => t.id).join(",")
                })`,
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
                    to: ["nandovelis@gmail.com"],
                    subject: `ESPN Fantasy: ${toAlert.length} speler(s) in jouw team dreigen van prijs te veranderen`,
                    text:
                      `Deze spelers in jouw team staan dicht bij een prijswijziging:\n\n${lines}\n\nBekijk het overzicht: https://connectyourhealth.vercel.app/overig`,
                  }),
                });
                if (mailRes.ok) {
                  await sbPost(
                    "espn_price_alerts_sent",
                    toAlert.map((t) => ({ player_id: t.id, verwachting: t.verwachting, sent_at: capturedAt })),
                    "return=minimal,resolution=merge-duplicates",
                  );
                } else {
                  console.warn(`Prijswaarschuwing-mail mislukt: ${mailRes.status} ${await mailRes.text()}`);
                }
              }
            }
          }
        }
      } else {
        console.warn(`espn entry ${ENTRY_ID} gaf status ${entryRes.status}, overgeslagen.`);
      }
    } catch (e) {
      console.warn(`Mijn-team-sync mislukt: ${String(e)}`);
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
