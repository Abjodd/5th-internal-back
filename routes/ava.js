// routes/ava.js — AVA, the client portal's guide chatbot.
//
//   POST /api/ava/chat — one turn of a conversation with AVA, proxied
//   through this server so the Gemini API key never reaches the browser.
//   Stateless: the caller (the AVA widget) sends the whole visible history
//   back each turn — nothing is stored here.
//
// AVA is a NAVIGATION + FEATURE GUIDE only. It never sees a brand's own
// campaigns, creators or spend — there is no per-brand data to leak, so
// this route needs no auth check of its own; whether the VISITOR can reach
// a page it names is still enforced exactly as today, by ProtectedRoute on
// the frontend. AVA answers from the fixed platform description below and,
// when a question is best answered by going somewhere, names one of the
// real routes in ROUTES so the widget's "Take me there" button has
// somewhere real to send the visitor — never a path the model invented.
import { Router } from "express";
import "dotenv/config";

const router = Router();

// Flash-Lite, not Flash or Pro: this is short, low-stakes chit-chat about a
// known, fixed set of facts (the platform description below), not the
// long-horizon reasoning work the bigger Flash tiers are built for — and in
// practice gemini-3.8-flash was consistently answering 503 "high demand"
// here (confirmed live, repeatedly, across separate runs), which tracks:
// it is Google's heaviest Flash tier. The Flash-Lite tier is the
// purpose-built fit (Google's own words: "fastest, most cost-effective...
// for high-throughput execution") and, being a different capacity pool,
// sidesteps that specific overload.
//
// Two stable Flash-Lite generations, tried in order — if the newer one is
// itself overloaded (it happens to any single model under enough load),
// the older generation is a live, separately-provisioned fallback rather
// than just failing the turn. Each is still given its own retry-with-
// backoff below before moving on.
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const apiUrl = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

// One real route per link AVA is allowed to offer — kept in sync with
// routes.jsx BY HAND (there is no route-table introspection at runtime;
// this list changes about as often as the nav does). `authed: true` just
// documents that ProtectedRoute will detour a signed-out visitor through
// /login first — AVA still describes what's there either way, "Take me
// there" simply lands on the sign-in step before it.
export const ROUTES = [
  { path: "/", label: "Home", authed: false, desc: "The public landing page — who Fifth Avenue is and what the agency does." },
  { path: "/regional", label: "Our network", authed: false, desc: "Public page on the creator network's reach across India and internationally." },
  { path: "/international", label: "International", authed: false, desc: "Public page on Fifth Avenue's international reach." },
  { path: "/tech", label: "Tech", authed: false, desc: "Public page on the tooling the agency runs campaigns on." },
  { path: "/creatives", label: "Creatives", authed: false, desc: "Public page on the agency's creative services." },
  { path: "/portfolio", label: "Portfolio", authed: false, desc: "Public page of past campaign work." },
  { path: "/careers", label: "Careers", authed: false, desc: "Open roles at Fifth Avenue." },
  { path: "/apply", label: "Apply as a creator", authed: false, desc: "Public form for a creator to apply to join the network." },
  { path: "/start", label: "Start a project", authed: false, desc: "Public form for a brand to start working with Fifth Avenue." },
  { path: "/login", label: "Client login", authed: false, desc: "Sign in to the client portal." },
  { path: "/portal/overview", label: "Overview", authed: true, desc: "The brand's front page after signing in: what needs a decision today, headline numbers (active campaigns, creators, views, engagement, budget, CPV), the performance funnel and spend split, and recent activity." },
  { path: "/portal/campaigns", label: "Campaigns", authed: true, desc: "The board of every campaign grouped by stage, and each campaign's own detail view — brief, creator roster with live posts, growth chart, and any open questions for Fifth Avenue." },
  { path: "/portal/regional", label: "Regional", authed: true, desc: "A map of where this brand's own creators actually are, by Indian state/region, with a drill-down into each state's roster." },
  { path: "/portal/assets", label: "Content", authed: true, desc: "A register of every piece of content posted across this brand's campaigns — the content archive." },
  { path: "/portal/billing", label: "Billing", authed: true, desc: "The exact cost breakdown of every campaign, line by line — what each creator was paid and the agency fee, meant to be read alongside an invoice." },
  { path: "/portal/insights", label: "Insights", authed: true, desc: "Open questions for the brand to answer, trending content in their space, Fifth Avenue's Market Watch notes, and the newsletter." },
  { path: "/portal/profile", label: "Profile", authed: true, desc: "Account settings — who's signed in, portal appearance (light/dark), and the company record Fifth Avenue holds for this brand." },
];

const ROUTE_LIST_TEXT = ROUTES.map(
  (r) => `- ${r.path} — "${r.label}"${r.authed ? " (after sign-in)" : ""}: ${r.desc}`
).join("\n");

