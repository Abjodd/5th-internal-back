/**
 * Comment analysis for the client portal's Insights tab.
 *
 * What a brand sees: how people reacted to the campaign posts in their Assets
 * tab — overall sentiment, the themes people talk about (with real quoted
 * comments), what they praise, what they complain about, the questions they
 * ask, how many show buying intent, and a per-post breakdown.
 *
 * ── How it's built ───────────────────────────────────────────────────────────
 *   1. Posts: every live Instagram post on the brand's campaigns — the same
 *      list the Assets tab shows (collectPosts in portalReels.js).
 *   2. Comments: HikerAPI /v2/media/comments, ~15 per page, up to
 *      COMMENTS_PER_POST (100) per post. Stored in `post_comments`.
 *   3. Per-post read: one Gemini call per post labels every comment
 *      (positive / neutral / negative / spam) and picks out themes, questions,
 *      buying intent and highlights — by comment NUMBER, never by quoting, so
 *      every quote the client sees is a real comment, word for word.
 *   4. Brand read: one more Gemini call merges the posts into the headline,
 *      summary, themes, praise, concerns and suggestions.
 *   5. Stored in `comment_insights`; the portal only ever reads that.
 *
 * ── Cost ─────────────────────────────────────────────────────────────────────
 * Nothing runs on a client's page load. A brand is refreshed weekly by the
 * scheduler (only brands whose read is older than COMMENTS_REFRESH_DAYS) and
 * whenever the team presses Refresh in the internal app. A post's comments
 * are re-bought at most once per COMMENTS_REFRESH_DAYS unless forced, a post
 * whose comments didn't change is never re-analysed, and one run is capped at
 * COMMENTS_MAX_REQUESTS_PER_RUN HikerAPI pages.
 */
import crypto from "node:crypto";
import Client from "./models/Client.js";
import ReelCache from "./models/ReelCache.js";
import { PostComments, CommentInsight } from "./models/CommentInsight.js";
import { collectPosts } from "./portalReels.js";

const HIKER = "https://api.hikerapi.com";
const PER_POST = () => Math.max(15, Number(process.env.COMMENTS_PER_POST || 100));
const MAX_PAGES = () => Math.min(25, Math.ceil(PER_POST() / 15) + 1);
const REFRESH_DAYS = () => Number(process.env.COMMENTS_REFRESH_DAYS || 7);
const RUN_CAP = () => Number(process.env.COMMENTS_MAX_REQUESTS_PER_RUN || 600);
const GAP_MS = Number(process.env.COMMENTS_GAP_MS ?? 400);
const DAY = 24 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[comments]", ...a);

// ── HikerAPI ────────────────────────────────────────────────────────────────
class FetchError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function hikerGet(path, params) {
  const token = process.env.HIKERAPI_TOKEN;
  if (!token) throw new FetchError("HIKERAPI_TOKEN is not set", 500);
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""));
  const res = await fetch(`${HIKER}${path}?${qs}`, { headers: { "x-access-key": token, accept: "application/json" } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok) throw new FetchError(`HikerAPI ${path} → ${res.status}: ${(body?.detail || text).toString().slice(0, 160)}`, res.status);
  return body;
}

/** The comment list and next-page cursor, whatever shape the page came in. */
export function commentsPage(body) {
  const r = body?.response && typeof body.response === "object" ? body.response : body;
  const list = Array.isArray(r?.comments) ? r.comments : Array.isArray(body) && Array.isArray(body[0]) ? body[0] : [];
  const next = body?.next_page_id ?? r?.next_page_id ?? r?.next_min_id ?? r?.next_max_id ?? (Array.isArray(body) ? body[1] : null) ?? null;
  const more = r?.has_more_comments ?? r?.has_more_headload_comments ?? body?.has_more ?? !!next;
  return { comments: list, next: more ? next : null };
}

const toComment = (c) => {
  const sec = Number(c.created_at_utc ?? c.created_at);
  return {
    id: String(c.pk ?? c.id ?? ""),
    text: String(c.text ?? "").slice(0, 1000),
    user: c.user?.username || null,
    likes: Number(c.comment_like_count ?? c.like_count ?? 0) || 0,
    replies: Number(c.child_comment_count ?? 0) || 0,
    at: Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000) : null,
  };
};

