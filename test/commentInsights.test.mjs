/**
 * Comment analysis end to end — real MongoDB, fake HikerAPI comments, fake Gemini.
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27017 node test/commentInsights.test.mjs
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";

process.env.HIKERAPI_TOKEN = "hk";
process.env.GEMINI_API_KEY = "gm";
process.env.COMMENTS_GAP_MS = "0";
process.env.COMMENTS_PER_POST = "100";
const URI = `${(process.env.MONGO_TEST_URI || "mongodb://127.0.0.1:27017").replace(/\/$/, "")}/${process.env.KEEP_DB || `comments_${Date.now().toString(36)}`}`;

// ── fakes ───────────────────────────────────────────────────────────────────
const POSTS = {
  "111_9": { n: 40, mix: ["Love this serum 😍 my skin glows", "Where can I buy this?", "Price please?", "Worst product, broke me out", "@friend look", "check my profile for giveaways 🔥", "Is it safe for oily skin?", "Ordered mine today!", "So fake, paid promo", "🔥🔥🔥"] },
  "222_9": { n: 130, mix: ["Absolutely love the packaging", "the texture is amazing", "Does it work on acne?", "Too expensive for me", "Bought it, loving it", "nice"] },
  "333_9": { n: 0, mix: [] },
};
const calls = { hiker: 0, gemini: 0, geminiByModel: {} };
let geminiDown = 0; // how many next Gemini calls answer 503
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
function commentsFor(id) {
  const p = POSTS[id] || POSTS[`${id}_9`];
  return Array.from({ length: p.n }, (_, i) => ({ pk: `${id}-${i}`, text: `${p.mix[i % p.mix.length]}${i >= p.mix.length ? ` #${i}` : ""}`, user: { username: `fan_${i}` }, comment_like_count: (i * 7) % 50, created_at: 1790000000 + i * 3600 * 7 }));
}
const labelOf = (t) => /check my profile/i.test(t) ? "S" : /worst|fake|expensive|broke/i.test(t) ? "N" : /love|amazing|glows|loving|ordered|bought|🔥/i.test(t) ? "P" : "U";
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "api.hikerapi.com") {
    calls.hiker++;
    assert.equal(url.pathname, "/v2/media/comments");
    const id = url.searchParams.get("id");
    if (id.includes("_")) return json({ detail: "use pk" }, 400); // forces the bare-pk retry
    const all = commentsFor(id), start = Number(url.searchParams.get("page_id") || 0), page = all.slice(start, start + 15);
    return json({ response: { comments: page, has_more_comments: start + 15 < all.length }, next_page_id: start + 15 < all.length ? String(start + 15) : null });
  }
  if (url.hostname === "generativelanguage.googleapis.com") {
    calls.gemini++;
    const model = url.pathname.split("/").pop().split(":")[0];
    calls.geminiByModel[model] = (calls.geminiByModel[model] || 0) + 1;
    if (geminiDown > 0) { geminiDown--; return json({ error: "busy" }, 503); }
    const prompt = JSON.parse(init.body).contents[0].parts[0].text;
    let out;
    if (prompt.includes("numbered comments")) {
      const lines = prompt.split("Comments:\n")[1].split("\n").filter(Boolean).map((l) => l.replace(/^\d+\.\s/, ""));
      const idx = (re) => lines.map((t, i) => (re.test(t) ? i + 1 : 0)).filter(Boolean);
      out = { labels: lines.map(labelOf).join(""), themes: [{ name: "Glowing skin", sentiment: "positive", comments: idx(/glow|texture|love/i) }, { name: "Price", sentiment: "negative", comments: idx(/price|expensive/i) }].filter((t) => t.comments.length),
        questions: [{ question: "Is it right for my skin type?", comments: idx(/oily|acne/i) }].filter((q) => q.comments.length),
        purchaseIntent: idx(/buy|ordered|bought|price|expensive/i) /* "expensive" = the AI wrongly tagging a complaint */, brandMentions: 3, highlights: idx(/love/i).slice(0, 3), concerns: idx(/worst|fake/i).slice(0, 3), summary: "People mostly loved it." };
    } else {
      const tCount = (prompt.match(/^T\d+\./gm) || []).length;
      out = { headline: "Strong love for the glow, some price pushback", summary: "Most people liked the results. Price came up.", praise: ["The glow"], concerns: ["Price"], recommendations: ["Share a price-point offer"],
        themes: [{ name: "Glow results", sentiment: "positive", description: "People love how skin looks.", from: Array.from({ length: tCount }, (_, i) => i + 1).filter((i) => i % 2 === 1) }, { name: "Price", sentiment: "negative", description: "Some think it's costly.", from: [2, 99] }],
        questions: [{ question: "Will it suit my skin type?", from: [1, 2] }] };
    }
    return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] });
  }
  throw new Error(`unexpected fetch ${url}`);
};