const SYSTEM_INSTRUCTION = `You are AVA, the friendly built-in guide for the Fifth Avenue client portal — an influencer-marketing agency's platform where brands track the campaigns Fifth Avenue runs for them.

Your job is narrow and deliberate: help a visitor understand what the platform does and find the right page. You do NOT have access to anyone's account, campaigns, creators, spend or any other live data — you only know the fixed page list below. If someone asks something specific to their own account ("what's my campaign status", "how much have I spent"), say plainly that you can't see their account data, and point them to the page that has it instead.

Every real page on the platform, with what it's for:
${ROUTE_LIST_TEXT}

How to answer:
- Be brief and warm — a sentence or two, not an essay. This is a small chat popup, not a document.
- When the answer is "go look at X", say so by name and set "navigate" to that page's exact path from the list above (never invent a path).
- Only set "navigate" when a specific page is actually the answer — for a general "what is Fifth Avenue" question, leave it unset.
- If asked something outside the platform entirely (weather, unrelated general knowledge), gently steer back: you're here to help them use Fifth Avenue's portal.
- Never claim to see the visitor's own data. Never invent a feature that isn't in the list above.

Respond ONLY in the JSON shape you've been given.`;

// Gemini's flash tier occasionally answers 503 "model is currently
// experiencing high demand" or 429 under rate limiting — both are
// transient, not a problem with this route or the request itself. A
// couple of short retries clears most of them before the visitor ever
// sees an error; anything past that is a real outage and should surface
// as one rather than stall the chat widget.
const RETRYABLE_STATUS = new Set([429, 503]);
const RETRY_DELAYS_MS = [300, 900]; // total worst case: 2 retries, ~1.2s of backoff

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGeminiWithRetry(model, key, body) {
  const url = apiUrl(model, key);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= RETRY_DELAYS_MS.length) {
      return res;
    }
    console.warn(`[ava] ${model} ${res.status} (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}) — retrying`);
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

// Walk MODELS in order, giving each its own retry-with-backoff (above)
// before falling through to the next. Returns the first ok/non-retryable
// response, or the LAST response if every model stayed busy — that one's
// status/body is what the caller reports, since it's the freshest evidence
// of what's actually wrong.
async function callGeminiAcrossModels(key, body) {
  let res;
  for (const model of MODELS) {
    res = await callGeminiWithRetry(model, key, body);
    if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
    console.warn(`[ava] ${model} stayed busy through retries — falling back to next model`);
  }
  return res;
}

function toGeminiHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h) => h && (h.role === "user" || h.role === "model") && typeof h.text === "string")
    // Keep the payload small and cheap — a guide chat has no reason to carry
    // an unbounded transcript, and Gemini bills by token either way.
    .slice(-20)
    .map((h) => ({ role: h.role, parts: [{ text: h.text.slice(0, 2000) }] }));
}

// POST /api/ava/chat — { message, history? } → { reply, navigate? }
router.post("/api/ava/chat", async (req, res) => {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      // Not the visitor's problem to see — logged for whoever's watching the
      // server, a generic message on the wire.
      console.error("[ava] GEMINI_API_KEY is not set");
      return res.status(503).json({ error: "AVA is not configured yet" });
    }

    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ error: "message is required" });
    if (message.length > 2000)
      return res.status(400).json({ error: "message is too long" });

    const contents = [
      ...toGeminiHistory(req.body?.history),
      { role: "user", parts: [{ text: message }] },
    ];

    const geminiRes = await callGeminiAcrossModels(
      key,
      JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              reply: { type: "string" },
              navigate: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  label: { type: "string" },
                },
              },
            },
            required: ["reply"],
          },
          temperature: 0.4,
          maxOutputTokens: 400,
        },
      }),
    );

    if (!geminiRes.ok) {
      const body = await geminiRes.text().catch(() => "");
      console.error(`[ava] Gemini ${geminiRes.status}: ${body.slice(0, 500)}`);
      // Distinct copy for "swamped, try again shortly" vs. any other
      // failure — retries above already absorbed a transient blip, so a
      // 503/429 reaching here means it stayed busy through all of them.
      const busy = RETRYABLE_STATUS.has(geminiRes.status);
      return res
        .status(busy ? 503 : 502)
        .json({ error: busy ? "AVA is getting a lot of requests right now — try again in a moment." : "AVA couldn't reach Gemini" });
    }

    const data = await geminiRes.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      console.error("[ava] empty Gemini response", JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: "AVA got an empty response" });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Structured output failing to parse is rare but not impossible — fall
      // back to showing the raw text rather than erroring the whole turn.
      return res.json({ reply: raw.slice(0, 2000) });
    }

    // Trust nothing from the model as a navigation target beyond what's
    // actually in ROUTES — a hallucinated path would otherwise go straight
    // into the frontend's router.
    const navigate =
      parsed.navigate?.path && ROUTES.some((r) => r.path === parsed.navigate.path)
        ? { path: parsed.navigate.path, label: parsed.navigate.label || ROUTES.find((r) => r.path === parsed.navigate.path).label }
        : undefined;

    res.json({ reply: String(parsed.reply || "").slice(0, 2000), navigate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
