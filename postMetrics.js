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

const IG_MEDIA_URL = "https://api.hikerapi.com/v1/media/by/url";
const HIKER_TOKEN = process.env.HIKERAPI_TOKEN;
const DEBUG = process.env.IG_DEBUG !== "0";

function log(...args) {
  if (DEBUG) console.log("[postMetrics]", ...args);
}

async function instagramPostMetrics(url) {
  if (!HIKER_TOKEN) return { error: "HIKERAPI_TOKEN not set in backend/.env" };

  let res;
  try {
    res = await fetch(`${IG_MEDIA_URL}?${new URLSearchParams({ url })}`, {
      headers: { "x-access-key": HIKER_TOKEN },
    });
  } catch (e) {
    log("network error:", e.message);
    return { error: `Network error: ${e.message}` };
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    log(`non-JSON response (status ${res.status}):`, text.slice(0, 300));
    return { error: `Non-JSON response (status ${res.status})` };
  }
  if (res.status !== 200) {
    log(`request failed status=${res.status}`, JSON.stringify(body).slice(0, 300));
    return { error: body?.detail || body?.message || `Request failed with status ${res.status}` };
  }

  log("media", JSON.stringify(body).slice(0, 500));
  return {
    platform: "Instagram",
    // Reels/videos report play_count; photos have neither — views stays null.
    views: body.play_count ?? body.view_count ?? null,
    likes: body.like_count ?? null,
    comments: body.comment_count ?? null,
    forwards: body.reshare_count ?? body.share_count ?? null,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchPostMetrics(url, platform) {
  const s = String(url || "");
  if (/youtube\.com|youtu\.be/i.test(s) || platform === "YouTube") return fetchYouTubeVideoMetrics(s);
  if (/instagram\.com/i.test(s) || platform === "Instagram") return instagramPostMetrics(s);
  return { error: "Unsupported link — only Instagram and YouTube posts can be tracked." };
}
