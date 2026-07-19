/**
 * YouTube fetch — Data API v3 (https://developers.google.com/youtube/v3)
 *
 * Needs YOUTUBE_API_KEY in backend/.env (Google Cloud Console → enable
 * "YouTube Data API v3" → create an API key).
 *
 * fetchYouTubeChannel(urlOrHandle)   — Add Creator auto-fetch. Mirrors
 *   fetchInstagramProfile's response shape so the frontend's fetched-profile
 *   card renders both platforms unchanged.
 * fetchYouTubeVideoMetrics(url)      — one video's stats for post tracking.
 */
import "dotenv/config";

const API = "https://www.googleapis.com/youtube/v3";
const KEY = process.env.YOUTUBE_API_KEY;
const RECENT_SAMPLE = 12; // how many recent uploads to average likes over
const DEBUG = process.env.IG_DEBUG !== "0";

function log(...args) {
  if (DEBUG) console.log("[youtubeFetch]", ...args);
}

// Shared defensive GET → { body } | { error }
async function getJson(path, params) {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  let res;
  try {
    res = await fetch(url);
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
    return { error: body?.error?.message || `Request failed with status ${res.status}` };
  }
  return { body };
}

// "https://youtube.com/watch?v=ID", youtu.be/ID, /shorts/ID, /embed/ID, /live/ID
export function extractYouTubeVideoId(input) {
  const s = String(input || "").trim();
  const m = s.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{6,})/i);
  return m ? m[1] : null;
}

// Channel link (/channel/UC…, /@handle, /c/name, /user/name) or a bare @handle.
function extractChannelRef(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const id = s.match(/youtube\.com\/channel\/(UC[\w-]{10,})/i);
  if (id) return { id: id[1] };
  const h = s.match(/youtube\.com\/(@[\w.-]+)/i);
  if (h) return { handle: h[1] };
  const c = s.match(/youtube\.com\/(?:c\/|user\/)([\w.-]+)/i);
  if (c) return { handle: `@${c[1]}` };
  if (!/youtube\.com/i.test(s)) return { handle: s.startsWith("@") ? s : `@${s}` };
  return null;
}

// GET /api/post-metrics (YouTube branch) — one video's public stats.
export async function fetchYouTubeVideoMetrics(url) {
  if (!KEY) return { error: "YOUTUBE_API_KEY not set in backend/.env" };
  const id = extractYouTubeVideoId(url);
  if (!id) return { error: "Could not parse a video id from that YouTube link." };

  const { body, error } = await getJson("/videos", { part: "statistics", id, key: KEY });
  if (error) return { error };
  const stats = body.items?.[0]?.statistics;
  if (!stats) return { error: "Video not found (private, deleted, or wrong link)." };

  const n = (v) => (v != null ? Number(v) : null);
  return {
    platform: "YouTube",
    views: n(stats.viewCount),
    likes: n(stats.likeCount),
    comments: n(stats.commentCount),
    forwards: null, // YouTube doesn't expose share counts
    fetchedAt: new Date().toISOString(),
  };
}

// GET /api/youtube — channel profile + recent-upload engagement averages.
export async function fetchYouTubeChannel(urlOrHandle) {
  if (!KEY) return { error: "YOUTUBE_API_KEY not set in backend/.env" };
  const ref = extractChannelRef(urlOrHandle);
  if (!ref) return { error: "Could not parse a channel from that link/handle." };

  const { body, error } = await getJson("/channels", {
    part: "snippet,statistics,contentDetails",
    key: KEY,
    ...(ref.id ? { id: ref.id } : { forHandle: ref.handle }),
  });
  if (error) return { error };
  const ch = body.items?.[0];
  if (!ch) return { error: "Channel not found." };

  const stats = ch.statistics || {};
  const followers = stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount ?? 0) || null;
  const profile = {
    id: ch.id,
    username: (ch.snippet?.customUrl || "").replace(/^@/, "") || ch.id,
    fullName: ch.snippet?.title ?? null,
    bio: ch.snippet?.description ?? null,
    followers,
    posts: Number(stats.videoCount ?? 0) || null,
    isVerified: false,
    isPrivate: false,
    profilePic: ch.snippet?.thumbnails?.medium?.url || ch.snippet?.thumbnails?.default?.url || null,
    avgLikes: null,
    avgComments: null,
    engagementRate: null,
    engagementSampleSize: 0,
    recentPosts: [],
    fetchedAt: new Date().toISOString(),
  };

  // Recent uploads → avg likes/comments. Best-effort: the profile still
  // returns even if these follow-up calls fail.
  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  if (uploads) {
    const pl = await getJson("/playlistItems", {
      part: "snippet,contentDetails", playlistId: uploads, maxResults: RECENT_SAMPLE, key: KEY,
    });
    const items = pl.body?.items || [];
    const ids = items.map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (ids.length) {
      const vids = await getJson("/videos", { part: "statistics", id: ids.join(","), key: KEY });
      const byId = new Map((vids.body?.items || []).map((v) => [v.id, v.statistics || {}]));
      const likes = [], comments = [];
      profile.recentPosts = items.map((i) => {
        const vid = i.contentDetails?.videoId;
        const st = byId.get(vid) || {};
        if (st.likeCount != null) likes.push(Number(st.likeCount));
        if (st.commentCount != null) comments.push(Number(st.commentCount));
        return {
          id: vid,
          permalink: `https://www.youtube.com/watch?v=${vid}`,
          thumbnailUrl: i.snippet?.thumbnails?.medium?.url || i.snippet?.thumbnails?.default?.url || null,
          likeCount: st.likeCount != null ? Number(st.likeCount) : null,
        };
      });
      const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
      profile.avgLikes = avg(likes);
      profile.avgComments = avg(comments);
      profile.engagementSampleSize = items.length;
      // Rough ER%: avg (likes + comments) per recent video over subscriber base
      if (profile.avgLikes != null && followers) {
        profile.engagementRate = Math.round(((profile.avgLikes + (profile.avgComments || 0)) / followers) * 1000) / 10;
      }
    }
  }

  return profile;
}
