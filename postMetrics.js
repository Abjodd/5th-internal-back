/**
 * Post metrics — real numbers for the Deliverables tab "Refresh" tracking.
 *
 * Instagram: HikerAPI GET /v1/media/by/url (same HIKERAPI_TOKEN as the
 *            profile lookup in instagramfetchhiker.js)
 * YouTube:   Data API v3 via youtubeFetch.js (YOUTUBE_API_KEY)
 *
 * Both branches return { platform, views, likes, comments, forwards,
 * fetchedAt } — null where the platform doesn't expose the number.
 */
import "dotenv/config";
import { fetchYouTubeVideoMetrics } from "./youtubeFetch.js";

/* ── Which HikerAPI endpoint, and why it matters ──────────────────────────────
 * v2 is the raw Instagram media object; v1 is HikerAPI's own normalised
 * subset. That subset does NOT carry a share count — not under any name — so
 * every "forwards" figure this app has recorded from Instagram has been null
 * regardless of what the post actually did. Verified against a live post:
 *
 *   /v1/media/by/url → { like_count, comment_count, play_count, view_count }
 *                      ...and nothing share-shaped anywhere in the object
 *   /v2/media/by/url → { items: [ { like_count, comment_count, play_count,
 *                                   reshare_count: 24540, ... } ] }
 *
 * v2 carries everything v1 did *plus* reshare_count, so this is a swap rather
 * than a second call — same one request per refresh, one more real number.
 * v1 stays as a fallback: if v2 ever changes shape or errors, the tab keeps
 * showing views/likes/comments instead of going blank.
 *
 * Note the response envelopes differ — v2 wraps in `items[]`, v1 is flat.
 */
/**
 * The raw media object, carried back beside the shaped counts.
 *
 * Attached as a NON-ENUMERABLE SYMBOL, and both halves of that are load-
 * bearing. This endpoint's response is ~150 keys of Instagram internals, and
 * callers hand our return value onward: /api/post-metrics does
 * `res.json(result)`, and refreshPostMetrics.js builds documents out of the
 * results it collects. A plain string key would leak the whole object into the
 * internal app's network tab and into the campaign document.
 *
 * The symbol keeps it out of JSON (`JSON.stringify` ignores symbol keys).
 * Non-enumerable keeps it out of a spread — object spread DOES copy enumerable
 * symbol keys, so the symbol alone would not have been enough. Together they
 * mean the value is invisible to every path that copies or serialises the
 * result, and visible only to a caller that names RAW_MEDIA explicitly.
 *
 * Why it is carried at all: portalReels.js needs the video, poster and caption
 * from this same response, and used to buy them in a second call to this same
 * endpoint. Handing over what we already have makes that second call
 * unnecessary — see cacheReelFromMedia() in portalReels.js.
 */
export const RAW_MEDIA = Symbol("hiker.rawMedia");

const IG_MEDIA_V2 = "https://api.hikerapi.com/v2/media/by/url";
const IG_MEDIA_V1 = "https://api.hikerapi.com/v1/media/by/url";
const HIKER_TOKEN = process.env.HIKERAPI_TOKEN;
const DEBUG = process.env.IG_DEBUG !== "0";

function log(...args) {
  if (DEBUG) console.log("[postMetrics]", ...args);
}

/** GET + parse, returning { ok, body } — never throws. */
async function hikerGet(endpoint, url) {
  let res;
  try {
    res = await fetch(`${endpoint}?${new URLSearchParams({ url })}`, {
      headers: { "x-access-key": HIKER_TOKEN },
    });
  } catch (e) {
    log("network error:", e.message);
    return { ok: false, error: `Network error: ${e.message}` };
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    log(`non-JSON response (status ${res.status}):`, text.slice(0, 300));
    return { ok: false, error: `Non-JSON response (status ${res.status})` };
  }
  if (res.status !== 200) {
    log(`${endpoint} failed status=${res.status}`, JSON.stringify(body).slice(0, 300));
    return { ok: false, error: body?.detail || body?.message || `Request failed with status ${res.status}` };
  }
  return { ok: true, body };
}

/* A count of 0 is a real measurement and must survive; only null/undefined
   mean "not reported". `??` alone would let a genuine 0 fall through to the
   next candidate key. */
const count = (...vals) => {
  for (const v of vals) {
    if (v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

/** Map either envelope's media object onto the shared return shape. */
const shape = (m) => ({
  platform: "Instagram",
  // Reels/videos report play_count; a photo has neither, so views stays null.
  views: count(m.play_count, m.view_count),
  likes: count(m.like_count),
  comments: count(m.comment_count),
  // Instagram's own name for a forward/send is a "reshare".
  forwards: count(m.reshare_count, m.share_count),
  fetchedAt: new Date().toISOString(),
});

async function instagramPostMetrics(url) {
  if (!HIKER_TOKEN) return { error: "HIKERAPI_TOKEN not set in backend/.env" };

  const v2 = await hikerGet(IG_MEDIA_V2, url);
  const item = v2.ok ? v2.body?.items?.[0] : null;
  if (item) {
    const result = shape(item);
    if (DEBUG) log("v2 media", JSON.stringify(result));
    // Only v2 carries video_versions/image_versions2/caption, so only v2 can
    // feed the reel cache. A v1 fallback returns counts alone and the reels
    // job picks that post up on its own pass.
    Object.defineProperty(result, RAW_MEDIA, { value: item, enumerable: false });
    return result;
  }
  log("v2 unusable, falling back to v1:", v2.error || "no items[] in response");

  const v1 = await hikerGet(IG_MEDIA_V1, url);
  if (!v1.ok) return { error: v1.error };
  const result = shape(v1.body);
  if (DEBUG) log("v1 media (no share count available at this tier)", JSON.stringify(result));
  return result;
}

export async function fetchPostMetrics(url, platform) {
  const s = String(url || "");
  if (/youtube\.com|youtu\.be/i.test(s) || platform === "YouTube") return fetchYouTubeVideoMetrics(s);
  if (/instagram\.com/i.test(s) || platform === "Instagram") return instagramPostMetrics(s);
  return { error: "Unsupported link — only Instagram and YouTube posts can be tracked." };
}
