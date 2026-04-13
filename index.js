require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json({ limit: '20mb' }));

// Enable CORS for all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// OpenRouter API configuration
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_CHAT_MODEL = process.env.OPENROUTER_CHAT_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
const OPENROUTER_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-pro-exp:free';

if (!OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY not set in .env');
  process.exit(1);
}

console.log(`✓ Using OpenRouter with chat model: ${OPENROUTER_CHAT_MODEL}`);
console.log(`✓ Using OpenRouter with vision model: ${OPENROUTER_VISION_MODEL}`);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Test endpoint (no auth) ────────────────────────────────────────────────
app.post('/api/test', async (req, res) => {
  try {
    console.log('[test] Calling OpenRouter with simple prompt...');
    const openrouterRes = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_CHAT_MODEL,
        messages: [{ role: 'user', content: 'Say hello' }],
      }),
    });

    if (!openrouterRes.ok) {
      const error = await openrouterRes.text();
      console.error('[test] OpenRouter error:', error);
      return res.status(500).json({ error: `OpenRouter error: ${openrouterRes.status}` });
    }

    const data = await openrouterRes.json();
    const reply = data.choices?.[0]?.message?.content || 'No response';
    res.json({ reply });
  } catch (err) {
    console.error('[test] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Auth guard ─────────────────────────────────────────────────────────────
// Every request must carry a valid Supabase session token.
// If the token is missing or invalid we reject before touching Gemini at all.
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    console.warn('[auth] Missing or invalid Authorization header');
    return res.status(401).json({ error: 'Unauthorised — sign in to use the AI features.' });
  }
  const token = auth.slice(7);
  try {
    console.log('[auth] Validating token with Supabase...');
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
    });
    console.log('[auth] Supabase response status:', r.status);
    if (!r.ok) {
      const errText = await r.text();
      console.error('[auth] Supabase error:', errText);
      return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    }
    req.user = await r.json();
    console.log('[auth] ✓ User authenticated:', req.user.email);
    next();
  } catch (err) {
    console.error('[auth] Check failed:', err.message);
    res.status(500).json({ error: 'Auth check failed.' });
  }
}

// ── Garden AI chat ─────────────────────────────────────────────────────────
app.post('/api/garden-ai', requireAuth, async (req, res) => {
  const { messages, context } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided.' });
  }

  const now = new Date();
  const monthName = now.toLocaleString('en-GB', { month: 'long' });
  const month = now.getMonth();
  const season =
    month < 2 || month === 11 ? 'winter'
    : month < 5 ? 'spring'
    : month < 8 ? 'summer'
    : 'autumn';

  const systemPrompt = `You are Allotment Buddy's AI garden assistant — friendly, knowledgeable, and encouraging. You help UK allotment gardeners plan and maintain their gardens.

Current garden context: ${context || 'No context provided.'}
Current date: ${now.toLocaleDateString('en-GB')} (${monthName}, ${season})

You are an EXPERT in:
- UK allotment gardening with knowledge of typical UK frost dates (last frost: late April south, mid-May north; first frost: mid-October north, late November south)
- Companion planting — which plants help or hinder each other
- Crop rotation — 4-year rotation groups (legumes, brassicas, roots/alliums, solanaceae/cucurbits)
- Soil health and organic matter
- Pest and disease management (slugs, carrot fly, blight, etc.)

NUTRIENT & FEEDING ADVICE — always consider:
- Tomatoes: high-potash feed weekly once fruiting starts
- Brassicas: nitrogen-rich feed, lime soil if acidic
- Root veg: avoid high nitrogen (causes forking)
- Legumes: fix their own nitrogen — don't over-feed
- Fruiting plants (peppers, courgettes, aubergines): balanced feed, then high-potash when fruiting
- General: blood fish & bone for planting, comfrey tea as liquid feed, seaweed extract for micronutrients
- Timing: start feeding late spring, increase in summer, reduce in autumn

Guidelines:
- Give practical, specific advice for UK/temperate climate gardening
- Mention companion planting benefits and things to avoid
- Suggest crop rotation when relevant
- Recommend specific feeds/nutrients when the user has planted specific crops
- Consider the current month and what should be done NOW
- Keep responses concise but helpful (2–3 paragraphs max)
- Use emojis sparingly for friendliness
- If suggesting layouts, describe positions clearly
- Suggest organic solutions first for pests`;

  try {
    console.log('[garden-ai] Processing request with OpenRouter...');

    // Build conversation with system prompt
    const conversationMessages = [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...messages,
    ];

    console.log('[garden-ai] Calling OpenRouter with', messages.length, 'messages');
    const openrouterRes = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_CHAT_MODEL,
        messages: conversationMessages,
        temperature: 0.7,
        max_tokens: 1000,
      }),
    });

    if (!openrouterRes.ok) {
      const error = await openrouterRes.text();
      console.error('[garden-ai] OpenRouter error:', error);
      return res.status(500).json({ error: 'AI service unavailable. Check API key.' });
    }

    const data = await openrouterRes.json();
    const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
    console.log('[garden-ai] ✓ Response generated');
    res.json({ reply });
  } catch (err) {
    console.error('[garden-ai] Error:', err.message || err);
    res.status(500).json({ error: err.message || 'AI request failed.' });
  }
});