/**
 * Fetch (or reuse) one post's comments. `budget.left` is the run's remaining
 * HikerAPI pages; this never spends past it.
 */
async function loadPostComments(post, { force, budget }) {
  const existing = await PostComments.findById(post.postUrl).lean();
  const fresh = existing?.fetchedAt && Date.now() - new Date(existing.fetchedAt).getTime() < REFRESH_DAYS() * DAY;
  if (existing && fresh && !force) return { row: existing, requests: 0 };

  const cache = await ReelCache.findById(post.postUrl, { reel: 1 }).lean();
  const mediaId = cache?.reel?.id;
  if (!mediaId) {
    // The Assets shelf hasn't cached this post yet (it does within a day of
    // going live); without its media id there is nothing to ask for.
    const lastError = "post not in the reel cache yet";
    await PostComments.updateOne({ _id: post.postUrl }, { $set: { attemptedAt: new Date(), lastError } }, { upsert: true });
    return { row: { ...(existing || {}), lastError }, requests: 0 };
  }
  if (budget.left <= 0) return { row: existing, requests: 0, skipped: true };

  const out = new Map();
  let requests = 0, next = null, id = mediaId, error = null, retriedBarePk = false, okPages = 0;
  for (let page = 0; page < MAX_PAGES() && out.size < PER_POST() && budget.left > 0; ) {
    let body;
    requests++; budget.left--;
    try {
      body = await hikerGet("/v2/media/comments", { id, page_id: next });
    } catch (e) {
      // Some media ids come as "<pk>_<userpk>"; if that form is refused, try the bare pk once.
      if (page === 0 && !retriedBarePk && id.includes("_") && e.status && e.status < 500) { id = id.split("_")[0]; retriedBarePk = true; continue; }
      error = e.message; break;
    }
    page++; okPages++;
    const { comments, next: n } = commentsPage(body);
    for (const c of comments.map(toComment)) if (c.id && c.text.trim() && !out.has(c.id)) out.set(c.id, c);
    if (!n) break;
    next = n;
    if (GAP_MS) await sleep(GAP_MS);
  }

  // Ran out of the run's budget before a single page came back: leave the
  // post as it was (not "fetched, no comments") so the next run picks it up.
  if (!okPages && !error) return { row: existing, requests, skipped: true };

  if (!out.size && error) {
    await PostComments.updateOne({ _id: post.postUrl }, { $set: { attemptedAt: new Date(), lastError: error } }, { upsert: true });
    return { row: { ...(existing || {}), lastError: error }, requests };
  }
  const comments = [...out.values()].slice(0, PER_POST());
  const set = {
    mediaId: id, code: cache.reel.code || null, commentCount: cache.reel.comments ?? null,
    comments, fetchedAt: new Date(), attemptedAt: new Date(), lastError: error, requests,
  };
  await PostComments.updateOne({ _id: post.postUrl }, { $set: set }, { upsert: true });
  return { row: { ...(existing || {}), _id: post.postUrl, ...set }, requests };
}

// ── Gemini ──────────────────────────────────────────────────────────────────
// Same models and retry policy as AVA (routes/ava.js): Flash-Lite, newest
// first, each with its own backoff before falling through to the older one.
const MODELS = (process.env.COMMENTS_GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite").split(",").map((s) => s.trim()).filter(Boolean);
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const DELAYS = [1500, 4000];

export async function geminiJSON(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new FetchError("GEMINI_API_KEY is not set on the backend", 500);
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 8192 },
  });
  let last;
  for (const model of MODELS) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body });
      if (res.ok) {
        const j = await res.json();
        const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        try { return JSON.parse(text.replace(/^```(json)?|```$/g, "").trim()); }
        catch { last = new FetchError(`Gemini (${model}) returned something that isn't JSON`, 502); break; }
      }
      last = new FetchError(`Gemini ${model} → ${res.status}`, res.status);
      if (!RETRYABLE.has(res.status) || attempt >= DELAYS.length) break;
      await sleep(DELAYS[attempt]);
    }
  }
  throw last;
}

