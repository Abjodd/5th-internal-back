/**
 * Portal reels — the live campaign posts belonging to one brand, shaped for the
 * client portal's Reels shelf (5th-avenue-client-front src/pages/assets.jsx).
 *
 * WHERE THE DATA COMES FROM, AND WHY IT TAKES TWO SOURCES
 *
 * Mongo knows *which* posts exist: every roster row that has gone live carries
 * `live.postUrl` (and, on newer rows, `live.postUrls[]`). That is the whole of
 * what campaigns store — a permalink and a date. It is enough for the
 * Deliverables tab, which only renders a link and the numbers
 * refreshPostMetrics.js writes back onto `tracking`.
 *
 * A shelf of playing video needs three things the campaign never held: the
 * video file, a poster frame, and the caption. Those live on Instagram's media
 * object, which we reach through HikerAPI's /v2/media/by/url.
 *
 * ── WHAT CHANGED, AND WHY THE OLD VERSION BURNED CREDITS ────────────────────
 *
 * This file used to fetch on the REQUEST PATH, behind a `new Map()` guarded by
 * a 24h TTL. The TTL was correct; the storage was not. A Map lives in process
 * memory, so it was emptied by every deploy, every crash, and every idle-
 * instance recycle. What the old header described as "one HikerAPI call per
 * post per day regardless of how many people at the brand open the page" was
 * in practice one call per post per COLD START. On a host that sleeps an idle
 * service, that is a full-price refetch of the entire shelf every time someone
 * opens the portal after a quiet spell — which is the charge that showed up on
 * the bill.
 *
 * Two changes fix it:
 *
 *   1. The cache is a Mongo collection (models/ReelCache.js), so it survives
 *      the restart that was causing the refetch.
 *   2. Nothing on the request path fetches. getClientReels() is now a read.
 *      Population happens on a schedule (refreshAllReels, wired up in
 *      scheduler.js) and — for free — off the media objects the nightly
 *      post-metrics job is ALREADY paying for.
 *
 * That second point is where most of the saving is. refreshPostMetrics.js has
 * always called the same /v2/media/by/url endpoint on the same post URLs every
 * night, kept `like_count`/`play_count`/etc. and discarded the rest of the
 * response — including the video, poster and caption this file was then buying
 * a SECOND time. cacheReelFromMedia() below lets that job hand the leftovers
 * over, so a post on an active campaign now costs one call a night in total
 * instead of two-plus.
 *
 * ── WHY THE TTL CANNOT SIMPLY BE RAISED ─────────────────────────────────────
 *
 * Instagram signs its CDN links with an expiry (`&oe=` — hex unix seconds).
 * Measured against live posts: video ~32h, poster image ~106h. The refresh
 * cadence therefore has a hard ceiling that is not a matter of taste — past
 * ~32h the stored video URL stops resolving and the card renders a dead
 * player. 24h is the longest interval that still hands the browser a link
 * certain to work, with ~8h of slack for a missed or slow run.
 *
 * Raising it to 48h would leave every video broken for roughly the last third
 * of each cycle. It costs nothing to keep it at 24h, because the call it rides
 * on is one the post-metrics job was making anyway.
 */
import Campaign from "./models/Campaign.js";
import ReelCache from "./models/ReelCache.js";
import { hydrateCampaignCreators } from "./creatorSync.js";

const IG_MEDIA_V2 = "https://api.hikerapi.com/v2/media/by/url";
const HIKER_TOKEN = process.env.HIKERAPI_TOKEN;
const DEBUG = process.env.IG_DEBUG !== "0";

/* A day. Overridable so a developer can shorten it while working on the page,
 * but see the header before lengthening it: above ~32h the stored video URL is
 * expired and the shelf plays nothing. */
const TTL_MS = Number(process.env.PORTAL_REELS_TTL_MS) || 24 * 60 * 60 * 1000;

/* How long a FAILED post is left alone before it is tried again. A post that
 * was deleted or made private on Instagram will never fetch again; without a
 * backoff those few dead links become a permanent daily charge for nothing. */
const RETRY_MS = Number(process.env.PORTAL_REELS_RETRY_MS) || 6 * 60 * 60 * 1000;

/* Serial with a gap, matching refreshPostMetrics.js. HikerAPI rate-limits per
 * key and this shares that key with the metrics job and the Add Creator
 * lookup; a burst is the reliable way to get throttled. */
const GAP_MS = Number(process.env.PORTAL_REELS_GAP_MS) || 400;

/* A ceiling on what one scheduled pass may spend, so a bad day cannot turn
 * into an unbounded bill. Entries are refreshed stalest-first, so a capped run
 * still makes correct progress and the remainder is picked up next pass. */
