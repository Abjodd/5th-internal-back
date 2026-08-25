/**
 * Portal reels — the live campaign posts belonging to one brand, shaped for the
 * client portal's Reels shelf (5th-avenue-client-front src/pages/assets.jsx).
 *
 * WHERE THE DATA COMES FROM, AND WHY IT TAKES TWO SOURCES
 *
 * Mongo knows *which* posts exist: every roster row that has gone live carries
 * `live.postUrl` (and, on newer rows, `live.postUrls[]`). That is the whole of
 * what we store — a permalink and a date. It is enough for the Deliverables tab,
 * which only ever renders a link and the numbers refreshPostMetrics.js writes
 * back onto `tracking`.
 *
 * A shelf of playing video needs three things Mongo has never held: the video
 * file, a poster frame, and the caption. Those live only on Instagram's own
 * media object, which we reach through HikerAPI — the same key and the same
 * /v2/media/by/url endpoint postMetrics.js already uses for view counts.
 *
 * WHY THE URLS ARE NOT WRITTEN BACK TO MONGO
 *
 * Instagram signs its CDN links with an expiry (`&oe=` — hex unix seconds).
 * Measured against live posts: video ~32h, poster image ~106h. Persisting them
 * would mean a collection that is authoritative-looking and quietly wrong a day
 * later, and nothing on the read path could tell a fresh URL from a dead one.
 * So the media object is cached in memory for a day instead. A cache entry that
 * expires is simply refetched; a stored one that expires is a broken <video>.
 *
 * The 24h TTL sits inside the video's ~32h signature on purpose. It is the
 * longest window that still hands the browser a link certain to resolve, and it
 * costs one HikerAPI call per post per day regardless of how many people at the
 * brand open the page.
 */
import Campaign from "./models/Campaign.js";
import { hydrateCampaignCreators } from "./creatorSync.js";

const IG_MEDIA_V2 = "https://api.hikerapi.com/v2/media/by/url";
const HIKER_TOKEN = process.env.HIKERAPI_TOKEN;
const DEBUG = process.env.IG_DEBUG !== "0";

// A day, matching the comment above. Overridable so a developer can shorten it
// while working on the page without editing code and forgetting to put it back.
const TTL_MS = Number(process.env.PORTAL_REELS_TTL_MS) || 24 * 60 * 60 * 1000;

// Cold posts only — anything cached is skipped — so this bounds a first load,
// not steady state. Kept low because HikerAPI rate-limits per key and this
// shares that key with the nightly refresh and the Add Creator lookup.
const CONCURRENCY = 4;

function log(...args) {
  if (DEBUG) console.log("[portalReels]", ...args);
}

/* ── cache ─────────────────────────────────────────────────────────────────
 * Keyed by post URL, not by client: two campaigns can carry the same post, and
 * the media object is identical either way. Process-local by design — the API
 * is a single always-on service (see refreshPostMetrics.js on why there is no
 * external cron), so there is no second instance to share a cache with.
 */
const cache = new Map(); // url -> { at: epochMs, media: object|null }

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
 */
function toReel(m, ctx) {
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
    // Which campaign this post was delivered for. The shelf does not group by
    // it today, but it is the brand's own campaign name and the obvious next
    // filter, so it travels rather than being refetched later.
    campaign: ctx.campaign || null,
  };
}

/** One media object, from cache when fresh. Never throws. */
async function fetchMedia(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.media;

  if (!HIKER_TOKEN) {
    log("HIKERAPI_TOKEN not set in backend/.env");
    return hit?.media ?? null;
  }

  let media = null;
  try {
    const res = await fetch(`${IG_MEDIA_V2}?${new URLSearchParams({ url })}`, {
      headers: { "x-access-key": HIKER_TOKEN },
    });
    const text = await res.text();
    if (res.status !== 200) {
      log(`media ${url} failed status=${res.status}`, text.slice(0, 200));
    } else {
      media = JSON.parse(text)?.items?.[0] ?? null;
      if (!media) log(`media ${url}: no items[] in response`);
    }
  } catch (e) {
    log(`media ${url}: ${e.message}`);
  }

  // A failed refetch keeps serving yesterday's entry rather than dropping the
  // card off the shelf. The signature outlives the TTL by ~8h, so a stale hit
  // is still very likely to play — and a reel that vanishes on a bad upstream
  // day reads to the brand as us having lost their post.
  if (media === null && hit) {
    log(`serving stale entry for ${url}`);
    return hit.media;
  }

  cache.set(url, { at: Date.now(), media });
  return media;
}

/** Every Instagram post this client has live, deduped, newest campaign first. */
async function collectPosts(clientName) {
  const campaigns = await Campaign.find({ client: clientName, deleted: { $ne: true } }).lean();
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

/** Map with a bounded number of in-flight requests. */
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/**
 * The brand's reels, newest first.
 *
 * Both reels and stills come back, tagged with `kind` — the shelf renders a
 * still as a card that only enlarges on hover, so a photo post is content here
 * rather than something to filter away.
 *
 * Posts that fail to fetch, or that carry neither a video nor a usable
 * thumbnail, drop out silently — a partial shelf is the right failure here.
 * The page's own empty state covers the case where nothing survives.
 */
export async function getClientReels(clientName) {
  const posts = await collectPosts(clientName);
  if (!posts.length) return [];

  const media = await pooled(posts, CONCURRENCY, (p) => fetchMedia(p.postUrl));
  const reels = media
    .map((m, i) => (m ? toReel(m, posts[i]) : null))
    .filter(Boolean);

  reels.sort((a, b) => (b.takenAt || "").localeCompare(a.takenAt || ""));
  log(`${clientName}: ${posts.length} post(s) -> ${reels.length} reel(s)`);
  return reels;
}
