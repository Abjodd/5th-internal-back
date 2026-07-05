/**
 * Instagram profile fetch — HikerAPI (api.hikerapi.com)
 *
 * GET https://api.hikerapi.com/v1/user/by/username?username={username}
 * Header: x-access-key: {HIKERAPI_TOKEN}
 *
 * Confirmed documented response shape (per HikerAPI docs):
 * {
 *   pk, username, full_name, is_private, is_verified,
 *   media_count, follower_count, following_count,
 *   biography, external_url, is_business,
 *   public_email, contact_phone_number, profile_pic_url, ...
 * }//new file
 */
import "dotenv/config";

const BASE_URL = "https://api.hikerapi.com/v1/user/by/username";
const MEDIAS_URL = "https://api.hikerapi.com/v1/user/medias";
const TOKEN = process.env.HIKERAPI_TOKEN;
const DEBUG = process.env.IG_DEBUG !== "0";
const RECENT_POSTS_SAMPLE_SIZE = 12; // how many recent posts to average likes over

function log(...args) {
  if (DEBUG) console.log("[instagramFetchHiker]", ...args);
}

function extractUsername(input) {
  if (!input) return null;
  const s = input.trim().replace(/^@/, "");
  const m = s.match(/instagram\.com\/([^/?#]+)/i);
  return m ? m[1] : s;
}

// Fetch recent posts for a user and compute average likes/comments.
// Returns nulls (not an error) if this call fails — profile data should
// still be returned even if the likes lookup has a hiccup.
async function fetchAverageEngagement(userId) {
  const url = `${MEDIAS_URL}?${new URLSearchParams({
    user_id: userId,
    amount: RECENT_POSTS_SAMPLE_SIZE,
  })}`;

  let res;
  try {
    res = await fetch(url, { headers: { "x-access-key": TOKEN } });
  } catch (e) {
    log("medias network error:", e.message);
    return { avgLikes: null, avgComments: null, sampleSize: 0 };
  }

  const text = await res.text();
  let posts;
  try {
    posts = JSON.parse(text);
  } catch {
    log("medias non-JSON response:", text.slice(0, 300));
    return { avgLikes: null, avgComments: null, sampleSize: 0 };
  }

  if (res.status !== 200 || !Array.isArray(posts)) {
    log(`medias request failed status=${res.status}`, JSON.stringify(posts).slice(0, 300));
    return { avgLikes: null, avgComments: null, sampleSize: 0 };
  }

  const likeValues = posts.map((p) => p.like_count).filter((n) => typeof n === "number" && n >= 0);
  const commentValues = posts.map((p) => p.comment_count).filter((n) => typeof n === "number" && n >= 0);

  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

  return {
    avgLikes: avg(likeValues),
    avgComments: avg(commentValues),
    sampleSize: posts.length,
  };
}

export async function fetchInstagramProfile(usernameOrUrl) {
  if (!TOKEN) {
    return { error: "HIKERAPI_TOKEN not set in backend/.env" };
  }

  const username = extractUsername(usernameOrUrl);
  if (!username) {
    return { error: "Could not parse a username from that link/handle." };
  }

  const url = `${BASE_URL}?${new URLSearchParams({ username })}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { "x-access-key": TOKEN },
    });
  } catch (e) {
    log("network error:", e.message);
    return { error: `Network error: ${e.message}`, username };
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    log(`non-JSON response (status ${res.status}):`, text.slice(0, 300));
    return { error: `Non-JSON response (status ${res.status})`, username, raw: text };
  }

  log(`status=${res.status}`, JSON.stringify(body).slice(0, 1000));

  if (res.status !== 200) {
    return {
      error: body?.detail || body?.message || `Request failed with status ${res.status}`,
      username,
      raw: body,
    };
  }

  const profile = {
    id: body.pk ?? null,
    username: body.username ?? username,
    fullName: body.full_name ?? null,
    bio: body.biography ?? null,
    externalUrl: body.external_url ?? null,
    followers: body.follower_count ?? null,
    following: body.following_count ?? null,
    posts: body.media_count ?? null,
    isVerified: !!body.is_verified,
    isPrivate: !!body.is_private,
    isBusiness: !!body.is_business,
    publicEmail: body.public_email ?? null,
    contactPhone: body.contact_phone_number ?? null,
    profilePic: body.profile_pic_url ?? null,
    avgLikes: null,
    avgComments: null,
    engagementSampleSize: 0,
    fetchedAt: new Date().toISOString(),
  };

  // Private accounts' media endpoint will 403/return nothing useful —
  // skip the extra call in that case.
  if (!profile.isPrivate && profile.id) {
    const engagement = await fetchAverageEngagement(profile.id);
    profile.avgLikes = engagement.avgLikes;
    profile.avgComments = engagement.avgComments;
    profile.engagementSampleSize = engagement.sampleSize;
  }

  return profile;
}