const LABEL = { P: "positive", U: "neutral", N: "negative", S: "spam" };
const idxList = (v, n) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((i) => Number.isInteger(i) && i >= 1 && i <= n))];
const hashOf = (comments) => crypto.createHash("sha1").update(comments.map((c) => `${c.id}:${c.text}`).join("\n")).digest("hex");

/** One post's comments → labels, themes, questions, intent, highlights (by comment number). */
async function analysePost(row, ctx) {
  const comments = row.comments || [];
  if (!comments.length) return { empty: true, counts: { positive: 0, neutral: 0, negative: 0, spam: 0 }, labels: "" };
  const lines = comments.map((c, i) => `${i + 1}. ${c.text.replace(/\s+/g, " ").slice(0, 280)}`).join("\n");
  const prompt = `You are analysing the comments on one Instagram post made by creator @${ctx.handle || "creator"} for the brand "${ctx.brand}" as part of an influencer campaign${ctx.campaign ? ` ("${ctx.campaign}")` : ""}.
Post caption: ${(ctx.caption || "(none)").replace(/\s+/g, " ").slice(0, 500)}

There are ${comments.length} numbered comments below. Comments may be in any language (Hindi, Hinglish, Tamil…) or only emoji — interpret them as a native speaker would.

Return ONLY a JSON object with exactly these keys:
- "labels": a string of exactly ${comments.length} letters, one per comment in order: P = positive (praise, love, excitement, agreement), U = neutral (tags of friends, plain questions, neutral remarks), N = negative (criticism, complaints, sarcasm, distrust, "paid promotion" cynicism), S = spam or bots (self-promotion, "check my profile", giveaway spam, crypto, unrelated links).
- "themes": up to 5 recurring topics people talk about, each {"name": short topic in plain English (2-4 words), "sentiment": "positive" | "negative" | "mixed" | "neutral", "comments": [comment numbers]}.
- "questions": up to 5 questions people ask, each {"question": the question in plain English, "comments": [comment numbers]}.
- "purchaseIntent": [numbers of comments showing genuine interest in buying or trying — asking where to buy or the price, saying they ordered, bought or will buy]. Do NOT include complaints (e.g. "too expensive", "waste of money").
- "brandMentions": the number of comments that mention the brand or its product.
- "highlights": up to 3 numbers of the most meaningful positive comments (not one-word ones).
- "concerns": up to 3 numbers of the most meaningful negative comments.
- "summary": one plain sentence on how the audience reacted to this post.
Never write out comment text yourself — refer to comments only by number.

Comments:
${lines}`;
  const out = await geminiJSON(prompt);
  const n = comments.length;
  let labels = String(out?.labels || "").toUpperCase().replace(/[^PUNS]/g, "");
  if (labels.length !== n) labels = labels.length > n ? labels.slice(0, n) : labels.padEnd(n, "U");
  const counts = { positive: 0, neutral: 0, negative: 0, spam: 0 };
  for (const ch of labels) counts[LABEL[ch]]++;
  return {
    labels, counts,
    themes: (Array.isArray(out?.themes) ? out.themes : []).slice(0, 5).map((t) => ({
      name: String(t?.name || "").slice(0, 60), sentiment: ["positive", "negative", "mixed", "neutral"].includes(t?.sentiment) ? t.sentiment : "mixed", comments: idxList(t?.comments, n),
    })).filter((t) => t.name && t.comments.length),
    questions: (Array.isArray(out?.questions) ? out.questions : []).slice(0, 5).map((q) => ({ question: String(q?.question || "").slice(0, 200), comments: idxList(q?.comments, n) })).filter((q) => q.question),
    purchaseIntent: idxList(out?.purchaseIntent, n),
    brandMentions: Math.max(0, Math.min(n, Number(out?.brandMentions) || 0)),
    highlights: idxList(out?.highlights, n).slice(0, 3),
    concerns: idxList(out?.concerns, n).slice(0, 3),
    summary: String(out?.summary || "").slice(0, 300),
  };
}