// ── Grow guide ─────────────────────────────────────────────────────────────
app.post('/api/grow-guide', requireAuth, async (req, res) => {
  const { plants } = req.body;
  if (!plants) return res.status(400).json({ error: 'No plants provided.' });

  const systemPrompt = `You are an expert UK allotment gardening advisor. The user has selected plants they want to grow. Create a comprehensive, personalised growing guide.

For each plant, provide:
1. **When to start** — exact months for sowing indoors, transplanting, and direct sowing
2. **Where to plant** — sun requirements, spacing, and plot position tips
3. **Companion planting** — what to grow nearby and what to avoid
4. **Key care tips** — watering, feeding, common pests
5. **Expected harvest** — when and how to harvest

Then provide an **Overall Plan**:
- A month-by-month timeline showing what to do when
- Crop rotation advice if relevant
- Layout suggestions for how to arrange them on a plot

Keep it practical, specific to UK climate, and encouraging. Use markdown formatting with headers and bullet points. Use emojis sparingly.`;

  try {
    console.log('[grow-guide] Processing request with OpenRouter...');
    const openrouterRes = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `I want to grow these plants on my UK allotment:\n\n${plants}\n\nPlease create a comprehensive growing guide with timings, companions, and layout suggestions.` },
        ],
      }),
    });

    if (!openrouterRes.ok) {
      const error = await openrouterRes.text();
      console.error('[grow-guide] OpenRouter error:', error);
      return res.status(500).json({ error: 'AI service unavailable. Check API key.' });
    }

    const data = await openrouterRes.json();
    const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a guide.';
    console.log('[grow-guide] ✓ Response generated');
    res.json({ reply });
  } catch (err) {
    console.error('[grow-guide] Error:', err.message || err);
    res.status(500).json({ error: err.message || 'AI request failed.' });
  }
});

