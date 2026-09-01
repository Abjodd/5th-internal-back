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
import { fetchRemoteImage } from "./remoteAvatar.js";

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

/* Poster bytes are copied once and kept forever, so the ceiling only has to be
 * generous enough for a full-resolution Instagram cover (~100-300KB observed).
 * Anything wildly above that is not a poster frame and is not worth storing. */
const MAX_POSTER_BYTES = 2 * 1024 * 1024;

/* Pass to any read that does not need the image itself — which is every read
 * except the poster route. Same discipline as avatarStore's OMIT_AVATAR: bytes
 * on the document are only affordable if list queries never load them. */
export const OMIT_POSTER = { poster: 0 };

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

/**
 * When a signed Instagram CDN link stops resolving, as an ISO string.
 *
 * Every one of these URLs carries `oe=<hex unix seconds>` — the moment past
 * which the CDN answers 403 for everyone. Reading it is free and exact, which
 * beats the alternative the TTL machinery used: assume 24h, refresh on a
 * schedule, and hope. Measured across this collection the video signature runs
 * 32-36h and the poster 104-108h, so the guess was never wrong by much — but it
 * could only be *acted* on by re-buying the media.
 *
 * Storing the real expiry instead lets a read decide, at zero cost, whether the
 * link it holds is still worth handing to a browser. null when the URL carries
 * no `oe=` (nothing to check, so nothing is assumed).
 */