// ── seed ────────────────────────────────────────────────────────────────────
await mongoose.connect(URI);
const db = mongoose.connection.db;
await db.collection("clients").insertOne({ _id: "glow", name: "Glow Co" });
await db.collection("campaigns").insertOne({ _id: "c1", name: "Diwali Glow", brandId: "glow", client: "Glow Co", creators: [
  { _id: "r1", creatorId: "@asha", live: { postUrls: ["https://www.instagram.com/reel/AAA/", "https://www.instagram.com/reel/BBB/"] } },
  { _id: "r2", creatorId: "@ravi", live: { postUrl: "https://www.instagram.com/reel/CCC/" } },
  { _id: "r3", creatorId: "@new", live: { postUrl: "https://www.instagram.com/reel/NEW/" } }, // not in the reel cache yet
], creatorIds: ["@asha", "@ravi", "@new"] });
await db.collection("creators").insertMany([{ _id: "@asha", handle: "@asha", name: "Asha" }, { _id: "@ravi", handle: "@ravi", name: "Ravi" }, { _id: "@new", handle: "@new" }]);
await db.collection("reel_cache").insertMany([
  { _id: "https://www.instagram.com/reel/AAA/", reel: { id: "111_9", code: "AAA", comments: 40, caption: "My glow routine", takenAt: "2026-10-20T10:00:00Z" }, posterUpdatedAt: new Date() },
  { _id: "https://www.instagram.com/reel/BBB/", reel: { id: "222_9", code: "BBB", comments: 130, takenAt: "2026-10-22T10:00:00Z" } },
  { _id: "https://www.instagram.com/reel/CCC/", reel: { id: "333_9", code: "CCC", comments: 0 } },
]);

const { refreshBrandInsights, getBrandInsights, getBrandInsightsStatus, refreshAllCommentInsights } = await import("../commentInsights.js");
let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log("  ✓", name); } catch (e) { console.log("  ✗", name, "\n   ", e.stack.split("\n").slice(0, 3).join("\n    ")); process.exitCode = 1; } };

console.log("comment insights");
let first;
await test("first run: fetches up to 100 comments per post, analyses each post, writes the brand read", async () => {
  first = await refreshBrandInsights("glow");
  assert.equal(first.error, undefined, first.error);
  assert.equal(first.posts, 4);
  // AAA: 1 refused + 3 pages; BBB: 1 refused + 7 pages (100 of 130); CCC: 1 refused + 1 empty page
  assert.equal(first.requests, 4 + 8 + 2, JSON.stringify(first));
  assert.equal(first.analysed, 3);
  const { status, insight } = await getBrandInsights("glow");
  assert.equal(status, "ready");
  assert.equal(insight.totals.comments, 140);
  assert.equal(insight.totals.posts, 4);
  assert.equal(insight.totals.analysedPosts, 2, "the empty post isn't analysed by the AI");
  const s = insight.sentimentPct;
  assert.ok(s.positive > s.negative && Math.abs(s.positive + s.neutral + s.negative - 100) < 0.5, JSON.stringify(s));
  assert.ok(insight.totals.spam > 0, "spam is counted apart");
  assert.equal(insight.headline, "Strong love for the glow, some price pushback");
});

await test("every quote is a real comment with its real author", async () => {
  const { insight } = await getBrandInsights("glow");
  const quotes = [...insight.themes.flatMap((t) => t.quotes), ...insight.topPositive, ...insight.topNegative, ...insight.purchaseQuotes, ...insight.questions.flatMap((q) => q.quotes)];
  assert.ok(quotes.length >= 8);
  for (const q of quotes) {
    const row = await db.collection("post_comments").findOne({ _id: q.postUrl });
    assert.ok(row.comments.some((c) => c.text === q.text && c.user === q.user), `not a real comment: ${q.text}`);
  }
  assert.ok(insight.themes.find((t) => t.name === "Glow results").count > 0);
  assert.ok(insight.themes.every((t) => t.count > 0), "bad 'from' numbers (99) are dropped, not invented");
});

await test("charts and cards: timeline by day, top 5 buying-intent, negative comments", async () => {
  const { insight } = await getBrandInsights("glow");
  assert.ok(insight.timeline.length >= 1 && insight.timelineUnit === "day");
  const tl = insight.timeline.reduce((s, b) => s + b.positive + b.neutral + b.negative, 0);
  assert.equal(tl, insight.totals.comments - insight.totals.spam, "timeline adds up to the non-spam comments");
  assert.ok(insight.purchaseQuotes.length <= 5 && insight.purchaseQuotes.length >= 3);
  // Buying signals never include complaints, even when the AI tags one as intent.
  assert.ok(insight.purchaseQuotes.every((q) => labelOf(q.text) !== "N" && ["positive", "neutral"].includes(q.tone)), "no negative buying signals");
  assert.ok(insight.negativeComments.some((q) => /expensive/i.test(q.text)), "price complaints land in the negatives");
  assert.ok(insight.negativeComments.length >= 3 && insight.negativeComments.length <= 8);
  assert.ok(insight.negativeComments.every((q) => /worst|fake|expensive|broke/i.test(q.text)), "only negative-labelled comments");
  assert.ok(insight.negativeComments[0].likes >= insight.negativeComments.at(-1).likes, "most-liked first");
});