// ── putting a brand together ────────────────────────────────────────────────
const quote = (c, postUrl) => c && { text: c.text, user: c.user, likes: c.likes || 0, at: c.at || null, postUrl };
const byLikes = (a, b) => (b?.likes || 0) - (a?.likes || 0);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
// Buying signals are only the positive or neutral buying comments — a price
// complaint the AI tagged as "intent" belongs with the negatives, not here.
// Uses the stored per-comment labels, so older cached reads are filtered too.
const buyingSignals = (a) => a.purchaseIntent.filter((i) => a.labels?.[i - 1] === "P" || a.labels?.[i - 1] === "U");

async function synthesise(brand, postReads) {
  const usable = postReads.filter((p) => p.analysis && !p.analysis.empty);
  const totals = { comments: 0, positive: 0, neutral: 0, negative: 0, spam: 0, purchaseIntent: 0, questions: 0, brandMentions: 0 };
  for (const p of usable) {
    const a = p.analysis;
    totals.comments += p.comments.length;
    for (const k of ["positive", "neutral", "negative", "spam"]) totals[k] += a.counts[k] || 0;
    totals.purchaseIntent += buyingSignals(a).length;
    totals.questions += a.questions.reduce((s, q) => s + Math.max(1, q.comments.length), 0);
    totals.brandMentions += a.brandMentions || 0;
  }
  const real = totals.comments - totals.spam;
  const sentimentPct = { positive: pct(totals.positive, real), neutral: pct(totals.neutral, real), negative: pct(totals.negative, real) };

  // Every per-post theme with its real comments, for the merge below.
  const rawThemes = [];
  for (const p of usable) for (const t of p.analysis.themes) {
    rawThemes.push({ name: t.name, sentiment: t.sentiment, post: p, comments: t.comments.map((i) => p.comments[i - 1]).filter(Boolean) });
  }
  const rawQuestions = [];
  for (const p of usable) for (const q of p.analysis.questions) rawQuestions.push({ question: q.question, post: p, comments: q.comments.map((i) => p.comments[i - 1]).filter(Boolean) });

  let merged = { headline: "", summary: "", themes: [], questions: [], praise: [], concerns: [], recommendations: [] };
  if (usable.length) {
    const themeList = rawThemes.map((t, i) => `T${i + 1}. "${t.name}" (${t.sentiment}, ${t.comments.length} comments, post by @${t.post.handle || "?"}) e.g. ${t.comments.slice(0, 2).map((c) => JSON.stringify(c.text.slice(0, 120))).join(" | ")}`).join("\n");
    const qList = rawQuestions.map((q, i) => `Q${i + 1}. ${q.question} (${q.comments.length})`).join("\n");
    const postList = usable.map((p) => `- @${p.handle || "?"}${p.campaign ? ` (${p.campaign})` : ""}: ${p.analysis.summary} [${p.analysis.counts.positive} positive / ${p.analysis.counts.neutral} neutral / ${p.analysis.counts.negative} negative]`).join("\n");
    const prompt = `You write the "Audience voice" section of a client report for the brand "${brand}". It summarises what real people said in the comments on the brand's influencer campaign posts. Write for the brand's marketing team: clear, specific, honest — not flattering, no jargon, no emoji.

Totals: ${totals.comments} comments on ${usable.length} posts. Sentiment (excluding spam): ${sentimentPct.positive}% positive, ${sentimentPct.neutral}% neutral, ${sentimentPct.negative}% negative. ${totals.purchaseIntent} comments show buying intent; ${totals.brandMentions} mention the brand or product.

Per post:
${postList}

Themes found on individual posts:
${themeList || "(none)"}

Questions found:
${qList || "(none)"}

Return ONLY a JSON object with:
- "headline": one short line (max 12 words) capturing the overall reaction.
- "summary": 2-3 sentences for the brand: how people reacted, what stood out, anything to watch.
- "themes": up to 6 merged themes across posts, each {"name": 2-4 words, "sentiment": "positive" | "negative" | "mixed" | "neutral", "description": one sentence, "from": [the T numbers merged into it, e.g. [1, 4]]}. Order by how much people talked about it.
- "questions": up to 5 merged questions, each {"question": plain English, "from": [Q numbers]}.
- "praise": up to 4 short phrases on what people liked.
- "concerns": up to 4 short phrases on what people disliked or doubted (empty if nothing real).
- "recommendations": up to 3 short, practical suggestions for the brand based on the comments.`;
    const out = await geminiJSON(prompt);
    const fromList = (v, max) => idxList(v, max);
    merged = {
      headline: String(out?.headline || "").slice(0, 120),
      summary: String(out?.summary || "").slice(0, 700),
      praise: (out?.praise || []).map(String).slice(0, 4),
      concerns: (out?.concerns || []).map(String).slice(0, 4),
      recommendations: (out?.recommendations || []).map(String).slice(0, 3),
      themes: (Array.isArray(out?.themes) ? out.themes : []).slice(0, 6).map((t) => {
        const parts = fromList(t?.from, rawThemes.length).map((i) => rawThemes[i - 1]);
        const comments = parts.flatMap((x) => x.comments.map((c) => ({ c, postUrl: x.post.postUrl })));
        return {
          name: String(t?.name || "").slice(0, 60),
          sentiment: ["positive", "negative", "mixed", "neutral"].includes(t?.sentiment) ? t.sentiment : "mixed",
          description: String(t?.description || "").slice(0, 240),
          count: comments.length,
          posts: new Set(parts.map((x) => x.post.postUrl)).size,
          quotes: comments.sort((a, b) => byLikes(a.c, b.c)).slice(0, 3).map(({ c, postUrl }) => quote(c, postUrl)),
        };
      }).filter((t) => t.name && t.count),
      questions: (Array.isArray(out?.questions) ? out.questions : []).slice(0, 5).map((q) => {
        const parts = fromList(q?.from, rawQuestions.length).map((i) => rawQuestions[i - 1]);
        const comments = parts.flatMap((x) => x.comments.map((c) => ({ c, postUrl: x.post.postUrl })));
        return { question: String(q?.question || "").slice(0, 200), count: comments.length, quotes: comments.sort((a, b) => byLikes(a.c, b.c)).slice(0, 4).map(({ c, postUrl }) => quote(c, postUrl)) };
      }).filter((q) => q.question && q.count),
    };
  }

  // Top 5 buying-intent comments (the portal rotates them as cards).
  const purchaseQuotes = usable.flatMap((p) => buyingSignals(p.analysis).map((i) => { const q = quote(p.comments[i - 1], p.postUrl); return q && { ...q, tone: p.analysis.labels[i - 1] === "P" ? "positive" : "neutral", handle: p.handle }; })).filter(Boolean).sort(byLikes).slice(0, 5);
  // Negative comments worth reading: the AI's picked concerns first, then the
  // most-liked of every other comment it labelled negative. Spam never.
  const negSeen = new Set();
  const negativeComments = [];
  const pushNeg = (c, postUrl, handle) => { if (c && !negSeen.has(c.id)) { negSeen.add(c.id); negativeComments.push({ ...quote(c, postUrl), handle: handle || null }); } };
  for (const p of usable) for (const i of p.analysis.concerns) pushNeg(p.comments[i - 1], p.postUrl, p.handle);
  const restNeg = usable.flatMap((p) => [...(p.analysis.labels || "")].map((l, i) => (l === "N" ? { c: p.comments[i], p } : null)).filter(Boolean)).sort((a, b) => byLikes(a.c, b.c));
  for (const { c, p } of restNeg) { if (negativeComments.length >= 8) break; pushNeg(c, p.postUrl, p.handle); }
  negativeComments.sort(byLikes);
  // Comments per day (or per week over long spans), split by sentiment — the
  // portal's "conversation over time" chart. Spam is left out.
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const buckets = new Map();
  for (const p of usable) [...(p.analysis.labels || "")].forEach((l, i) => {
    const c = p.comments[i];
    if (!c?.at || l === "S") return;
    const k = dayKey(c.at);
    const b = buckets.get(k) || { date: k, positive: 0, neutral: 0, negative: 0 };
    b[LABEL[l]]++;
    buckets.set(k, b);
  });
  let timeline = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  let timelineUnit = "day";
  if (timeline.length > 45) {
    const weeks = new Map();
    for (const b of timeline) {
      const d = new Date(`${b.date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
      const k = dayKey(d);
      const w = weeks.get(k) || { date: k, positive: 0, neutral: 0, negative: 0 };
      w.positive += b.positive; w.neutral += b.neutral; w.negative += b.negative;
      weeks.set(k, w);
    }
    timeline = [...weeks.values()].sort((a, b) => a.date.localeCompare(b.date));
    timelineUnit = "week";
  }
  const loved = usable.flatMap((p) => p.analysis.highlights.map((i) => quote(p.comments[i - 1], p.postUrl))).filter(Boolean).sort(byLikes).slice(0, 4);
  const critical = usable.flatMap((p) => p.analysis.concerns.map((i) => quote(p.comments[i - 1], p.postUrl))).filter(Boolean).sort(byLikes).slice(0, 4);
  const dates = usable.flatMap((p) => p.comments.map((c) => c.at && new Date(c.at).getTime()).filter(Boolean));

  return {
    totals: { ...totals, posts: postReads.length, analysedPosts: usable.length },
    sentimentPct,
    purchaseIntentPct: pct(totals.purchaseIntent, real),
    period: dates.length ? { from: new Date(Math.min(...dates)).toISOString(), to: new Date(Math.max(...dates)).toISOString() } : null,
    ...merged,
    topPositive: loved,
    topNegative: critical,
    purchaseQuotes,
    negativeComments,
    timeline,
    timelineUnit,
    posts: postReads.map((p) => ({
      postUrl: p.postUrl, code: p.code || null, handle: p.handle || null, campaign: p.campaign || null,
      takenAt: p.takenAt || null, hasPoster: !!p.hasPoster, posterUpdatedAt: p.posterUpdatedAt || null, thumbnail: p.thumbnail || null,
      totalComments: p.commentCount ?? null, analysed: p.comments?.length || 0,
      counts: p.analysis?.counts || null, summary: p.analysis?.summary || null,
      topComment: p.analysis && !p.analysis.empty ? quote([...(p.analysis.highlights || []).map((i) => p.comments[i - 1])].filter(Boolean).sort(byLikes)[0], p.postUrl) || null : null,
      status: p.analysis ? (p.analysis.empty ? "no-comments" : "ready") : p.lastError ? "unavailable" : "pending",
    })).sort((a, b) => (b.analysed - a.analysed) || String(b.takenAt || "").localeCompare(String(a.takenAt || ""))),
  };
}

/**
 * Re-read one brand's comments and rebuild its analysis. `force` re-buys
 * every post's comments even if fetched within the refresh window.
 * Safe to call while another run is going — the second one returns at once.
 */
export async function refreshBrandInsights(brandId, { force = false, budget = { left: RUN_CAP() } } = {}) {
  const started = Date.now();
  const brand = await Client.findById(brandId, { name: 1 }).lean();
  if (!brand) throw new FetchError("Brand not found", 404);
  // One run per brand at a time (a run stuck for over 30 minutes is presumed dead).
  const claim = await CommentInsight.findOneAndUpdate(
    { _id: brandId, $or: [{ status: { $ne: "running" } }, { startedAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) } }] },
    { $set: { status: "running", startedAt: new Date(), brandName: brand.name, statusNote: "Fetching comments…" } },
    { new: true },
  ).lean().catch(() => null);
  if (!claim) {
    const exists = await CommentInsight.exists({ _id: brandId });
    if (exists) return { alreadyRunning: true };
    try { await CommentInsight.create({ _id: brandId, brandName: brand.name, status: "running", startedAt: new Date(), statusNote: "Fetching comments…" }); }
    catch { return { alreadyRunning: true }; }
  }

  const run = { posts: 0, fetched: 0, requests: 0, analysed: 0, skippedForBudget: 0 };
  try {
    const posts = await collectPosts(brandId);
    run.posts = posts.length;
    const reels = await ReelCache.find({ _id: { $in: posts.map((p) => p.postUrl) } }, { "reel.code": 1, "reel.takenAt": 1, "reel.thumbnail": 1, "reel.caption": 1, "reel.comments": 1, posterUpdatedAt: 1 }).lean();
    const reelBy = new Map(reels.map((r) => [r._id, r]));

    const reads = [];
    for (const post of posts) {
      const { row, requests, skipped } = await loadPostComments(post, { force, budget });
      run.requests += requests;
      if (requests) run.fetched++;
      if (skipped) run.skippedForBudget++;
      const rc = reelBy.get(post.postUrl);
      const base = {
        postUrl: post.postUrl, handle: post.handle, campaign: post.campaign,
        code: rc?.reel?.code, takenAt: rc?.reel?.takenAt, thumbnail: rc?.reel?.thumbnail, hasPoster: !!rc?.posterUpdatedAt, posterUpdatedAt: rc?.posterUpdatedAt,
        commentCount: rc?.reel?.comments ?? row?.commentCount ?? null, comments: row?.comments || [], lastError: row?.lastError || null,
      };
      if (!row?.fetchedAt) { reads.push(base); continue; }

      // Re-analyse only when the comments changed.
      const hash = hashOf(row.comments || []);
      let analysis = row.analysisHash === hash ? row.analysis : null;
      if (!analysis) {
        await CommentInsight.updateOne({ _id: brandId }, { $set: { statusNote: `Analysing comments (${reads.length + 1} of ${posts.length})…` } });
        analysis = await analysePost(row, { brand: brand.name, handle: post.handle, campaign: post.campaign, caption: rc?.reel?.caption });
        await PostComments.updateOne({ _id: post.postUrl }, { $set: { analysis, analysisHash: hash, analysedAt: new Date() } });
        run.analysed++;
      }
      reads.push({ ...base, analysis });
    }

    await CommentInsight.updateOne({ _id: brandId }, { $set: { statusNote: "Writing the summary…" } });
    const insight = await synthesise(brand.name, reads);
    run.ms = Date.now() - started;
    await CommentInsight.updateOne({ _id: brandId }, {
      $set: { status: "ready", statusNote: null, generatedAt: new Date(), insight, lastRun: run, brandName: brand.name },
    });
    log(`${brand.name}: ${JSON.stringify(run)}`);
    return run;
  } catch (e) {
    run.error = e.message;
    run.ms = Date.now() - started;
    // Keep the previous analysis on screen — a failed refresh shouldn't blank the client's page.
    await CommentInsight.updateOne({ _id: brandId }, { $set: { status: "error", statusNote: e.message, lastRun: run } });
    log(`${brand.name} failed: ${e.message}`);
    return run;
  }
}

/** Weekly job: every brand with live posts whose read is older than the refresh window. */
export async function refreshAllCommentInsights({ log: out = log } = {}) {
  if (!process.env.GEMINI_API_KEY) { out("GEMINI_API_KEY not set — skipping comment analysis"); return { skipped: true }; }
  const { default: Campaign } = await import("./models/Campaign.js");
  const brandIds = (await Campaign.distinct("brandId", { deleted: { $ne: true }, "creators.live": { $exists: true } })).filter(Boolean);
  const cutoff = new Date(Date.now() - REFRESH_DAYS() * DAY);
  const budget = { left: RUN_CAP() };
  const done = [];
  for (const id of brandIds) {
    if (budget.left <= 0) break;
    const cur = await CommentInsight.findById(id, { generatedAt: 1 }).lean();
    if (cur?.generatedAt && cur.generatedAt > cutoff) continue;
    const r = await refreshBrandInsights(id, { budget });
    if (r.posts) done.push({ brand: id, ...r });
  }
  out(`refreshed ${done.length} brand(s)`);
  return { brands: done.length, requests: done.reduce((s, r) => s + (r.requests || 0), 0) };
}

/** What the portal shows — a read, never a fetch. */
export async function getBrandInsights(brandId) {
  const doc = await CommentInsight.findById(brandId).lean();
  if (!doc) return { status: "none", insight: null, generatedAt: null };
  return { status: doc.status, statusNote: doc.statusNote || null, generatedAt: doc.generatedAt || null, insight: doc.insight || null };
}

/** For the internal app: the same plus the last run's numbers. */
export async function getBrandInsightsStatus(brandId) {
  const doc = await CommentInsight.findById(brandId).lean();
  return doc
    ? { status: doc.status, statusNote: doc.statusNote || null, startedAt: doc.startedAt || null, generatedAt: doc.generatedAt || null, lastRun: doc.lastRun || null, totals: doc.insight?.totals || null }
    : { status: "none" };
}
