// Triggert de bestaande "Auto-sync Garmin" GitHub Action on-demand, i.p.v. te
// wachten op de volgende geplande run (elke 15 min, en die loopt op GitHub's
// gratis/publieke-repo-scheduler vaak alsnog 1-3 uur achter). Wordt aangeroepen
// vanuit index.html.html nadat een maaltijd is opgeslagen -- Nando eet na het
// hardlopen, dus dat moment is een goede proxy voor "er staat waarschijnlijk
// een verse Garmin-activiteit/weging klaar om opgehaald te worden".
//
// Vereist een Supabase secret GITHUB_TOKEN: een fine-grained GitHub personal
// access token, gescoped tot alleen deze repo, met "Actions: read and write"
// rechten (Settings -> Developer settings -> Personal access tokens ->
// Fine-grained tokens, op github.com). Zonder die secret slaat dit stil over
// (net als de e-mail-/pushwaarschuwingen zonder hun eigen secrets) -- de
// maaltijd wordt gewoon opgeslagen, alleen de extra sync-trigger blijft dan
// achterwege.

const GITHUB_OWNER = "NandoVelis";
const GITHUB_REPO = "connectyourhealth";
const WORKFLOW_FILE = "auto-sync-garmin.yml";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const githubToken = Deno.env.get("GITHUB_TOKEN");
  if (!githubToken) {
    return new Response(JSON.stringify({ ok: false, skipped: true, reason: "GITHUB_TOKEN niet gezet" }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "connectyourhealth-trigger-garmin-sync",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      return new Response(JSON.stringify({ ok: false, status: res.status, error: text }), {
        status: 502,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
