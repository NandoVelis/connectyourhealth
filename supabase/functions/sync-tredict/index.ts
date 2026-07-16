import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Alle aanroepen naar Tredict lopen via deze helper, zodat een trage of
// hangende externe request de hele functie niet meer eindeloos blokkeert.
// Zonder dit bleef de functie voor sommige accounts (bv. Nick) hangen tot
// Supabase 'm zelf afbrak, wat in de browser als "Failed to fetch" verscheen.
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error(`Tredict-aanroep naar ${url} duurde langer dan ${timeoutMs / 1000}s (timeout).`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Haalt maxConcurrent activiteiten tegelijk op i.p.v. één voor één, zodat een
// eerste volledige sync met veel activiteiten niet minutenlang duurt en een
// enkele trage/mislukte activiteit de rest niet blokkeert.
async function mapWithConcurrency<T, R>(
  items: T[],
  maxConcurrent: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current]);
    }
  }
  const workers = Array.from({ length: Math.min(maxConcurrent, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// Zelfde dagscore-formule als in dashboard.html (computeDagscore), zodat het
// teambord en het persoonlijke dashboard nooit uit de pas lopen.
function computeDagscoreServer(
  consumedKcal: number,
  training: { totalKcal?: number; activities: { kcal: number }[] } | null,
  vitals: { hrRest?: number | null; hrv?: number | null; sleepMinutes?: number | null } | null
): number | null {
  if (!consumedKcal || consumedKcal === 0) {
    const hadActivity = !!training?.activities?.some((a) => Number(a.kcal) > 0);
    return hadActivity ? 8 : 6;
  }

  const parts: number[] = [];

  if (training?.totalKcal) {
    const balans = consumedKcal - training.totalKcal;
    const absB = Math.abs(balans);
    parts.push(absB <= 200 ? 10 : Math.max(0, 10 - (absB - 200) / 144.4));
  }

  const herstelScores: number[] = [];
  if (vitals?.sleepMinutes) herstelScores.push(Math.max(0, 10 - Math.abs(vitals.sleepMinutes - 480) / 30));
  if (vitals?.hrRest != null) herstelScores.push(Math.max(0, Math.min(10, 10 - (vitals.hrRest - 35) / 2)));
  if (vitals?.hrv != null) herstelScores.push(Math.max(0, Math.min(10, vitals.hrv / 10)));
  if (herstelScores.length) {
    parts.push(herstelScores.reduce((a, b) => a + b, 0) / herstelScores.length);
  }

  if (training) {
    const actKcal = training.activities.reduce((sum, a) => sum + (Number(a.kcal) || 0), 0);
    parts.push(actKcal === 0 ? 5 : Math.min(10, actKcal / 60));
  }

  if (parts.length === 0) return null;
  return Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 10) / 10;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const url = new URL(req.url);
    const full = url.searchParams.get("full") === "1";
    const owner = (url.searchParams.get("owner") || "Nando").trim();

    // Elke persoon heeft een eigen Tredict Personal API-token, als losse
    // environment variable TREDICT_TOKEN_<NAAM> (bv. TREDICT_TOKEN_NICK).
    // Voor Nando valt dit terug op de bestaande TREDICT_TOKEN, zodat die
    // niet hernoemd hoeft te worden.
    const envKey = "TREDICT_TOKEN_" + owner.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const token = Deno.env.get(envKey) || (owner === "Nando" ? Deno.env.get("TREDICT_TOKEN") : undefined);

    if (!token) {
      return new Response(
        JSON.stringify({
          success: false,
          error:
            `Nog geen Tredict-koppeling voor "${owner}". Zo regel je dat:\n` +
            `1. Ga naar tredict.com → Instellingen → Personal API\n` +
            `2. Maak een token aan met scopes "activityRead" en "bodyvaluesRead"\n` +
            `3. Stuur dat token naar de beheerder (Nando)\n` +
            `4. De beheerder zet het in Supabase (Edge Functions → Manage secrets) als ${envKey} — NIET in Vercel, dat is een apart systeem`,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };

    // Periode geldt nu voor ALLE Tredict-data (gewicht/hartslag/HRV/slaap
    // én training), niet meer alleen voor training. Zonder deze grens
    // verwerkte de functie voorheen de VOLLEDIGE Tredict-geschiedenis van
    // een account bij elke sync, rij voor rij — dat kon bij een account met
    // veel historische data minutenlang duren of zelfs hangen.
    const DAYS_BACK = full ? 60 : 7; // knop = volledig venster, automatische sync bij laden = kort
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - DAYS_BACK);
    const cutoffDateStr = cutoffDate.toISOString().substring(0, 10);

    let weightsInserted = 0;
    let vitalsUpdated = 0;
    let trainingDaysWritten = 0;

    // BODYVALUES (gewicht + rusthartslag)
    const bodyResponse = await fetchWithTimeout(
      "https://www.tredict.com/api/oauth/v2/bodyvalues",
      { headers: authHeaders }
    );
    if (!bodyResponse.ok) {
      throw new Error(`Tredict bodyvalues gaf status ${bodyResponse.status}. Controleer of het token van "${owner}" nog geldig is.`);
    }
    const bodyData = await bodyResponse.json();

    // Deno.Map i.p.v. array: als Tredict meerdere metingen op dezelfde dag
    // teruggeeft, mag een batch-upsert nooit twee rijen met dezelfde sleutel
    // (owner+datum) bevatten — Postgres staat dat niet toe binnen één
    // aanroep ("ON CONFLICT DO UPDATE command cannot affect row a second
    // time"). Per datum houden we gewoon de laatst geziene meting aan.
    const weightByDate = new Map<string, { owner: string; weight_date: string; kg: number }>();
    const hrRestByDate = new Map<string, { owner: string; vital_date: string; hr_rest: number }>();

    for (const item of bodyData.bodyvalues || []) {
      const date = item.timestamp.substring(0, 10);
      if (date < cutoffDateStr) continue; // buiten de gekozen periode, overslaan

      if (item.weightInKilograms) {
        weightByDate.set(date, { owner, weight_date: date, kg: item.weightInKilograms });
      }
      if (item.hrRestDynamic) {
        hrRestByDate.set(date, { owner, vital_date: date, hr_rest: item.hrRestDynamic });
      }
    }
    const weightRows = Array.from(weightByDate.values());
    const hrRestRows = Array.from(hrRestByDate.values());

    // In één keer wegschrijven per tabel i.p.v. per rij een aparte aanroep —
    // dat scheelt bij een volledige (60-dagen) sync tientallen tot honderden
    // sequentiële database round-trips.
    if (weightRows.length) {
      const { error } = await supabase
        .from("weight")
        .upsert(weightRows, { onConflict: "owner,weight_date" });
      if (error) throw new Error(`Wegschrijven gewicht mislukt: ${error.message}`);
      weightsInserted = weightRows.length;
    }
    if (hrRestRows.length) {
      const { error } = await supabase
        .from("vitals")
        .upsert(hrRestRows, { onConflict: "owner,vital_date" });
      if (error) throw new Error(`Wegschrijven rusthartslag mislukt: ${error.message}`);
      vitalsUpdated += hrRestRows.length;
    }

    // HRV
    const hrvResponse = await fetchWithTimeout(
      "https://www.tredict.com/api/oauth/v2/hrv",
      { headers: authHeaders }
    );
    if (!hrvResponse.ok) {
      throw new Error(`Tredict hrv gaf status ${hrvResponse.status}.`);
    }
    const hrvData = await hrvResponse.json();

    const hrvRows: { owner: string; vital_date: string; hrv: number }[] = [];
    for (const [dateKey, values] of Object.entries(hrvData.hrv || {})) {
      const arr = values as any[];
      const isoDate = `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
      if (isoDate < cutoffDateStr) continue;
      hrvRows.push({ owner, vital_date: isoDate, hrv: arr[0] });
    }
    if (hrvRows.length) {
      const { error } = await supabase
        .from("vitals")
        .upsert(hrvRows, { onConflict: "owner,vital_date" });
      if (error) throw new Error(`Wegschrijven HRV mislukt: ${error.message}`);
      vitalsUpdated += hrvRows.length;
    }

    // SLAAP
    const sleepResponse = await fetchWithTimeout(
      "https://www.tredict.com/api/oauth/v2/sleep",
      { headers: authHeaders }
    );
    if (!sleepResponse.ok) {
      throw new Error(`Tredict sleep gaf status ${sleepResponse.status}.`);
    }
    const sleepData = await sleepResponse.json();

    const sleepRows: { owner: string; vital_date: string; sleep_minutes: number }[] = [];
    for (const [dateKey, values] of Object.entries(sleepData.sleep || {})) {
      const arr = values as any[];
      const isoDate = `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`;
      if (isoDate < cutoffDateStr) continue;
      sleepRows.push({ owner, vital_date: isoDate, sleep_minutes: Math.round(arr[0] / 60) });
    }
    if (sleepRows.length) {
      const { error } = await supabase
        .from("vitals")
        .upsert(sleepRows, { onConflict: "owner,vital_date" });
      if (error) throw new Error(`Wegschrijven slaap mislukt: ${error.message}`);
      vitalsUpdated += sleepRows.length;
    }

    // TRAINING (activiteiten)
    // Geboortedatum/lengte per persoon: eerst het zelf-ingevulde profiel uit
    // Supabase (tabel "profiles", via het dashboard bij Team ingevuld),
    // daarna pas de handmatige env vars (BIRTHDATE_<NAAM>/HEIGHT_CM_<NAAM>,
    // voor oudere accounts die nog niet via de nieuwe onboarding zijn gegaan),
    // en tot slot een generieke fallback.
    const envSuffix = owner.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const { data: profileRow } = await supabase
      .from("profiles")
      .select("birth_date, height_cm")
      .eq("owner", owner)
      .maybeSingle();

    const birthDateStr =
      profileRow?.birth_date ||
      Deno.env.get("BIRTHDATE_" + envSuffix) ||
      (owner === "Nando" ? "1992-10-20" : "1990-01-01");
    const heightCmStr =
      profileRow?.height_cm ||
      Deno.env.get("HEIGHT_CM_" + envSuffix) ||
      (owner === "Nando" ? "183" : "175");
    const BIRTH_DATE = new Date(birthDateStr);
    const HEIGHT_CM = Number(heightCmStr);

    function calculateAge(atDate: Date) {
      let age = atDate.getFullYear() - BIRTH_DATE.getFullYear();
      const m = atDate.getMonth() - BIRTH_DATE.getMonth();
      if (m < 0 || (m === 0 && atDate.getDate() < BIRTH_DATE.getDate())) age--;
      return age;
    }
    function calculateBMR(weightKg: number, atDate: Date) {
      const age = calculateAge(atDate);
      return 10 * weightKg + 6.25 * HEIGHT_CM - 5 * age + 5; // Mifflin-St Jeor
    }
    function toAmsterdamDateStr(isoDate: string) {
      return new Date(isoDate).toLocaleDateString("sv-SE", {
        timeZone: "Europe/Amsterdam",
      });
    }

    const sportTypeMap: Record<string, string> = {
      running: "hardlopen",
      cycling: "fietsen",
      swimming: "zwemmen",
    };

    const activityListResponse = await fetchWithTimeout(
      "https://www.tredict.com/api/oauth/v2/activityList?pageSize=100",
      { headers: authHeaders }
    );
    if (!activityListResponse.ok) {
      throw new Error(`Tredict activityList gaf status ${activityListResponse.status}.`);
    }
    const activityListData = await activityListResponse.json();
    const allActivities = activityListData?._embedded?.activityList || [];
    const recentActivities = allActivities.filter(
      (a: any) => new Date(a.date) >= cutoffDate
    );

    // Detail-aanroepen parallel (max 5 tegelijk) i.p.v. één voor één; een
    // enkele mislukte/trage activiteit slaat de sync niet meer plat, maar
    // wordt overgeslagen met een console-warning.
    const activityDetails = await mapWithConcurrency(
      recentActivities,
      5,
      async (act: any) => {
        try {
          const detailResponse = await fetchWithTimeout(
            `https://www.tredict.com/api/oauth/v2/activity/${act.id}`,
            { headers: authHeaders }
          );
          if (!detailResponse.ok) {
            console.warn(`Activiteit ${act.id} gaf status ${detailResponse.status}, overgeslagen.`);
            return null;
          }
          const detail = await detailResponse.json();
          return { act, detail };
        } catch (e) {
          console.warn(`Activiteit ${act.id} overgeslagen: ${String(e)}`);
          return null;
        }
      }
    );

    const activitiesByDate: Record<string, any[]> = {};
    for (const entry of activityDetails) {
      if (!entry) continue;
      const { act, detail } = entry;
      const dateStr = toAmsterdamDateStr(act.date);
      if (!activitiesByDate[dateStr]) activitiesByDate[dateStr] = [];
      activitiesByDate[dateStr].push({
        name: detail.title || detail.sportType,
        kcal: Math.round(detail.summary?.calories || 0),
        km: detail.summary?.distance
          ? Math.round((detail.summary.distance / 1000) * 100) / 100
          : 0,
        type: sportTypeMap[detail.sportType] || detail.sportType,
      });
    }

    for (const [dateStr, activities] of Object.entries(activitiesByDate)) {
      const activityKcalSum = activities.reduce(
        (sum, a: any) => sum + (a.kcal || 0),
        0
      );

      const { data: weightRow } = await supabase
        .from("weight")
        .select("kg")
        .eq("owner", owner)
        .lte("weight_date", dateStr)
        .order("weight_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      const weightKg = weightRow?.kg || 63;
      const restKcal = Math.round(calculateBMR(weightKg, new Date(dateStr)) * 1.31);
      const totalKcal = restKcal + activityKcalSum;

      await supabase
        .from("training")
        .delete()
        .eq("training_date", dateStr)
        .eq("owner", owner);
      const rows = activities.map((a: any) => ({
        owner,
        training_date: dateStr,
        activity_name: a.name,
        kcal: a.kcal,
        km: a.km,
        activity_type: a.type,
        rest_kcal: restKcal,
        total_kcal: totalKcal,
      }));
      await supabase.from("training").insert(rows);
      trainingDaysWritten++;
    }

    // ---- TEAMBORD (real-time) ----
    // Voorheen werd het gedeelde teambord alleen bijgewerkt als iemand zelf
    // het dashboard opende (client-side push) — dus nieuwe Tredict-data
    // (bijv. een zwemactiviteit) verscheen daar pas ná een volgend bezoek,
    // wat aanvoelde als "het werkt niet". Nu berekent de sync zelf voor elke
    // dag die training bevat direct het teambord-record, met dezelfde
    // dagscore-formule als de app.
    let teamEntriesUpdated = 0;
    for (const [dateStr, activities] of Object.entries(activitiesByDate)) {
      const kmByType = { hardlopen: 0, fietsen: 0, zwemmen: 0 } as Record<string, number>;
      let activityKcalSum = 0;
      for (const a of activities as any[]) {
        activityKcalSum += a.kcal || 0;
        if (a.type in kmByType) kmByType[a.type] += Number(a.km) || 0;
      }

      const [{ data: dayVitals }, { data: dayMeals }] = await Promise.all([
        supabase.from("vitals").select("hr_rest, hrv, sleep_minutes").eq("owner", owner).eq("vital_date", dateStr).maybeSingle(),
        supabase.from("meals").select("kcal").eq("owner", owner).eq("meal_date", dateStr),
      ]);
      const consumedKcal = (dayMeals || []).reduce((s: number, m: any) => s + (Number(m.kcal) || 0), 0);

      const { data: weightRow } = await supabase
        .from("weight")
        .select("kg")
        .eq("owner", owner)
        .lte("weight_date", dateStr)
        .order("weight_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      const weightKg = weightRow?.kg || 63;
      const restKcal = Math.round(calculateBMR(weightKg, new Date(dateStr)) * 1.31);
      const totalKcal = restKcal + activityKcalSum;

      const dagscore = computeDagscoreServer(
        consumedKcal,
        { totalKcal, activities },
        { hrRest: dayVitals?.hr_rest, hrv: dayVitals?.hrv, sleepMinutes: dayVitals?.sleep_minutes }
      );

      const { error: teamErr } = await supabase.from("team_entries").upsert(
        {
          name: owner,
          entry_date: dateStr,
          dagscore,
          km_hardlopen: kmByType.hardlopen,
          km_fietsen: kmByType.fietsen,
          km_zwemmen: kmByType.zwemmen,
          hrv: dayVitals?.hrv ?? null,
          hr_rest: dayVitals?.hr_rest ?? null,
          sleep_minutes: dayVitals?.sleep_minutes ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "name,entry_date" }
      );
      if (!teamErr) teamEntriesUpdated++;
    }

    return new Response(
      JSON.stringify(
        {
          success: true,
          owner,
          weightsInserted,
          vitalsUpdated,
          trainingDaysWritten,
          teamEntriesUpdated,
          daysBack: DAYS_BACK,
          message: "Sync completed",
        },
        null,
        2
      ),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify(
        {
          success: false,
          error: String(error),
        },
        null,
        2
      ),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
