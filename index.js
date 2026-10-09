require('dotenv').config();
const path = require('node:path');
const express = require('express');
const { guideKey, createGuideCache, createUserCap } = require('./ai-budget');

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
// Model settings are comma-separated lists, sent as OpenRouter's `models`: it
// tries each in turn, so a free model that is rate-limited or withdrawn falls
// through to the next instead of failing the request.
const modelList = (value, fallback) => (value || fallback).split(',').map((m) => m.trim()).filter(Boolean);
const OPENROUTER_CHAT_MODELS = modelList(process.env.OPENROUTER_CHAT_MODEL,
  'nvidia/nemotron-3-super-120b-a12b:free,apodex/apodex-1.1-mini:free,google/gemma-4-31b-it:free');
const OPENROUTER_VISION_MODELS = modelList(process.env.OPENROUTER_VISION_MODEL,
  'dots-studio/dots-3-note-preview:free,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,google/gemma-4-31b-it:free');

if (!OPENROUTER_API_KEY) {
  console.error('ERROR: OPENROUTER_API_KEY not set in .env');
  process.exit(1);
}

console.log(`✓ Using OpenRouter with chat models: ${OPENROUTER_CHAT_MODELS.join(' → ')}`);
console.log(`✓ Using OpenRouter with vision models: ${OPENROUTER_VISION_MODELS.join(' → ')}`);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
      },
    });
    if (!r.ok) {
      return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
    }
    req.user = await r.json();
    next();
  } catch (err) {
    console.error('[auth] Check failed:', err.message);
    res.status(500).json({ error: 'Auth check failed.' });
  }
}

// ── Upstream failure ───────────────────────────────────────────────────────
// OpenRouter answers 429 when every listed free model is rate-limited, or the
// key has used up its daily free-model allowance. Say that, not "check the key".
function aiUnavailable(res, upstreamStatus) {
  if (upstreamStatus === 429) {
    return res.status(429).json({ error: 'The free AI models are busy or today’s limit has been reached. Try again later.' });
  }
  return res.status(502).json({ error: 'The AI service is unavailable right now. Try again later.' });
}

// ── AI budget ───────────────────────────────────────────────────────────────
// The free tier allows 50 free-model requests a day across every user and feature (see
// ai-budget.js): grow guides are cached, and each user is capped so no one uses the lot.
const guideCache = createGuideCache(path.join(__dirname, 'data', 'grow-guides.json'), 30 * 24 * 3600_000);
const userCap = createUserCap(Number(process.env.AI_DAILY_PER_USER) || 20);

function spendAi(req, res, next) {
  if (userCap.take(req.user.id)) return next();
  console.warn(`[ai-budget] ${req.user.id} reached ${userCap.limit} requests today`);
  res.status(429).json({ error: `You’ve used today’s ${userCap.limit} AI requests. They reset at midnight UTC.` });
}

