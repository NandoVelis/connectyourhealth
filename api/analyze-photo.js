export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64, mediaType } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 ontbreekt' });
    }

    const GEMINI_MODEL = 'gemini-3.5-flash'; // actueel gratis-tier model (gemini-2.5-flash is uitgezet)
    const apiKey = process.env.GEMINI_API_KEY;

    async function callGemini() {
      return fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    inline_data: {
                      mime_type: mediaType || 'image/jpeg',
                      data: imageBase64,
                    },
                  },
                  {
                    text: 'Schat de voedingswaarden van deze maaltijd in. Antwoord ALLEEN met geldige JSON, geen markdown, geen uitleg: {"desc": "korte omschrijving in het Nederlands", "kcal": <getal>, "protein": <gram>, "carbs": <gram>, "fat": <gram>}',
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.2,
            },
          }),
        }
      );
    }

    // Gemini's gratis tier geeft af en toe een 503 ("model overloaded") terug
    // bij drukte. Eén retry met een korte pauze, zodat de totale wachttijd
    // (incl. eventuele trage requests op mobiel internet) ruim binnen de
    // 90s-timeout aan de clientkant blijft.
    let response;
    let data;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      response = await callGemini();
      data = await response.json();

      if (response.ok) break;
      if (response.status !== 503 || attempt === maxAttempts) break;

      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!response.ok) {
      const friendlyError =
        response.status === 503
          ? 'De AI-dienst is momenteel overbelast (gratis tier). Probeer het over een minuutje nog eens.'
          : data;
      return res.status(response.status).json({ error: friendlyError });
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return res.status(200).json({ text });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
  maxDuration: 60,
};