await test("per-post rows: counts, status, poster flag, and the post that isn't cached yet", async () => {
  const { insight } = await getBrandInsights("glow");
  const by = Object.fromEntries(insight.posts.map((p) => [p.code || p.postUrl, p]));
  assert.equal(by.AAA.analysed, 40); assert.equal(by.AAA.hasPoster, true); assert.equal(by.AAA.handle, "@asha"); assert.equal(by.AAA.campaign, "Diwali Glow");
  assert.equal(by.BBB.analysed, 100); assert.equal(by.BBB.totalComments, 130);
  assert.equal(by.CCC.status, "no-comments");
  assert.equal(by["https://www.instagram.com/reel/NEW/"].status, "unavailable");
  assert.ok(by.AAA.counts.positive > 0 && by.AAA.summary);
});

await test("a second run within the week buys nothing and re-analyses nothing", async () => {
  const before = { ...calls };
  const r = await refreshBrandInsights("glow");
  assert.equal(r.requests, 0);
  assert.equal(r.analysed, 0);
  assert.equal(calls.hiker, before.hiker);
  assert.equal(calls.gemini, before.gemini + 1, "only the brand summary is rewritten");
});

await test("force re-buys comments; unchanged comments still aren't re-analysed", async () => {
  const r = await refreshBrandInsights("glow", { force: true });
  assert.ok(r.requests > 0);
  assert.equal(r.analysed, 0);
});

await test("the run's request cap is respected", async () => {
  await db.collection("post_comments").deleteMany({});
  const r = await refreshBrandInsights("glow", { force: true, budget: { left: 5 } });
  assert.ok(r.requests <= 5, JSON.stringify(r));
  assert.ok(r.skippedForBudget >= 1);
  const { insight } = await getBrandInsights("glow");
  assert.equal(insight.posts.length, 4, "posts it couldn't afford still listed");
  assert.equal(await db.collection("post_comments").countDocuments({ fetchedAt: { $exists: true }, comments: { $size: 0 }, _id: /BBB/ }), 0, "a post cut off by the cap isn't saved as 'no comments'");
  const next = await refreshBrandInsights("glow");
  assert.ok(next.fetched >= 1, "the next run picks up what the cap left");
});

await test("Gemini busy: retries, then falls back to the second model", async () => {
  await db.collection("post_comments").updateMany({}, { $unset: { analysisHash: "" } });
  geminiDown = 3; // first model: initial + 2 retries all 503 → fallback
  const r = await refreshBrandInsights("glow");
  assert.equal(r.error, undefined, r.error);
  assert.ok(calls.geminiByModel["gemini-3.1-flash-lite"] > 0);
});

await test("a failed run keeps the last good analysis on screen", async () => {
  const keep = (await getBrandInsights("glow")).insight.headline;
  delete process.env.GEMINI_API_KEY;
  await db.collection("post_comments").updateMany({}, { $unset: { analysisHash: "" } });
  const r = await refreshBrandInsights("glow");
  process.env.GEMINI_API_KEY = "gm";
  assert.match(r.error, /GEMINI_API_KEY/);
  const now = await getBrandInsights("glow");
  assert.equal(now.status, "error");
  assert.equal(now.insight.headline, keep);
});

await test("two refreshes at once: the second returns straight away", async () => {
  await db.collection("comment_insights").updateOne({ _id: "glow" }, { $set: { status: "running", startedAt: new Date() } });
  const r = await refreshBrandInsights("glow");
  assert.equal(r.alreadyRunning, true);
  await db.collection("comment_insights").updateOne({ _id: "glow" }, { $set: { status: "ready" } });
});

await test("weekly job skips brands analysed within the week", async () => {
  const r = await refreshAllCommentInsights({ log: () => {} });
  assert.equal(r.brands, 0);
  await db.collection("comment_insights").updateOne({ _id: "glow" }, { $set: { generatedAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) } });
  const r2 = await refreshAllCommentInsights({ log: () => {} });
  assert.equal(r2.brands, 1);
  assert.equal((await getBrandInsightsStatus("glow")).status, "ready");
});

if (!process.env.KEEP_DB) await db.dropDatabase();
await mongoose.disconnect();
console.log(`\n${passed} passed`);
