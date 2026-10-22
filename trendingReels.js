/**
 * Scheduled refresh for every HikerAPI-backed reel snapshot that doesn't ride
 * a free call from somewhere else: Insights → Trending / Market Watch, and
 * now Managed Creator Projects.
 *
 * All three store a HikerAPI media snapshot directly on the row — `media`,
 * from fetchReelSnapshot() in portalReels.js — fetched exactly once, at the
 * moment the row is created (see the doc comments on POST /api/trending and
 * /api/market-watch in server.js, and POST /api/creators/:id/projects in
 * routes/creators.js). That's a deliberate cost call in each case, but it
 * means a reel's signed Instagram CDN links eventually expire — video ~32h,
 * poster image ~106h — and, with nothing to re-fetch them, the card goes
 * dark for good.
 *
 * This job re-runs the same fetch on a nightly cadence so that never
 * happens. Unlike portalReels.js's ReelCache refresh, there is no free ride
 * here: a campaign's own posts get refreshed as a by-product of the nightly
 * post-metrics job's calls to the same endpoint, but none of the three
 * collections below are on any campaign roster, so every refresh is a
 * full-price HikerAPI credit, for as long as the row exists. That ongoing
 * cost, against reels that otherwise permanently break, is the tradeoff the
 * brand chose when asking for this job — and again when adding Projects to it.
 *
 * Deliberately its own file rather than folded into portalReels.js: that
 * file's TTL/backoff machinery exists to decide whether a call is even worth
 * making (skip it if a free one already happened recently). Nothing here is
 * ever free, so there's nothing to skip — every row is simply re-fetched,
 * serially with a gap, every run.
 */
import TrendingItem from "./models/TrendingItem.js";
import MarketWatchItem from "./models/MarketWatchItem.js";
import Project from "./models/Project.js";
import { fetchReelSnapshot } from "./portalReels.js";

// Same gap as the other jobs that call HikerAPI (portalReels.js,
// refreshPostMetrics.js) — they all share one rate-limited key, and a burst
// from any of them is the reliable way to get throttled.
const GAP_MS = Number(process.env.TRENDING_REELS_GAP_MS) || 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-fetch and store one row's media. Mirrors cacheReelFromMedia's choice in
 * portalReels.js: a failed fetch (dead link, private post, a bad night for
 * HikerAPI) never overwrites a snapshot that was working — it only records
 * the attempt, so a transient failure can't blank out a card that was fine
 * yesterday. The old `oe=` link that's left in place is still read fresh at
 * serve time (signedExpiryOf), so a stale-but-present snapshot degrades to a
 * still frame or an "Open on Instagram" card rather than rendering as a
 * crash.
 */
async function refreshOne(Model, doc) {
  const now = new Date();
  const media = await fetchReelSnapshot(doc.url);
  if (media?.ok) {
    await Model.updateOne(
      { _id: doc._id },
      { $set: { media, fetchedAt: now, attemptedAt: now, lastError: null } },
    );
    return true;
  }
  await Model.updateOne(
    { _id: doc._id },
    { $set: { attemptedAt: now, lastError: "fetch failed" } },
  );
  return false;
}

// `extraFilter` narrows which rows in a collection count as refreshable
// reels — Trending/MarketWatch also hold `kind: "note"` rows with no link at
// all, so those need `{ kind: "reel" }`; every Project row has a link or
// none, so it needs no extra filter beyond `url` being set.
async function refreshCollection(Model, label, out, extraFilter = {}) {
  const rows = await Model.find({ url: { $ne: null }, ...extraFilter })
    .select({ url: 1 })
    .lean();
  let ok = 0, failed = 0;
  for (const doc of rows) {
    if (await refreshOne(Model, doc)) ok++; else failed++;
    await sleep(GAP_MS);
  }
  out(`[trendingReels] ${label}: ${rows.length} rows, ${ok} ok, ${failed} failed`);
  return { rows: rows.length, ok, failed };
}

/**
 * Wired into scheduler.js. Walks every reel row across all three collections
 * and re-fetches its media snapshot so a signed CDN link is never more than
 * one night old.
 */
export async function refreshTrendingReels({ log: out = console.log } = {}) {
  const started = Date.now();
  const trending = await refreshCollection(TrendingItem, "trending", out, { kind: "reel" });
  const marketWatch = await refreshCollection(MarketWatchItem, "market-watch", out, { kind: "reel" });
  const projects = await refreshCollection(Project, "projects", out);

  const summary = {
    trending,
    marketWatch,
    projects,
    ok: trending.ok + marketWatch.ok + projects.ok,
    failed: trending.failed + marketWatch.failed + projects.failed,
    ms: Date.now() - started,
  };
  out(`[trendingReels] refresh ${JSON.stringify(summary)}`);
  return summary;
}
