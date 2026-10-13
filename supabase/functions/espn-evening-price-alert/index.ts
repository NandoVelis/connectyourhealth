// Dagelijkse avond-melding met de prijsverwachting voor de nacht -- draait
// via pg_cron om 21:00 UTC, dus ná het dagelijkse piekvenster van
// transferactiviteit (14:00-21:00 UTC, ontdekt via analyse van de 15-min-
// snapshots) en vlak vóór de nachtelijke prijsronde (~02:30-02:45 UTC). Op
// dat moment is het grootste deel van de dagelijkse opbouw al binnen, dus
// is dit de meest betrouwbare voorspelling van de dag -- push i.p.v. alleen
// data in de app, zodat 'm niet mist wie voor 22u slaapt.
//
// Bevat ook de 90%+-mail (op verzoek, 13 okt): dit was voorheen een losse
// real-time check in espn-fantasy-sync die elke 15 min draaide en zodra een
// NIEUWE speler over 90% progress heen ging meteen apart mailde -- bij meerdere
// spelers op verschillende momenten op 1 dag gaf dat meerdere losse mails.
// Nu 1x per dag, hier, met alle spelers die op dit moment 90%+ staan in 1
// mail, inclusief duidelijke richting (omhoog/omlaag) i.p.v. alleen het
// technische "stijgt"/"daalt"-label.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GLOBAL_WATCH_EMAIL = "nandovelis@gmail.com";
const MY_TEAMS_EMAILS = ["nandovelis@gmail.com", "duncanvelis@ziggo.nl"];
// Eigen dedup-sleutel (niet GLOBAL_WATCH_EMAIL zelf) -- espn-fantasy-sync
// schrijft ZELF ook naar espn_price_alerts_sent (voor de real-time push-
// dedup, alert_email=GLOBAL_WATCH_EMAIL). Dezelfde sleutel hergebruiken zou
// betekenen dat een speler die al push-gedupt is (overdag) 's avonds
// stilzwijgend uit de mail valt, nog vóór hij ooit gemaild is -- vandaar een
// losse sleutel, zodat de dagelijkse mail-dedup onafhankelijk van de
// real-time push-dedup bijhoudt wie al gemaild is.
const EMAIL_DEDUP_KEY = `${GLOBAL_WATCH_EMAIL}#daily-digest`;

const RICHTING: Record<string, string> = {
  "stijgt": "omhoog",
  "stijgt bijna": "omhoog (bijna)",
  "daalt": "omlaag",
  "daalt bijna": "omlaag (bijna)",
};

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
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: sbHeaders({ Prefer: prefer }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status} ${await r.text()}`);
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
      "espn_price_board?select=id,web_name,team_short,now_cost,verwachting,progress,owners&verwachting=neq.stabiel&verwachting=neq.onbekend",
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

    // ---- 90%+-MAIL (1x per dag, i.p.v. de oude real-time versie) ----
    // Alleen spelers die nog niet eerder gemaild zijn voor hun huidige
    // verwachting (zelfde dedup-tabel/-aanpak als voorheen in
    // espn-fantasy-sync) -- anders zou dit elke avond alle ~170 spelers met
    // progress>=90% opnieuw mailen (progress loopt na 100% gewoon door tot
    // de prijs echt wijzigt, dus "90%+" is zonder dedup vrijwel de hele
    // stijgt/daalt-lijst, niet alleen de nieuwe/net overschreden spelers).
    const highProgressAll = board.filter((b) => (b.progress || 0) >= 0.9 && (b.owners || 0) > 0);
    let highProgress: any[] = [];
    let mailSent = false;
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (resendKey && highProgressAll.length) {
      const alreadyRes = await fetch(
        `${SB_URL}/rest/v1/espn_price_alerts_sent?select=player_id,verwachting&alert_email=eq.${
          encodeURIComponent(EMAIL_DEDUP_KEY)
        }&player_id=in.(${highProgressAll.map((t) => t.id).join(",")})`,
        { headers: sbHeaders() },
      );
      const already: any[] = alreadyRes.ok ? await alreadyRes.json() : [];
      const alreadySet = new Set(already.map((a) => `${a.player_id}:${a.verwachting}`));
      highProgress = highProgressAll
        .filter((t) => !alreadySet.has(`${t.id}:${t.verwachting}`))
        .sort((a, b) => (b.progress || 0) - (a.progress || 0));
      if (highProgress.length) {
        const lines = highProgress.map((t) =>
          `- ${t.web_name} (${t.team_short}): ${RICHTING[t.verwachting] ?? t.verwachting} (${
            Math.round((t.progress || 0) * 100)
          }% van de drempel, huidige prijs €${(t.now_cost / 10).toFixed(1)})`
        ).join("\n");
        const omhoog = highProgress.filter((t) => t.verwachting.startsWith("stijgt")).length;
        const omlaag = highProgress.filter((t) => t.verwachting.startsWith("daalt")).length;
        const mailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "ConnectYourHealth <onboarding@resend.dev>",
            to: [GLOBAL_WATCH_EMAIL],
            subject:
              `ESPN Fantasy: ${highProgress.length} speler(s) op 90%+ richting een prijswijziging (${omhoog}x omhoog, ${omlaag}x omlaag)`,
            text:
              `Deze spelers staan op 90% of meer richting een prijswijziging (ongeacht of ze in een van jullie teams zitten):\n\n${lines}\n\nBekijk het overzicht: https://connectyourhealth.vercel.app/overig`,
          }),
        });
        mailSent = mailRes.ok;
        if (mailRes.ok) {
          await sbPost(
            "espn_price_alerts_sent",
            highProgress.map((t) => ({
              alert_email: EMAIL_DEDUP_KEY,
              player_id: t.id,
              verwachting: t.verwachting,
              sent_at: new Date().toISOString(),
            })),
            "return=minimal,resolution=merge-duplicates",
          );
        } else {
          console.warn(`90%-waarschuwing-mail mislukt: ${mailRes.status} ${await mailRes.text()}`);
        }
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        stijgers: stijgers.length,
        dalers: dalers.length,
        bijna_stijgers: bijnaStijgers.length,
        bijna_dalers: bijnaDalers.length,
        high_progress_total: highProgressAll.length,
        high_progress_new: highProgress.length,
        mail_sent: mailSent,
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
