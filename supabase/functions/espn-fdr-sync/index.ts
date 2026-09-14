// Haalt de Fixture Difficulty Rating (FDR) op van eredivisiepreview.com/fdr
// en slaat 'm op in espn_fdr -- deze site heeft geen JSON-API, alleen een
// server-gerenderde HTML-tabel (Team x Speelronde), dus dit parsed de
// vaste, repetitieve markup-structuur met regexen i.p.v. een DOM-parser
// (scheelt een zware dependency voor iets dat maar 1x per dag hoeft te
// draaien). Draait via pg_cron, 1x per dag -- de FDR verandert alleen bij
// een verzet programma, niet continu zoals de prijzen/transfers.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FDR_URL = "https://www.eredivisiepreview.com/fdr";

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

async function sbPost(path: string, rows: unknown[], prefer = "return=minimal") {
  if (!rows.length) return;
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: sbHeaders({ Prefer: prefer }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`POST ${path} -> ${r.status} ${await r.text()}`);
}

// eredivisiepreview.com gebruikt "AZA" als teamcode voor AZ Alkmaar; onze
// eigen espn_teams-tabel (rechtstreeks van ESPN Fantasy) gebruikt "AZ".
// Alle overige 17 clubcodes komen exact overeen.
const CODE_FIX: Record<string, string> = { AZA: "AZ" };
const normalizeCode = (code: string) => CODE_FIX[code] ?? code;

function parseFdrTable(html: string) {
  const gameweeks = [...html.matchAll(/<th class="whitespace-nowrap">Speelronde (\d+)<\/th>/g)]
    .map((m) => Number(m[1]));

  const rows: { team: string; event: number; opponent: string; is_home: boolean; fdr: number }[] = [];

  const trRegex = /<tr class="bg-gray-50">([\s\S]*?)<\/tr>/g;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(html))) {
    const trHtml = trMatch[1];
    const teamMatch = trHtml.match(/<h3>&nbsp;(\S+)&nbsp;<\/h3>/);
    if (!teamMatch) continue;
    const team = normalizeCode(teamMatch[1]);

    const cellRegex = /bg-fdr-(\d)[^']*'>\s*([\s\S]*?)<\/td>/g;
    let cellMatch: RegExpExecArray | null;
    let i = 0;
    while ((cellMatch = cellRegex.exec(trHtml))) {
      const fdr = Number(cellMatch[1]);
      const inner = cellMatch[2].trim();
      const opMatch = inner.match(/(\S+)\s*\((t|u)\)/);
      const event = gameweeks[i];
      i++;
      if (!opMatch || event == null) continue;
      rows.push({
        team,
        event,
        opponent: normalizeCode(opMatch[1]),
        is_home: opMatch[2] === "t",
        fdr,
      });
    }
  }

  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const res = await fetch(FDR_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; connectyourhealth-fdr-sync/1.0)",
        Accept: "text/html",
      },
    });
    if (!res.ok) throw new Error(`FDR-pagina -> ${res.status}`);
    const html = await res.text();

    const parsed = parseFdrTable(html);
    if (!parsed.length) throw new Error("Geen FDR-rijen gevonden -- pagina-structuur mogelijk gewijzigd");

    const capturedAt = new Date().toISOString();
    const rows = parsed.map((r) => ({
      team_short: r.team,
      event: r.event,
      opponent_short: r.opponent,
      is_home: r.is_home,
      fdr: r.fdr,
      updated_at: capturedAt,
    }));

    await sbPost("espn_fdr", rows, "return=minimal,resolution=merge-duplicates");

    return new Response(
      JSON.stringify({ ok: true, rows_written: rows.length }),
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