// What's left today, for the app to show before someone asks. OpenRouter's count is cached a
// minute; checking it isn't charged against the free allowance.
let keyStatus = { at: 0, value: null };
app.get('/api/ai-quota', requireAuth, async (req, res) => {
  if (Date.now() - keyStatus.at > 60_000) {
    try {
      const r = await fetch(`${OPENROUTER_BASE_URL}/key`, { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` } });
      const free = r.ok ? (await r.json()).data?.free_model_daily_requests : null;
      keyStatus = { at: Date.now(), value: free ?? null };
    } catch { keyStatus = { at: Date.now(), value: null }; }
  }
  res.json({
    shared: keyStatus.value, // { used, limit, remaining } across everyone, or null if unknown
    you: { used: userCap.used(req.user.id), limit: userCap.limit },
  });
});

// ── Garden AI chat ─────────────────────────────────────────────────────────
app.post('/api/garden-ai', requireAuth, spendAi, async (req, res) => {
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
        models: OPENROUTER_CHAT_MODELS,
        messages: conversationMessages,
        temperature: 0.7,
        // The free models reason before answering, and that counts against the
        // cap: a two-paragraph reply took ~1,050 tokens in all, so 1000 cut it off.
        max_tokens: 4000,
      }),
    });

    if (!openrouterRes.ok) {
      const error = await openrouterRes.text();
      console.error('[garden-ai] OpenRouter error:', error);
      return aiUnavailable(res, openrouterRes.status);
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
app.post('/api/grow-guide', requireAuth, (req, res, next) => {
  const { plants } = req.body;
  if (!plants) return res.status(400).json({ error: 'No plants provided.' });
  // The same plants get the same guide: answer from the cache without spending a request.
  const cached = guideCache.get(guideKey(plants));
  if (cached) return res.json({ reply: cached, cached: true });
  next();
}, spendAi, async (req, res) => {
  const { plants } = req.body;

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
        models: OPENROUTER_CHAT_MODELS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `I want to grow these plants on my UK allotment:\n\n${plants}\n\nPlease create a comprehensive growing guide with timings, companions, and layout suggestions.` },
        ],
      }),
    });

    if (!openrouterRes.ok) {
      const error = await openrouterRes.text();
      console.error('[grow-guide] OpenRouter error:', error);
      return aiUnavailable(res, openrouterRes.status);
    }

    const data = await openrouterRes.json();
    const content = data.choices?.[0]?.message?.content;
    const reply = content || 'Sorry, I could not generate a guide.';
    if (content) guideCache.set(guideKey(plants), content);
    console.log('[grow-guide] ✓ Response generated');
    res.json({ reply });
  } catch (err) {
    console.error('[grow-guide] Error:', err.message || err);
    res.status(500).json({ error: err.message || 'AI request failed.' });
  }
});

// ── Watering guide ─────────────────────────────────────────────────────────
app.post('/api/watering-guide', requireAuth, spendAi, async (req, res) => {
  const { weatherData, plants, forecast } = req.body;
  if (!weatherData || !plants) return res.status(400).json({ error: 'Missing required data.' });

  // Format plants array into readable text (capped: the prompt has to stay small)
  const plantsText = Array.isArray(plants)
    ? plants.slice(0, 60).map((p) => `${p.emoji} ${p.name}${p.count > 1 ? ` ×${p.count}` : ''} (${p.category}, ${p.location}${p.selfWatering ? ', self-watering' : ''})`).join('\n')
    : plants;

  // v2 sends no humidity, and v1 no forecast, so each line only when present.
  const has = (v) => v !== undefined && v !== null && v !== '';
  const weatherText = [
    `- Temperature: ${weatherData.temperature}°C`,
    has(weatherData.humidity) && `- Humidity: ${weatherData.humidity}%`,
    has(weatherData.windSpeed) && `- Wind: ${weatherData.windSpeed} km/h`,
    `- Conditions: ${weatherData.conditions}`,
  ].filter(Boolean).join('\n');
  const forecastText = Array.isArray(forecast) && forecast.length
    ? `\n\nFORECAST:\n${forecast.slice(0, 7).map((d) => `- ${d.date}: ${d.condition}, ${d.min}–${d.max}°C, ${d.precip}% chance of rain`).join('\n')}`
    : '';

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
${weatherText}${forecastText}

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
        models: OPENROUTER_CHAT_MODELS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!openrouterRes.ok) {
      const error = await openrouterRes.text();
      console.error('[watering-guide] OpenRouter error:', error);
      return aiUnavailable(res, openrouterRes.status);
    }

    const data = await openrouterRes.json();
    const content = data.choices?.[0]?.message?.content || '{}';

    // Models often wrap the JSON in a ```json fence or a line of preamble.
    let parsed;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
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
app.post('/api/scan-seed-pack', requireAuth, spendAi, async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image provided.' });

  // Accept a data URL (data:<mediaType>;base64,<data>) or bare base64 — the
  // Allotment Buddy client strips the prefix and sends bare base64.
  const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
  const base64Data = match ? match[2] : imageBase64;
  if (!/^[A-Za-z0-9+/]+=*$/.test(base64Data)) {
    return res.status(400).json({ error: 'Invalid image format. Expected base64 image data.' });
  }

  // Bare base64 carries no type, so read it off the file signature.
  const sniffed =
    base64Data.startsWith('/9j/') ? 'image/jpeg'
    : base64Data.startsWith('iVBOR') ? 'image/png'
    : base64Data.startsWith('R0lGOD') ? 'image/gif'
    : base64Data.startsWith('UklGR') ? 'image/webp'
    : null;
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const mediaType = allowed.includes(match?.[1]) ? match[1] : sniffed || 'image/jpeg';

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
        models: OPENROUTER_VISION_MODELS,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt,
              },
              {
                type: 'image_url',
                image_url: { url: `data:${mediaType};base64,${base64Data}` },
              },
            ],
          },
        ],
        // The free vision models reason before answering; at 500 they spent
        // the whole budget thinking and returned no JSON at all.
        max_tokens: 4000,
      }),
    });

    if (!openrouterRes.ok) {
      const err = await openrouterRes.text();
      console.error('[scan-seed-pack] OpenRouter error:', err);
      return aiUnavailable(res, openrouterRes.status);
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

// ── Barcode Lookup ────────────────────────────────────────────────────────
app.post('/api/lookup-barcode', requireAuth, async (req, res) => {
  const { barcode } = req.body;
  if (!barcode) return res.status(400).json({ error: 'No barcode provided.' });
  // Barcode goes straight into a URL path — keep it to digits so it can't traverse.
  if (!/^\d{6,14}$/.test(String(barcode))) {
    return res.status(400).json({ error: 'Invalid barcode.' });
  }

  try {
    console.log('[lookup-barcode] Looking up barcode:', barcode);

    // Query Open Food Facts API
    const url = `https://world.openfoodfacts.org/api/v0/product/${barcode}.json`;
    const response = await fetch(url);

    if (!response.ok) {
      console.log('[lookup-barcode] Barcode not found in database');
      return res.json({ found: false, message: 'Barcode not found. Please enter details manually.' });
    }

    const data = await response.json();

    if (!data.product) {
      console.log('[lookup-barcode] No product data returned');
      return res.json({ found: false, message: 'No product information found.' });
    }

    const product = data.product;
    const extracted = {
      plant_name: product.product_name || product.brands || 'Unknown',
      image_url: product.image_front_url || product.image_url || null,
      manufacturer: product.brands || '',
      description: product.generic_name || '',
    };

    console.log('[lookup-barcode] ✓ Found product:', extracted.plant_name);
    res.json({ found: true, extracted });
  } catch (err) {
    console.error('[lookup-barcode] Error:', err.message);
    res.status(500).json({ error: 'Lookup failed. Please try again.' });
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
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Allotment API listening on 127.0.0.1:${PORT} (nginx only)`);
});

// Keep-alive to prevent crashes
server.keepAliveTimeout = 65000;
