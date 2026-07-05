/**
 * Instagram profile fetch — instagram-social.p.rapidapi.com
 *
 * GET /v1/profile?username={username}
 *
 * Confirmed real endpoint (RapidAPI Playground example response for
 * "mrbeast"). Response shape:
 * {
 *   meta: { version, status, copywrite, username, user_id },
 *   body: {
 *     id, username, full_name, is_verified, is_private, is_business,
 *     profile_pic, ...(21 keys total — likely includes follower_count,
 *     following_count, media_count, biography, category, external_url,
 *     but not all confirmed yet — logging raw body below to verify)
 *   }
 * }
 *
 * NOTE: the exact query param name is assumed to be "username" based on
 * this API's convention (the /v1/search endpoint uses "search"). If this
 * 400s, check the Params tab on RapidAPI's v1/profile page for the real
 * param name and swap PARAM_NAME below.
 */
import "dotenv/config";

const HOST = "instagram-social.p.rapidapi.com";
const KEY  = process.env.RAPIDAPI_KEY;
const DEBUG = process.env.IG_DEBUG !== "0";
const PARAM_NAME = "username"; // <-- change this if RapidAPI's Params tab shows a different name

function log(...args) {
  if (DEBUG) console.log("[instagramFetch]", ...args);
}

function extractUsername(input) {
  if (!input) return null;
  const s = input.trim().replace(/^@/, "");
  const m = s.match(/instagram\.com\/([^/?#]+)/i);
  return m ? m[1] : s;
}

function toNumberOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

async function callProfile(username) {
  const qs = new URLSearchParams({ [PARAM_NAME]: username }).toString();
  const url = `https://${HOST}/v1/profile?${qs}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": HOST,
        "x-rapidapi-key": KEY,
      },
    });
  } catch (e) {
    log("network error:", e.message);
    return { error: `Network error: ${e.message}` };
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    log(`non-JSON response (status ${res.status}):`, text.slice(0, 300));
    return { error: `Non-JSON response (status ${res.status})`, raw: text };
  }

  log(`status=${res.status} body=`, JSON.stringify(json).slice(0, 1500));

  if (res.status !== 200) {
    return { error: json?.message || json?.meta?.message || `Request failed with status ${res.status}`, raw: json };
  }

  return { data: json };
}

function parseProfile(raw) {
  const body = raw?.body || raw;
  if (!body || typeof body !== "object") return null;

  // Log the full key list once so we can see the real field names for
  // follower/following/media counts and extend this list precisely.
  log("body keys:", Object.keys(body));

  const followers = body.follower_count ?? body.followers_count ?? body.followers ?? null;
  const following = body.following_count ?? body.followings_count ?? body.following ?? null;
  const posts     = body.media_count ?? body.posts_count ?? body.post_count ?? null;

  return {
    id:             body.id ?? null,
    username:       body.username ?? null,
    fullName:       body.full_name ?? null,
    bio:            body.biography ?? body.bio ?? null,
    category:       body.category ?? null,
    externalUrl:    body.external_url ?? null,
    followers:      toNumberOrNull(followers),
    following:      toNumberOrNull(following),
    posts:          toNumberOrNull(posts),
    isVerified:     !!body.is_verified,
    isPrivate:      !!body.is_private,
    isBusiness:     !!body.is_business,
    profilePic:     body.profile_pic ?? body.profile_pic_url ?? null,
    fetchedAt:      new Date().toISOString(),
    // Keep the full raw body too, so nothing is lost while we confirm
    // the remaining field names (21 keys total, not all mapped above yet).
    _raw:           body,
  };
}

export async function fetchInstagramProfile(usernameOrUrl) {
  if (!KEY) {
    return { error: "RAPIDAPI_KEY not set in backend/.env" };
  }

  const username = extractUsername(usernameOrUrl);
  if (!username) {
    return { error: "Could not parse a username from that link/handle." };
  }

  const result = await callProfile(username);
  if (result.error) {
    return { error: result.error, username, raw: result.raw ?? null };
  }

  const parsed = parseProfile(result.data);
  if (!parsed) {
    return {
      error: "Got a 200 response but couldn't find a usable body — check `raw`.",
      username,
      raw: result.data,
    };
  }

  return { username, ...parsed };
}