const MAX_PER_RUN = Number(process.env.PORTAL_REELS_MAX_PER_RUN) || 400;

/* Whether a post the cache has NEVER seen may be fetched on the request path.
 *
 * This is not a reopening of the old behaviour. The old code refetched a post
 * whenever the process had restarted, without limit and forever. This fills a
 * genuine first-sight gap — a creator's post that went live since the last
 * scheduled pass — and because the result is PERSISTED (including failures,
 * which write `attemptedAt`), it can happen at most once per post for the
 * lifetime of that post. Set to 0 to make reads strictly database-only and let
 * a new reel wait for the next job run to appear.
 */
const FILL_ON_READ = process.env.PORTAL_REELS_FILL_ON_READ !== "0";
const MAX_FILL_ON_READ = Number(process.env.PORTAL_REELS_MAX_FILL) || 12;

function log(...args) {
  if (DEBUG) console.log("[portalReels]", ...args);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Highest-fidelity progressive MP4 the response offers.
 *
 * `video_versions` comes back as several entries at the SAME dimensions with
 * different `type` codes (101/102/103 observed) — these are encoding variants,
 * not quality steps, so sorting by pixel count picks arbitrarily among equals.
 * 101 is the progressive MP4 that plays in a plain <video>; the others are
 * adaptive renditions. Prefer it explicitly and fall back to first-listed.
 */
function pickVideo(versions) {
  if (!Array.isArray(versions) || !versions.length) return null;
  return (versions.find((v) => v.type === 101) || versions[0]).url || null;
}

/** Poster frame. `candidates` is the post's own thumbnail; `first_frame` is a
 *  grab from the video itself and only stands in when the former is absent. */
function pickThumbnail(iv2) {
  return (
    iv2?.candidates?.[0]?.url ||
    iv2?.additional_candidates?.first_frame?.url ||
    null
  );
}

/* A count of 0 is a real measurement and must survive; only null/undefined mean
   "not reported". Same rule, and the same reason, as postMetrics.js. */
const count = (...vals) => {
  for (const v of vals) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

/**
 * The media object, reduced to what a brand may see.
 *
 * Built by explicit construction rather than by spreading the response and
 * deleting fields — the same choice CREATOR_PUBLIC makes in server.js, for the
 * same reason. HikerAPI returns ~150 keys per media, including viewer-state and
 * monetisation flags that mean nothing here; a denylist would publish every one
 * of them the day Instagram adds it. Everything below is already public on the
 * post itself.
 *
 * That mattered when this was a response shape. It matters more now that it is
 * also the STORED shape: what this function keeps is what lands in Mongo.
 */
export function toReel(m, ctx = {}) {
  // `kind` is the whole reason photos travel at all. The shelf treats the two
  // differently on hover — a reel starts playing, a still only lifts — and that
  // decision cannot be made from the presence of a video URL alone: a feed
  // video (media_type 2, product_type "feed") has one too but is not a reel.
  // product_type is Instagram's own answer, so it is the one we ask.
  const video = pickVideo(m.video_versions);
  const isReel = m.product_type === "clips" && !!video;

  // A carousel's cover is its first child; the parent carries no media of its
  // own. Without this the whole post drops out for want of a thumbnail.
  const cover = m.media_type === 8 ? m.carousel_media?.[0] : m;
  const thumbnail = pickThumbnail(cover?.image_versions2);

  // Nothing to show at all — not a playable reel and no still to fall back on.
  // A card here would be a dead tile, so it is better that it never mounts.
  if (!isReel && !thumbnail) return null;

  return {
    id: String(m.id || m.pk || m.code),
    kind: isReel ? "reel" : "post",
    code: m.code || null,
    // Rebuilt from `code` rather than echoing the stored postUrl: an /p/ link
    // and a /reel/ link resolve to the same post, but /reel/ is what Instagram
    // itself hands out for clips and what opens the reel player on mobile.
    permalink: m.code ? `https://www.instagram.com/reel/${m.code}/` : ctx.postUrl,
    username: m.user?.username || ctx.handle || null,
    caption: m.caption?.text || null,
    // Only reels carry a video: a feed video would otherwise autoplay on hover
    // in a shelf whose hint promises that only reels do.
    video: isReel ? video : null,
    thumbnail,
    likes: count(m.like_count),
    comments: count(m.comment_count),
    views: count(m.play_count, m.ig_play_count, m.view_count),
    forwards: count(m.reshare_count, m.share_count),
    duration: count(m.video_duration),
    width: count(m.original_width),
    height: count(m.original_height),
    // How many stills a carousel holds; null for anything single-frame, which
    // is what the card reads to decide whether to show a multi-image badge.
    slides: m.media_type === 8 ? (m.carousel_media?.length ?? null) : null,
    takenAt: m.taken_at ? new Date(m.taken_at * 1000).toISOString() : null,
    // Deliberately NOT stored: `campaign`. It is a campaign NAME, and a name is
    // editable — a cached copy would go stale the moment someone renames the
    // campaign in the internal app. getClientReels() reattaches it at read time
    // from the live campaign document, which costs nothing because that query
    // is how we resolved the post list in the first place.
  };
}

/**
 * Persist one reel from a media object somebody has ALREADY paid for.
 *
 * The reason this is exported: refreshPostMetrics.js hits the very same
 * /v2/media/by/url on the very same URLs every night and throws away
 * everything except four counts. Handing the response here makes the portal's
 * copy a by-product of a call that was already on the bill, which is what
 * takes an active campaign's cost from two calls per post per day to one.
 *
 * Never throws — a bookkeeping write must not be able to fail the job it rides
 * on. A missed upsert just means the scheduled reels pass picks the post up.
 */
export async function cacheReelFromMedia(postUrl, media, ctx = {}) {
  if (!postUrl) return null;
  const now = new Date();
  try {
    if (!media) {
      // Record the attempt so a dead post backs off, but leave `reel` and
      // `fetchedAt` untouched: whatever we last managed to read stays on the
      // shelf. The video signature outlives the TTL by ~8h, so a stale hit is
      // still likely to play — and a reel that vanishes on a bad upstream day
      // reads to the brand as us having lost their post.
      await ReelCache.updateOne(
        { _id: postUrl },
        { $set: { attemptedAt: now, lastError: "no media in response" } },
        { upsert: true },
      );
      return null;
    }
    const reel = toReel(media, { ...ctx, postUrl });
    await ReelCache.updateOne(
      { _id: postUrl },
      { $set: { reel, fetchedAt: now, attemptedAt: now, lastError: null } },
      { upsert: true },
    );
    return reel;
  } catch (e) {
    log(`cache write ${postUrl}: ${e.message}`);
    return null;
  }
}

/** One media object, straight from HikerAPI. Never throws. Returns null on any
 *  failure — the caller decides what a failure means. */
async function fetchMedia(url) {
  if (!HIKER_TOKEN) {
    log("HIKERAPI_TOKEN not set in backend/.env");
    return null;
  }
  try {
    const res = await fetch(`${IG_MEDIA_V2}?${new URLSearchParams({ url })}`, {
      headers: { "x-access-key": HIKER_TOKEN },
    });
    const text = await res.text();
    if (res.status !== 200) {
      log(`media ${url} failed status=${res.status}`, text.slice(0, 200));
      return null;
    }
    const media = JSON.parse(text)?.items?.[0] ?? null;
    if (!media) log(`media ${url}: no items[] in response`);
    return media;
  } catch (e) {
    log(`media ${url}: ${e.message}`);
    return null;
  }
}

/** Fetch one post and store it. The only place in this file that spends a
 *  credit; everything else reads Mongo. */
async function fetchAndCache(post) {
  const media = await fetchMedia(post.postUrl);
  return cacheReelFromMedia(post.postUrl, media, post);
}

/**
 * Every Instagram post the given client has live, deduped, with the handle and
 * campaign name each came from. Pass no client to sweep every brand — that is
 * what the scheduled refresh does.
 */
export async function collectPosts(clientName = null) {
  const filter = { deleted: { $ne: true } };
  if (clientName) filter.client = clientName;

  const campaigns = await Campaign.find(filter).lean();
  // Roster rows carry no `handle` of their own since creator profiles moved to
  // the creators collection — without this the fallback username is undefined
  // for every post. Same rejoin every other read path performs; see the note on
  // /api/portal/analytics in server.js for what happens when it is skipped.
  await hydrateCampaignCreators(campaigns);

  const seen = new Set();
  const posts = [];
  for (const c of campaigns) {
    for (const cr of c.creators || []) {
      const live = cr.live || {};
      const urls = Array.isArray(live.postUrls)
        ? live.postUrls
        : live.postUrl
          ? [live.postUrl]
          : [];
      for (const raw of urls) {
        const url = String(raw || "").trim();
        // Platform is the roster's own label and is sometimes unset on older
        // rows, so the link itself is the authority on what this is.
        if (!/instagram\.com/i.test(url) || seen.has(url)) continue;
        seen.add(url);
        posts.push({ postUrl: url, handle: cr.handle || null, campaign: c.name || null });
      }
    }
  }
  return posts;
}

/**
 * The brand's reels, newest first — read from Mongo.
 *
 * This is the request path, and in steady state it costs zero HikerAPI calls
 * however many people at the brand open the page, however many times, and
 * whether or not the process restarted five seconds ago. That last clause is
 * the entire point of the change.
 *
 * Both reels and stills come back, tagged with `kind` — the shelf renders a
 * still as a card that only enlarges on hover, so a photo post is content here
 * rather than something to filter away.
 *
 * Posts with no cached media, or that carry neither a video nor a usable
 * thumbnail, drop out silently — a partial shelf is the right failure here.
 * The page's own empty state covers the case where nothing survives.
 */
export async function getClientReels(clientName) {
  const posts = await collectPosts(clientName);
  if (!posts.length) return [];

  const urls = posts.map((p) => p.postUrl);
  const rows = await ReelCache.find({ _id: { $in: urls } }).lean();
  const byUrl = new Map(rows.map((r) => [r._id, r]));

  // First sight only: a post that went live since the last scheduled pass has
  // no row at all. See FILL_ON_READ — this is bounded, persisted (so it cannot
  // repeat for the same post), and skipped entirely when disabled.
  const unseen = FILL_ON_READ ? posts.filter((p) => !byUrl.has(p.postUrl)) : [];
  if (unseen.length) {
    const batch = unseen.slice(0, MAX_FILL_ON_READ);
    log(`${clientName}: ${unseen.length} post(s) never cached, filling ${batch.length}`);
    for (const p of batch) {
      const reel = await fetchAndCache(p);
      byUrl.set(p.postUrl, { _id: p.postUrl, reel });
      await sleep(GAP_MS);
    }
  }

  const reels = [];
  for (const p of posts) {
    const cached = byUrl.get(p.postUrl)?.reel;
    if (!cached) continue;
    reels.push({
      ...cached,
      // Reattached from the live campaign rather than read from the cache, so
      // a renamed campaign is correct on the shelf immediately. Same for the
      // handle fallback, which only applies when the media carried no username.
      username: cached.username || p.handle || null,
      campaign: p.campaign || null,
    });
  }

  reels.sort((a, b) => (b.takenAt || "").localeCompare(a.takenAt || ""));
  log(`${clientName}: ${posts.length} post(s) -> ${reels.length} reel(s) (0 API calls)`);
  return reels;
}

/**
 * Scheduled refresh — rewrite every cached reel whose signed CDN links are
 * approaching expiry. Wired up in scheduler.js.
 *
 * Runs AFTER the nightly post-metrics job on purpose: that job has by then
 * already refreshed, for free, every post on a campaign still in flight (see
 * ACTIVE_STAGES in refreshPostMetrics.js). What is left for this pass to pay
 * for is the remainder — posts on completed and archived campaigns, which the
 * metrics job deliberately stops touching but which are still on the brand's
 * shelf and still need a link that resolves.
 */
export async function refreshAllReels({ log: out = console.log } = {}) {
  const started = Date.now();
  const posts = await collectPosts();

  const rows = await ReelCache.find({ _id: { $in: posts.map((p) => p.postUrl) } })
    .select({ fetchedAt: 1, attemptedAt: 1 })
    .lean();
  const byUrl = new Map(rows.map((r) => [r._id, r]));

  const now = Date.now();
  const due = posts.filter((p) => {
    const row = byUrl.get(p.postUrl);
    if (!row) return true; // never fetched
    const fetched = row.fetchedAt ? new Date(row.fetchedAt).getTime() : 0;
    if (now - fetched < TTL_MS) return false; // still inside the signature
    // Stale, but don't retry a failing post on every pass — see RETRY_MS.
    const attempted = row.attemptedAt ? new Date(row.attemptedAt).getTime() : 0;
    return now - attempted >= RETRY_MS;
  });

  // Stalest first, so a capped run always spends its budget where the links
  // are closest to expiring rather than on whatever Mongo listed first.
  due.sort((a, b) => {
    const at = byUrl.get(a.postUrl)?.fetchedAt ?? 0;
    const bt = byUrl.get(b.postUrl)?.fetchedAt ?? 0;
    return new Date(at).getTime() - new Date(bt).getTime();
  });

  const batch = due.slice(0, MAX_PER_RUN);
  let ok = 0, failed = 0;
  for (const p of batch) {
    const reel = await fetchAndCache(p);
    if (reel === null) failed++; else ok++;
    await sleep(GAP_MS);
  }

  const summary = {
    posts: posts.length,
    fresh: posts.length - due.length,
    due: due.length,
    attempted: batch.length,
    ok,
    failed,
    skippedByCap: due.length - batch.length,
    ms: Date.now() - started,
  };
  out(`[portalReels] refresh ${JSON.stringify(summary)}`);
  return summary;
}
