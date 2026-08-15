/**
 * post-metrics refresh.
 *
 *
 * Scope is deliberately narrow: live posts on campaigns still in execution or
 * reporting. Completed campaigns are signed off and their numbers should stop
 * moving; drafts have no posts. That keeps the nightly HikerAPI spend
 * proportional to work actually in flight rather than to the size of the
 * archive, which only ever grows.
 *
 * Runs in-process (see scheduler.js) rather than as an external cron because
 * the API is a single always-on service — a second scheduler would mean a
 * second deploy target and a second set of credentials for one job.
 */
import Campaign from "./models/Campaign.js";
import { fetchPostMetrics } from "./postMetrics.js";
import { withHistory } from "./trackingHistory.js";

// Only campaigns with work in flight. Mirrors the frontend's finance track
// (src/lib/campaign.js) plus every retired id that used to mean "delivering",
// so this keeps working on documents that predate a stage change and haven't
// been re-saved yet — nothing migrates the collection, it self-heals on save.
//
// The set is deliberately WIDER than "the campaign is live" since the pipeline
// forked. Delivery is now its own derived track, so a campaign's stored stage
// no longer says whether creators are posting: a campaign sitting at
// `team_assigned` because the client PO is slow can still have every creator
// live. Gating on the old two stages would have quietly stopped refreshing
// exactly those campaigns. `draft`/`brief_locked` stay out — no roster can
// exist yet — and `payment_done` stays out because a settled campaign is
// signed off and its numbers should stop moving.
const ACTIVE_STAGES = [
  "team_assigned", "po_raised", "advance_received", "invoice_raised",
  // Retired ids, still on documents that haven't been re-saved.
  "execution", "reporting", "po", "advance",
  "brief_sent", "concept_submitted", "concept_approved", "production",
  "video_submitted", "internal_review", "client_approved", "live", "creator_paid",
];

// Same shape the frontend's TabDeliverables refresh writes, so a scheduled
// refresh and a manual one are indistinguishable downstream.
const liveLinksOf = (cr) => {
  const live = cr?.live;
  if (!live) return [];
  const urls = Array.isArray(live.postUrls) ? live.postUrls : live.postUrl ? [live.postUrl] : [];
  return urls.map((u) => String(u || "").trim()).filter(Boolean);
};

// Serial, with a gap between calls. HikerAPI is rate-limited and billed per
// call; firing a hundred posts in parallel at midnight is the reliable way to
// get throttled and end up with less fresh data than before.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP_MS = Number(process.env.METRICS_REFRESH_GAP_MS) || 400;

export async function refreshAllPostMetrics({ log = console.log } = {}) {
  const started = Date.now();
  const campaigns = await Campaign.find({
    deleted: { $ne: true },
    stage: { $in: ACTIVE_STAGES },
  }).lean();

  let posts = 0, ok = 0, failed = 0, touched = 0;

  for (const camp of campaigns) {
    const creators = camp.creators || [];
    let changed = false;

    for (const cr of creators) {
      const links = liveLinksOf(cr);
      if (!links.length) continue;

      const results = [];
      for (const url of links) {
        posts++;
        try {
          const m = await fetchPostMetrics(url, cr.platform);
          if (m?.error) { failed++; } else { ok++; results.push(m); }
        } catch (e) {
          // One unreachable post must never abort the run — the remaining
          // campaigns would silently keep yesterday's numbers.
          failed++;
          log(`[refreshPostMetrics] ${camp._id} ${url}: ${e.message}`);
        }
        await sleep(GAP_MS);
      }
      if (!results.length) continue;

      // null stays null: YouTube exposes no forward count, and summing that as
      // 0 would report a real zero rather than "not measured".
      const sum = (k) => (results.some((m) => m[k] != null)
        ? results.reduce((s, m) => s + (m[k] || 0), 0)
        : null);

      const next = {
        ...(cr.tracking || {}),
        views: sum("views"), likes: sum("likes"),
        comments: sum("comments"), forwards: sum("forwards"),
        postsCounted: results.length,
        lastFetched: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
        lastAutoRefresh: new Date().toISOString(),
      };
      // Recorded before the overwrite, so each night's reading survives as a
      // point on the growth chart instead of replacing the only copy. The
      // outgoing tracking is passed too: on a creator that has no series yet it
      // seeds the first point, so the chart has something to draw one refresh
      // sooner than if the already-measured reading were simply discarded.
      cr.tracking = {
        ...next,
        history: withHistory(cr.tracking?.history, next, new Date(), cr.tracking),
      };
      changed = true;
    }

    if (changed) {
      // Writes creators[] only. A full document save would clobber whatever
      // someone edited in the UI while this was running — the job holds a lean
      // snapshot read minutes ago, and midnight is not a guarantee of an idle
      // system.
      await Campaign.updateOne({ _id: camp._id }, { $set: { creators } });
      touched++;
    }
  }

  const summary = { campaigns: campaigns.length, updated: touched, posts, ok, failed, ms: Date.now() - started };
  log(`[refreshPostMetrics] ${JSON.stringify(summary)}`);
  return summary;
}
