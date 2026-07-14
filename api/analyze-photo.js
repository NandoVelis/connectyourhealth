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

    const response = await fetch(
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

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data });
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
};