// ── Watering guide ─────────────────────────────────────────────────────────
app.post('/api/watering-guide', requireAuth, async (req, res) => {
  const { weatherData, plants, structures } = req.body;
  if (!weatherData || !plants) return res.status(400).json({ error: 'Missing required data.' });

  // Format plants array into readable text
  const plantsText = Array.isArray(plants)
    ? plants.map((p) => `${p.emoji} ${p.name} (${p.category}, ${p.location}${p.selfWatering ? ', self-watering' : ''})`).join('\n')
    : plants;

  const systemPrompt = `You are Allotment Buddy's AI watering advisor. Analyze weather data and garden plants to give specific, actionable watering recommendations.

You MUST respond with valid JSON matching this exact structure:
{
  "summary": "Brief overall watering advice for today (1-2 sentences)",
  "overallStatus": "water" | "skip" | "reduce" | "extra",
  "plants": [
    {
      "name": "Plant name",
      "emoji": "🌱",
      "recommendation": "skip" | "light" | "normal" | "heavy",
      "reason": "Short reason why",
      "nextWaterDays": 1
    }
  ],
  "tips": ["Tip 1", "Tip 2"],
  "forecast": "Brief 3-day watering outlook based on forecast"
}

Guidelines:
- Plants inside structures are INDOOR — they don't get rain
- Outdoor plants get natural rainfall
- If it's raining or rain is forecast, outdoor plants may not need watering
- Hot weather (>25°C) = more water needed
- Cool/humid weather (<15°C, >70% humidity) = less water needed
- Be specific: mention each plant by name with its emoji
- Return recommendations for ALL plants listed`;

  const userPrompt = `Current weather & garden data:

WEATHER:
- Temperature: ${weatherData.temperature}°C
- Humidity: ${weatherData.humidity}%
- Wind: ${weatherData.windSpeed} km/h
- Conditions: ${weatherData.conditions}

PLANTS IN GARDEN:
${plantsText}

Analyze this data and provide watering recommendations for EACH plant listed above.`;

  try {
    console.log('[watering-guide] Processing request with OpenRouter...');
    const openrouterRes = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!openrouterRes.ok) {
      const error = await openrouterRes.text();
      console.error('[watering-guide] OpenRouter error:', error);
      return res.status(500).json({ error: 'AI service unavailable. Check API key.' });
    }

    const data = await openrouterRes.json();
    const content = data.choices?.[0]?.message?.content || '{}';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { summary: content, overallStatus: 'water', plants: [], tips: [], forecast: '' };
    }

    console.log('[watering-guide] ✓ Response generated');
    res.json(parsed);
  } catch (err) {
    console.error('[watering-guide] Error:', err.message || err);
    res.status(500).json({ error: err.message || 'AI request failed.' });
  }
});

// ── Seed pack scanner ──────────────────────────────────────────────────────
app.post('/api/scan-seed-pack', requireAuth, async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided.' });

  // Parse data URL: data:<mediaType>;base64,<data>
  const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'Invalid image format. Expected a base64 data URL.' });
  const [, rawType, base64Data] = match;

  // Gemini accepts: image/jpeg, image/png, image/gif, image/webp
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mediaType = allowed.includes(rawType) ? rawType : 'image/jpeg';

  try {
    console.log('[scan-seed-pack] Processing image with OpenRouter...');

    const prompt = `You are analyzing a seed packet image. Extract all growing information visible and return ONLY a JSON object with these fields (omit any you cannot find):
{
  "plant_name": "string — common name",
  "variety": "string — cultivar/variety name",
  "sow_indoors": "string — e.g. Feb-Apr",
  "sow_outdoors": "string — e.g. Apr-Jun",
  "harvest": "string — e.g. Jul-Oct",
  "spacing_cm": number,
  "days_to_harvest": number,
  "depth_cm": number,
  "tips": "string — key growing tip from the packet",
  "sun_preference": "full-sun" | "partial-shade" | "full-shade" | "any",
  "difficulty": "easy" | "moderate" | "challenging"
}
Return only valid JSON, no markdown, no explanation.`;

    const openrouterRes = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENROUTER_VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt,
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: base64Data,
                },
              },
            ],
          },
        ],
        max_tokens: 500,
      }),
    });

    if (!openrouterRes.ok) {
      const err = await openrouterRes.text();
      console.error('[scan-seed-pack] OpenRouter error:', err);
      return res.status(500).json({ error: 'Scan service unavailable.' });
    }

    const data = await openrouterRes.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '{}';
    let extracted = {};
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : { plant_name: 'Unknown' };
    } catch {
      extracted = { plant_name: 'Unknown' };
    }
    console.log('[scan-seed-pack] ✓ Successfully extracted seed info:', extracted.plant_name || 'Unknown plant');
    res.json({ extracted });
  } catch (err) {
    console.error('[scan-seed-pack] Error:', err.message || err);
    res.status(500).json({ error: err.message || 'Scan failed.' });
  }
});

// ── Error handling ────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error);
  process.exit(1);
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = 3001;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Allotment API listening on 0.0.0.0:${PORT} (all interfaces)`);
});

// Keep-alive to prevent crashes
server.keepAliveTimeout = 65000;
