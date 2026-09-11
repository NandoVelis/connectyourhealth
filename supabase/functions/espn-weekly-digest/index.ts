// Wekelijkse samenvatting -- draait elke vrijdag om 19:00 lokale tijd (via
// pg_cron, zie migratie add_weekly_digest_cron) en berekent:
//  - de spelers met de meeste transfers (grootste |netto|) van de laatste 24u
//  - de snelst stijgende spelers (hoogste voortgang richting een stijging)
//  - per gevolgd team (MY_TEAMS): top 5 en flop 5 op basis van netto
//    transfers laatste 24u, alleen onder de eigen selectie
// Slaat het resultaat op in espn_weekly_digest (die overig.html als popup
// toont zodra er een nieuwere generated_at is dan wat de gebruiker al
// gezien heeft) en stuurt daarnaast een korte pushmelding + mail als
// aankondiging dat de update klaarstaat.

import webpush from "npm:web-push@3.6.7";

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
  const r = await fetchWithRetry(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: sbHeaders({ Prefer: prefer }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status} ${await r.text()}`);
}

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
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await fetch(
            `${SB_URL}/rest/v1/espn_push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`,
            { method: "DELETE", headers: sbHeaders() },
          );
        }
      }
    }
  } catch { /* best-effort */ }
}

const top = (arr: any[], field: string, n: number) =>
  [...arr].filter((r) => r[field] !== 0 && r[field] !== null).sort((a, b) => b[field] - a[field]).slice(0, n);
const bottom = (arr: any[], field: string, n: number) =>
  [...arr].filter((r) => r[field] !== 0 && r[field] !== null).sort((a, b) => a[field] - b[field]).slice(0, n);

const slim = (r: any, field: string) => ({
  id: r.id,
  web_name: r.web_name,
  team_short: r.team_short,
  now_cost: r.now_cost,
  value: r[field],
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const momentum: any[] = await sbGet("espn_transfer_momentum?select=*&limit=1000");
    const board: any[] = await sbGet(
      "espn_price_board?select=id,web_name,team_short,now_cost,verwachting,progress&progress=not.is.null",
    );

    const mostTransferred24h = [...momentum]
      .filter((r) => r.net_24h !== 0)
      .sort((a, b) => Math.abs(b.net_24h) - Math.abs(a.net_24h))
      .slice(0, 10)
      .map((r) => slim(r, "net_24h"));

    const fastestRisers = [...board]
      .filter((r) => r.verwachting === "stijgt" || r.verwachting === "stijgt bijna")
      .sort((a, b) => (b.progress || 0) - (a.progress || 0))
      .slice(0, 10)
      .map((r) => ({ id: r.id, web_name: r.web_name, team_short: r.team_short, now_cost: r.now_cost, value: r.progress }));

    const momentumById = new Map(momentum.map((r) => [r.id, r]));
    const teams: Record<string, any> = {};
    for (const { entryId, alertEmails } of MY_TEAMS) {
      try {
        const myTeamRows: any[] = await sbGet(`espn_my_team?entry_id=eq.${entryId}&select=picks,player_name&limit=1`);
        const picks: any[] = myTeamRows[0]?.picks || [];
        const owned = picks
          .map((p) => momentumById.get(p.element))
          .filter((r): r is any => !!r);
        teams[String(entryId)] = {
          player_name: myTeamRows[0]?.player_name || null,
          top5: top(owned, "net_24h", 5).map((r) => slim(r, "net_24h")),
          flop5: bottom(owned, "net_24h", 5).map((r) => slim(r, "net_24h")),
        };
      } catch (e) {
        console.warn(`Weekly digest team ${entryId} mislukt: ${String(e)}`);
      }
    }

    const payload = {
      generated_at: new Date().toISOString(),
      most_transferred_24h: mostTransferred24h,
      fastest_risers: fastestRisers,
      teams,
    };
    await sbPost("espn_weekly_digest", [{ payload }]);

    const notifiedEmails = new Set<string>();
    for (const { alertEmails } of MY_TEAMS) {
      for (const email of alertEmails) {
        if (notifiedEmails.has(email)) continue;
        notifiedEmails.add(email);
        await sendPush(
          email,
          "Wekelijkse ESPN Fantasy-update klaar",
          "Grootste stijgers/dalers en jouw team-highlights van deze week -- bekijk 'm in de app.",
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
