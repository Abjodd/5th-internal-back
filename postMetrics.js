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