export function signedExpiryOf(url) {
  const m = /[?&]oe=([0-9a-f]+)/i.exec(String(url || ""));
  if (!m) return null;
  const ms = parseInt(m[1], 16) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
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
    // The moment the line above stops resolving. Read at serve time so an
    // expired URL is never handed to a browser — a card with no video renders
    // as a still, which is correct, where a dead <video> renders as a black
    // box. See signedExpiryOf and getClientReels.
    videoExpiresAt: isReel ? signedExpiryOf(video) : null,
    // Kept even once the bytes are ours: it is what a re-capture would fetch
    // from, and what the shelf falls back to for a row stored before posters
    // were captured at all.
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
 * Returns { reel, posterUpdatedAt } — the stored document's own fields, so a
 * caller that just wrote a row does not have to read it back. Null `reel` means
 * nothing renderable was stored.
 *
 * Never throws — a bookkeeping write must not be able to fail the job it rides
 * on. A missed upsert just means the post is picked up on a later pass.
 */
export async function cacheReelFromMedia(postUrl, media, ctx = {}) {
  if (!postUrl) return { reel: null, posterUpdatedAt: null };
  const now = new Date();
  try {
    // What we already hold, so the poster is copied once rather than on every
    // refresh. One indexed _id read against a write we were making anyway.
    const existing = await ReelCache.findById(postUrl, { posterUpdatedAt: 1 }).lean();

    if (!media) {
      // Record the attempt so a dead post backs off, but leave `reel` and
      // `fetchedAt` untouched: whatever we last managed to read stays on the
      // shelf. A reel that vanishes on a bad upstream day reads to the brand as
      // us having lost their post — and now that the poster is bytes we own,
      // the card keeps rendering correctly regardless.
      await ReelCache.updateOne(
        { _id: postUrl },
        { $set: { attemptedAt: now, lastError: "no media in response" } },
        { upsert: true },
      );
      return { reel: null, posterUpdatedAt: existing?.posterUpdatedAt ?? null };
    }

    const reel = toReel(media, { ...ctx, postUrl });
    const set = { reel, fetchedAt: now, attemptedAt: now, lastError: null, code: reel?.code ?? null };

    // Copy the poster frame the first time we see this post, and only then.
    // The image does not change, so re-fetching it on later passes would be
    // bandwidth spent to store the same bytes again. A failure here is not a
    // failure of the write: the signed `reel.thumbnail` is still on the
    // document and still serves the card until the next pass tries again.
    let posterUpdatedAt = existing?.posterUpdatedAt ?? null;
    if (!posterUpdatedAt && reel?.thumbnail) {
      const poster = await fetchRemoteImage(reel.thumbnail, { maxBytes: MAX_POSTER_BYTES });
      if (poster) {
        set.poster = poster;
        set.posterUpdatedAt = now;
        posterUpdatedAt = now;
      }
    }

    await ReelCache.updateOne({ _id: postUrl }, { $set: set }, { upsert: true });
    return { reel, posterUpdatedAt };
  } catch (e) {
    log(`cache write ${postUrl}: ${e.message}`);
    return { reel: null, posterUpdatedAt: null };
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
 * The Instagram posts on one roster, deduped against `seen`.
 *
 * Split out of collectPosts because the write path needs the same walk over a
 * creators[] array it is about to save, without a campaigns query to do it —
 * see warmReels(). One reading of the roster shape means the two paths cannot
 * disagree about which links count as posts.
 */
function postsOfCreators(creators, campaignName = null, seen = new Set()) {
  const posts = [];
  for (const cr of creators || []) {
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
      posts.push({ postUrl: url, handle: cr.handle || null, campaign: campaignName });
    }
  }
  return posts;
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
  for (const c of campaigns) posts.push(...postsOfCreators(c.creators, c.name || null, seen));
  return posts;
}

/**
 * Fetch and store any post on this roster the cache has never seen.
 *
 * Called from the campaign write path (PATCH /api/campaigns/:id), which is the
 * moment a post URL first exists in the system — someone on the internal side
 * has just pasted the permalink of a reel that went live.
 *
 * ── Why the write path is the right place ───────────────────────────────────
 * Fetching here does not change what a post costs: it is one call either way,
 * once, for the lifetime of the post. What it changes is WHEN and WHO. Before,
 * the first fetch happened on a brand's own page load (FILL_ON_READ) or up to
 * 24h later on a scheduled pass — so a client opening the portal minutes after
 * delivery either paid the latency of a third-party call inside their request,
 * or saw a shelf that was silently missing the post they were told about.
 *
 * Doing it at write time means the portal's read path can be strictly
 * database-only (PORTAL_REELS_FILL_ON_READ=0) while a new reel still appears
 * immediately.
 *
 * Fire-and-forget by design — never awaited by the route, never throws. A
 * campaign save must not fail, or wait, because Instagram is slow. Idempotent
 * and self-limiting: a row exists after the first attempt whether it succeeded
 * or not, so a post is never fetched here twice.
 */
export async function warmReels(creators, campaignName = null) {
  try {
    const posts = postsOfCreators(creators, campaignName);
    if (!posts.length) return { posts: 0, fetched: 0 };

    const known = await ReelCache.find({ _id: { $in: posts.map((p) => p.postUrl) } })
      .select({ _id: 1 })
      .lean();
    const seen = new Set(known.map((r) => r._id));

    // Capped for the same reason the read-path fill was: one save should not be
    // able to turn into an unbounded run of paid calls. Anything over the cap
    // is a bulk import, which the scheduled pass is the right place to absorb.
    const batch = posts.filter((p) => !seen.has(p.postUrl)).slice(0, MAX_FILL_ON_READ);
    if (!batch.length) return { posts: posts.length, fetched: 0 };

    log(`warm ${campaignName || "campaign"}: ${batch.length} new post(s)`);
    for (const post of batch) {
      await fetchAndCache(post);
      await sleep(GAP_MS);
    }
    return { posts: posts.length, fetched: batch.length };
  } catch (e) {
    log(`warm failed: ${e.message}`);
    return { posts: 0, fetched: 0 };
  }
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
  // Without OMIT_POSTER this would pull every stored JPEG into memory to build
  // a JSON payload that does not contain them — the whole point of serving the
  // image from its own route. Same rule as avatarStore's list projections.
  const rows = await ReelCache.find({ _id: { $in: urls } }).select(OMIT_POSTER).lean();
  const byUrl = new Map(rows.map((r) => [r._id, r]));

  // First sight only: a post that went live since the last scheduled pass has
  // no row at all. See FILL_ON_READ — this is bounded, persisted (so it cannot
  // repeat for the same post), and skipped entirely when disabled. With
  // warmReels() on the campaign write path this should now find nothing, and
  // setting PORTAL_REELS_FILL_ON_READ=0 makes that guarantee rather than a
  // hope.
  const unseen = FILL_ON_READ ? posts.filter((p) => !byUrl.has(p.postUrl)) : [];
  if (unseen.length) {
    const batch = unseen.slice(0, MAX_FILL_ON_READ);
    log(`${clientName}: ${unseen.length} post(s) never cached, filling ${batch.length}`);
    for (const p of batch) {
      const { reel, posterUpdatedAt } = await fetchAndCache(p);
      byUrl.set(p.postUrl, { _id: p.postUrl, reel, posterUpdatedAt });
      await sleep(GAP_MS);
    }
  }

  const now = Date.now();
  const reels = [];
  for (const p of posts) {
    const row = byUrl.get(p.postUrl);
    const cached = row?.reel;
    if (!cached) continue;

    // A signed video URL past its `oe=` is a 403 waiting to happen, and a
    // <video> pointed at one renders a black box rather than falling back. The
    // shelf already treats "no video" as "this is a still", so withholding the
    // dead link is what makes an archived reel degrade cleanly instead of
    // breaking. The poster is ours and does not expire, so the card is intact
    // either way — only the hover-play is lost.
    const playable = cached.videoExpiresAt
      ? Date.parse(cached.videoExpiresAt) > now
      : !!cached.video;

    reels.push({
      ...cached,
      video: playable ? cached.video : null,
      // Whether the portal should read the poster from our own route instead of
      // the signed `thumbnail`. Mirrors `hasAvatar` on the creator routes, and
      // for the same reason: the bytes never travel in a list payload, so the
      // client needs a witness that they exist plus a version to cache-bust on.
      hasPoster: !!row.posterUpdatedAt,
      posterUpdatedAt: row.posterUpdatedAt ?? null,
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
 * The stored poster for one shortcode, or null. Feeds GET
 * /api/portal/reels/:code/poster — the only read that wants the bytes.
 */
export async function getReelPoster(code) {
  const row = await ReelCache.findOne({ code }, { poster: 1 }).lean();
  return row?.poster ?? null;
}

/**
 * Copy the poster frame for every cached reel that has not got one yet.
 *
 * Costs NOTHING at HikerAPI. Each row already holds the signed `thumbnail` URL
 * from whenever it was last fetched, and the image signature runs ~106h — far
 * longer than the video's ~32h — so a row refreshed any time in the last four
 * days can have its bytes copied straight off that link. Only a row whose
 * thumbnail signature has also lapsed is beyond reach here; it is picked up by
 * the next ordinary fetch of that post.
 *
 * Exists because the posters and the `code` index arrived after the collection
 * did. Without it every row cached before this change keeps serving the signed
 * link, on the same expiry clock as before, and the change only helps posts
 * fetched from here on. Safe to run repeatedly: rows that already have a poster
 * are not queried, so a second run does nothing.
 */
export async function backfillPosters({ log: out = console.log } = {}) {
  const started = Date.now();
  const rows = await ReelCache.find({ posterUpdatedAt: { $in: [null, undefined] } })
    .select({ reel: 1 })
    .lean();

  let ok = 0, failed = 0, skipped = 0;
  for (const row of rows) {
    const thumbnail = row.reel?.thumbnail;
    // `code` is backfilled alongside, and unconditionally: it is what the
    // poster route looks a document up by, and it was never stored at the top
    // level before this change.
    const set = { code: row.reel?.code ?? null };

    if (!thumbnail) {
      skipped++;
    } else {
      const poster = await fetchRemoteImage(thumbnail, { maxBytes: MAX_POSTER_BYTES });
      if (poster) {
        set.poster = poster;
        set.posterUpdatedAt = new Date();
        ok++;
      } else {
        // Almost always an expired image signature — see signedExpiryOf. Left
        // for the next fetch of this post to supply a fresh link.
        failed++;
      }
    }
    await ReelCache.updateOne({ _id: row._id }, { $set: set });
  }

  const summary = { rows: rows.length, ok, failed, skipped, apiCalls: 0, ms: Date.now() - started };
  out(`[portalReels] backfillPosters ${JSON.stringify(summary)}`);
  return summary;
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
    const { reel } = await fetchAndCache(p);
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
